import { newYork } from "./time";
import { cached, FeedFailure, publicResponse } from "./provider-cache";
import { payload, type Mcp } from "./mcp";
import { yahoo, type Series } from "./market";
import type { State } from "./state";

type Bar = Series["intervals"][string][number];
export const equities = "SPY QQQ IWM AAPL MSFT NVDA AMD TSLA TLT GLD IAU GLDM SGOL GDX UGL GLL SLV USO".split(" ");
export const pairs = ["EUR/USD","GBP/USD","USD/JPY"];
export const normalize = (s: string) => /^(BTC|ETH)-USD$/.test(s) ? s.replace("-","/") : s;
const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
const mins = 60000;
export const freshness = {spot:15, forex:30, futures:20, crypto:20, equity:30, index:30, daily:5*1440};
export type Quote = { symbol: string; regularMarketPrice: number; regularMarketTime: number; regularMarketVolume?: number;
  regularMarketPreviousClose?: number; regularMarketVwap?: number; regularMarketDayHigh?: number; regularMarketDayLow?: number;
  exchangeDataDelayedBy?: number; marketState?: string; expireDate?: number; currency?: string; provider?: string;
  responseAt?:string; receivedAt?:string; sessionStart?: number; sessionEnd?: number; exchange?: string; instrumentType?: string; continuous?: boolean; bid?: number; ask?: number; observationDate?: string };
const spotTickers:Record<string,string>={"XAU/USD":"XAUUSD=X","XAG/USD":"XAGUSD=X","EUR/USD":"EURUSD=X","GBP/USD":"GBPUSD=X","USD/JPY":"JPY=X"};
function weekendClosed(now=new Date()) {
  const ny=newYork(now);
  const weekday=new Date(ny.date+"T12:00:00Z").getUTCDay();
  return weekday===6 || (weekday===5 && ny.time>="18:00") || (weekday===0 && ny.time<"16:00");
}
export function quoteQuality(q:Quote, now:Date, maxAge:number) {
  const age=+now-q.regularMarketTime*1000;
  if (!positive(q.regularMarketTime) || !Number.isFinite(age) || age<0) return "timestamp non verificabile";
  if (age>maxAge) return "dato datato";
  if (q.exchangeDataDelayedBy && q.exchangeDataDelayedBy>0) return "ritardo "+q.exchangeDataDelayedBy+" min";
  return "prezzo recente · "+(q.exchangeDataDelayedBy===0?"ritardo dichiarato 0 min":"latenza non verificabile");
}
async function secret(name: string) {
  const file = process.env[name+"_FILE"];
  const value = file ? await Bun.file(file).text().catch(()=>"") : process.env[name];
  if (!value?.trim()) throw new Error("Chiave "+name+" assente");
  return value.trim();
}
export const sourceOf = (s:string) => equities.includes(s) ? "Alpaca IEX" : /^(BTC|ETH)[/-]USD$/.test(s) ? "Alpaca Crypto" :
  pairs.includes(s) ? "Twelve Data" : "Yahoo Chart v8";
