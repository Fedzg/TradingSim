import { createHash } from "node:crypto";
import { ask, type Agents, type Role } from "./agents";
import { enqueue } from "./chat";
import type { scan, Candidate, Evidence, Instrument } from "./discovery-sources";
import type { Article } from "./market";
import type { State } from "./state";
import { rome } from "./time";

type Finding = { verdict: "approve" | "reject"; reason: string; doubt: string; sourceIds: string[] };
type Sources = Record<string, Evidence>;
type Registry = {
  scanAt?: string; coverage?: Awaited<ReturnType<typeof scan>>["coverage"];
  watchlist: Record<string, { instrument: Instrument; addedAt: string; notice?: string }>;
};

const path = "watchlist.json";
const registry = async (state: State): Promise<Registry> => await state.read<Registry>(path) ?? { watchlist: {} };
const requestId = (item: Instrument) => createHash("sha256").update(JSON.stringify([item.category, item.venue, item.symbol])).digest("hex").slice(0, 24);
const trim = (text: string) => text.slice(0, 430);
const sourceLine = (source: Evidence) => `${source.source} · ${source.at} · ${source.url}`;
const evidenceLinks = (sources: Sources, ids: string[]) => [...new Set(ids)].filter(id => Object.hasOwn(sources, id)).map(id => sourceLine(sources[id])).join("\n");

export async function savedWatchlist(state: State) {
  return Object.values((await registry(state)).watchlist).map(entry => entry.instrument);
}

function sourcesFor(candidate: Candidate, articles: Article[], now: Date): Sources {
  const item = candidate.instrument;
  const recent = articles.filter(article => {
    const age = +now - Date.parse(article.published);
    return (article.symbols.includes(item.ticker) || article.symbols.includes(item.symbol)) &&
      /^https:\/\//.test(article.link) && age >= 0 && age <= 36 * 3600_000;
  }).slice(0, 4);
  return { mercato: candidate.market, ...Object.fromEntries(recent.map((article, index) => [
    `notizia-${index + 1}`, { url: article.link, source: article.source, at: article.published, detail: `${article.title} · ${article.summary}` },
  ])) };
}

async function find(agents: Agents, role: Role, input: object, sources: Sources, required?: string): Promise<Finding> {
  const result = await ask<Finding>(agents, role, { ...input, sources });
  if ((result.verdict === "approve" && !result.sourceIds.length) ||
      result.sourceIds.some(id => !Object.hasOwn(sources, id)) ||
      (result.verdict === "approve" && required !== undefined && !result.sourceIds.includes(required))) {
    return { verdict: "reject", reason: "Le prove citate non sono verificabili nel fascicolo.", doubt: "Fonti insufficienti.", sourceIds: [] };
  }
  return result;
}

export class Discovery {
  constructor(private state: State, private agents: Agents, private redact: (text: string) => string) {}

  // Il chiamante serializza le scansioni con discovery.guard.
  async collect(result: Awaited<ReturnType<typeof scan>>, articles: Article[], now: Date) {
    const data = await registry(this.state);
    data.coverage = result.coverage;
    const ranked = result.candidates.filter(c => !data.watchlist[requestId(c.instrument)])
      .sort((a, b) => b.metrics.relativeMove - a.metrics.relativeMove);
    const scanned = new Set<Instrument["category"]>();
    for (const candidate of ranked) {
      if (scanned.has(candidate.instrument.category)) continue;
      scanned.add(candidate.instrument.category);
      const id = requestId(candidate.instrument);
      const sources = sourcesFor(candidate, articles, now);
      const context = { candidate, now: now.toISOString() };
      const [news, charts] = await Promise.allSettled([
        find(this.agents, "discoveryNews", context, sources),
        find(this.agents, "discoveryCharts", context, sources, "mercato"),
      ]);
      if (news.status === "rejected" || charts.status === "rejected") {
        const coverage = data.coverage.find(item => item.category === candidate.instrument.category);
        coverage?.notes.push(`${candidate.instrument.symbol}: almeno un analista non ha restituito una verifica valida.`);
        continue;
      }
      if (news.value.verdict !== "approve" || charts.value.verdict !== "approve") continue;
      const { instrument, market } = candidate;
      const notice = [
        `${instrument.symbol} · ${instrument.category} · ${instrument.venue}`, instrument.series,
        "Aggiunto alla watchlist. Solo monitoraggio.", market.detail, `Dato: ${market.at}`,
        `Analista notizie: ${trim(news.value.reason)}`, `Analista grafici: ${trim(charts.value.reason)}`,
        `Dubbio: ${trim(charts.value.doubt)} / ${trim(news.value.doubt)}`,
        evidenceLinks(sources, ["mercato", ...news.value.sourceIds, ...charts.value.sourceIds]), instrument.providerUrl,
      ].filter(Boolean).join("\n");
      data.watchlist[id] = { instrument, addedAt: now.toISOString(), notice: this.redact(notice) };
      await this.state.write(path, data);
    }
    data.scanAt = now.toISOString();
    await this.state.write(path, data);
    await this.publish();
  }

  async publish() {
    const data = await registry(this.state);
    if (data.scanAt && data.coverage) {
      const { date } = rome(new Date(data.scanAt));
      const text = ["Copertura delle fonti per la scoperta dei mercati",
        ...data.coverage.map(item => `${item.category}: ${item.usable}/${item.total} strumenti con dati utilizzabili${item.notes.length ? ". " + item.notes.join(" ") : "."}`),
      ].join("\n");
      await enqueue(this.state, date, "watchlist", this.redact(text), `coverage/${date}/${text}`);
    }
    for (const [id, entry] of Object.entries(data.watchlist)) {
      if (entry.notice) await enqueue(this.state, id, "watchlist", entry.notice, `${id}/outcome`);
    }
  }

  async status() {
    const { scanAt, coverage } = await registry(this.state);
    return { scanAt, coverage };
  }
}
