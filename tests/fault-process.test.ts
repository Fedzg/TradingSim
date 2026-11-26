import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrokerOrder, Intent } from "../src/broker";
import { FakeAgents, reviewOrder } from "../src/agents";
import { enqueue, type Message } from "../src/chat";
import { State, type Baton, type RunLock } from "../src/state";
import { wake } from "../src/time";

const cli = join(import.meta.dir, "../src/cli.ts");
const fixtureFiles = join(import.meta.dir, "fixtures");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "tradingsim-fault-"));
  roots.push(base);
  const state = new State(join(base, "state-fake"));
  await mkdir(state.root, { recursive: true });
  const orders = async () => await state.read<BrokerOrder[]>("fake-broker.json") ?? [];
  const messages = async () => Promise.all((await state.list("outbox")).map(name => state.read<Message>(`outbox/${name}`)));
  function spawn(args: string[], fault = "", extra: Record<string, string> = {}) {
    const env = { PATH: process.env.PATH!, TRADINGSIM_STATE_DIR: base, FAULT_CASE: fault, ...extra };
    const proc = Bun.spawn([process.execPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const outcome = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      .then(([code, out, err]) => ({ code, out, err }));
    return { proc, outcome };
  }
  const command = (args: string[], fault = "", extra: Record<string, string> = {}) => spawn([cli, ...args, "--fake"], fault, {
    ...(fault ? { BUN_OPTIONS: `--preload=${join(fixtureFiles, "fault-preload.ts")}` } : {}), ...extra,
  });
  const once = (fault = "", extra: Record<string, string> = {}, slot = "15:40") => command(["once", "--slot", slot, "--force"], fault, extra);
  const driver = (caseName: string, phase = "") => spawn([join(fixtureFiles, "fault-delivery-news.ts"), state.root, caseName, phase]).outcome;
  return { base, state, orders, messages, once, command, driver };
}

async function until<T>(read: () => Promise<T | undefined>, wait = 3000): Promise<T> {
  const limit = Date.now() + wait;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(15);
  } while (Date.now() < limit);
  throw new Error("Checkpoint di guasto non raggiunto");
}

async function checkpoint(state: State, name: string) {
  return until(async () => {
    const file = Bun.file(state.path(name));
    if (await file.exists()) return Number(await file.text());
  });
}

test("G1: SIGKILL esterno dopo persistenza e rilancio dello stesso slot", async () => {
  const f = await fixture();
  const first = f.once("crash");
  const pid = await checkpoint(f.state, "broker-checkpoint");
  const lock = await f.state.read<RunLock>("run.lock");
  expect(lock?.pid).toBe(pid);
  const before = await f.orders();
  expect(before).toHaveLength(1);
  expect(lock?.intents).toEqual([before[0].client_order_id]);
  process.kill(pid, "SIGKILL");
  const killed = await first.outcome;
  expect(killed.code).toBe(137);
  expect(await f.state.read("run.lock")).toBeDefined();
  const retry = await f.once().outcome;
  expect(retry.code).toBe(0);
  expect(retry.out).toContain("interrotta");
  expect((await f.state.intents())[0]?.observed?.status).toBe("accepted");
  expect(await f.orders()).toEqual(before);
  console.log("G1", { pid, code: killed.code, retry: retry.code, id: before[0].client_order_id, before: 1, after: 1 });
});

test("G2: due run Bun sovrapposti a 500 ms", async () => {
  const f = await fixture();
  const start = performance.now();
  const first = f.once("hold");
  await Bun.sleep(500);
  const delta = Math.round(performance.now() - start);
  const pid = await checkpoint(f.state, "broker-checkpoint");
  process.kill(pid, 0);
  const second = await f.once().outcome;
  expect(second.code).toBe(0);
  expect(second.out).toContain("già attivo");
  process.kill(pid, 0);
  const done = await first.outcome;
  expect(done.code).toBe(0);
  expect((await f.orders()).map(x => [x.symbol,x.side])).toEqual([["SPY","buy"]]);
  console.log("G2", { delta, pid, codes: [done.code, second.code], "SPY/buy": 1 });
});

