import type { Candidate, Evidence } from "./discovery-sources";

export const analysisTtl = 60 * 60_000;
export type EvidenceSet = Record<string, Evidence>;

function newsEvidence(sources: EvidenceSet) {
  return JSON.stringify(Object.entries(sources).filter(([id]) => id !== "mercato")
    .map(([, source]) => [source.url, source.source, source.at, source.detail]).sort());
}

export function materialChange(
  cached: { candidate: Candidate; sources: EvidenceSet; analyzedAt: string },
  candidate: Candidate, sources: EvidenceSet, now: Date,
) {
  const age = +now - Date.parse(cached.analyzedAt);
  const { metrics: prior, market } = cached.candidate;
  const current = candidate.metrics;
  const dataAge = +now - Date.parse(current.at);
  if (!(age >= 0 && age < analysisTtl && dataAge >= 0 && dataAge <= 90 * 60_000)) return "validità";
  if (market.source !== candidate.market.source || market.url !== candidate.market.url || candidate.instrument.ticker !== cached.candidate.instrument.ticker) return "fonte";
  if (newsEvidence(cached.sources) !== newsEvidence(sources)) return "notizie";
  if ((prior.setups??[]).join() !== (current.setups??[]).join()) return "setup";
  const direction = Math.sign(prior.dayPct);
  if (Math.sign(current.dayPct) !== direction || Math.sign(current.hourPct) !== Math.sign(prior.hourPct)) return "direzione";
  const invalidated = (price: number) => direction > 0 ? price <= prior.invalidation : price >= prior.invalidation;
  // Usa solo le nuove candele chiuse: un attraversamento seguito da recupero conta.
  const newCandles = candidate.indicators?.intervals["15Min"].candles ?? [];
  if (invalidated(current.lastClose) || newCandles.some(([at, , high, low]) =>
    typeof at === "string" && Date.parse(at) > Date.parse(prior.at) &&
    invalidated(Number(direction > 0 ? low : high)))) return "invalidazione";
  const dailyThreshold = Math.max(0.25, prior.typicalDayPct * 0.5);
  const hourlyThreshold = Math.max(0.15, prior.typicalDayPct * 0.25);
  if (Math.abs(current.dayPct - prior.dayPct) >= dailyThreshold ||
      Math.abs(current.hourPct - prior.hourPct) >= hourlyThreshold ||
      Math.abs(current.relativeMove - prior.relativeMove) >= 0.5) return "movimento";
  const before = prior.volumeMultiple, after = current.volumeMultiple;
  if ((before === null) !== (after === null) ||
      (before !== null && after !== null && Math.abs(before - after) >= Math.max(0.5, before * 0.3))) return "volume";
  return undefined;
}
