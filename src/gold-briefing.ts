import { enqueue, outboxId } from "./chat";
import { verifyEvents } from "./event-news";
import type { NewsAnalysis } from "./agents";
import { pct, rsi14 } from "./indicators";
import { MonitorFeeds, freshness, quoteQuality, type Quote } from "./monitor-feeds";
import { type News, type Series } from "./market";
import type { State } from "./state";
import { rome } from "./time";

const instruments = [
  ["GOLD","XAU/USD","Spot OTC","XAUUSD=X"], ["GOLD","Gold CFD","CFD broker",""],
  ["GOLD","GC","COMEX","GC","CMX"], ["GOLD","MGC","COMEX","MGC","CMX"],
  ["MATERIE PRIME","XAG/USD","Spot OTC","XAGUSD=X"], ["MATERIE PRIME","WTI CL","NYMEX","CL","NYM"],
  ["MATERIE PRIME","WTI MCL","NYMEX","MCL","NYM"], ["MATERIE PRIME","Brent BZ","NYMEX","BZ","NYM"],
  ["FOREX E MACRO","EUR/USD","Spot OTC","EURUSD=X"], ["FOREX E MACRO","GBP/USD","Spot OTC","GBPUSD=X"],
  ["FOREX E MACRO","USD/JPY","Spot OTC","JPY=X"], ["FOREX E MACRO","DXY","Indice dollaro ICE","DX-Y.NYB"], ["FOREX E MACRO","Treasury USA 10Y","Rendimento %","^TNX"],
] as const;

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
type Bar = Series["intervals"][string][number];
export function technical(bars: Bar[], minutes: number, now: Date) {
  const duration = minutes * 60_000;
  const clean = bars.filter(b => [b.c,b.l,b.h,b.o].every(positive) && b.h >= Math.max(b.o,b.c,b.l) &&
    b.l <= Math.min(b.o,b.c) && Date.parse(b.t) + duration <= +now);
  // Restart the sample at a gap, including venue breaks without verified bars.
  let start = 0;
  for (let i=1; i<clean.length; i++) {
    const gap=Date.parse(clean[i].t)-Date.parse(clean[i-1].t);
    const weekend=minutes===1440 && new Date(clean[i-1].t).getUTCDay()===5 && new Date(clean[i].t).getUTCDay()===1;
    const expected=weekend?3*duration:duration;
    if (gap!==expected && !(minutes===1440 && Math.abs(gap-expected)===3600000)) start=i;
  }
  clean.splice(0,start);
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

export async function buildGoldReport(state: State, now: Date, fake: boolean) {
  const { date } = rome(now);
  const rows = instruments.map(([section,name,venue,ticker,exchange]) => ({ section,name,venue,exchange,
    symbols: exchange ? contracts(ticker,exchange,now) : ticker ? [ticker] : [] }));
  const quotes = fake ? await state.read<Quote[]>("fake-gold-quotes.json") ?? [] :
    [];
  const feeds = new MonitorFeeds(state,undefined,true);
  const text = [`${date} · 12:30 Europe/Rome${fake ? " · SIMULAZIONE" : ""}`];
  const next: string[] = [];
  const selected: Record<string,string> = {};
  const previous = await state.read<Record<string,string>>("gold-contracts.json") ?? {};
  let section = "";
  for (const row of rows) {
    if (row.name === "Gold CFD" && !row.symbols.length) continue;
    if (section !== row.section) { section = row.section; text.push("",section); }
    const candidates = quotes.filter(q=>row.symbols.includes(q.symbol));
    let q = row.exchange ? activeContract(candidates,now) : candidates[0];
    let problem = "";
    if (!fake && row.symbols.length) {
      try {
        if (row.exchange) {
          const root = row.name.split(" ").at(-1)!;
          const reference = await feeds.yahooQuote(root+"=F").catch(()=>undefined);
          const contracts = await feeds.datedContracts(row.symbols,now,reference?.marketState==="CLOSED");
          q = activeContract(contracts,now) ?? reference;
        } else if (["XAU/USD","XAG/USD","EUR/USD","GBP/USD","USD/JPY"].includes(row.name)) {
          q=await feeds.spotQuote(row.name,now);
        } else if (row.name==="Treasury USA 10Y") q=await feeds.treasury();
        else q=await feeds.yahooQuote(row.symbols[0]);
      } catch (e) { problem = e instanceof Error && /^(Feed |Chiave |Endpoint )/.test(e.message) ? " · "+e.message : " · fonte indisponibile"; }
    }
    const decimals=row.name==="USD/JPY"?3:["GBP/USD","EUR/USD"].includes(row.name)?5:2;
    const price=(v:number)=>v.toLocaleString("it-IT",{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
    const label = row.name+" · "+row.venue;
    if (q?.responseAt && !q.regularMarketTime) {
      text.push(label+" · "+q.provider+" · "+price(q.regularMarketPrice)+" USD · risposta "+q.responseAt+" · freschezza del prezzo non verificabile.");
      continue;
    }
    if (!q || !positive(q.regularMarketPrice) || !positive(q.regularMarketTime) || q.regularMarketTime*1000 > +now) {
      text.push(label+" · "+(row.exchange ? "contratto attivo e prezzo non verificabili" : "quotazione non verificabile")+problem); next.push(row.name+" · ricontrollare disponibilità"); continue;
    }
    if(q.observationDate){
      text.push(label+" · "+q.symbol+" · "+q.regularMarketPrice.toFixed(2)+"% · osservazione giornaliera FRED del "+q.observationDate+". Pubblicazione successiva alla rilevazione.");
      continue;
    }
    const age = +now-q.regularMarketTime*1000;
    const stamp = new Date(q.regularMarketTime*1000).toISOString();
    const maxAge = (q.observationDate ? freshness.daily : row.exchange ? freshness.futures : row.name.startsWith("XA") ? freshness.spot : freshness.forex)*60_000;
    const delay = quoteQuality(q,now,maxAge);
    const withinWindow = q.sessionStart && q.sessionEnd && q.sessionStart*1000<=+now && +now<q.sessionEnd*1000 &&
      q.regularMarketTime>=q.sessionStart;
    const session = age <= 20*60_000 && q.marketState === "REGULAR" ? "aperta secondo il feed" :
      q.marketState === "CLOSED" ? "chiusa secondo il feed" : withinWindow ? "finestra di seduta; apertura non confermata" : "sessione non verificabile";
    text.push(`${label} · ${q.provider ?? "Yahoo"} ${q.symbol} · ${price(q.regularMarketPrice)} ${row.name.includes("10Y") ? "%" : q.currency ?? ""} · ${q.observationDate ?? stamp} · ${delay} · ${session}`);
    if (q.continuous) text.push("Serie continua indicativa. Contratto attivo e scadenza non verificati.");
    if (q.bid && q.ask) text.push("Bid/ask "+fmt(q.bid)+"/"+fmt(q.ask));
    if (row.exchange && !q.continuous) {
      selected[row.name] = q.symbol;
      text.push("Scadenza "+new Date(q.expireDate!*1000).toISOString().slice(0,10));
      if (previous[row.name] && previous[row.name] !== q.symbol) text.push(`Rollover ${previous[row.name]} → ${q.symbol}. Serie separate.`);
    }
    if (positive(q.regularMarketPreviousClose)) text.push("Variazione giornaliera "+pct(q.regularMarketPreviousClose,q.regularMarketPrice).toFixed(2)+"%");
    const forex = q.provider?.startsWith("Twelve Data");
    if ((section !== "GOLD" && !forex) || age > maxAge) continue;
    if (positive(q.regularMarketDayLow) && positive(q.regularMarketDayHigh)) text.push(`Min/max seduta ${fmt(q.regularMarketDayLow)}–${fmt(q.regularMarketDayHigh)}`);
    if (row.exchange && positive(q.regularMarketVolume)) {
      text.push("Volume seduta "+fmt(q.regularMarketVolume));
      if (positive(q.regularMarketVwap)) text.push("VWAP seduta "+fmt(q.regularMarketVwap));
    }
    if (q.continuous || (q.provider==="goldApi.dev" || q.provider?.includes("fallback spot"))) {
      text.push(q.continuous ? "Indicatori sospesi: rollover della serie continua non verificabile." : "OHLC spot non disponibili.");
      continue;
    }
    const frames = [["15m","5d",15],["1h","1mo",60],["1d","3mo",1440]] as const;
    const fixture = fake ? await state.read<Record<string,Bar[]>>("fake-gold-bars.json") : undefined;
    const indicators = await Promise.all(frames.map(async ([interval,range,min]) => {
      const bars = fake ? fixture?.[q.symbol+"/"+interval] ?? [] : forex ? await feeds.forex(row.name,interval==="15m"?"15min":interval==="1d"?"1day":"1h",false).catch(()=>[]) : await feeds.yahooBars(q.symbol,range,interval).catch(()=>[]);
      return technical(bars,min,now);
    }));
    for (const [i, result] of indicators.entries()) {
      const frame = frames[i][0];
      if (!result) { text.push(frame+" · indicatori non verificabili"); continue; }
      const {fast,slow,atr,rsi,high,low,signal} = result;
      text.push(`${frame} · ${fast > slow ? "rialzista" : fast < slow ? "ribassista" : "laterale"} · SMA5/20 ${fmt(fast)}/${fmt(slow)} · RSI14 ${rsi.toFixed(1)} · ATR14 ${fmt(atr)} · ${signal}`);
      if (!indicators.slice(0,i).some(Boolean)) {
        text.push(`Scenari ${frame}: rialzista sopra ${fmt(high)}, ribassista sotto ${fmt(low)}, neutrale fra i due livelli. Rientro nel range invalida il breakout.`);
        next.push(`${q.symbol}: verificare la chiusura ${frame} rispetto a ${fmt(low)} e ${fmt(high)}.`);
      }
    }
  }
  if (!text.some(line => line.startsWith("VWAP seduta"))) text.splice(text.indexOf("MATERIE PRIME")-1,0,"VWAP seduta non verificabile.");
  text.push("", "NOTIZIE", ...await headlines(state,now),
    "", "PROSSIMO CONTROLLO", ...(next.length ? next : ["Verificare nuovi prezzi, sessioni e livelli dell’oro."]),
    "", "OPERAZIONI", "Nessun ordine inviato: briefing informativo.");
  return { text:text.join("\n"), contracts:{...previous,...selected} };
}

export async function goldBriefing(state: State, now: Date, fake: boolean, redact: (s:string)=>string) {
  const {date}=rome(now);
  if (await state.read("outbox/"+outboxId("gold",date)+".json")) return;
  const report=await buildGoldReport(state,now,fake);
  await enqueue(state,date,"gold",redact(report.text),date,"gold-report");
  await state.write("gold-contracts.json",report.contracts);
}
