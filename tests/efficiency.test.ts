import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeAgents, reviewOrder, type Agents, type Role } from "../src/agents";
import { materialChange } from "../src/analysis-cache";
import { FakeBroker } from "../src/broker";
import { Discovery } from "../src/discovery";
import { catalog, type Candidate } from "../src/discovery-sources";
import { chartContext, closedCandles, marketEvidence, rsi14 } from "../src/indicators";
import { fakeCharts, type Article } from "../src/market";
import { orderReviewContext } from "../src/order-review-context";
import { ticketFor } from "../src/risk";
import { State, type Baton } from "../src/state";
import { wake } from "../src/time";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const t0 = Date.parse("2026-11-20T14:40:00Z");
const at = (minutes: number) => new Date(t0 + minutes * 60_000);

function candidate(now: Date, changes: Partial<Candidate["metrics"]> = {}): Candidate {
  const stamp = new Date(+now - 900_000).toISOString();
  return { instrument: catalog[0], market: { url: "https://example.com/amd", source: "Fonte test", at: stamp, detail: "Trend" },
    metrics: { dayPct: 2.4, hourPct: 0.6, typicalDayPct: 1, relativeMove: 2.4, volumeMultiple: 1.6,
      lastClose: 103, invalidation: 101, at: stamp, ...changes } };
}

async function root() {
  const path = await mkdtemp(join(tmpdir(), "tradingsim-efficiency-"));
  roots.push(path);
  return path;
}

async function fixture(options: { reject?: boolean; error?: boolean } = {}) {
  const directory = await root();
  const calls: Role[] = [];
  const agents: Agents = { async invoke(role) {
    calls.push(role);
    if (options.error && role === "discoveryCharts") throw new Error("Codex non disponibile");
    return { verdict: options.reject && role === "discoveryNews" ? "reject" : "approve",
      reason: "Test su fonte verificabile.", doubt: "Volatilità.", sourceIds: ["mercato"] };
  } };
  const state = () => new State(directory);
  const discovery = () => new Discovery(state(), agents, x => x);
  const scan = (now: Date, item = candidate(now), articles: Article[] = []) =>
    discovery().collect({ candidates: [item], coverage: [] }, articles, now);
  return { state, calls, discovery, scan };
}

test("quattro scansioni distinte e riavvio: due chiamate anche se avanza la candela", async () => {
  const f = await fixture();
  for (const minutes of [0, 15, 30, 45]) await f.scan(at(minutes));
  expect(f.calls).toEqual(["discoveryNews", "discoveryCharts"]);
  expect(await f.discovery().proposals()).toHaveLength(1);
  expect(await f.state().list("outbox")).toEqual([]);
  const { analysisCache } = (await f.state().read<any>("watchlist.json"))!;
  const record = Object.values(analysisCache)[0] as any;
  expect(record.analyzedAt).toBe(at(0).toISOString());
  expect(record.sources.mercato.url).toBe(candidate(at(0)).market.url);
  expect(record.candidate.metrics.dayPct).toBe(2.4);
});

test("riusa un veto valido e rivaluta alla prima notizia pertinente e al cambio di direzione", async () => {
  const f = await fixture({ reject: true });
  await f.scan(at(0));
  await f.scan(at(15), candidate(at(15), { dayPct: 2.41, hourPct: 0.61 }));
  expect(f.calls).toHaveLength(2);
  const news = [{ title: "AMD aggiorna la guidance", source: "Fonte verificata", link: "https://example.com/news",
    published: at(20).toISOString(), symbols: ["AMD"], summary: "Revisione delle stime." }];
  await f.scan(at(30), candidate(at(30)), news);
  expect(f.calls).toHaveLength(4);
  await f.scan(at(45), candidate(at(45), { dayPct: -2.4, hourPct: -0.6, lastClose: 99, invalidation: 101 }), news);
  expect(f.calls).toHaveLength(6);
  expect(await f.discovery().proposals()).toEqual([]);
  expect(await f.state().list("outbox")).toEqual([]);
});