test("G3: timeout MCP reale con richiesta persa e con risposta persa", async () => {
  await Promise.all(["unaccepted", "accepted", "unaccepted-upstream", "accepted-upstream"].map(async fault => {
    const f = await fixture();
    const first = await f.once("wire", { FAULT_WIRE: fault }).outcome;
    const trace = await Promise.all((await f.state.list(".")).filter(x => x.startsWith("wire-")).map(x => f.state.read<{ name: string; args: { client_order_id: string }; at: number }>(x)));
    const send = trace.find(x => x?.name === "place_stock_order")!;
    const lookup = trace.filter(x => x?.name === "get_order_by_client_id" && x.at > send.at).at(-1)!;
    const delta = lookup.at - send.at;
    const upstream = fault.endsWith("-upstream");
    const accepted = fault.startsWith("accepted");
    const receipt = await f.state.read<{ name: string; at: number }>("upstream-timeout.json");
    // The fixture timestamps receipt, after the client has already started its timer.
    const toleranceMs = 100;
    if (upstream) {
      expect(receipt?.name).toBe("TimeoutError");
      expect(receipt!.at - send.at).toBeGreaterThanOrEqual(30_000 - toleranceMs);
    } else expect(delta).toBeGreaterThanOrEqual(35_000 - toleranceMs);
    expect(lookup.args.client_order_id).toBe(send.args.client_order_id);
    expect(first.code).toBe(0);
    expect(first.out).toContain(upstream ? "place_stock_order ha restituito un errore" : "timeout tools/call");
    expect(first.out).not.toContain("eseguite 2/2");
    const intent = (await f.state.intents())[0] as Intent;
    const before = await f.orders();
    expect(intent.id).toBe(send.args.client_order_id);
    expect(intent.observed?.status).toBe(accepted ? "accepted" : undefined);
    const retry = await f.once().outcome;
    expect(retry.code).toBe(0);
    expect(await f.orders()).toEqual(before);
    expect(before).toHaveLength(accepted ? 1 : 0);
    console.log("G3", { fault, delta, id: intent.id, observed: intent.observed?.status ?? null, before: before.length, after: before.length });
  }));
}, 50_000);

for (const [label, json] of [
  ["troncato", '{"orders":['],
  ["campo mancante", '{"orders":[],"reasoning":"Prova"}'],
  ["quantità negativa", '{"orders":[{"symbol":"SPY","side":"buy","qty":-2,"reason":"Prova"}],"reasoning":"Prova","planNext":"Prova"}'],
]) {
  test(`G4: Codex ${label}`, async () => {
    const f = await fixture();
    const codex = join(f.base, "codex");
    await Bun.write(codex, `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --output-last-message ]; then shift; printf %s '${json}' > "$1"; exit 0; fi\n  shift\ndone\nexit 9\n`);
    await chmod(codex, 0o700);
    const result = await f.once("invalid", { PATH: `${f.base}:${process.env.PATH}` }).outcome;
    const log = (await f.state.list("logs"))[0];
    const alerts = (await f.state.read<{ alerts: string[] }>(`logs/${log}`))!.alerts.join(" ");
    expect(result.code).toBe(0);
    expect(alerts).toContain("Decisione mancante");
    expect(alerts).toMatch(label === "troncato" ? /JSON|parse|Unexpected/i : /Risposta non valida/);
    expect((await f.messages()).some(m => m?.kind === "allarmi" && m.text.includes(alerts))).toBe(true);
    expect((await f.messages()).some(m => m?.kind === "resoconto" && m.text.includes("Decisione mancante"))).toBe(true);
    expect(await f.orders()).toEqual([]);
    console.log("G4", { label, alerts, orders: 0 });
  });
}

