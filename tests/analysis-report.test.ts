import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgents } from "../src/agents";
import { FakeBroker, FakeMcp, type MarketSession } from "../src/broker";
import { closeReportId, dailyClose } from "../src/daily-close";
import { analyzeWakeNews, verifyEvents } from "../src/event-news";
import { fakeCharts, Market } from "../src/market";
import { briefingSession, sessionCandles } from "../src/market-session";
import { run } from "../src/run";
import { State } from "../src/state";
import { nyInstant, rome, wake } from "../src/time";
import { outboxId, type Message } from "../src/chat";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tradingsim-analysis-report-"));
  roots.push(root);
  const state = new State(root);
  return { root, state };
}

const session = (date: string, close = "16:00"): MarketSession => ({ date, open: "09:30", close });
const candle = (t: string, c = 81.2, high = 81.7) => ({ t, o: 81, c, h: high, l: 80, v: 100 });
const redact = (text: string) => text;

test("lunedì 09:00 Roma conserva venerdì come ultima seduta e distingue il premarket", async () => {
  const { state } = await fixture();
  const now = new Date("2026-03-16T08:00:00Z"); // New York 04:00, prima del cambio italiano.
  const date = "2026-03-16";
  const days = [session("2026-03-13"), session(date)];
  const clock = { is_open: false, timestamp: now.toISOString() };
  await state.write("fake-calendar.json", days);
  await state.write("fake-clock.json", clock);
  const market = new Market(undefined, true);
  const series = { symbol: "SPY", source: "Alpaca IEX", updated: "2026-03-13T19:45:00Z", intervals: {
    "15Min": [candle("2026-03-13T19:45:00Z"), candle("2026-03-13T21:00:00Z")],
    "1Day": [candle("2026-03-13T04:00:00Z")],
  } };
  market.charts = async () => [series];
  await run({ state, broker: new FakeBroker(state), agents: new FakeAgents(), market, redact }, wake(date, "09:00"), false, now);
  const report = await state.read<Message>("outbox/" + outboxId("resoconto", date + "-0900") + ".json");
  expect(report?.text).toContain("Ultima seduta completata: 2026-03-13.");
  expect(report?.text).toContain("regolare 2026-03-13: 2026-03-13T19:45:00Z");
  expect(report?.text).not.toContain("dato datato");
  expect(report?.text).toContain("premarket non ancora disponibile");
  const later = new Date("2026-03-16T08:30:00Z");
  series.intervals["15Min"].push(candle("2026-03-16T08:00:00Z"));
  expect(sessionCandles(series, briefingSession(days, { ...clock, timestamp: later.toISOString() }, later)).premarket)
    .toBe("2026-03-16T08:00:00Z");
  expect(await new FakeBroker(state).orders()).toHaveLength(0);
});

test("festività USA e orari di chiusura gestiscono ora legale e seduta anticipata", async () => {
  expect(rome(nyInstant("2026-03-16", "16:00")).time).toBe("21:00");
  expect(rome(nyInstant("2026-03-30", "16:00")).time).toBe("22:00");
  expect(rome(nyInstant("2026-11-27", "13:00")).time).toBe("19:00");
  const { state } = await fixture();
  const now = new Date("2026-11-26T21:05:00Z");
  await state.write("fake-calendar.json", [session("2026-11-25")]);
  await dailyClose(state, new FakeBroker(state), now, redact);
  expect(briefingSession([session("2026-11-25")], { is_open: false, timestamp: now.toISOString() }, now).status).toContain("chiuso");
  expect(await state.list("outbox")).toHaveLength(0);
});

const article = { title: "Broker downgrades TLT", link: "https://example.com/one", source: "Fonte A",
  published: "2026-11-22T12:00:00Z", symbols: ["TLT"], summary: "The broker downgraded TLT on November 12, 2026." };
const event = { title: article.title, link: article.link, source: article.source, published: article.published, symbols: article.symbols,
  impact: "Possibile pressione sul titolo.", classification: "fatto", effectiveDate: "2026-11-12", dateQuote: article.summary,
  eventType: "downgrade", subject: "TLT", update: "no" as const };