test("validità scaduta rivaluta; un errore Codex viene ritentato e non salvato come veto", async () => {
  const options = { error: true };
  const f = await fixture(options);
  await f.scan(at(0));
  expect((await f.state().read<any>("watchlist.json"))?.analysisCache).toEqual({});
  options.error = false;
  await f.scan(at(15));
  expect(f.calls).toHaveLength(4);
  await f.scan(at(60));
  expect(f.calls).toHaveLength(4);
  await f.scan(at(75));
  expect(f.calls).toHaveLength(6);
});

test("soglie: invalidazione intraday anche con recupero, movimento e volume", () => {
  const original = candidate(at(0));
  const sources = { mercato: original.market };
  const cached = { candidate: original, sources, analyzedAt: at(0).toISOString() };
  const item = candidate(at(15));
  expect(materialChange(cached, item, sources, at(15))).toBeUndefined();
  expect(materialChange(cached, candidate(at(15), { lastClose: 100 }), sources, at(15))).toBe("invalidazione");
  const chart = fakeCharts(at(15))[0];
  chart.intervals["15Min"].at(-1)!.l = 100;
  expect(materialChange(cached, { ...item, indicators: marketEvidence(chart, at(15)) }, sources, at(15))).toBe("invalidazione");
  expect(materialChange(cached, candidate(at(15), { dayPct: 3.01 }), sources, at(15))).toBe("movimento");
  expect(materialChange(cached, candidate(at(15), { volumeMultiple: 2.2 }), sources, at(15))).toBe("volume");
});

test("indicatori e contesto omettono candele aperte e conservano timestamp, fonte e lacune", () => {
  const now = at(0);
  const charts = fakeCharts(now);
  const series = charts[0];
  const last = series.intervals["15Min"].at(-1)!;
  series.intervals["15Min"].push({ ...last, t: new Date(+now - 1000).toISOString(), c: 999 });
  series.intervals["1Day"].push({ ...last, t: new Date(+now - 12 * 3600_000).toISOString(), c: 999 });
  const compact = chartContext(charts, now);
  const data = compact.charts[0].intervals;
  expect(data["15Min"].sma20).toBe(100);
  expect(data["15Min"].rsi14).toBe(50);
  expect(data["15Min"].relativeVolume).toBe(1);
  expect(data["15Min"].lastClosed).toBe(last.t);
  expect(data["1Day"].candles.at(-1)?.[4]).toBe(100);
  expect(closedCandles(series, "15Min", now)).toHaveLength(24);
  expect(compact.charts[0].source).toBe(series.source);
  expect(compact.candleFields).toContain("timestamp");
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify({ now, charts })) / 3);
  expect(marketEvidence({ ...series, intervals: {} }, now).intervals["15Min"]).toMatchObject({ stale: true, sma20: null, rsi14: null });
  expect(rsi14(Array.from({ length: 15 }, (_, i) => i + 8))).toBe(100);
  expect(rsi14(Array.from({ length: 15 }, (_, i) => 25 - i))).toBe(0);
});

test("revisione compatta conserva i tre ruoli, può porre veto e lega il verdetto all’ordine", async () => {
  const now = at(0);
  const state = new State(await root());
  const broker = new FakeBroker(state);
  const snapshot = await broker.snapshot();
  const order = { symbol: "SPY", side: "buy" as const, qty: 2, reason: "Rialzo sopra la media." };
  const limit = 100;
  const item = orderReviewContext(order, limit, snapshot, wake("2026-11-20", "15:40"), fakeCharts(now)[0], undefined, undefined, now);
  const args: { role: Role; input: any }[] = [];
  const fake = new FakeAgents();
  const agents: Agents = { async invoke(role, input) {
    args.push({ role, input });
    return role === "review" ? { verdict: "reject", reason: "Volatilità troppo alta." } : fake.invoke(role, input);
  } };
  const ticket = ticketFor(order, limit);
  expect((await reviewOrder(agents, ticket, item)).review.verdict).toBe("reject");
  expect(args.map(x => x.role)).toEqual(["challenge", "answer", "review"]);
  expect(args[0].input.risk.limits).toMatchObject({ maxPositions: 5, maxExposure: 0.2 });
  expect(args[1].input.challenge).toBeDefined();
  expect(args[2].input.answer).toBeDefined();
  expect(args[0].input.reason).toBe(order.reason);
  expect(JSON.parse(args[2].input.ticket)).toMatchObject({ qty: 2, limit: 100, side: "buy", symbol: "SPY" });
  const approved = await reviewOrder(fake, ticket, item);
  expect(approved.ticket).not.toBe(ticketFor({ ...order, qty: 3 }, limit));
  expect(approved.ticket).not.toBe(ticketFor(order, 101));
});