test("G5: SIGKILL dopo 31 byte del temporaneo di baton.json", async () => {
  const f = await fixture();
  const old: Baton = { wake: wake("2026-01-02", "09:00"), savedAt: "2026-01-02T08:00:00Z", planNext: "Precedente", report: "", pending: [] };
  await f.state.write("baton.json", old);
  const bytes = await Bun.file(f.state.path("baton.json")).text();
  const first = f.once("baton", {}, "09:00");
  const pid = await checkpoint(f.state, "baton-checkpoint");
  process.kill(pid, "SIGKILL");
  expect((await first.outcome).code).toBe(137);
  const temporary = (await readdir(f.state.root)).find(name => /^baton\.json\..+\.tmp$/.test(name))!;
  expect(await Bun.file(f.state.path(temporary)).text()).toHaveLength(31);
  expect(await Bun.file(f.state.path("baton.json")).text()).toBe(bytes);
  const retry = await f.once("", {}, "09:00").outcome;
  expect(retry.code).toBe(0);
  expect(retry.out).toContain("interrotta");
  expect((await f.state.baton()).baton?.wake.id).not.toBe(old.wake.id);
  console.log("G5", { temporaryBytes: 31, old: old.wake.id, new: (await f.state.baton()).baton?.wake.id });
});

test("G6: ore 22:05 Roma, scheduler non recupera le 21:40 e force non invia", async () => {
  const f = await fixture();
  await f.state.write("fake-open.json", false);
  const fake = new FakeAgents();
  const proposal = (await fake.invoke("decide") as { orders: unknown[] }).orders[0];
  expect((await reviewOrder(fake, JSON.stringify(proposal), {})).review.verdict).toBe("approve");
  const scheduler = f.command(["schedule"], "clock");
  try {
    await until(async () => (await f.state.read("news.json")) ?? undefined);
    expect(await f.state.read("run.lock")).toBeUndefined();
    expect(await f.state.read("baton.json")).toBeUndefined();
  } finally { scheduler.proc.kill("SIGTERM"); }
  const stopped = await scheduler.outcome;
  expect(stopped.code).toBe(0);
  expect(stopped.out).toContain("2026-11-21 09:00");
  const manual = await f.once("clock", {}, "21:40").outcome;
  expect(manual.code).toBe(0);
  expect(manual.out).toContain("mercato chiuso");
  expect(await f.orders()).toEqual([]);
  console.log("G6", { next: "2026-11-21 09:00", manual: "2026-11-20-2140", orders: 0, note: "blocco prima della revisione" });
});

type Send = { part: number; accepted: boolean; at: number };

test("G7a: Telegram 429 sulla parte 2, riavvio e attesa a partire dal 429", async () => {
  const f = await fixture();
  await enqueue(f.state, "429", "resoconto", "x".repeat(5100));
  expect((await f.driver("429")).code).toBe(0);
  const failure = (await f.messages())[0]!;
  const limitedAt = (await f.state.read<number>("limited-at.json"))!;
  const immediate = await f.driver("429");
  const beforeRetry = (await f.state.read<Send[]>("requests.json"))!;
  await Bun.sleep(1100);
  const retry = await f.driver("429");
  const after = (await f.state.read<Send[]>("requests.json"))!;
  console.log("G7a", { retryDelayMs: Date.parse(failure.retryAt!) - limitedAt, immediateCalls: beforeRetry.length, parts: after.map(x => x.part) });
  expect(immediate.code).toBe(0);
  expect(retry.code).toBe(0);
  expect(failure.partsSent).toBe(1);
  expect(failure.delivered).toBeUndefined();
  expect(Date.parse(failure.retryAt!) - limitedAt).toBeGreaterThanOrEqual(1000);
  expect(beforeRetry).toHaveLength(2);
  expect(after.map(x => x.part)).toEqual([1, 2, 2]);
  expect((await f.messages())[0]?.delivered).toBeDefined();
});

