import { open, unlink } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { CodexAgents, FakeAgents, type Charts } from "../../src/agents";
import { FakeMcp } from "../../src/broker";
import { Market, fakeCharts } from "../../src/market";
import { AlpacaStdio } from "../../src/mcp";

const mode = process.env.FAULT_CASE;
const root = join(process.env.TRADINGSIM_STATE_DIR!, "state-fake");
const mark = (name: string) => Bun.write(join(root, name), String(process.pid));
const cli = process.argv[1]?.endsWith("/src/cli.ts");

if (cli && !process.argv.includes("--fake")) throw new Error("La fixture richiede --fake.");

if (mode === "clock") {
  const Original = Date;
  const instant = Original.parse("2026-11-20T21:05:00Z");
  globalThis.Date = class extends Original {
    constructor(...args: [] | [string | number]) { super(args.length ? args[0] : instant); }
    static now() { return instant; }
  } as DateConstructor;
}

if (mode === "hold" || mode === "crash") {
  const call = FakeMcp.prototype.call;
  FakeMcp.prototype.call = async function (name, args) {
    const result = await call.call(this, name, args);
    if (name === "place_stock_order") {
      await mark("broker-checkpoint");
      await Bun.sleep(mode === "hold" ? 1400 : 15_000);
    }
    return result;
  };
}

if (mode === "wire") {
  // Scambia solo il trasporto del broker finto. Il client JSON-RPC e i timer sono quelli del progetto.
  const transport = new AlpacaStdio("fixture", "fixture");
  const spawn = Bun.spawn;
  Bun.spawn = ((args: string[], options: Parameters<typeof spawn>[1]) => {
    if (args[0] === "alpaca-mcp-server") {
      return spawn([process.execPath, join(import.meta.dir, "fault-mcp.ts"), root, process.env.FAULT_WIRE ?? ""],
        { ...options, env: { PATH: process.env.PATH! } });
    }
    return spawn(args, options);
  }) as typeof Bun.spawn;
  FakeMcp.prototype.call = transport.call.bind(transport);
  // La fixture stdio è un processo separato e termina chiudendo la pipe del genitore.
  const remove = (await import("../../src/state")).State.prototype.remove;
  (await import("../../src/state")).State.prototype.remove = async function(name) {
    await remove.call(this, name);
    if (name === "run.lock") transport.close();
  };
}

if (mode === "baton") {
  const probe = join(process.env.TRADINGSIM_STATE_DIR!, "handle-probe");
  const handle = await open(probe, "w");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  await unlink(probe).catch(() => {});
  const write = prototype.writeFile;
  prototype.writeFile = async function(content: string, ...args: unknown[]) {
    const path = readlinkSync(`/proc/self/fd/${this.fd}`);
    if (/\/baton\.json\..+\.tmp$/.test(path)) {
      await this.write(content.slice(0, 31));
      await this.sync();
      await mark("baton-checkpoint");
      await Bun.sleep(15_000);
    }
    return write.call(this, content, ...args);
  };
}

if (mode === "invalid") {
  const invoke = FakeAgents.prototype.invoke;
  FakeAgents.prototype.invoke = function(role, input) {
    return role === "decide" ? new CodexAgents(x => x).invoke(role, input) : invoke.call(this, role, input);
  } as typeof invoke;
}

if (mode === "charts") {
  const invoke = FakeAgents.prototype.invoke;
  const idea: Charts["ideas"][number] = {
    symbol: "SPY", horizon: "15 minuti", bias: "ribassista", direction: "Debolezza",
    evidence: "Massimi decrescenti", invalidation: "Chiusura sopra 101", uncertainty: "Volumi ridotti",
  };
  FakeAgents.prototype.invoke = async function(role, input) {
    if (role === "charts") return { limitations: [], ideas: [
      idea, { ...idea, symbol: "QQQ", bias: "laterale" }, { ...idea, symbol: "NVDA" }, { ...idea, symbol: "AAPL" },
    ] };
    return invoke.call(this, role, input);
  } as typeof invoke;
  Market.prototype.charts = async function(now) {
    const charts = fakeCharts(now);
    charts.find(x => x.symbol === "NVDA")!.intervals["15Min"] = [];
    charts.find(x => x.symbol === "AAPL")!.intervals["15Min"] = fakeCharts(new Date(+now - 97 * 3600_000))[0].intervals["15Min"];
    return charts;
  };
}

