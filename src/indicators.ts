import {intradayTime} from "./bar-time";
import type { Series } from "./market";

type Bar = Series["intervals"][string][number];
export type Interval = "15Min" | "1Day";
const duration = { "15Min": 900_000, "1Day": 86400_000 };
export const pct = (from: number, to: number) => 100 * (to / from - 1);
const rounded = (value: number) => Number(value.toPrecision(8));

export function closedCandles(series: Series, interval: Interval, now: Date): Bar[] {
  return (series.intervals[interval] ?? []).filter(bar => {
    const start = Date.parse(bar.t);
    return Number.isFinite(start) && start + duration[interval] <= +now &&
      [bar.o, bar.h, bar.l, bar.c].every(price => Number.isFinite(price) && price > 0);
  });
}

export function relativeVolume(bars: Bar[]) {
  const last = bars.at(-1)?.v;
  const sample = bars.slice(-21, -1).map(bar => bar.v).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (sample.length < 10 || last == null || !Number.isFinite(last) || last <= 0) return null;
  return last / (sample.reduce((total, v) => total + v, 0) / sample.length);
}

export function rsi14(prices: number[]) {
  if (prices.length < 15) return null;
  const changes = prices.slice(1).map((value, i) => value - prices[i]);
  let gain = 0, loss = 0;
  for (const [i, delta] of changes.entries()) {
    const up = Math.max(0, delta), down = Math.max(0, -delta);
    if (i < 14) {
      gain += up / 14;
      loss += down / 14;
    } else {
      gain = (gain * 13 + up) / 14;
      loss = (loss * 13 + down) / 14;
    }
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

function intervalEvidence(series: Series, interval: Interval, now: Date) {
  const bars = closedCandles(series, interval, now);
  const last = bars.at(-1);
  const sample = bars.slice(-20);
  const mean = (count: number) => bars.length < count ? null : rounded(bars.slice(-count).reduce((sum, b) => sum + b.c, 0) / count);
  const rsi = rsi14(bars.map(b => b.c));
  const volume = relativeVolume(bars);
  const lagMinutes = last ? Math.round((+now - Date.parse(last.t) - duration[interval]) / 60_000) : null;
  return {
    ...(last && interval==="15Min" && series.source==="Alpaca IEX" ? {timing:intradayTime(last.t,series.source,now,last.receivedAt)}:{}),
    lastClosed: last?.t ?? null, lagMinutes, feedError: series.intervalErrors?.[interval],
    stale: lagMinutes === null || lagMinutes > (interval === "15Min" ? 75 : 4 * 24 * 60),
    count: bars.length, changePct: bars.length > 1 ? rounded(pct(bars.at(-2)!.c, last!.c)) : null,
    sma5: mean(5), sma20: mean(20), rsi14: rsi === null ? null : rounded(rsi),
    relativeVolume: volume === null ? null : rounded(volume),
    low20: sample.length >= 5 ? Math.min(...sample.map(b => b.l)) : null,
    high20: sample.length >= 5 ? Math.max(...sample.map(b => b.h)) : null,
    candles: bars.slice(interval === "15Min" ? -6 : -4).map(b => [
      b.t, rounded(b.o), rounded(b.h), rounded(b.l), rounded(b.c),
      b.v !== null && Number.isFinite(b.v) ? b.v : null,
    ]),
  };
}

export function marketEvidence(series: Series, now: Date) {
  return {
    symbol: series.symbol, source: series.source, sourceIssue: series.error,
    intervals: { "15Min": intervalEvidence(series, "15Min", now), "1Day": intervalEvidence(series, "1Day", now) },
  };
}

export type MarketEvidence = ReturnType<typeof marketEvidence>;
export const candleFields = ["timestamp", "open", "high", "low", "close", "volume"] as const;
export function chartContext(charts: Series[], now: Date) {
  return { now: now.toISOString(), candleFields, charts: charts.map(series => marketEvidence(series, now)) };
}