test("notizie ripubblicate deduplicate per evento, aggiornamenti distinti e date non verificate", () => {
  const now = new Date(article.published);
  const duplicate = { ...article, title: "TLT rating cut", link: "https://example.com/two", source: "Fonte B" };
  const unknown = { ...article, title: "Fed comments", link: "https://example.com/three", summary: "No event date provided." };
  const update = { ...article, title: "Broker publishes new outlook", link: "https://example.com/four", summary: "The broker revised its outlook on 2026-11-22." };
  const dates = [article, duplicate, unknown, update];
  const result = verifyEvents([event,
    { ...event, title: duplicate.title, source: duplicate.source, link: duplicate.link },
    { ...event, link: unknown.link, effectiveDate: "2026-11-22", dateQuote: unknown.summary },
    { ...event, link: update.link, effectiveDate: "2026-11-22", dateQuote: update.summary, update: "sì" },
  ], dates, [{ symbol: "TLT", source: "Alpaca IEX", updated: null, intervals: {
    "1Day": [candle("2026-11-13T05:00:00Z", 80), candle("2026-11-16T05:00:00Z", 81)],
  } }], now);
  expect(result.map(item => [item.status, item.effectiveDate])).toEqual([
    ["notizia storica", "2026-11-12"], ["Data dell’evento non verificata", undefined], ["aggiornamento di un evento precedente", "2026-11-22"],
  ]);
  expect(result[0].movement).toContain("1.25%");
  expect(result[0].movement).toContain("Causalità non verificata");
});

test("cache notizie tra istanze, invalidata da un aggiornamento della fonte", async () => {
  const { state, root } = await fixture();
  const now = new Date(article.published);
  const agents = { calls: 0, async invoke() { this.calls++; return { events: [event], newMarkets: [], limitations: [] }; } };
  const news = { checked: article.published, lastSuccess: article.published, articles: [article] };
  await analyzeWakeNews(state, agents, now, news, ["TLT"]);
  await analyzeWakeNews(new State(root), agents, new Date(+now + 300_000), news, ["TLT"]);
  expect(agents.calls).toBe(1);
  await analyzeWakeNews(state, agents, new Date(+now + 600_000), { ...news, articles: [{ ...article, summary: article.summary + " New outlook." }] }, ["TLT"]);
  expect(agents.calls).toBe(2);
});

test("nessun acquisto TLT, livello e prezzo verificati nei log, conto con P&L", async () => {
  const { state } = await fixture();
  const now = new Date();
  const { date } = rome(now);
  const entry = wake(date, "15:40");
  const market = new Market(undefined, true);
  const tlt = { ...fakeCharts(now)[0], symbol: "TLT", source: "Alpaca IEX", intervals: {
    "15Min": Array.from({ length: 24 }, (_, index) => candle(new Date(+now - (24 - index) * 900_000).toISOString())),
  } };
  market.charts = async () => [tlt];
  await state.write("fake-positions.json", [{ symbol: "TLT", qty: "1", qty_available: "1", avg_entry_price: "80", current_price: "81.2",
    market_value: "81.2", unrealized_pl: "1.2" }]);
  const base = new FakeAgents({ orders: [], reasoning: "Nessuna rottura confermata della resistenza TLT.", planNext: "Controllare TLT." });
  const agents = { invoke: async (role: Parameters<typeof base.invoke>[0], input: unknown) => role === "charts"
    ? { ideas: [{ symbol: "TLT", horizon: "15 minuti", bias: "laterale", direction: "Laterale", evidence: "Range",
      invalidation: "Perdita del supporto", uncertainty: "Segnale assente" }], limitations: [] }
    : base.invoke(role, input) };
  const broker = new FakeBroker(state);
  await run({ state, broker, agents, market, redact }, entry, false, now);
  const msg = await state.read<Message>("outbox/" + outboxId("resoconto", entry.id) + ".json");
  expect(msg?.text).toContain("Nessun ordine inviato");
  expect(msg?.text).toContain("rottura della resistenza non confermata");
  expect(msg?.text).toContain("resistenza 81.7");
  expect(msg?.text).toContain(now.toISOString());
  expect(msg?.text).toContain("Equity");
  expect(msg?.text).toContain("P&L giornaliero");
  expect(msg?.text).toContain("P&L non realizzato");
  const [file] = await state.list("logs");
  expect((await state.read<{ technical: string[] }>("logs/" + file))?.technical[0]).toContain("Invalidazione: chiusura sotto il supporto 80");
  expect(await broker.orders()).toHaveLength(0);
});

