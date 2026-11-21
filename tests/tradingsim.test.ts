import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeAgents, reviewOrder, type Agents, type Decision, type Role } from "../src/agents";
import { FakeBroker, FakeMcp, type Position, type Proposal } from "../src/broker";
import { enqueue, FakeChannel, flush, type Message } from "../src/chat";
import type { Mcp } from "../src/mcp";
import { Market } from "../src/market";
import { ticketFor } from "../src/risk";
import { run } from "../src/run";
import { State } from "../src/state";
import { TelegramChannel } from "../src/telegram";
import { rome, wake } from "../src/time";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const date = "2026-09-24";
const opening = wake(date, "15:40");
const close = wake(date, "21:40");
const now = new Date("2026-09-24T13:40:00Z");
const order: Proposal = { symbol: "SPY", side: "buy", qty: 2, reason: "Trend simulato." };

function decision(orders: Proposal[]): Decision {
  return { orders, reasoning: "Il test verifica la proposta. I dati sono simulati. Il rischio è valutato dal codice.", planNext: "Controllare gli ordini." };
}

async function fixture(agents: Agents = new FakeAgents(), wrapMcp?: (mcp: Mcp) => Mcp) {
  const root = await mkdtemp(join(tmpdir(), "tradingsim-test-"));
  roots.push(root);
  const state = new State(root);
  const broker = new FakeBroker(state, wrapMcp?.(new FakeMcp(state)));
  const input = { state, broker, agents, market: new Market(undefined, true), redact: (x: string) => x };
  const messages = async () => await Promise.all((await state.list("outbox")).map(file => state.read<Message>(`outbox/${file}`)));
  return { ...input, messages, start: (entry = opening, force = false) => run(input, entry, force, now) };
}

test("stessa sveglia anche con force: un solo ordine", async () => {
  const f = await fixture();
  await f.start();
  await f.start();
  await f.start(opening, true);
  expect((await f.broker.orders()).map(x => x.client_order_id)).toEqual(["2026-09-24-1540-SPY-buy"]);
});

test("SIGKILL dopo broker, poi riconciliazione senza ricomprare alla sveglia successiva", async () => {
  const f = await fixture();
  const base = f.state.root;
  const state = new State(join(base, "state-fake"));
  const args = [process.execPath, join(import.meta.dir, "../src/cli.ts"), "_run", "--fake", "--date", date, "--slot"];
  const spawn = (slot: string, crash = false) => Bun.spawn(["flock", "--no-fork", "-n", state.path("run.guard"), ...args, slot], {
    env: { ...process.env, TRADINGSIM_STATE_DIR: base, TRADINGSIM_FAKE_CRASH: crash ? "after-submit" : "" },
    stdout: "ignore", stderr: "pipe",
  });
  await state.write("init.json", true);
  const crashed = spawn("15:40", true);
  expect(await crashed.exited).toBe(137);
  expect(await state.read("run.lock")).toBeDefined();
  const restarted = spawn("18:30");
  expect(await restarted.exited).toBe(0);
  expect((await new FakeBroker(state).orders()).map(x => x.client_order_id)).toEqual(["2026-09-24-1540-SPY-buy"]);
  expect((await state.baton()).baton?.planNext).toContain("interrotta");
  expect(await state.read("run.lock")).toBeUndefined();
});

test("due sveglie saltate e nessun ordine al briefing", async () => {
  const f = await fixture();
  await f.start(wake(date, "09:00"));
  expect(await f.broker.orders()).toEqual([]);
  await f.start(close);
  const baton = (await f.state.baton()).baton!;
  expect(baton.planNext).toContain("2026-09-24 15:40, 2026-09-24 18:30");
});

test("rifiuta simbolo fuori universo e acquisto al 40%", async () => {
  const f = await fixture(new FakeAgents(decision([{ ...order, symbol: "TSLA" }, { ...order, qty: 40 }])));
  await f.start();
  expect(await f.broker.orders()).toEqual([]);
  const report = (await f.state.baton()).baton!.report;
  expect(report).toContain("fuori dall’universo");
  expect(report).toContain("20%");
});

