import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorFeeds, equities, normalize } from "../src/monitor-feeds";
import { cached, FeedFailure } from "../src/provider-cache";
import { goldBriefing, technical } from "../src/gold-briefing";
import { State } from "../src/state";
import { universe } from "../src/broker";
const dirs:string[]=[];
const original=globalThis.fetch;
const variables=["GOLDAPI_KEY","TWELVE_DATA_API_KEY","GOLDAPI_URL_TEMPLATE"];
const saved=variables.map(k=>process.env[k]);
afterEach(async()=>{
  globalThis.fetch=original;
  variables.forEach((k,i)=>{if(saved[i]===undefined) delete process.env[k]; else process.env[k]=saved[i]});
  await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));
});
async function state() {
  const dir=await mkdtemp(join(tmpdir(),"provider-test-"));
  dirs.push(dir);
  return new State(dir);
}
function http(fn:(url:URL,init?:RequestInit)=>Response) {
  globalThis.fetch=(async (url,init)=>fn(new URL(String(url)),init)) as typeof fetch;
}
for (const code of [401,403,404,429,500,0]) test("provider sospende chiamate dopo "+code,async()=>{
  const f=new MonitorFeeds(await state()); let calls=0;
  http(()=>{ calls++; if(!code) throw new DOMException("simulato","TimeoutError"); return new Response(null,{status:code}); });
  for(let i=0;i<2;i++) await expect(f.yahooQuote("GC=F")).rejects.toBeInstanceOf(FeedFailure);
  expect(calls).toBe(1);
  expect(await f.state.read("providers/yahoo.json")).toMatchObject({calls:1,errors:1});
});
test("cache persistente con processi Bun concorrenti e budget giornaliero",async()=>{
  const s=await state();
  const script=`import {cached} from "./src/provider-cache"; import {State} from "./src/state"; const s=new State(process.argv.at(-1)); console.log(await cached(s,"fixture","same",60000,async()=>{await Bun.sleep(70);return crypto.randomUUID()}));`;
  const call=async()=>{const p=Bun.spawn([process.execPath,"-e",script,s.root],{stdout:"pipe"}); const text=await new Response(p.stdout).text(); expect(await p.exited).toBe(0);return text.trim()};
  const values=await Promise.all([call(),call()]);
  expect(values[0]).toBeTruthy();expect(values[0]).toBe(values[1]); expect(await call()).toBe(values[0]);
  await expect(cached(s,"fixture","other",600,async()=>2,8,1)).rejects.toThrow("429");
  expect(await s.read("providers/fixture.json")).toMatchObject({calls:1});
});
test("catalogo azioni, ETF a leva e crypto con ticker interno persistente e solo letture",async()=>{
  const calls:string[]=[];
  const feeds=new MonitorFeeds(await state(),{async call(tool,args:any){
    calls.push(tool);
    const bar={t:new Date().toISOString(),o:1,h:1,l:1,c:1,v:3};
    return {structuredContent:tool==="get_asset"?{symbol:args.symbol_or_asset_id,status:"active",class:"us_equity"}:
      tool==="get_clock"?{timestamp:new Date().toISOString(),is_open:false}:{bars:{[args.symbols]:[bar]}}};
  }});
  for(const s of [...equities,"BTC-USD","ETH-USD"]){
    const result=await feeds.series({symbol:s,ticker:s});
    expect(result.symbol).toBe(s);expect(result.source).toContain(normalize(s));
    if(s.includes("-")) expect(result.source).toContain("24/7");else expect(result.source).toContain("sessione chiusa");
    if(["UGL","GLL"].includes(s)) expect(result.source).toContain("leva giornaliera");
  }
  expect(calls.filter(c=>c==="get_asset")).toHaveLength(equities.length);
  expect(new Set(calls)).toEqual(new Set(["get_clock","get_asset","get_stock_bars","get_crypto_bars"]));
  expect([...universe]).toEqual(["SPY","QQQ","IWM","AAPL","MSFT","NVDA","GLD","TLT"]);
});
test("Twelve Data controlla identità, intervallo, UTC e 429 nel JSON",async()=>{
  process.env.TWELVE_DATA_API_KEY="test-only";
  const f=new MonitorFeeds(await state());
  http((u,init)=>{
    expect(new Headers(init?.headers).get("Authorization")).toBe("apikey test-only");
    expect(u.search.includes("test-only")).toBe(false);
    if(u.searchParams.get("symbol")==="GBP/USD")return Response.json({status:"error",code:429});
    return Response.json({meta:{symbol:"EUR/USD",interval:"15min"},values:[{datetime:"2026-11-23 11:15:00",open:"1.1",high:"1.2",low:"1",close:"1.13"}]});
  });
  expect((await f.forex("EUR/USD","15min"))[0].t).toBe("2026-11-23T11:15:00.000Z");
  await expect(f.forex("GBP/USD","1h")).rejects.toThrow("429");
  await expect(f.forex("USD/JPY","1day")).rejects.toThrow("429");
});
test("metalli spot richiedono chiave e identità USD, nessun indicatore da un tick",async()=>{
  delete process.env.GOLDAPI_KEY;
  const f=new MonitorFeeds(await state());
  await expect(f.metal("XAU/USD")).rejects.toThrow("assente");
  process.env.GOLDAPI_KEY="test-only";process.env.GOLDAPI_URL_TEMPLATE="https://goldapi.dev/test/{metal}";
  http(()=>Response.json({metal:"XAU",currency:"USD",price:2420,timestamp:1795433400,bid:2419,ask:2421}));
  expect(await f.metal("XAU/USD")).toMatchObject({provider:"goldApi.dev",regularMarketPrice:2420,bid:2419,ask:2421});
  await expect(f.metal("XAG/USD")).rejects.toThrow();
  expect(technical([],15,new Date())).toBeUndefined();
});
test("briefing con feed simulati: serie continue, indice, DGS10 e CFD distinti",async()=>{
  const s=await state(), now=new Date();
  delete process.env.GOLDAPI_KEY;delete process.env.TWELVE_DATA_API_KEY;
  const hits:string[]=[];
  http(u=>{
    hits.push(u.pathname);
    if(u.hostname.startsWith("fred.")) return new Response("observation_date,DGS10\n"+now.toISOString().slice(0,10)+",4.10");
    const symbol=decodeURIComponent(u.pathname.split("/").at(-1)!);
    return Response.json({chart:{result:[{meta:{symbol,instrumentType:"FUTURE",exchangeName:/^(M?GC)/.test(symbol)?"CMX":"NYM",regularMarketPrice:1900,regularMarketTime:Math.floor(+now/1000),currency:"USD"}}]}});
  });
  await goldBriefing(s,now,false,s=>s);
  await goldBriefing(s,now,false,s=>s);
  const files=await s.list("outbox");expect(files).toHaveLength(1);
  const {text}=await s.read<any>("outbox/"+files[0]);
  for(const symbol of ["GC=F","MGC=F","CL=F","MCL=F","BZ=F","DX-Y.NYB","DGS10","USD/JPY"])expect(text).toContain(symbol);
  expect(text).toContain("Serie continua indicativa"); expect(text).toContain("Gold CFD · CFD broker · quotazione non verificabile");
  expect(hits.some(path=>path.includes("v7"))).toBe(false);
  expect(await s.list("intents")).toHaveLength(0);
});
test("confronto volumi solo nella stessa sessione, esclude scaduti e barre con lacune",async()=>{
  const s=await state(), f=new MonitorFeeds(s), now=new Date();
  const records=["A","B","OLD"].map(symbol=>({symbol,source:"https://www.cmegroup.com/calendar",lastTradeAt:new Date(+now+(symbol==="OLD"?-1:1)*86400000).toISOString()}));
  await s.write("futures-calendar.json",records);
  http(u=>{
    const symbol=u.pathname.split("/").at(-1);
    expect(symbol).not.toBe("OLD");
    return Response.json({chart:{result:[{meta:{symbol,regularMarketPrice:40,regularMarketTime:+now/1000,regularMarketVolume:100,currentTradingPeriod:{regular:{start:+now/1000-(symbol==="A"?100:200)}}}}]}});
  });
  expect(await f.datedContracts(["A","B","OLD"],now)).toEqual([]);
  const bars=Array.from({length:25},(_,i)=>({t:new Date(+now-(26-i)*900000).toISOString(),o:10,l:9,h:11,c:10,v:null}));
  bars.splice(15,1);expect(technical(bars,15,now)).toBeUndefined();
});
test("contratti datati v8 selezionabili senza calendario solo con scadenze e volumi verificati",async()=>{
  const now=new Date(), s=await state(), f=new MonitorFeeds(s);
  http(u=>{
    const symbol=decodeURIComponent(u.pathname.split("/").at(-1)!);
    if(symbol==="GCQ28.CMX") return new Response(null,{status:404});
    return Response.json({chart:{result:[{meta:{symbol,exchangeName:"CMX",instrumentType:"FUTURE",regularMarketPrice:2400,
      regularMarketVolume:symbol==="GCZ28.CMX"?1000:400,regularMarketTime:+now/1000,expireDate:+now/1000+86400,
      currentTradingPeriod:{regular:{start:+now/1000-3600,end:+now/1000+3600}}}}]}});
  });
  const result=await f.datedContracts(["GCZ28.CMX","GCG29.CMX","GCQ28.CMX"],now);
  const {activeContract}=await import("../src/gold-briefing");
  expect(activeContract(result,now)?.symbol).toBe("GCZ28.CMX");
});
test("watchlist crypto precedente leggibile con la stessa identità e senza riscrittura",async()=>{
  const {savedWatchlist,Discovery}=await import("../src/discovery");
  const {catalog}=await import("../src/discovery-sources");
  const {FakeAgents}=await import("../src/agents");
  const {createHash}=await import("node:crypto");
  const s=await state(), symbol="BTC-USD", venue="Yahoo Finance, aggregato spot USD";
  const id=createHash("sha256").update(JSON.stringify(["crypto",venue,symbol])).digest("hex").slice(0,24);
  const watchlist={[id]:{instrument:{symbol,category:"crypto",ticker:symbol,venue},addedAt:new Date().toISOString()}};
  await s.write("watchlist.json",{watchlist});
  expect(await savedWatchlist(s)).toEqual([{symbol,category:"crypto",venue:"Alpaca Crypto US",ticker:"BTC/USD"}]);
  const engine=new Discovery(s,new FakeAgents(),s=>s);
  const item=catalog.find(i=>i.symbol===symbol)!;
  await engine.collect({coverage:[],candidates:[{instrument:item} as any]},[],new Date());
  expect((await s.read<any>("watchlist.json")).watchlist).toEqual(watchlist);
  expect(await engine.proposals()).toEqual([]);
});