test("G7b: risposta persa dopo accettazione, la parte non confermata rimane sospesa", async () => {
  const f = await fixture();
  await enqueue(f.state, "lost", "resoconto", "x".repeat(5100));
  expect((await f.driver("lost")).code).toBe(0);
  expect((await f.messages())[0]).toMatchObject({ partsSent: 1, error: expect.stringContaining("incerto") });
  expect((await f.messages())[0]?.delivered).toBeUndefined();
  expect((await f.driver("lost")).code).toBe(0);
  const requests = (await f.state.read<Send[]>("requests.json"))!;
  expect(requests.filter(x => x.accepted).map(x => x.part)).toEqual([1, 2]);
  expect((await f.messages())[0]?.deliveryStatus).toBe("DELIVERY_UNKNOWN");
  console.log("G7b", { accepted: requests.map(x => x.part), unconfirmedCheckpoint: 1 });
});

test("G8: analista fallito e notizia ripetuta tra processi distinti", async () => {
  const f = await fixture();
  const failed = await f.driver("news", "fail");
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("Analista indisponibile");
  expect(await f.messages()).toHaveLength(0);
  const valid = await f.driver("news", "valid");
  const repeat = await f.driver("news", "repeat");
  expect(valid.out).toContain("avvisi 1");
  expect(repeat.out).toContain("avvisi 0");
  const [alert] = await f.messages();
  expect(await f.messages()).toHaveLength(1);
  expect(alert?.text).toContain("https://example.com/nvda");
  expect(alert?.text).toContain("Fonte originale");
  expect(alert?.text).not.toMatch(/AAPL|ID inesistente/);
  expect(await f.orders()).toEqual([]);
  console.log("G8", { codes: [failed.code, valid.code, repeat.code], alerts: 1, orders: 0 });
});

test("G9: scenari validati e deduplicati, chart-report fake resta di sola lettura", async () => {
  const f = await fixture();
  expect((await f.once("charts", {}, "09:00").outcome).code).toBe(0);
  expect((await f.once("charts", {}, "09:00").outcome).code).toBe(0);
  const scenarios = (await f.messages()).filter(x => x?.kind === "scenario-grafici");
  expect(scenarios).toHaveLength(1);
  for (const text of ["SPY (15 minuti)", "Massimi decrescenti", "Invalidazione: Chiusura sopra 101", "Incertezza: Volumi ridotti", "(Roma)"]) {
    expect(scenarios[0]?.text).toContain(text);
  }
  expect(scenarios[0]?.text).not.toMatch(/QQQ|NVDA|AAPL/);
  const onDemand = await f.command(["chart-report"], "charts").outcome;
  console.log("G9", { wakeAlerts: scenarios.length, chartReportCode: onDemand.code, error: onDemand.err.trim(), orders: (await f.orders()).length });
  expect(onDemand.code).toBe(0);
  expect((await f.messages()).filter(x => x?.kind === "scenario-grafici")).toHaveLength(2);
  expect(await f.orders()).toEqual([]);
});

for (const [fault, detail, orderStatus] of [
  ["review-down", "Revisore indisponibile"],
  ["review-schema", "Risposta non valida dal ruolo review"],
  ["account-error", "get_account_info"],
  ["account-invalid", "conto non valida"],
  ["positions", "get_all_positions"],
  ["all", "get_orders"],
  ["open", "get_orders"],
  ["clock", "get_clock"],
  ["position-row", "get_all_positions"],
  ["order-row", "get_orders"],
  ["lookup-500", "HTTP 500"],
  ["lookup-ambiguous", "HTTP 500"],
  ["lookup-404", "accettato", "accepted"],
  ["rejected", "respinto", "rejected"],
] as const) {
  test(`Audit worker ${fault}`, async () => {
    const f = await fixture();
    const result = await f.once("audit", { AUDIT_FAULT: fault }).outcome;
    const trace = await Bun.file(f.state.path("audit.trace")).text();
    const baton = (await f.state.baton()).baton!;
    const orders = await f.orders();
    const intents = await f.state.intents();
    const notifications = await f.state.list("fake-chat");
    console.log("AUDIT", JSON.stringify({ fault, code: result.code, orders: orders.length, intents: intents.length,
      notifications: notifications.length, wake: baton.wake.id, observed: intents[0]?.observed?.status }));
    expect(result.code).toBe(0);
    expect(baton.report).toContain(detail);
    expect(trace.split("\n").filter(line => line.startsWith("place_stock_order "))).toHaveLength(orderStatus ? 1 : 0);
    expect(orders).toHaveLength(orderStatus ? 1 : 0);
    expect(notifications).toHaveLength(orders.length + 1);
    if (fault.startsWith("review-")) expect(trace).toContain("decide\nchallenge\nanswer\nreview");
    if (orderStatus) {
      expect(intents[0].observed).toMatchObject({ client_order_id: orders[0].client_order_id, status: orderStatus, filled_qty: "0" });
      expect(baton.report).not.toContain("eseguite 2/2");
    }
  });
}