if (mode === "audit" && process.argv.includes("_run")) {
  const { appendFile } = await import("node:fs/promises");
  const trace = (event: string) => appendFile(join(root, "audit.trace"), event + "\n");
  const fault = process.env.AUDIT_FAULT;
  let placed = false;
  const call = FakeMcp.prototype.call;
  FakeMcp.prototype.call = async function(name, args) {
    await trace(name + (args?.client_order_id ? " " + args.client_order_id : ""));
    if (name === "get_account_info" && fault === "account-error") return { isError: true };
    if ((name === "get_account_info" && fault === "account-invalid") ||
        (name === "get_all_positions" && fault === "positions") ||
        (name === "get_orders" && args?.status === fault) ||
        (name === "get_clock" && fault === "clock")) return { structuredContent: {} };
    if ((name === "get_all_positions" && fault === "position-row") || (name === "get_orders" && args?.status === "open" && fault === "order-row")) {
      return { structuredContent: { result: [null] } };
    }
    if (name === "get_order_by_client_id" && fault === "lookup-ambiguous") {
      return { isError: true, content: [{ type: "text", text: "HTTP error 500: upstream previously returned 404: Not Found" }] };
    }
    if (name === "get_order_by_client_id" && (fault === "lookup-500" || (placed && fault === "lost"))) {
      return { isError: true, content: [{ type: "text", text: "HTTP error 500: Internal Server Error" }] };
    }
    if (name === "place_stock_order" && fault === "buying-power") {
      return { structuredContent: { _alpaca_mcp_security: {}, data: { error: {
        message: "API rejected the order", http_status: 403,
        detail: { code: 40310000, message: "insufficient buying power" },
      } } } };
    }
    const result = await call.call(this, name, args);
    if (name === "place_stock_order" && ["wake-buy-filled", "wake-partial", "wake-sale"].includes(fault ?? "")) {
      const orders = await this.orders();
      const order = orders.at(-1)!;
      order.status = fault === "wake-partial" ? "partially_filled" : "filled";
      order.filled_qty = fault === "wake-partial" ? "1" : order.qty;
      await Bun.write(join(root, "fake-broker.json"), JSON.stringify(orders));
      return { structuredContent: order };
    }
    if (name === "place_stock_order" && fault === "lost") {
      placed = true;
      return { isError: true };
    }
    if (name === "place_stock_order" && fault === "rejected") {
      const orders = await this.orders();
      orders.at(-1)!.status = "rejected";
      await Bun.write(join(root, "fake-broker.json"), JSON.stringify(orders));
      // The submission response is lost. A lookup returns the definitive broker rejection.
      return { isError: true };
    }
    return result;
  };
  const invoke = FakeAgents.prototype.invoke;
  FakeAgents.prototype.invoke = async function(role, input) {
    await trace(role);
    if (role === "news" && fault?.startsWith("news-")) {
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = ((fn, ms, ...args) => timer(fn, ms === 150000 ? 75 : ms, ...args)) as typeof setTimeout;
      try { return await new CodexAgents(x => x).invoke(role, input); }
      finally { globalThis.setTimeout = timer; }
    }
    if (role === "decide" && fault === "wake-sale") {
      return { orders: [{ symbol: "SPY", side: "sell", qty: 2, reason: "Riduzione dell’esposizione su SPY." }],
        reasoning: "Il trend ha perso forza.", planNext: "Ricontrollare SPY." };
    }
    if (role === "review" && fault === "review-down") throw new Error("Revisore indisponibile");
    if (role === "review" && fault === "review-schema") return { verdict: true };
    return invoke.call(this, role, input);
  } as typeof invoke;
}
