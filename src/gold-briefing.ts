import { enqueue, outboxId } from "./chat";
import { verifyEvents } from "./event-news";
import type { NewsAnalysis } from "./agents";
import { pct, rsi14 } from "./indicators";
import { yahoo, type News, type Series } from "./market";
import type { State } from "./state";
import { rome } from "./time";

const instruments = [
  ["GOLD","XAU/USD","Spot OTC","XAUUSD=X"], ["GOLD","Gold CFD","CFD broker",""],
  ["GOLD","GC","COMEX","GC","CMX"], ["GOLD","MGC","COMEX","MGC","CMX"],
  ["MATERIE PRIME","XAG/USD","Spot OTC","XAGUSD=X"], ["MATERIE PRIME","WTI CL","NYMEX","CL","NYM"],
  ["MATERIE PRIME","WTI MCL","NYMEX","MCL","NYM"], ["MATERIE PRIME","Brent BZ","NYMEX","BZ","NYM"],
  ["FOREX E MACRO","EUR/USD","Spot OTC","EURUSD=X"], ["FOREX E MACRO","GBP/USD","Spot OTC","GBPUSD=X"],
  ["FOREX E MACRO","DXY","Indice dollaro ICE","DX-Y.NYB"], ["FOREX E MACRO","Treasury USA 10Y","Rendimento %","^TNX"],
] as const;