export class MonitorFeeds {
  constructor(readonly state: State, readonly mcp?: Mcp, readonly priority=false, readonly verifyDirect=false) {}
  async equitySession() {
    return cached(this.state,"alpaca","market-clock-v2",(v:{open:boolean;next:number})=>v.open?mins:Math.max(mins,v.next-Date.now()),async()=>{
      const clock=await payload<{is_open:boolean;timestamp:string;next_open?:string}>(this.mcp!,"get_clock");
      if (typeof clock.is_open!=="boolean" || Math.abs(Date.now()-Date.parse(clock.timestamp))>5*mins || !Number.isFinite(Date.parse(clock.timestamp))) throw new FeedFailure(0);
      return {open:clock.is_open,next:Date.parse(clock.next_open??"") || Date.now()+mins};
    });
  }
  async forex(pair: string, interval: "15min"|"1h"|"1day", priority=this.priority) {
    if (!pairs.includes(pair) && pair!=="XAU/USD") throw new Error("Coppia sconosciuta");
    const key = await secret("TWELVE_DATA_API_KEY");
    return cached(this.state,"twelve",pair+interval, interval === "1day" ? 6*3600000 : interval === "1h" ? 3600000 : 15*mins,async () => {
      const url = new URL("https://api.twelvedata.com/time_series");
      url.search = new URLSearchParams({symbol:pair,interval,outputsize:"48",timezone:"UTC",order:"asc"}).toString();
      const data = await (await publicResponse(url,{Authorization:"apikey "+key})).json();
      if (data.status === "error") {
        const quotaUntilMidnight=Number(data.code)===429 && /daily|per day|day.limit/i.test(String(data.message));
        throw new FeedFailure(Number(data.code)||0,quotaUntilMidnight?86400000-Date.now()%86400000:0);
      }
      if (data.meta?.symbol !== pair || data.meta.interval !== interval || !Array.isArray(data.values)) throw new FeedFailure(0);
      return data.values.map((v: Record<string,string>) => {
        const t = Date.parse(interval==="1day" ? v.datetime+"T00:00:00Z" : v.datetime.replace(" ","T")+"Z");
        const [o,h,l,c] = [v.open,v.high,v.low,v.close].map(Number);
        if (!Number.isFinite(t) || ![o,h,l,c].every(positive) || l>Math.min(o,c) || h<Math.max(o,c)) throw new FeedFailure(0);
        return {t:new Date(t).toISOString(),o,h,l,c,v:null};
      }) as Bar[];
    },8,Math.min(700,Number(process.env.TWELVE_DATA_DAILY_LIMIT ?? 700)),{priority,fresh:this.verifyDirect,cacheOnly:!this.verifyDirect && weekendClosed()});
  }
  async yahooQuote(symbol: string, cacheOnly=false) {
    return cached(this.state,"yahoo",symbol+"/quote",(q:Quote)=>q.marketState==="CLOSED" ? 60*mins : 10*mins,async () => {
      const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol));
      url.search = "range=1d&interval=15m";
      const meta = (await (await publicResponse(url)).json()).chart?.result?.[0]?.meta;
      const future = symbol.endsWith("=F") || /\.(CMX|NYM)$/.test(symbol);
      const exchange = /^(M?GC)/.test(symbol) ? "CMX" : "NYM";
      if (future && (meta?.instrumentType!=="FUTURE" || meta.exchangeName!==exchange)) throw new FeedFailure(0);
      if (meta?.symbol !== symbol || !positive(meta.regularMarketPrice) || !positive(meta.regularMarketTime)) throw new FeedFailure(0);
      const session=meta.currentTradingPeriod?.regular;
      return {symbol,provider:"Yahoo Chart v8",currency:meta.currency,regularMarketPrice:meta.regularMarketPrice,
        regularMarketTime:meta.regularMarketTime,regularMarketPreviousClose:meta.previousClose ?? meta.chartPreviousClose,
        regularMarketDayHigh:meta.regularMarketDayHigh, regularMarketDayLow:meta.regularMarketDayLow,
        regularMarketVolume:meta.regularMarketVolume,exchangeDataDelayedBy:meta.exchangeDataDelayedBy,
        expireDate:meta.expireDate,marketState:meta.marketState,exchange:meta.exchangeName,instrumentType:meta.instrumentType,sessionStart:session?.start,sessionEnd:session?.end,continuous:symbol.endsWith("=F")} as Quote;
    },60,3000,{cacheOnly});
  }
  async datedContracts(symbols: string[], now: Date, cacheOnly=false) {
    // Contract expiry is an instant supplied by exchange reference data, never inferred from a month code.
    const contracts = await this.state.read<{symbol:string;lastTradeAt:string;source:string}[]>("futures-calendar.json") ?? [];
    const reference = contracts.filter(c=>symbols.includes(c.symbol) && /^https:\/\/(www\.)?cmegroup\.com\//.test(c.source) &&
      /T.*(?:Z|[+-]\d\d:\d\d)$/.test(c.lastTradeAt) && Number.isFinite(Date.parse(c.lastTradeAt)));
    // Probe exact dated symbols when no local calendar is supplied. An absent listing is
    // different from a listing with unknown expiry or an ambiguous transport failure.
    const names=symbols.filter(name=>!reference.some(c=>c.symbol===name && Date.parse(c.lastTradeAt)<=+now));
    const results=await Promise.allSettled(names.map(async name=>{
      const q=await this.yahooQuote(name,cacheOnly);
      const record=reference.find(c=>c.symbol===name);
      return {...q,expireDate:record ? Date.parse(record.lastTradeAt)/1000 : q.expireDate};
    }));
    if (results.some(r=>r.status==="rejected" && !(r.reason instanceof FeedFailure && r.reason.code===404))) return [];
    const listed=results.flatMap(r=>r.status==="fulfilled"?[r.value]:[]);
    if (listed.some(q=>!positive(q.expireDate))) return [];
    const observations=listed.filter(q=>q.expireDate!*1000>+now);
    // Compare cumulative volumes only for the same venue session and nearby timestamps.
    if (!observations.length || observations.some(q=>
      !q.sessionStart || q.sessionStart!==observations[0].sessionStart || q.sessionEnd!==observations[0].sessionEnd || q.regularMarketTime<q.sessionStart ||
      !positive(q.regularMarketVolume) || !q.sessionEnd || q.regularMarketTime>q.sessionEnd || Math.max(...observations.map(v=>v.regularMarketTime))-Math.min(...observations.map(v=>v.regularMarketTime))>300)) return [];
    return observations;
  }
  async metal(symbol: string): Promise<Quote> {
    const key = await secret("GOLDAPI_KEY");
    const template = process.env.GOLDAPI_URL_TEMPLATE || "https://goldapi.dev/api/v1/price/{metal}/USD";
    if (!template || !template.includes("{metal}")) throw new Error("Endpoint goldApi.dev del piano non configurato");
    const metal = symbol.split("/")[0];
    const url = new URL(template.replace("{metal}",metal));
    if (url.protocol !== "https:" || !["goldapi.dev","api.goldapi.dev"].includes(url.hostname) || url.port || url.username || url.password) throw new Error("Endpoint goldApi.dev non valido");
    return cached(this.state,"gold",symbol,15*mins,async () => {
      const header = process.env.GOLDAPI_AUTH_HEADER || "X-API-Key";
      const data = await (await publicResponse(url,{[header]:key})).json();
      const quote = data.data ?? data;
      const at = typeof quote.timestamp==="number" ? (quote.timestamp>1e12 ? quote.timestamp/1000 : quote.timestamp) : Date.parse(quote.timestamp)/1000;
      const responseAt=Date.parse(quote.updatedAt ?? data.updatedAt);
      if (![metal,symbol].includes(quote.symbol ?? quote.metal) || quote.currency !== "USD" || !positive(quote.price)) throw new FeedFailure(0);
      return {symbol,provider:"goldApi.dev",regularMarketPrice:quote.price,regularMarketTime:positive(at)?at:0,responseAt:Number.isFinite(responseAt)?new Date(responseAt).toISOString():undefined,currency:"USD",
        receivedAt:new Date().toISOString(),
        bid:positive(quote.bid) ? quote.bid : undefined, ask:positive(quote.ask) ? quote.ask : undefined};
    },80,Number(process.env.GOLDAPI_DAILY_LIMIT ?? Infinity),{priority:this.priority && symbol==="XAU/USD",fresh:this.verifyDirect,cacheOnly:!this.verifyDirect && weekendClosed()});
  }
  async goldMinute():Promise<Quote> {
    const key=await secret("TWELVE_DATA_API_KEY");
    return cached(this.state,"twelve","XAU/USD/quote/1min",5*mins,async()=>{
      const url=new URL("https://api.twelvedata.com/quote?symbol=XAU%2FUSD&interval=1min");
      const q=await (await publicResponse(url,{Authorization:"apikey "+key})).json();
      if(q.status==="error") throw new FeedFailure(Number(q.code)||0);
      if(q.symbol!=="XAU/USD" || !positive(q.timestamp) || !positive(Number(q.close))) throw new FeedFailure(0);
      return {symbol:q.symbol,provider:"Twelve Data · quote 1min",currency:"USD",regularMarketPrice:Number(q.close),regularMarketTime:q.timestamp};
    },8,Math.min(700,Number(process.env.TWELVE_DATA_DAILY_LIMIT??700)),{priority:this.priority,cacheOnly:weekendClosed()});
  }
  async spotQuote(symbol:string, now:Date):Promise<Quote> {
    const ticker=spotTickers[symbol];
    if (!ticker) throw new Error("Strumento spot non supportato");
    const fx=pairs.includes(symbol);
    const maxAge=(fx?freshness.forex:freshness.spot)*mins;
    if (!fx) {
      if (symbol==="XAU/USD") {
        const primary=await this.goldMinute().catch(()=>undefined);
        if (primary && primary.regularMarketTime*1000<=+now && +now-primary.regularMarketTime*1000<=maxAge) return primary;
      }
      return this.metal(symbol);
    }
    let preferred:Quote|undefined;
    let reason:unknown;
    try {
      if (fx) {
        const bars=await this.forex(symbol,"15min");
        const last=bars.filter(b=>Date.parse(b.t)+15*mins<=+now).at(-1);
        if (last) preferred={symbol,provider:"Twelve Data · chiusura 15 min",currency:symbol.slice(-3),
          regularMarketPrice:last.c,regularMarketTime:(Date.parse(last.t)+15*mins)/1000};
      } else preferred=await this.metal(symbol);
    } catch (e) { reason=e; }
    if (preferred && preferred.regularMarketTime*1000>+now) preferred=undefined;
    if (preferred && +now-preferred.regularMarketTime*1000<=maxAge) return preferred;
    if (!weekendClosed(now)) {
      const other=await this.yahooQuote(ticker).catch(()=>undefined);
      if (other?.instrumentType==="CURRENCY" && other.currency===symbol.slice(-3) &&
        other.regularMarketTime*1000<=+now && other.regularMarketTime>(preferred?.regularMarketTime??0))
        return {...other,provider:"Yahoo Chart v8 · fallback spot"};
    }
    if (preferred) return preferred;
    throw reason ?? new FeedFailure(0);
  }
  async treasury(): Promise<Quote> {
    return cached(this.state,"fred","DGS10",6*3600000,async () => {
      const url = new URL("https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10");
      url.searchParams.set("cosd",new Date(Date.now()-14*86400000).toISOString().slice(0,10));
      const rows=(await (await publicResponse(url)).text()).trim().split(/\r?\n/);
      if (!rows.shift()?.endsWith(",DGS10")) throw new FeedFailure(0);
      const line=rows.filter(s=>/^\d{4}-\d\d-\d\d,-?\d+(\.\d+)?$/.test(s)).at(-1);
      if (!line) throw new FeedFailure(0);
      const [date,value]=line.split(",");
      return {symbol:"DGS10",provider:"FRED · osservazione giornaliera",observationDate:date,regularMarketPrice:Number(value),regularMarketTime:Date.parse(date)/1000};
    });
  }
  yahooBars(symbol:string,range:string,interval:string,spotCurrency?:string) {
    return cached(this.state,"yahoo",[symbol,range,interval,spotCurrency].filter(Boolean).join("/"),interval==="1d"?6*3600000:15*mins,()=>yahoo(symbol,range,interval,spotCurrency));
  }
  async series(item:{symbol:string;ticker:string;series?:string}):Promise<Series> {
    const symbol=item.symbol;
    let provider=sourceOf(symbol), ticker=provider==="Yahoo Chart v8"?item.ticker:normalize(symbol);
    const fx=provider==="Twelve Data";
    const crypto=provider==="Alpaca Crypto", equity=provider==="Alpaca IEX";
    if (equity) await cached(this.state,"alpaca",symbol+"/catalog",86400000,async()=>{
      const a=await payload<{symbol:string;class:string;status:string}>(this.mcp!,"get_asset",{symbol_or_asset_id:symbol});
      if (a.symbol!==symbol || a.class!=="us_equity" || a.status!=="active") throw new FeedFailure(404);
      return true;
    });
    const clock=equity?await this.equitySession().catch(()=>undefined):undefined;
    const session=crypto?"24/7":clock?(clock.open?"aperta":"chiusa"):"non verificabile";
    const results=await Promise.allSettled((["15Min","1Day"] as const).map(async interval=>{
      const daily=interval==="1Day";
      if (equity || crypto) return cached(this.state,"alpaca",ticker+interval+(clock && !clock.open?"/closed":""),clock && !clock.open?Math.max(mins,clock.next-Date.now()):daily?6*3600000:15*mins,async()=>{
        const data=await payload<{bars:Record<string,Bar[]>}>(this.mcp!,crypto?"get_crypto_bars":"get_stock_bars",
          {symbols:ticker,timeframe:interval,start:new Date(Date.now()-(daily?75:5)*86400000).toISOString(),limit:10000,...(crypto?{}:{feed:"iex"})});
        if (!Array.isArray(data.bars?.[ticker])) throw new FeedFailure(0);
        return data.bars[ticker].slice(-48);
      },180,10000);
      if (provider==="Twelve Data") return this.forex(symbol,daily?"1day":"15min");
      return this.yahooBars(ticker,daily?"3mo":"5d",daily?"1d":"15m");
    }));
    const complete=(bars:Bar[],duration:number)=>bars.filter(b=>
      [b.o,b.h,b.l,b.c].every(positive) && b.l<=Math.min(b.o,b.c) && b.h>=Math.max(b.o,b.c) &&
      Date.parse(b.t)+duration<=Date.now());
    let [intra,daily]=results.map((r,i)=>r.status==="fulfilled"?complete(r.value,i===0?15*mins:86400000):[]);
    let error=results.find(r=>r.status==="rejected");
    const primaryAt=Date.parse(intra.at(-1)?.t??"") || 0;
    if (fx && !weekendClosed() && (error || intra.length<5 || daily.length<16 || Date.now()-primaryAt>freshness.forex*mins)) {
      const other=spotTickers[symbol];
      const replacement=await Promise.all([this.yahooBars(other,"5d","15m",symbol.slice(-3)),
        this.yahooBars(other,"3mo","1d",symbol.slice(-3))]).catch(()=>undefined);
      if (replacement) {
        const bars=complete(replacement[0],15*mins), days=complete(replacement[1],86400000);
        const at=Date.parse(bars.at(-1)?.t??"");
        if (bars.length>=5 && days.length>=16 && at>=primaryAt && Date.now()-at<=freshness.forex*mins &&
            Date.now()-Date.parse(days.at(-1)!.t)<=freshness.daily*mins) {
          intra=bars; daily=days; error=undefined; ticker=other; provider="Yahoo Chart v8 · fallback spot";
        }
      }
    }
    const detail = crypto ? "spot USD · sessione 24/7" : ["UGL","GLL"].includes(symbol) ? "ETF a leva giornaliera" : item.series;
    const observed=intra.at(-1);
    const age=observed?(Date.now()-Date.parse(observed.t))/mins:Infinity;
    const threshold=crypto?freshness.crypto:equity?freshness.equity:fx?freshness.forex:freshness.futures;
    const quality=error?"parziale":age<0 || age>threshold?"assente o datato":"candela completa";
    const instrumentType=crypto?"crypto spot":equity?(["AAPL","MSFT","NVDA","AMD","TSLA"].includes(symbol)?"azione":
      ["UGL","GLL"].includes(symbol)?"ETF a leva giornaliera":"ETF/ETP"):fx?"Forex spot":
      ticker==="^GSPC"?"indice S&P 500 · solo sottostante CFD":ticker.endsWith("=F")?"future continuo":"indice";
    const observation={provider,providerSymbol:ticker,instrumentType,venue:equity?"IEX":crypto?"Alpaca Crypto US":
      fx?"OTC":ticker==="^GSPC"?"S&P DJI":item.series??"Yahoo",
      currency:fx?symbol.slice(-3):"USD",price:observed?.c??null,barStart:observed?.t??null,
      session,quality,delayMinutes:null};
    if (ticker.endsWith("=F")) {
      // Preserve the indicative last price. Continuous history has no constituent IDs.
      return {symbol,observation,source:[provider,ticker,detail].filter(Boolean).join(" · "),updated:observed?.t??null,
        intervals:{},error:"Serie continua: storico dei rollover non verificabile per gli indicatori"};
    }
    return {symbol, observation, source:[provider,ticker,detail,"sessione "+session].filter(Boolean).join(" · "),updated:intra.at(-1)?.t ?? null,
      error:error ? "Dati parziali: "+(error.reason instanceof FeedFailure ? error.reason.message : "fonte non disponibile") : age<0 || age>threshold ? "Ultima candela intraday assente o datata" : undefined,
      intervals:{"15Min":intra,"1Day":daily}};
  }
}