test("posizione a -4%: stop obbligatorio nonostante il decisore rimanga fermo", async () => {
  const f = await fixture(new FakeAgents(decision([])));
  const position: Position = { symbol: "SPY", qty: "3", qty_available: "3", avg_entry_price: "100", current_price: "96", market_value: "288" };
  await f.state.write("fake-positions.json", [position]);
  await f.start();
  expect((await f.broker.orders())[0]).toMatchObject({ client_order_id: "2026-09-24-1540-SPY-sell", side: "sell", qty: "3" });
});

test("testimone corrotto: prosegue e segnala l’errore", async () => {
  const f = await fixture();
  await writeFile(f.state.path("baton.json"), "{");
  await f.start();
  expect((await f.broker.orders()).length).toBe(1);
  expect((await f.state.baton()).baton!.planNext).toContain("Testimone corrotto");
});

test("veto, eccezione e risposta non valida del revisore bloccano l’invio", async () => {
  for (const verdict of ["reject", "throw", "invalid"]) {
    const base = new FakeAgents();
    const f = await fixture({ async invoke(role, input) {
      if (role !== "review") return base.invoke(role);
      if (verdict === "throw") throw new Error("Revisore indisponibile");
      return verdict === "invalid" ? {} : { verdict, reason: "Prova contraria." };
    } });
    await f.start();
    expect(await f.broker.orders()).toEqual([]);
    expect((await f.state.baton()).baton!.report).toMatch(/Respinto dal revisore|non confermato/);
  }
});

test("approvazione vincolata a quantità e prezzo limite", async () => {
  const agents = new FakeAgents();
  const first = await reviewOrder(agents, ticketFor(order, 100), {});
  expect(first.review.verdict).toBe("approve");
  expect(first.ticket).not.toBe(ticketFor({ ...order, qty: 3 }, 100));
  expect(first.ticket).not.toBe(ticketFor(order, 101));
});

test("WTI e GBP/USD solo monitorati, nuovo mercato con fonte origina una domanda", async () => {
  const base = new FakeAgents(decision([{ ...order, symbol: "USOIL" }, { ...order, symbol: "GBP/USD" }]));
  const f = await fixture({ async invoke(role: Role) {
    if (role !== "news") return base.invoke(role);
    return { events: [], limitations: [], newMarkets: [{ name: "Euro/Dollaro", symbol: "EUR/USD",
      source: "Fonte finta", published: now.toISOString(), link: "https://example.com/mercati", event: "Dati macro", reason: "Verificare la reazione valutaria." }] };
  } });
  await f.start();
  const messages = await f.messages();
  expect(messages.some(x => x?.text.includes("Vuoi aggiungere Euro/Dollaro"))).toBe(true);
  const report = (await f.state.baton()).baton!.report;
  expect(report).toContain("USOIL: solo monitoraggio");
  expect(report).toContain("GBP/USD: solo monitoraggio");
  expect(report).toContain("Chiusure USOIL, 15Min");
  expect(await f.broker.orders()).toEqual([]);
});

test("consegna fallita e ritentata senza inviare nuovi ordini", async () => {
  const f = await fixture();
  await f.start();
  await flush(f.state, new FakeChannel(f.state, true));
  expect((await f.state.baton()).baton).toBeDefined();
  expect((await f.messages())[0]).toMatchObject({ attempts: 1, error: "Consegna finta non riuscita." });
  await flush(f.state, new FakeChannel(f.state));
  expect((await f.messages())[0]?.delivered).toBeDefined();
  expect((await f.broker.orders()).length).toBe(1);
});

test("conferme ordine e notizie già osservate non producono nuove notifiche", async () => {
  const f = await fixture();
  await f.start();
  await f.start(opening, true);
  const messages = await f.messages();
  expect(messages.filter(message => message?.kind === "ordine").map(message => message?.text))
    .toEqual([expect.stringContaining("accettato")]);
  expect(messages.filter(message => message?.kind === "notizia")).toHaveLength(1);
});

