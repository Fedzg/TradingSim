import { equities, sourceOf } from "./monitor-feeds";
import { closedCandles, marketEvidence, pct, relativeVolume, type MarketEvidence } from "./indicators";
import { yahoo, type Series } from "./market";

export const categories = ["azioni", "forex", "futures", "crypto", "CFD"] as const;
type Category = typeof categories[number];
export type Instrument = { symbol: string; category: Category; venue: string; ticker: string; series?: string; providerUrl?: string };
export const catalog: readonly Instrument[] = [
  { symbol: "AMD", category: "azioni", venue: "Nasdaq", ticker: "AMD" },
  { symbol: "TSLA", category: "azioni", venue: "Nasdaq", ticker: "TSLA" },
  { symbol: "EUR/USD", category: "forex", venue: "Spot OTC", ticker: "EURUSD=X" },
  { symbol: "USD/JPY", category: "forex", venue: "Spot OTC", ticker: "JPY=X" },
  { symbol: "GC=F", category: "futures", venue: "COMEX", ticker: "GC=F", series: "Yahoo Gold Futures, serie front-month." },
  { symbol: "BTC-USD", category: "crypto", venue: "Alpaca Crypto US", ticker: "BTC/USD" },
  { symbol: "ETH-USD", category: "crypto", venue: "Alpaca Crypto US", ticker: "ETH/USD" },
  { symbol: "SPX500_USD", category: "CFD", venue: "OANDA v20, US SPX 500 CFD", ticker: "^GSPC", series: "Solo sottostante S&P 500 (^GSPC). Quotazioni, spread e disponibilità del CFD OANDA non verificati.",
    providerUrl: "https://www.oanda.com/uk-en/trading/instruments/us-spx-500/" },
  ...equities.filter(s=>s!=="AMD" && s!=="TSLA").map(symbol=>({symbol,category:"azioni" as const,venue:"US equity",ticker:symbol})),
  { symbol: "GBP/USD", category:"forex", venue:"Spot OTC", ticker:"GBPUSD=X" },
];

export type Evidence = { url: string; source: string; at: string; detail: string };
export type Candidate = { instrument: Instrument; market: Evidence; metrics: Trend; indicators?: MarketEvidence };
type Trend = { dayPct: number; hourPct: number; typicalDayPct: number; relativeMove: number; volumeMultiple: number | null; lastClose: number; invalidation: number; at: string };
const hour = 3600_000;

export function trend(series: Series, now: Date): { metrics?: Trend; problem?: string } {
  const daily = closedCandles(series, "1Day", now);
  const intra = closedCandles(series, "15Min", now);
  const last = intra.at(-1);
  if (daily.length < 16 || intra.length < 5 || !last) return { problem: "Servono almeno 16 sedute e 5 candele a 15 minuti." };
  const age = +now - Date.parse(last.t);
  if (age < 0 || age > 90 * 60_000 || intra.slice(-5).slice(1).some((bar, i) => Date.parse(bar.t) - Date.parse(intra.at(-5 + i)!.t) !== 15 * 60_000)) return { problem: "Candele a 15 minuti vecchie o discontinue." };
  const days = daily.slice(-21);
  if (+now - Date.parse(days.at(-1)!.t) > 5 * 24 * hour) return { problem: "Serie giornaliera non recente." };
  const moves = days.slice(1).map((bar, i) => Math.abs(pct(days[i].c, bar.c))).sort((a, b) => a - b);
  const typicalDayPct = moves[Math.floor(moves.length / 2)];
  if (!(typicalDayPct > 0)) return { problem: "Volatilità storica non misurabile." };
  const dayPct = pct(days.at(-1)!.c, last.c);
  const hourPct = pct(intra.at(-5)!.c, last.c);
  const relativeMove = Math.abs(dayPct) / typicalDayPct;
  if (relativeMove < 1.5 || Math.abs(hourPct) < typicalDayPct * 0.2 || Math.sign(dayPct) !== Math.sign(hourPct)) return {};
  const volumeMultiple = relativeVolume(intra);
  return { metrics: { dayPct, hourPct, typicalDayPct, relativeMove, volumeMultiple, lastClose: last.c,
    invalidation: intra.at(-5)!.c, at: last.t } };
}

export const quoteUrl = (ticker: string) => `https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`;
export async function readSeries(instrument: Instrument): Promise<Series> {
  const [intra, daily] = await Promise.all([yahoo(instrument.ticker, "5d", "15m"), yahoo(instrument.ticker, "3mo", "1d")]);
  return { symbol: instrument.symbol, source: `Yahoo Finance ${instrument.ticker}${instrument.series ? " · " + instrument.series : ""}`,
    updated: intra.at(-1)?.t ?? null, intervals: { "15Min": intra.slice(-30), "1Day": daily.slice(-30) } };
}

export async function scan(now: Date, load = readSeries) {
  const observations = await Promise.all(catalog.map(async instrument => {
    try {
      const series = await load(instrument);
      const signal = series.error ? { problem:series.error } : trend(series, now);
      return { instrument, source:series.source, ...signal, indicators: signal.metrics ? marketEvidence(series, now) : undefined };
    } catch { return { instrument, problem: "Fonte dati non raggiungibile o non valida." }; }
  }));
  const candidates = observations.flatMap(({ instrument, metrics, indicators, source }) => metrics ? [{
    instrument, metrics, indicators, market: { url: source?.startsWith("Alpaca") ? "https://docs.alpaca.markets/docs/market-data" : source?.startsWith("Twelve Data") ? "https://api.twelvedata.com/time_series?symbol="+encodeURIComponent(instrument.symbol)+"&interval=15min" : quoteUrl(instrument.ticker), source: source ?? sourceOf(instrument.symbol), at: metrics.at,
      detail: `Movimento giornaliero ${metrics.dayPct.toFixed(2)}%, ${metrics.relativeMove.toFixed(2)}× la volatilità tipica; 60 minuti ${metrics.hourPct.toFixed(2)}%. Volume ${metrics.volumeMultiple?.toFixed(2) ?? "non disponibile"}${metrics.volumeMultiple === null ? "" : "×"}.` },
  }] : []);
  return { candidates, coverage: categories.map(category => {
    const entries = observations.filter(item => item.instrument.category === category);
    return { category, usable: entries.filter(item => !item.problem).length, total: entries.length,
      notes: entries.flatMap(item => item.problem ? [`${item.instrument.symbol}: ${item.problem}`] : []) };
  }) };
}
