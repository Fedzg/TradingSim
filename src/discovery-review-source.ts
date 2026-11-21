import type { Evidence, Instrument } from "./discovery-sources";

const stooq: Record<string, [string, string]> = {
  AMD: ["amd.us", "AMD Nasdaq"], TSLA: ["tsla.us", "TSLA Nasdaq"],
  "EUR/USD": ["eurusd", "EUR/USD spot"], "USD/JPY": ["usdjpy", "USD/JPY spot"],
  "GC=F": ["xauusd", "Oro spot, confronto con il front-month. Non è lo stesso contratto."],
  SPX500_USD: ["^spx", "Indice S&P 500. Solo sottostante, non quotazione CFD."],
};

export async function reviewEvidence(item: Instrument, now: Date): Promise<Evidence | undefined> {
  const crypto = item.symbol === "BTC-USD" || item.symbol === "ETH-USD";
  const comparison = Object.hasOwn(stooq, item.symbol) ? stooq[item.symbol] : undefined;
  if (!crypto && !comparison) return;
  const url = crypto ? `https://api.exchange.coinbase.com/products/${item.symbol}/candles?granularity=900` :
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(comparison![0])}&i=d&d1=${new Date(+now - 14 * 86400_000).toISOString().slice(0, 10).replaceAll("-", "")}`;
  const change = (last: number, first: number) => (100 * (last / first - 1)).toFixed(2);
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    if (crypto) {
      const bars = (await response.json() as number[][]).filter(row => row[0] * 1000 + 900_000 <= +now).slice(0, 5);
      if (bars.length !== 5 || bars.some((row, i) => !Number.isFinite(row[4]) || row[4] <= 0 ||
          (i > 0 && bars[i - 1][0] - row[0] !== 900))) return;
      if (+now - bars[0][0] * 1000 > 90 * 60_000) return;
      return { url, source: "Coinbase Exchange", at: new Date(bars[0][0] * 1000).toISOString(),
        detail: `${item.symbol} spot, 60 minuti ${change(bars[0][4], bars[4][4])}%.` };
    }
    const rows = (await response.text()).trim().split(/\r?\n/).slice(-2).map(row => row.split(","));
    if (rows.length !== 2 || rows.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row[0]) || !(Number(row[4]) > 0))) return;
    const [prior, last] = rows;
    const age = +now - Date.parse(last[0]);
    if (!(age >= 0 && age <= 4 * 86400_000)) return;
    return { url, source: "Stooq", at: last[0], detail: `${comparison![1]} Variazione di seduta ${change(Number(last[4]), Number(prior[4]))}%. La fonte fornisce la data, senza orario.` };
  } catch { return; }
}
