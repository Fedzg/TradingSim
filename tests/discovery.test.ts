import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agents, Role } from "../src/agents";
import { FakeBroker, universe } from "../src/broker";
import { enqueue, type Message } from "../src/chat";
import { Discovery, savedWatchlist } from "../src/discovery";
import { catalog, scan, trend, type Candidate } from "../src/discovery-sources";
import { flushNotifications } from "../src/notifications";
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

async function fixture(options: { veto?: Role; fail?: Role; invalidSource?: Role; missingIndependent?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tradingsim-discovery-"));
  roots.push(root);
  const state = new State(root);
  const calls: Role[] = [];
  const agents: Agents = { async invoke(role) {
    calls.push(role);
    if (role === options.fail) throw new Error("Interruzione simulata");
    if (role === "discoveryChallenge") return { newsQuestion: "Quali notizie?", chartsQuestion: "Quali dati?", objection: "Movimento momentaneo?" };
    return { verdict: role === options.veto ? "reject" : "approve", reason: "Conferma del movimento su due fonti.", doubt: "Volume ridotto.",
      sourceIds: [role === options.invalidSource ? "inesistente" : role === "discoveryReview" ? "indipendente" :
        role === "discoveryChartsAnswer" ? "aggiornato" : "mercato"] };
  } };
  const engine = () => new Discovery(new State(root), agents, x => x, async () => series("AMD"),
    async () => options.missingIndependent ? undefined : { url: "https://example.com/seconda", source: "Seconda fonte", at: now.toISOString(), detail: "Prezzo coerente." });
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

test("due conferme preparano una proposta locale e l’aggiunta richiede permesso e revisore", async () => {
  const f = await fixture();
  await f.collect();
  const proposal = (await f.engine().proposals())[0];
  expect(proposal.status).toBe("pending");
  await f.engine().reviewApproved(now);
  await f.engine().publish();
  expect(f.calls).toEqual(["discoveryNews", "discoveryCharts"]);
  expect(await f.messages()).toEqual([]);
  expect(await savedWatchlist(f.state)).toEqual([]);

  await f.engine().approve(proposal.id);
  await expect(f.engine().approve(proposal.id)).rejects.toThrow("già decisa");
  await f.engine().publish();
  expect(await f.messages()).toEqual([]);
  await f.engine().reviewApproved(now);
  expect((await savedWatchlist(f.state)).map(x => x.symbol)).toEqual(["AMD"]);
  expect(await f.messages()).toEqual([]); // Interruzione simulata tra salvataggio e coda.

  // Un nuovo processo logico riapre lo stato, ricrea una sola notifica.
  await f.engine().reviewApproved(now);
  await f.engine().publish();
  await f.engine().publish();
  expect(f.calls.slice(2)).toEqual(["discoveryChallenge", "discoveryNewsAnswer", "discoveryChartsAnswer", "discoveryReview"]);
  const messages = (await f.messages()).filter(x => x.text.includes("Aggiunto alla watchlist"));
  expect(messages).toHaveLength(1);
  expect(messages[0].text).toContain("Motivo finale: Conferma del movimento su due fonti.");

  const broker = new FakeBroker(f.state);
  const snapshot = await broker.snapshot();
  expect(universe).not.toContain("AMD");
  expect(risk({ symbol: "AMD", side: "buy", qty: 1, reason: "Prova" }, 100, snapshot, wake("2026-09-24", "15:40"))).toContain("fuori");
  expect(await broker.orders()).toEqual([]);
});

test("un veto indipendente o una fonte mancante non aggiungono e non inviano", async () => {
  for (const options of [{ veto: "discoveryReview" }, { missingIndependent: true }] as const) {
    const f = await fixture(options);
    await f.collect();
    await f.engine().approve((await f.engine().proposals())[0].id);
    await f.engine().reviewApproved(now);
    await f.engine().publish();
    expect((await f.engine().proposals())[0].status).toBe("rejected");
    expect(await savedWatchlist(f.state)).toEqual([]);
    expect(await f.messages()).toEqual([]);
  }
});

test("Telegram consegna una sola aggiunta salvata e conserva la copertura e i vecchi riepiloghi locali", async () => {
  const f = await fixture();
  await enqueue(f.state, "test", "watchlist", "Vecchio riepilogo di copertura");
  await enqueue(f.state, "test", "resoconto", "Briefing");
  await f.collect();
  const sent: string[] = [];
  const channel = () => new TelegramChannel("0:fake", "42", (async (url: string, init: RequestInit) => {
    expect(url).toEndWith("/sendMessage");
    sent.push(JSON.parse(String(init.body)).text);
    return Response.json({ ok: true });
  }) as typeof fetch);
  await flushNotifications(f.state, channel(), x => x);
  expect(sent).toEqual([]);
  await f.engine().approve((await f.engine().proposals())[0].id);
  await f.engine().reviewApproved(now);
  await f.engine().publish();
  await flushNotifications(f.state, channel(), x => x);
  await f.collect(); // Riparte dallo stato persistito, senza ricreare la proposta o l’aggiunta.
  await f.engine().publish();
  await flushNotifications(new State(f.state.root), channel(), x => x);
  expect(sent).toHaveLength(1);
  expect(await savedWatchlist(f.state)).toHaveLength(1);
  expect(await f.engine().proposals()).toEqual([]);
  expect(sent[0]).toContain("Aggiunto alla watchlist");
  expect(sent[0]).toContain("Motivo finale");
  expect((await f.messages()).filter(message => !message.delivered)).toHaveLength(2);
});
