import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agents, Role } from "../src/agents";
import { FakeBroker, universe } from "../src/broker";
import { flush, type Message } from "../src/chat";
import { Discovery, savedWatchlist } from "../src/discovery";
import { catalog, scan, trend, type Candidate } from "../src/discovery-sources";
import type { Series } from "../src/market";
import { risk } from "../src/risk";
import { State } from "../src/state";
import { TelegramChannel } from "../src/telegram";
import { wake } from "../src/time";

const now = new Date("2026-09-24T14:00:00Z");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function series(symbol: string): Series {
  const bars = (count: number, interval: number, values: number[]) => values.map((c, i) => ({
    t: new Date(+now - (count - i) * interval).toISOString(), o: c, h: c, l: c, c, v: i === count - 1 ? 300 : 100,
  }));
  const daily = Array.from({ length: 24 }, (_, i) => 100 + i % 2);
  const intra = Array.from({ length: 16 }, (_, i) => 100 + i * 0.2);
  return { symbol, source: "Fonte sintetica", updated: null, intervals: {
    "1Day": bars(24, 86400_000, daily), "15Min": bars(16, 900_000, intra),
  } };
}
const metrics = trend(series("AMD"), now).metrics!;
const candidate: Candidate = { instrument: catalog[0], metrics, market: {
  url: "https://example.com/mercato", source: "Fonte primaria", at: metrics.at, detail: "Movimento 3× la volatilità tipica.",
} };

async function fixture(options: { veto?: Role; fail?: Role; invalidSource?: Role } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tradingsim-discovery-"));
  roots.push(root);
  const state = new State(root);
  const calls: Role[] = [];
  const agents: Agents = { async invoke(role) {
    calls.push(role);
    if (role === options.fail) throw new Error("Interruzione simulata");
    return { verdict: role === options.veto ? "reject" : "approve", reason: "Motivo verificabile.", doubt: "Volume ridotto.",
      sourceIds: [role === options.invalidSource ? "inesistente" : "mercato"] };
  } };
  const engine = () => new Discovery(new State(root), agents, x => x);
  const collect = (job = engine()) => job.collect({ candidates: [candidate], coverage: [] }, [], now);
  const messages = async () => (await Promise.all((await state.list("outbox")).map(x => state.read<Message>(`outbox/${x}`)))).filter(x => !!x);
  return { state, engine, calls, collect, messages };
}

test("lo scanner valuta tutte e cinque le categorie e segnala dati assenti o vecchi", async () => {
  const result = await scan(now, async instrument => {
    if (instrument.category === "CFD") throw new Error("Fonte finta indisponibile");
    if (instrument.symbol === "USD/JPY") return { ...series(instrument.symbol), intervals: {} };
    return series(instrument.symbol);
  });
  expect(result.coverage.map(x => x.category)).toEqual(["azioni", "forex", "futures", "crypto", "CFD"]);
  expect(result.coverage[4]).toMatchObject({ usable: 0, total: 1 });
  expect(result.candidates.some(x => x.instrument.symbol === "USD/JPY")).toBe(false);
  expect(result.candidates.find(x => x.instrument.category === "futures")?.instrument.series).toContain("front-month");
  const stale = series("X");
  stale.intervals["15Min"].forEach(bar => { bar.t = new Date(Date.parse(bar.t) - 10 * 3600_000).toISOString(); });
  expect(trend(stale, now).problem).toContain("vecchie");
  const cfd = await scan(now, async instrument => series(instrument.symbol));
  expect(cfd.candidates.find(x => x.instrument.category === "CFD")?.instrument).toMatchObject({ ticker: "^GSPC", symbol: "SPX500_USD" });
  expect(cfd.candidates.find(x => x.instrument.category === "CFD")?.instrument.series).toContain("Solo sottostante");
});


test("un veto, un errore o una fonte invalida impediscono l’aggiunta", async () => {
  for (const options of [{ veto: "discoveryNews" }, { fail: "discoveryCharts" }, { invalidSource: "discoveryNews" }] as const) {
    const f = await fixture(options);
    await f.collect();
    expect(f.calls).toEqual(["discoveryNews", "discoveryCharts"]);
    expect(await savedWatchlist(f.state)).toEqual([]);
    expect((await f.messages()).some(x => x.text.includes("Aggiunto alla watchlist"))).toBe(false);
  }
});

test("due conferme aggiungono direttamente un solo strumento, senza ordini", async () => {
  const f = await fixture();
  await f.collect();
  await f.collect();
  await f.engine().publish();
  expect(f.calls).toEqual(["discoveryNews", "discoveryCharts"]);
  expect((await savedWatchlist(f.state)).map(x => x.symbol)).toEqual(["AMD"]);
  const messages = (await f.messages()).filter(x => x.text.includes("Aggiunto alla watchlist"));
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toContain(candidate.market.url);
  expect(messages[0]).not.toHaveProperty("buttons");

  const broker = new FakeBroker(f.state);
  const snapshot = await broker.snapshot();
  expect(universe).not.toContain("AMD");
  expect(risk({ symbol: "AMD", side: "buy", qty: 1, reason: "Prova" }, 100, snapshot, wake("2026-09-24", "15:40"))).toContain("fuori");
  expect(await broker.orders()).toEqual([]);
});

test("riavvio dopo il salvataggio ricrea l’avviso senza rieseguire gli analisti", async () => {
  const f = await fixture();
  const job = f.engine();
  job.publish = async () => { throw new Error("Interruzione prima della coda"); };
  await expect(f.collect(job)).rejects.toThrow("Interruzione prima della coda");
  expect(await savedWatchlist(f.state)).toHaveLength(1);
  expect(await f.messages()).toEqual([]);
  await f.engine().publish();
  await f.engine().publish();
  expect((await f.messages()).filter(x => x.text.includes("Aggiunto alla watchlist"))).toHaveLength(1);
  expect(f.calls).toEqual(["discoveryNews", "discoveryCharts"]);
});

test("Telegram invia soltanto la conferma e scarta le vecchie richieste non consegnate", async () => {
  const f = await fixture();
  await f.state.write("outbox/000-legacy.json", {
    id: "000-legacy", kind: "watchlist", text: "Autorizza revisione", buttons: [{ text: "Scarta", callback_data: "wl:no:legacy" }],
  });
  await f.collect();
  const sent: Array<{ url: string; payload: Record<string, unknown> }> = [];
  const channel = new TelegramChannel("0:fake", "42", (async (url: string, init: RequestInit) => {
    sent.push({ url, payload: JSON.parse(String(init.body)) });
    return Response.json({ ok: true });
  }) as typeof fetch);
  await flush(f.state, channel);
  const notices = sent.filter(x => String(x.payload.text).includes("Aggiunto alla watchlist"));
  expect(notices).toHaveLength(1);
  expect(sent.every(x => x.url.endsWith("/sendMessage") && !x.payload.reply_markup)).toBe(true);
  expect(sent.some(x => String(x.payload.text).includes("Autorizza revisione"))).toBe(false);
  expect(await f.state.read("outbox/000-legacy.json")).toBeUndefined();
});
