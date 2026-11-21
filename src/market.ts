import { universe, watched } from "./broker";
import { McpError, payload, type Mcp } from "./mcp";
import type { State } from "./state";

type Candle = { t: string; o: number; h: number; l: number; c: number; v: number | null };
export type Series = { symbol: string; source: string; updated: string | null; error?: string; intervals: Record<string, Candle[]> };
export type Article = { title: string; link: string; source: string; published: string; symbols: string[]; summary: string };
export type News = { lastSuccess: string | null; checked: string; error?: string; articles: Article[] };

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Fonte grafici: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function yahoo(symbol: string, range: string, interval: string): Promise<Candle[]> {
  type Quote = Record<"open" | "high" | "low" | "close" | "volume", (number | null)[]>;
  const data = await json<{ chart: { result: { meta?: { symbol?: string }; timestamp: number[]; indicators: { quote: Quote[] } }[] } }>(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
  );
  const result = data.chart.result?.[0];
  if (!result || (result.meta?.symbol && result.meta.symbol.toUpperCase() !== symbol.toUpperCase())) throw new Error("Serie assente o simbolo non corrispondente.");
  const q = result.indicators.quote[0];
  return result.timestamp.flatMap((stamp, i) => {
    const [o, h, l, c, v] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume?.[i] ?? null];
    return o === null || h === null || l === null || c === null ? [] : [{ t: new Date(stamp * 1000).toISOString(), o, h, l, c, v }];
  });
}

export function fakeCharts(now: Date): Series[] {
  return watched.map(symbol => {
    const build = (duration: number) => Array.from({ length: 24 }, (_, i) => ({
      t: new Date(+now - (24 - i) * duration).toISOString(), o: 96 + i / 10, h: 101, l: 95, c: 100, v: 1000,
    }));
    return { symbol, source: symbol === "USOIL" ? "Finto, replica CL=F" : "Finto", updated: new Date(+now - 900_000).toISOString(), intervals: { "15Min": build(900_000), "1Day": build(86400_000) } };
  });
}

export class Market {
  constructor(private mcp: Mcp | undefined, private fake: boolean, private watchlist?: () => Promise<Series[]>) {}

  async charts(now: Date): Promise<Series[]> {
    if (this.fake) return fakeCharts(now);
    const stocks = Promise.all(["15Min", "1Day"].map(async interval => {
      const since = new Date(+now - (interval === "15Min" ? 5 : 75) * 86400_000).toISOString();
      type Bar = Omit<Candle, "v"> & { v: number };
      return payload<{ bars: Record<string, Bar[]> }>(this.mcp!, "get_stock_bars", {
        symbols: universe.join(","), timeframe: interval, feed: "iex", start: since, limit: 10000,
      });
    }));
    const extras = Promise.all([["USOIL", "CL=F"], ["GBP/USD", "GBPUSD=X"]].map(async ([symbol, ticker]) => {
      const source = `Yahoo Finance ${ticker}` + (symbol === "USOIL" ? ", futures NYMEX WTI front-month continuo" : "");
      const results = await Promise.allSettled([yahoo(ticker, "5d", "15m"), yahoo(ticker, "3mo", "1d")]);
      const bars = results.map(r => r.status === "fulfilled" ? r.value.slice(-48) : []);
      return { symbol, source, updated: bars[0].at(-1)?.t ?? bars[1].at(-1)?.t ?? null,
        error: bars.some(b => b.length < 15) ? "Dati parziali o fonte indisponibile" : undefined,
        intervals: { "15Min": bars[0], "1Day": bars[1] } };
    }));
    const [results, other, discovered] = await Promise.all([stocks.then(value => ({ value, error: undefined })).catch(() => ({ value: undefined, error: "Dati Alpaca IEX indisponibili" })), extras, this.watchlist?.() ?? []]);
    return [...universe.map(symbol => {
      const intra = results.value?.[0].bars?.[symbol]?.slice(-48) ?? [];
      const daily = results.value?.[1].bars?.[symbol]?.slice(-48) ?? [];
      return { symbol, source: "Alpaca IEX", updated: intra.at(-1)?.t ?? daily.at(-1)?.t ?? null,
        error: results.error ?? (intra.length < 15 || daily.length < 15 ? "Dati insufficienti" : undefined),
        intervals: { "15Min": intra, "1Day": daily } };
    }), ...other, ...discovered];
  }

  async poll(state: State, now = new Date()): Promise<News> {
    const previous = await this.cachedNews(state);
    const checked = now.toISOString();
    let next: News;
    try {
      const articles = this.fake ? [{
        title: "Dati macro di prova per WTI e GBP/USD", link: "https://example.com/mercati",
        source: "Fonte finta", published: checked, symbols: ["USOIL", "GBP/USD"], summary: "Esempio deterministico.",
      }] : await this.alpacaNews(now);
      const merged = new Map([...previous.articles, ...articles].map(x => [x.link, x]));
      next = { checked, lastSuccess: checked, articles: [...merged.values()]
        .filter(article => Date.parse(article.published) >= +now - 48 * 3600_000)
        .sort((a, b) => b.published.localeCompare(a.published)).slice(0, 200) };
    } catch (error) {
      next = { ...previous, checked, error: error instanceof McpError ? error.message : "Fonte Alpaca News indisponibile." };
    }
    await state.write("news.json", next);
    return next;
  }

  async cachedNews(state: State): Promise<News> {
    return await state.read<News>("news.json") ?? { lastSuccess: null, checked: "", articles: [] };
  }

  private async alpacaNews(now: Date): Promise<Article[]> {

    type Entry = { headline: string; url: string; source: string; created_at: string; symbols: string[]; summary: string };
    const { news } = await payload<{ news: Entry[] }>(this.mcp!, "get_news", {
      start: new Date(+now - 48 * 3600_000).toISOString(), limit: 50, sort: "desc",
    });
    return news.filter(x => /^https:\/\//.test(x.url)).map(x => ({
      title: x.headline.slice(0, 300), link: x.url, source: x.source, published: x.created_at,
      symbols: x.symbols, summary: (x.summary || "").slice(0, 600),
    }));
  }
}

export function miniChart(series: Series, interval: string) {
  const closes = series.intervals[interval]?.slice(-24).map(bar => bar.c).filter(Number.isFinite) ?? [];
  if (closes.length < 2) return;
  const low = Math.min(...closes);
  const high = Math.max(...closes);
  const glyphs = "▁▂▃▄▅▆▇█";
  const graph = closes.map(price => glyphs[high === low ? 3 : Math.round(7 * (price - low) / (high - low))]).join("");
  const show = (number: number) => number.toLocaleString("it-IT", { maximumFractionDigits: 4 });
  return `${interval} ${graph} (min ${show(low)}, max ${show(high)}, ultimo ${show(closes.at(-1)!)})`;
}