for (const corruption of ["troncato", "campi invalidi", "data impossibile"]) {
  test(`Audit recupero baton ${corruption}`, async () => {
    const f = await fixture();
    expect((await f.once().outcome).code).toBe(0);
    const before = await f.orders();
    const [intent] = await f.state.intents();
    const old = (await f.state.baton()).baton!;
    await f.state.write(`intents/${intent.id}.json`, { ...intent, observed: undefined });
    await Bun.write(f.state.path("baton.json"), corruption === "troncato" ? '{"wake":' :
      JSON.stringify(corruption === "data impossibile" ? { ...old, wake: wake("2026-99-44", "15:40") } : { ...old, report: 42, pending: "??" }));
    const recovery = await f.once("audit").outcome;
    const trace = await Bun.file(f.state.path("audit.trace")).text();
    const recovered = (await f.state.baton()).baton!;
    const restarted = await f.once().outcome;
    const notifications = await f.state.list("fake-chat");
    console.log("AUDIT", JSON.stringify({ corruption, codes: [recovery.code, restarted.code], id: intent.id,
      before: before.length, after: (await f.orders()).length, notifications: notifications.length }));
    expect(recovery.code).toBe(0);
    expect(recovery.out).toContain("Testimone corrotto");
    expect(trace.indexOf("get_order_by_client_id " + intent.id)).toBe(0);
    expect(trace).toContain("decide");
    expect(trace).not.toContain("place_stock_order");
    expect(recovered.wake).toEqual(old.wake);
    expect((await f.state.intents())[0].observed?.client_order_id).toBe(intent.id);
    expect(restarted.code).toBe(0);
    expect(await f.orders()).toEqual(before);
    expect(notifications).toHaveLength(2);
  });
}

test("Audit scheduler riparte alle 21:40 Roma dopo due slot saltati", async () => {
  const f = await fixture();
  const prior = wake("2026-11-20", "09:00");
  await f.state.write("baton.json", { wake: prior, savedAt: "2026-11-20T08:00:00Z", report: "", planNext: "", pending: [] });
  await f.state.write("fake-open.json", false);
  const before = await f.orders();
  const clock = join(f.base, "clock");
  await Bun.write(clock, String(Date.parse("2026-11-20T20:40:00Z")));
  await f.state.write("test-scan-resume.json", true);
  const scheduler = f.command(["schedule"], "", {
    BUN_OPTIONS: "--preload=" + join(fixtureFiles, "efficiency-scheduler-preload.ts"), TEST_SCHEDULER_CLOCK: clock,
  });
  try {
    await until(async () => (await f.state.baton()).baton?.wake.slot === "21:40" || undefined);
    await until(async () => (await f.state.list("fake-chat")).find(name => name.startsWith("resoconto-")));
  } finally { scheduler.proc.kill("SIGTERM"); }
  const result = await scheduler.outcome;
  const logs = await f.state.list("history");
  const baton = (await f.state.baton()).baton!;
  console.log("AUDIT", JSON.stringify({ fault: "missed", code: result.code, before: before.length, after: (await f.orders()).length, logs }));
  expect(result.code).toBe(0);
  expect(baton.planNext).toContain("Sveglie saltate (ora di Roma): 2026-11-20 15:40, 2026-11-20 18:30.");
  expect(logs).toHaveLength(1);
  expect(logs[0]).toStartWith("2026-11-20-2140-");
  expect(await f.state.list("fake-chat")).toHaveLength(1);
  expect(await f.orders()).toEqual(before);
});