type Quote = { symbol: string; regularMarketPrice: number; regularMarketTime: number; regularMarketVolume?: number;
  regularMarketPreviousClose?: number; regularMarketVwap?: number; regularMarketDayHigh?: number; regularMarketDayLow?: number;
  exchangeDataDelayedBy?: number; marketState?: string; expireDate?: number; currency?: string };
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const fmt = (v: number) => Number(v.toPrecision(6)).toLocaleString("it-IT", { maximumFractionDigits: 6 });
const months = "FGHJKMNQUVXZ";
function contracts(root: string, exchange: string, now: Date) {
  return Array.from({ length: 8 }, (_, i) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    return root + months[date.getUTCMonth()] + String(date.getUTCFullYear()).slice(-2) + "." + exchange;
  });
}
export function activeContract(quotes: Quote[], now: Date) {
  return quotes.filter(q => positive(q.expireDate) && q.expireDate * 1000 > +now && positive(q.regularMarketVolume)
    && positive(q.regularMarketPrice) && positive(q.regularMarketTime) && q.regularMarketTime * 1000 <= +now
    && +now - q.regularMarketTime * 1000 < 4 * 86400_000)
    .sort((a,b) => b.regularMarketVolume! - a.regularMarketVolume! || a.expireDate! - b.expireDate!)[0];
}
async function readQuotes(symbols: string[]): Promise<Quote[]> {
  const res = await fetch("https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(symbols.join(",")),
    { redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("Feed quotazioni non disponibile");
  const data = await res.json();
  return data.quoteResponse.result.filter((q: Quote) => symbols.includes(q.symbol));
}

// The chart endpoint can supply a timestamped indicative quote when the batch feed is unavailable.
async function chartQuote(symbol: string): Promise<Quote | undefined> {
  const response = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol)+"?range=1d&interval=15m", {
    redirect: "error", signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return;
  const meta = (await response.json()).chart?.result?.[0]?.meta;
  if (meta?.symbol !== symbol) return;
  return { ...meta, regularMarketPreviousClose: meta.previousClose ?? meta.chartPreviousClose };
}

type Bar = Series["intervals"][string][number];
export function technical(bars: Bar[], minutes: number, now: Date) {
  const duration = minutes * 60_000;
  const clean = bars.filter(b => [b.c,b.l,b.h,b.o].every(positive) && b.h >= Math.max(b.o,b.c,b.l) &&
    b.l <= Math.min(b.o,b.c) && Date.parse(b.t) + duration <= +now);
  const last = clean.at(-1);
  if (!last || +now - Date.parse(last.t) > (minutes === 1440 ? 5 * 86400_000 : duration * 3) ||
      clean.length < 21 || clean.some((b,i) => i > 0 && b.t <= clean[i-1].t)) return;
  const window = clean.slice(-21,-1);
  const high = Math.max(...window.map(b => b.h)), low = Math.min(...window.map(b => b.l));
  const closes = clean.map(b => b.c);
  const sma = (n: number) => closes.slice(-n).reduce((a,b) => a+b,0)/n;
  const ranges = clean.slice(1).map((b,i) => Math.max(b.h-b.l, Math.abs(b.h-clean[i].c), Math.abs(b.l-clean[i].c)));
  let atr = ranges.slice(0,14).reduce((a,b) => a+b,0)/14;
  for (const value of ranges.slice(14)) atr = (13*atr+value)/14;
  const previous = clean.at(-2)!;
  const prior = clean.slice(-22,-2);
  const reversal = prior.length === 20 && ((previous.c > Math.max(...prior.map(b=>b.h)) && last.c < previous.l) ||
    (previous.c < Math.min(...prior.map(b=>b.l)) && last.c > previous.h));
  const signal = last.c > high ? "breakout rialzista" : last.c < low ? "breakout ribassista" :
    reversal ? "possibile inversione" : last.h > high || last.l < low ? "possibile falsa rottura" : "nel range";
  return { high, low, signal, atr, rsi: rsi14(closes)!, fast: sma(5), slow: sma(20) };
}

const macro = /\b(gold|silver|bullion|crude|oil|opec|federal reserve|fed|inflation|cpi|payrolls?|employment|dollar|treasury|central bank|geopolitic\w*|sanctions?|ceasefire|oil inventories)\b/i;
async function headlines(state: State, now: Date) {
  const news = await state.read<News>("news.json");
  if (!news || news.error || !news.lastSuccess || !(+now-Date.parse(news.lastSuccess) <= 30*60_000)) return ["Cache notizie non verificabile."];
  const articles = news.articles.filter(a => macro.test(a.title+" "+a.summary) && /^https:\/\//.test(a.link) &&
    Date.parse(a.published) <= +now && +now-Date.parse(a.published) <= 48*3600_000);
  const cache = await state.read<{ analysis: NewsAnalysis }>("wake-news-analysis.json");
  const events = verifyEvents(cache?.analysis.events ?? [], articles, [], now);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const a of articles) {
    const identity = a.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
    if (seen.has(identity)) continue;
    seen.add(identity);
    const verified = events.find(e => e.link === a.link);
    if (!verified && cache?.analysis.events.some(e => e.link === a.link && events.some(v => v.subject === e.subject && v.eventType === e.eventType && v.effectiveDate === e.effectiveDate))) continue;
    lines.push(`• ${a.title} · ${a.source} · pubblicato ${a.published}\n${verified?.effectiveDate ? verified.status+" · evento "+verified.effectiveDate : "Data dell’evento non verificata"}. ${verified?.impact ?? "Impatto non verificato."}\n${a.link}`);
    if (lines.length === 3) break;
  }
  return lines.length ? lines : ["Nessuna notizia pertinente verificata."];
}

export async function goldBriefing(state: State, now: Date, fake: boolean, redact: (s: string)=>string) {
  const { date } = rome(now);
  if (await state.read("outbox/"+outboxId("gold",date)+".json")) return;
  const rows = instruments.map(([section,name,venue,ticker,exchange]) => ({ section,name,venue,exchange,
    symbols: exchange ? contracts(ticker,exchange,now) : ticker ? [ticker] : [] }));
  const quotes = fake ? await state.read<Quote[]>("fake-gold-quotes.json") ?? [] :
    await readQuotes(rows.flatMap(row=>row.symbols)).catch(()=>[]);
  const text = [`${date} · 12:30 Europe/Rome${fake ? " · SIMULAZIONE" : ""}`];
  const next: string[] = [];
  const selected: Record<string,string> = {};
  const previous = await state.read<Record<string,string>>("gold-contracts.json") ?? {};
  let section = "";
  for (const row of rows) {
    if (section !== row.section) { section = row.section; text.push("",section); }
    const candidates = quotes.filter(q=>row.symbols.includes(q.symbol));
    let q = row.exchange ? activeContract(candidates,now) : candidates[0];
    if (!q && !fake && !row.exchange && row.symbols.length) {
      q = await chartQuote(row.symbols[0]).catch(() => undefined);
    }
    const label = row.name+" · "+row.venue;
    if (!q || !positive(q.regularMarketPrice) || !positive(q.regularMarketTime) || q.regularMarketTime*1000 > +now) {
      text.push(label+" · "+(row.exchange ? "contratto attivo e prezzo non verificabili" : "quotazione non verificabile")); continue;
    }
    const age = +now-q.regularMarketTime*1000;
    const stamp = new Date(q.regularMarketTime*1000).toISOString();
    const delay = age > 20*60_000 ? "dato datato" : q.exchangeDataDelayedBy === 0 ? "real-time dichiarato" :
      positive(q.exchangeDataDelayedBy) ? "ritardo "+q.exchangeDataDelayedBy+" min" : "latenza non verificabile";
    const session = age <= 20*60_000 && q.marketState === "REGULAR" ? "aperta secondo il feed" :
      q.marketState === "CLOSED" ? "chiusa secondo il feed" : "sessione non verificabile";
    text.push(`${label} · Yahoo ${q.symbol} · ${fmt(q.regularMarketPrice)} ${row.name.includes("10Y") ? "%" : q.currency ?? ""} · ${stamp} · ${delay} · ${session}`);
    if (row.exchange) {
      selected[row.name] = q.symbol;
      text.push("Scadenza "+new Date(q.expireDate!*1000).toISOString().slice(0,10));
      if (previous[row.name] && previous[row.name] !== q.symbol) text.push(`Rollover ${previous[row.name]} → ${q.symbol}. Serie separate.`);
    }
    if (positive(q.regularMarketPreviousClose)) text.push("Variazione giornaliera "+fmt(pct(q.regularMarketPreviousClose,q.regularMarketPrice))+"%");
    if (section !== "GOLD" || age > 20*60_000) continue;
    if (positive(q.regularMarketDayLow) && positive(q.regularMarketDayHigh)) text.push(`Min/max seduta ${fmt(q.regularMarketDayLow)}–${fmt(q.regularMarketDayHigh)}`);
    if (row.exchange && positive(q.regularMarketVolume)) {
      text.push("Volume seduta "+fmt(q.regularMarketVolume));
      if (positive(q.regularMarketVwap)) text.push("VWAP seduta "+fmt(q.regularMarketVwap));
    }
    const frames = [["15m","5d",15],["1h","1mo",60],["1d","3mo",1440]] as const;
    const fixture = fake ? await state.read<Record<string,Bar[]>>("fake-gold-bars.json") : undefined;
    const indicators = await Promise.all(frames.map(async ([interval,range,min]) => {
      const bars = fake ? fixture?.[q.symbol+"/"+interval] ?? [] : await yahoo(q.symbol,range,interval).catch(()=>[]);
      return technical(bars,min,now);
    }));
    for (const [i, result] of indicators.entries()) {
      const frame = frames[i][0];
      if (!result) { text.push(frame+" · indicatori non verificabili"); continue; }
      const {fast,slow,atr,rsi,high,low,signal} = result;
      text.push(`${frame} · ${fast > slow ? "rialzista" : fast < slow ? "ribassista" : "laterale"} · SMA5/20 ${fmt(fast)}/${fmt(slow)} · RSI14 ${fmt(rsi)} · ATR14 ${fmt(atr)} · ${signal}`);
      if (!indicators.slice(0,i).some(Boolean)) {
        text.push(`Scenari ${frame}: rialzista sopra ${fmt(high)}, ribassista sotto ${fmt(low)}, neutrale fra i due livelli. Rientro nel range invalida il breakout.`);
        next.push(`${q.symbol}: verificare la chiusura ${frame} rispetto a ${fmt(low)} e ${fmt(high)}.`);
      }
    }
  }
  if (!text.some(line => line.startsWith("VWAP seduta"))) text.push("VWAP seduta non verificabile.");
  text.push("", "NOTIZIE", ...await headlines(state,now),
    "", "PROSSIMO CONTROLLO", ...(next.length ? next : ["Verificare nuovi prezzi, sessioni e livelli dell’oro."]),
    "", "OPERAZIONI", "Nessun ordine inviato: briefing informativo.");
  await enqueue(state,date,"gold",redact(text.join("\n")),date,"gold-report");
  await state.write("gold-contracts.json",{...previous,...selected});
}
