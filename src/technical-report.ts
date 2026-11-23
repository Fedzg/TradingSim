import type { Charts } from "./agents";
import { closedCandles, marketEvidence } from "./indicators";
import type { Series } from "./market";

export function technicalDetails(series: Series, idea: Charts["ideas"][number], now: Date) {
  const interval = idea.horizon === "15 minuti" ? "15Min" : "1Day";
  const bars = closedCandles(series, interval, now);
  const last = bars.at(-1);
  const prior = bars.slice(-21, -1);
  const levels = prior.length >= 5 ? {
    support: Math.min(...prior.map(bar => bar.l)),
    resistance: Math.max(...prior.map(bar => bar.h)),
  } : undefined;
  const recent = last && +now - Date.parse(last.t) <= (interval === "15Min" ? 45 * 60_000 : 5 * 86400_000);
  const intraday = closedCandles(series, "15Min", now).at(-1);
  const daily = closedCandles(series, "1Day", now).at(-1);
  const intradayClose = intraday && new Date(Date.parse(intraday.t) + 900_000);
  const useIntraday = intradayClose && (!daily || +intradayClose > Date.parse(daily.t) + 86400_000);
  const price = useIntraday ? `Chiusura 15 min ${intraday!.c} · ${series.source} · ${intradayClose.toISOString()}` :
    daily ? `Chiusura giornaliera ${daily.c} · ${series.source} · ${daily.t} (timestamp candela)` : "Prezzo non disponibile";
  const { sma5, sma20 } = marketEvidence(series, now).intervals[interval];
  const spread = sma5 === null || sma20 === null ? null : sma5 / sma20 - 1;
  const trend = spread === null ? "non verificabile" : spread > 0.001 ? "rialzista" : spread < -0.001 ? "ribassista" : "laterale";
  const base = `${series.symbol} (${idea.horizon}) · trend ${trend} · ${price}`;
  if (!last || !levels) return { short: base + " · livelli non verificabili", full: base + ". Dati insufficienti per livelli e conferma." };
  const bearish = idea.bias === "ribassista";
  const confirmation = bearish ? `chiusura sotto il supporto ${levels.support}` : `chiusura sopra la resistenza ${levels.resistance}`;
  const invalidation = bearish ? `chiusura sopra la resistenza ${levels.resistance}` : `chiusura sotto il supporto ${levels.support}`;
  const confirmed = bearish ? last.c < levels.support : last.c > levels.resistance;
  const reason = !recent ? "dato datato per confermare il segnale" : confirmed ?
    "livello superato alla chiusura della candela" : bearish ? "supporto non rotto" : "rottura della resistenza non confermata";
  return {
    short: `${base} · ${reason}. Attesa: ${confirmation}.`,
    full: `${base}. Supporto ${levels.support}, resistenza ${levels.resistance}. ${reason}. Conferma: ${confirmation}. Invalidazione: ${invalidation}.`,
  };
}