for (const [fault, command, reason] of [
  ["news-timeout", "exec sleep 20", "timeout dopo 150 s"],
  ["news-quota", "echo 'usage_limit_reached PRIVATE-MARKER' >&2; exit 1", "limite di utilizzo"],
  ["news-auth", "echo 'HTTP 401 PRIVATE-MARKER' >&2; exit 1", "autenticazione"],
]) {
  test(`Audit worker ${fault}`, async () => {
    const f = await fixture();
    const codex = join(f.base, "codex");
    await Bun.write(codex, "#!/bin/sh\n" + command + "\n");
    await chmod(codex, 0o700);
    const outcome = await f.once("audit", { AUDIT_FAULT: fault, PATH: f.base + ":" + process.env.PATH }).outcome;
    const baton = (await f.state.baton()).baton!;
    const trace = await Bun.file(f.state.path("audit.trace")).text();
    expect(outcome.code).toBe(0);
    expect(outcome.err).toContain(reason);
    expect(outcome.err + outcome.out).not.toContain("PRIVATE-MARKER");
    expect(baton.report).toContain("SPY (giornaliero): Laterale");
    expect(baton.planNext).toContain(reason);
    expect(trace).not.toMatch(/decide|place_stock_order/);
    expect(await f.orders()).toHaveLength(0);
    expect((await f.state.list("fake-chat")).filter(name => name.startsWith("resoconto-"))).toHaveLength(1);
  });
}

test("Audit risposta persa e lookup indisponibile fino al riavvio", async () => {
  const f = await fixture();
  const first = await f.once("audit", { AUDIT_FAULT: "lost" }).outcome;
  const [order] = await f.orders();
  expect(first.code).toBe(0);
  expect(first.out).toContain("esito non verificato");
  expect((await f.state.intents())[0].observed).toBeUndefined();
  expect(order).toMatchObject({ status: "accepted", filled_qty: "0" });
  const retry = await f.once("audit").outcome;
  const trace = await Bun.file(f.state.path("audit.trace")).text();
  expect(retry.code).toBe(0);
  expect(trace.split("place_stock_order " + order.client_order_id)).toHaveLength(2);
  expect(retry.out).not.toContain("eseguite 2/2");
  expect((await f.state.intents())[0].observed).toEqual(order);
  expect(await f.orders()).toEqual([order]);
  expect(await f.state.list("fake-chat")).toHaveLength(2);
});

test("Audit rifiuto esplicito del broker senza ordine creato", async () => {
  const f = await fixture();
  const first = await f.once("audit", { AUDIT_FAULT: "buying-power" }).outcome;
  const baton = (await f.state.baton()).baton!;
  const retry = await f.once("audit").outcome;
  const trace = await Bun.file(f.state.path("audit.trace")).text();
  expect(first.code).toBe(0);
  expect(retry.code).toBe(0);
  expect(trace.match(/place_stock_order/g)).toHaveLength(1);
  expect(await f.orders()).toEqual([]);
  expect(baton.report).toContain("potere di acquisto insufficiente");
  expect(baton.pending).toEqual([]);
  expect((await f.state.intents())[0].observed).toMatchObject({ status: "rejected", filled_qty: "0" });
  expect(await f.state.list("fake-chat")).toHaveLength(2);
});