test("chiusura anticipata in sola lettura, eseguiti di oggi e deduplica dopo riavvio", async () => {
  const { root, state } = await fixture();
  const date = "2026-11-27";
  const before = new Date("2026-11-27T18:04:59Z");
  const after = new Date("2026-11-27T18:05:10Z");
  const calls: string[] = [];
  const mcp = new FakeMcp(state);
  const broker = new FakeBroker(state, { async call(name, args) { calls.push(name); return mcp.call(name, args); } });
  await state.write("fake-calendar.json", [session(date, "13:00")]);
  await dailyClose(state, broker, before, redact);
  expect(calls).toEqual(["get_calendar"]);
  const order = { id: "id-1", submitted_at: "2026-11-25T12:00:00Z", client_order_id: "paper-1",
    symbol: "TLT", side: "buy", status: "partially_filled", qty: "8", filled_qty: "5", limit_price: "80" };
  await state.write("fake-broker.json", [order]);
  await state.write("fake-fills.json", [{ id: "fill-1", order_id: order.id, symbol: "TLT", side: "buy", qty: "2", transaction_time: "2026-11-27T16:00:00Z" }]);
  await state.write("fake-clock.json", { is_open: false, timestamp: after.toISOString() });
  await state.write("history/" + date + "-1540-test.json", { wake: wake(date, "15:40"), savedAt: after.toISOString(),
    summary: { reasons: ["Resistenza non superata."], alerts: ["Fonte grafici parziale."] } });
  const cli = join(import.meta.dir, "../src/cli.ts");
  const clock = join(root, "clock");
  await Bun.write(clock, String(+after));
  const child = async (command: string) => {
    const proc = Bun.spawn([process.execPath, cli, command, "--fake"], { env: {
      PATH: process.env.PATH!, TRADINGSIM_STATE_DIR: root,
      BUN_OPTIONS: "--preload=" + join(import.meta.dir, "fixtures/efficiency-scheduler-preload.ts"), TEST_SCHEDULER_CLOCK: clock,
    }, stdout: "ignore", stderr: "inherit" });
    expect(await proc.exited).toBe(0);
  };
  // Use the same persisted state directory expected by --fake in fresh CLI processes.
  const { rename, mkdir } = await import("node:fs/promises");
  const fakeRoot = state.path("state-fake");
  await mkdir(fakeRoot);
  for (const name of await state.list(".")) await rename(state.path(name), join(fakeRoot, name));
  await rename(state.path("history"), join(fakeRoot, "history"));
  await child("_close");
  await child("deliver");
  await child("_close");
  await child("deliver");
  const restarted = new State(fakeRoot);
  const key = closeReportId(date) + ".json";
  const delivered = await restarted.read<Message>("fake-chat/" + key);
  expect(delivered?.text).toContain("chiusura 19:00 Roma");
  expect(delivered?.text).toContain("TLT · Acquisto · eseguito in parte · eseguite oggi 2");
  expect(delivered?.text).toContain("Resistenza non superata");
  expect(delivered?.text).toContain("Fonte grafici parziale");
  expect(await restarted.list("outbox")).toEqual([key]);
  expect((await restarted.read<Message>("outbox/" + key))?.attempts).toBe(1);
  expect(await restarted.read("fake-broker.json")).toEqual([order]);
});
