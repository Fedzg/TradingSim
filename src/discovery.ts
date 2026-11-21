import { createHash } from "node:crypto";
import { ask, type Agents, type Role } from "./agents";
import { enqueue } from "./chat";
import { readSeries, trend, type scan, type Candidate, type Evidence, type Instrument } from "./discovery-sources";
import type { Article } from "./market";
import type { State } from "./state";
import { reviewEvidence } from "./discovery-review-source";

type Finding = { verdict: "approve" | "reject"; reason: string; doubt: string; sourceIds: string[] };
type Sources = Record<string, Evidence>;
type Challenge = { newsQuestion: string; chartsQuestion: string; objection: string };
type Proposal = {
  candidate: Candidate; sources: Sources; news: Finding; charts: Finding; status: "pending" | "approved" | "rejected" | "added";
  challenge?: Challenge; newsAnswer?: Finding; chartsAnswer?: Finding; reason?: string; checkedAt?: string; failures?: number;
};
type Registry = {
  proposals?: Record<string, Proposal>;
  scanAt?: string; coverage?: Awaited<ReturnType<typeof scan>>["coverage"];
  watchlist: Record<string, { instrument: Instrument; addedAt: string; notice?: string }>;
};

const path = "watchlist.json";
const registry = async (state: State): Promise<Registry> => await state.read<Registry>(path) ?? { watchlist: {} };
const requestId = (item: Instrument) => createHash("sha256").update(JSON.stringify([item.category, item.venue, item.symbol])).digest("hex").slice(0, 24);
const trim = (text: string) => text.slice(0, 430);

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
  constructor(private state: State, private agents: Agents, private redact: (text: string) => string, private refresh = readSeries, private compare = reviewEvidence) {}

  // Il chiamante serializza le scansioni con discovery.guard.
  async collect(result: Awaited<ReturnType<typeof scan>>, articles: Article[], now: Date) {
    const data = await registry(this.state);
    data.coverage = result.coverage;
    const proposals = data.proposals ??= {};
    const ranked = result.candidates.filter(c => {
      const id = requestId(c.instrument);
      return !data.watchlist[id] && (!proposals[id] || proposals[id].status === "pending");
    })
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
      proposals[id] = { candidate, sources, news: news.value, charts: charts.value, status: "pending" };
    }
    data.scanAt = now.toISOString();
    await this.state.write(path, data);
  }

  async proposals() {
    const data = await registry(this.state);
    return Object.entries(data.proposals ?? {}).filter(([, item]) => item.status !== "added")
      .map(([id, item]) => ({ id, ...item }));
  }

  // Questo comando è eseguito sotto discovery.guard dall’operatore del worker.
  async approve(id: string) {
    const data = await registry(this.state);
    const proposal = data.proposals && Object.hasOwn(data.proposals, id) ? data.proposals[id] : undefined;
    if (!proposal || proposal.status !== "pending") throw new Error("Proposta inesistente o già decisa.");
    proposal.status = "approved";
    await this.state.write(path, data);
  }

  async reviewApproved(now: Date) {
    const data = await registry(this.state);
    const entry = Object.entries(data.proposals ?? {}).find(([, item]) => item.status === "approved");
    if (!entry) return;
    const [id, proposal] = entry;
    try { await this.review(id, proposal, data, now); }
    catch (error) {
      if (proposal.status !== "approved") throw error;
      proposal.failures = (proposal.failures ?? 0) + 1;
      if (proposal.failures >= 3) {
        proposal.status = "rejected";
        proposal.reason = "Revisione indisponibile dopo tre tentativi.";
      }
      await this.state.write(path, data);
      if (proposal.status === "approved") throw error;
    }
  }

  private async review(id: string, proposal: Proposal, data: Registry, now: Date) {
    const save = () => this.state.write(path, data);
    const reject = async (reason: string) => {
      proposal.status = "rejected";
      proposal.reason = this.redact(reason);
      await save();
    };
    const { candidate, sources } = proposal;
    if (proposal.checkedAt && +now - Date.parse(proposal.checkedAt) > 90 * 60_000) {
      return reject("Le prove aggiornate sono scadute durante la revisione.");
    }
    if (!proposal.challenge) {
      const [fresh, independent] = await Promise.all([
        this.refresh(candidate.instrument).then(series => trend(series, now).metrics).catch(() => undefined),
        this.compare(candidate.instrument, now),
      ]);
      if (!fresh || !independent || Math.sign(fresh.dayPct) !== Math.sign(candidate.metrics.dayPct)) {
        return reject("Segnale aggiornato o confronto indipendente insufficienti.");
      }
      sources.aggiornato = { ...candidate.market, at: fresh.at,
        detail: `Giorno ${fresh.dayPct.toFixed(2)}%, ora ${fresh.hourPct.toFixed(2)}%, volume relativo ${fresh.volumeMultiple ?? "non disponibile"}, invalidazione ${fresh.invalidation}.` };
      sources.indipendente = independent;
      proposal.challenge = await ask<Challenge>(this.agents, "discoveryChallenge", { candidate, sources, initial: [proposal.news, proposal.charts] });
      proposal.checkedAt = fresh.at;
      await save();
    }
    const context = { candidate, challenge: proposal.challenge, initial: [proposal.news, proposal.charts] };
    if (!proposal.newsAnswer) {
      proposal.newsAnswer = await find(this.agents, "discoveryNewsAnswer", context, sources);
      await save();
    }
    if (!proposal.chartsAnswer) {
      proposal.chartsAnswer = await find(this.agents, "discoveryChartsAnswer", context, sources, "aggiornato");
      await save();
    }
    const veto = [proposal.newsAnswer, proposal.chartsAnswer].find(answer => answer.verdict === "reject");
    if (veto) return reject(veto.reason);
    const result = await find(this.agents, "discoveryReview", {
      ...context, answers: [proposal.newsAnswer, proposal.chartsAnswer],
    }, sources, "indipendente");
    if (result.verdict === "reject") return reject(result.reason);
    proposal.status = "added";
    proposal.reason = this.redact(trim(result.reason));
    const notice = this.redact([
      `${candidate.instrument.symbol} · ${candidate.instrument.category}`,
      "Aggiunto alla watchlist. Solo monitoraggio.",
      `Motivo finale: ${trim(result.reason)}`,
    ].join("\n"));
    data.watchlist[id] = { instrument: candidate.instrument, addedAt: now.toISOString(), notice };
    await save();
  }

  async publish() {
    const data = await registry(this.state);
    for (const [id, entry] of Object.entries(data.watchlist)) {
      if (entry.notice && data.proposals?.[id]?.status === "added") await enqueue(this.state, id, "watchlist", entry.notice, `${id}/outcome`, "watchlist-addition");
    }
  }

  async status() {
    const { scanAt, coverage } = await registry(this.state);
    return { scanAt, coverage };
  }
}