async function until(check: () => Promise<boolean>, wait = 3000) {
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(15);
  }
  throw new Error("Checkpoint dello scheduler non raggiunto.");
}

test("processi Bun: le quattro sveglie partono anche durante la scansione; feed a 5/15 minuti", async () => {
  const directory = await root();
  const clockFile = join(directory, "clock");
  const tick = async (instant: string) => {
    await writeFile(clockFile + ".tmp", String(Date.parse(instant)));
    await rename(clockFile + ".tmp", clockFile);
  };
  const start = "2026-11-20T07:59:30.000Z"; // 08:59:30 Europe/Rome
  await tick(start);
  const state = new State(join(directory, "state-fake"));
  await mkdir(state.root, { recursive: true });
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "schedule", "--fake"], {
    env: { PATH: process.env.PATH!, TRADINGSIM_STATE_DIR: directory, TEST_SCHEDULER_CLOCK: clockFile,
      BUN_OPTIONS: `--preload=${join(import.meta.dir, "fixtures/efficiency-scheduler-preload.ts")}` },
    stdout: "pipe", stderr: "pipe",
  });
  const output = new Response(proc.stdout).text();
  const errors = new Response(proc.stderr).text();
  const batonAt = async (slot: string) => (await state.read<Baton>("baton.json"))?.wake.slot === slot;
  const newsAt = async (stamp: string) => (await state.read<{ checked: string }>("news.json"))?.checked === stamp;
  const scanAt = async (stamp: string) => (await state.read<{ scanAt: string }>("watchlist.json"))?.scanAt === stamp;
  try {
    await until(async () => !!await state.read("test-scan-start.json") && await newsAt(start));
    await tick("2026-11-20T08:00:00.000Z");
    await until(() => batonAt("09:00"));
    expect(await state.read("watchlist.json")).toBeUndefined(); // Scansione ancora in corso.
    await state.write("test-scan-resume.json", true);
    await until(() => scanAt(start));

    await tick("2026-11-20T08:04:29.000Z");
    await Bun.sleep(160);
    expect(await newsAt(start)).toBe(true);
    const secondPoll = "2026-11-20T08:04:30.000Z";
    await tick(secondPoll);
    await until(() => newsAt(secondPoll));

    await tick("2026-11-20T08:14:29.000Z");
    await Bun.sleep(180);
    expect(await scanAt(start)).toBe(true);
    const secondScan = "2026-11-20T08:14:30.000Z";
    await tick(secondScan);
    await until(() => scanAt(secondScan));
    for (const [time, slot] of [["14:40", "15:40"], ["17:30", "18:30"], ["20:40", "21:40"]]) {
      await tick(`2026-11-20T${time}:00.000Z`);
      await until(() => batonAt(slot));
    }
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
  expect(await output).toContain("Scheduler attivo");
  expect(await errors).toBe("");
}, 18_000);

test("Il budget discovery sopravvive alla ricreazione del workflow",async()=>{
  const f=await fixture({});
  await f.state().write("budgets/discovery.json",{calls:Array(24).fill(+at(0)),failures:0,resume:0});
  await f.scan(at(15));
  expect(f.calls).toHaveLength(0);
  await f.scan(at(61));
  expect(f.calls).toHaveLength(2);
});