for (const [fault, expected, notifications] of [
  ["closed", ["Nessun ordine inviato.", "Alpaca indica mercato chiuso.", "Nessun ordine attivo."], 1],
  ["accepted", ["SPY · Acquisto · richieste 2 · inviato · accettato, 0 eseguite", "residue 2"], 2],
  ["wake-partial", ["eseguito in parte, acquistato: 1", "eseguite 1, residue 1"], 2],
  ["wake-sale", ["SPY · Vendita · richieste 2 · inviato · eseguito, venduto: 2", "Riduzione dell’esposizione su SPY."], 2],
  ["wake-buy-filled", ["inviato · eseguito, acquistato: 2", "Trend di prova.", "Grafico (giornaliero)"], 2],
  ["news-feed", ["Notizie non verificabili.", "Feed finto indisponibile"], 1],
  ["open", ["Ordini attivi non verificabili.", "get_orders (open)"], 1],
  ["account-error", ["Conto Paper non verificabile", "get_account_info", "QQQ · Vendita · accettato", "eseguite 1, residue 2", "stop 95"], 1],
] as const) {
  test(`Resoconto Telegram fake ${fault}`, async () => {
    const f = await fixture();
    if (fault === "closed" || fault === "news-feed") await f.state.write("fake-open.json", false);
    if (fault === "wake-sale") await f.state.write("fake-positions.json", [
      { symbol: "SPY", qty: "4", qty_available: "4", avg_entry_price: "100", current_price: "100", market_value: "400" },
    ]);
    if (fault === "account-error") await f.state.write("fake-broker.json", [
      { client_order_id: "precedente", symbol: "QQQ", side: "sell", status: "accepted", qty: "3", filled_qty: "1", limit_price: null, stop_price: "95" },
    ]);
    const checked = new Date().toISOString();
    const article = { title: "Dati macro di prova", link: "https://example.com/paper", source: "Fonte di prova",
      published: checked, symbols: ["SPY"], summary: "Inflazione sotto le attese." };
    await f.state.write("news.json", { checked, lastSuccess: checked,
      ...(fault === "news-feed" ? { error: "Feed finto indisponibile", articles: [] } : { articles: [article] }) });
    const result = await f.once("audit", { AUDIT_FAULT: fault }).outcome;
    expect(result.code).toBe(0);
    expect((await f.once("audit", { AUDIT_FAULT: fault }).outcome).code).toBe(0);
    const files = await f.state.list("fake-chat");
    expect(files).toHaveLength(notifications);
    const [name] = files.filter(name => name.startsWith("resoconto-"));
    const report = (await f.state.read<Message>("fake-chat/" + name))!.text;
    const reports = (await f.messages()).filter(message => message?.kind === "resoconto");
    expect(reports).toHaveLength(1);
    for (const part of ["15:40 · Europe/Rome", "Esito della sveglia", "Ordini Paper attivi", "Notizie con possibile impatto Paper", ...expected]) {
      expect(report).toContain(part);
    }
    if (fault === "accepted") expect(report).not.toContain("acquistato:");
    if (fault !== "news-feed") {
      expect(report).toContain(article.link);
      expect(report).toContain("Dati macro di prova (SPY)");
    }
    if (fault === "wake-buy-filled" || fault === "closed") console.log("ESEMPIO " + fault + "\n" + report);
  });
}

test("Resoconto Telegram fake ritenta dopo riavvio senza ripetere la sveglia", async () => {
  const f = await fixture();
  const first = await f.once("audit", { TRADINGSIM_FAKE_CHAT_FAIL: "1" }).outcome;
  expect(first.code).toBe(0);
  const original = (await f.messages()).find(message => message?.notification === "wake-report")!;
  expect(original).toMatchObject({ attempts: 1, error: "Consegna finta non riuscita." });
  const history = await f.state.list("history");
  const orders = await f.orders();
  expect(orders).toHaveLength(1);
  expect(await f.state.list("fake-chat")).toHaveLength(0);
  expect((await f.command(["deliver"]).outcome).code).toBe(0);
  expect((await f.command(["deliver"]).outcome).code).toBe(0);
  expect(await f.state.list("history")).toEqual(history);
  expect(await f.orders()).toEqual(orders);
  const delivered = (await f.messages()).filter(message => message?.notification === "wake-report");
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ id: original.id, attempts: 2, delivered: expect.any(String) });
  expect(await f.state.list("fake-chat")).toHaveLength(2);
});

