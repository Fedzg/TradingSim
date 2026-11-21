import { closedCandles } from "./indicators";
import type { Charts } from "./agents";
import { universe } from "./broker";
import type { Series } from "./market";

const formats = {
  "15 minuti": new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Rome" }),
  giornaliero: new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeZone: "Europe/Rome" }),
};
const price = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 5 });

export function chartScenarios(analysis: Charts, charts: Series[], now: Date) {
  const seen = new Set<string>();
  const sections: string[] = [];
  for (const idea of analysis.ideas) {
    const key = `${idea.symbol}/${idea.horizon}`;
    if (idea.bias === "laterale" || seen.has(key)) continue;
    const series = charts.find(x => x.symbol === idea.symbol);
    const bars = series && closedCandles(series, idea.horizon === "15 minuti" ? "15Min" : "1Day", now);
    const last = bars?.at(-1);
    if (!series || !bars || bars.length < 15 || !last || !Number.isFinite(last.c)) continue;
    const time = Date.parse(last.t);
    const age = +now - time;
    if (!Number.isFinite(time) || age < 0 || age > 96 * 3_600_000) continue;
    seen.add(key);
    const movement = idea.bias === "rialzista" ? "↑ Possibile rialzo" : "↓ Possibile ribasso";
    const watch = universe.some(symbol => symbol === idea.symbol) ? "" : " · solo monitoraggio";
    sections.push([
      `${movement} — ${idea.symbol} (${idea.horizon})${watch}`,
      `Motivo: ${idea.evidence.slice(0, 550)}`,
      `Invalidazione: ${idea.invalidation.slice(0, 240)}`,
      `Incertezza: ${idea.uncertainty.slice(0, 240)}`,
      `Chiusura ultima candela disponibile: ${price.format(last.c)} · ${formats[idea.horizon].format(time)} (Roma) · ${series.source}`,
    ].join("\n"));
  }
  if (!sections.length) return undefined;
  return ["Scenari tecnici basati sulle ultime candele disponibili. L’esito è incerto.", ...sections].join("\n\n");
}