test("Telegram riprende dalla parte rimasta in coda dopo un limite di invio", async () => {
  const f = await fixture();
  const sent: { chat_id: string; text: string; link_preview_options: { is_disabled: boolean } }[] = [];
  const request = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.telegram.org/bot123:simulato/sendMessage");
    expect(init.method).toBe("POST");
    sent.push(JSON.parse(init.body as string));
    if (sent.length === 2) return Response.json({ ok: false, parameters: { retry_after: 45 } }, { status: 429 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  await enqueue(f.state, opening.id, "resoconto", "x".repeat(3900) + "📊".repeat(70));
  const channel = new TelegramChannel("123:simulato", "123456", request);
  await flush(f.state, channel, now);
  const [queued] = await f.messages();
  expect(queued).toMatchObject({ partsSent: 1, attempts: 1, retryAt: "2026-09-24T13:40:45.000Z" });
  await flush(f.state, channel, new Date(+now + 30_000));
  expect(sent).toHaveLength(2);
  await flush(f.state, channel, new Date(+now + 45_000));
  expect(sent).toHaveLength(3);
  expect(sent[2]).toEqual(sent[1]);
  expect(sent[0]).toMatchObject({ chat_id: "123456", link_preview_options: { is_disabled: true } });
  expect(sent[0].text).toStartWith("TradingSim · Resoconto (1/2)");
  expect(sent[1].text).toStartWith("TradingSim · Resoconto (2/2)");
  expect(sent.every(message => message.text.length <= 4096)).toBe(true);
  expect((await f.messages())[0]?.delivered).toBeDefined();
});

test("mercato chiuso blocca anche gli stop; fuso Roma con e senza ora legale", async () => {
  const f = await fixture();
  await f.state.write("fake-open.json", false);
  await f.state.write("fake-positions.json", [{ symbol: "SPY", qty: "3", qty_available: "3", avg_entry_price: "100", current_price: "96", market_value: "288" }]);
  await f.start();
  expect(await f.broker.orders()).toEqual([]);
  expect(rome(new Date("2026-09-24T13:40:00Z")).time).toBe("15:40");
  expect(rome(new Date("2026-11-20T14:40:00Z")).time).toBe("15:40");
});

const mcpFaults = [
  ["conto: errore MCP", "get_account_info", { isError: true }],
  ["conto: risposta incompleta", "get_account_info", { structuredContent: { equity: "10000" } }],
  ["posizioni: envelope malformato", "get_all_positions", { structuredContent: { _alpaca_mcp_security: {}, data: {} } }],
  ["orologio: sessione non verificabile", "get_clock", { structuredContent: { is_open: "true", timestamp: now.toISOString() } }],
  ["ricerca: errore diverso da 404", "get_order_by_client_id", { isError: true, content: [{ type: "text", text: "HTTP error 403: Forbidden" }] }],
] as const;

for (const [scenario, target, fault] of mcpFaults) {
  test(`guasto MCP ${scenario}: nessun invio`, async () => {
    const calls: string[] = [];
    const f = await fixture(new FakeAgents(), mcp => ({ async call(name, args) {
      calls.push(name);
      if (name === target) return structuredClone(fault) as unknown as Awaited<ReturnType<Mcp["call"]>>;
      return mcp.call(name, args);
    } }));
    await f.start();
    expect(calls).toContain(target);
    expect(calls).not.toContain("place_stock_order");
    expect(await f.broker.orders()).toEqual([]);
    expect((await f.state.baton()).baton?.planNext).toContain("Alpaca MCP");
  });
}

test("guasto MCP dopo invio: riconcilia lo stesso ID senza reinviare", async () => {
  let sends = 0;
  const f = await fixture(new FakeAgents(), mcp => ({ async call(name, args) {
    if (name !== "place_stock_order") return mcp.call(name, args);
    sends++;
    await mcp.call(name, args);
    return { structuredContent: { _alpaca_mcp_security: {}, data: { error: { timeout: true } } } };
  } }));
  await f.start();
  await f.start(opening, true);
  expect(sends).toBe(1);
  expect((await f.broker.orders())[0].client_order_id).toBe("2026-09-24-1540-SPY-buy");
  expect((await f.state.intents())[0].observed?.status).toBe("accepted");
});