test("12:30 Gold automatico e manuale, futures aperti con NYSE chiusa; riavvio senza duplicati", async () => {
  const f = await fixture();
  const now = new Date("2026-11-23T11:30:00Z");
  const clock = join(f.base, "gold-clock");
  await Bun.write(clock,String(+now));
  const env = { TEST_SCHEDULER_CLOCK: clock, BUN_OPTIONS: "--preload="+join(fixtureFiles,"efficiency-scheduler-preload.ts") };
  await f.state.write("fake-open.json",false);
  await f.state.write("test-scan-resume.json",true);
  const q = { symbol: "GCZ26.CMX", regularMarketTime: +now/1000, expireDate: +now/1000+86400*35,
    regularMarketPrice: 2400, regularMarketVolume: 150, marketState: "REGULAR", exchangeDataDelayedBy: 10 };
  await f.state.write("fake-gold-quotes.json",[q,{...q,symbol:"GCX26.CMX",expireDate:+now/1000-1,regularMarketVolume:500},
    {...q,symbol:"EURUSD=X",regularMarketTime:+now/1000-3600}]);
  await f.state.write("gold-contracts.json",{GC:"GCX26.CMX"});
  const article = { title:"Gold and Fed rates",summary:"Inflation report.",source:"Fonte finta",link:"https://example.org/rates",published:now.toISOString(),symbols:[] };
  await f.state.write("news.json",{lastSuccess:now.toISOString(),checked:now.toISOString(),articles:[article,{...article,link:"https://example.org/reprint"}]});
  const scheduler = f.command(["schedule"],"",env);
  try {
    await until(async () => (await f.state.list("fake-chat")).find(name=>name.startsWith("gold-")));
  } finally { scheduler.proc.kill("SIGTERM"); }
  expect((await scheduler.outcome).code).toBe(0);
  expect((await f.once("",env,"12:30").outcome).code).toBe(0);
  const [name] = await f.state.list("fake-chat");
  const report = (await f.state.read<Message>("fake-chat/"+name))!;
  for (const part of ["GOLD","MATERIE PRIME","FOREX E MACRO","NOTIZIE","PROSSIMO CONTROLLO","OPERAZIONI","GCZ26.CMX","aperta secondo il feed","ritardo 10 min","Rollover","dato datato"]) expect(report.text).toContain(part);
  expect(report.text.match(/Gold and Fed rates/g)).toHaveLength(1);
  expect(await f.state.list("fake-chat")).toHaveLength(1);
  expect(await f.orders()).toEqual([]);
  expect(await f.state.list("intents")).toHaveLength(0);
  expect(await f.state.read("baton.json")).toBeUndefined();
  const manual = await fixture();
  expect((await manual.once("",env,"12:30").outcome).code).toBe(0);
  const [missing] = await manual.messages();
  expect(missing?.text).toContain("contratto attivo e prezzo non verificabili");
  expect(await manual.orders()).toEqual([]);
});

test("indicatori oro solo su barre complete, ATR e RSI e range precedente", async () => {
  const { technical } = await import("../src/gold-briefing");
  const now = new Date();
  const bars = Array.from({length:25},(_,i)=>({t:new Date(+now-(25-i)*900000).toISOString(),o:100+i,h:101+i,l:99+i,c:100+i,v:null}));
  expect(technical([],15,now)).toBeUndefined();
  expect(technical(bars,15,now)).toMatchObject({atr:2,rsi:100,high:124,low:83+20,fast:122});
  expect(technical([...bars,{...bars[0],t:now.toISOString(),c:999}],15,now)).toEqual(technical(bars,15,now));
});
