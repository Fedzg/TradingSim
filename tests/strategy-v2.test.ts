import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBroker, FakeMcp, type Intent, type Snapshot } from "../src/broker";
import { FakeAgents, type Role } from "../src/agents";
import { Market, type Series } from "../src/market";
import { State } from "../src/state";
import { run } from "../src/run";
import { capacity, entryPlan, executionMode, setups, type Bar } from "../src/strategies";
import { breakerOpen, confirms, recordHealth } from "../src/strategy-controls";
import { manageBrackets } from "../src/strategy-exits";
import { outcome, replay } from "../src/replay";
import { filings, fundamentals } from "../src/edgar";
import { nyInstant, wake } from "../src/time";

const day={date:"2026-11-23",open:"09:30",close:"16:00"};
const now=nyInstant(day.date,"10:00");
const open=+nyInstant(day.date,day.open);
const q=900000;
const bar=(time:number):Bar=>({t:new Date(time).toISOString(),o:99,h:100,l:98,c:99,v:2000});
function chart():Series{
  const daily=Array.from({length:25},(_,i)=>bar(open-(27-i)*86400000));
  const history=Array.from({length:20},(_,i)=>bar(open-3*86400000+i*q));
  return {symbol:"SPY",source:"Alpaca IEX",updated:now.toISOString(),intervals:{
    "15Min":[...history,bar(open),{...bar(open+q),o:99.5,h:101.3,c:101,v:5000}],
    "1Day":daily}};
}
const signal=()=>entryPlan(chart(),day,now,["orb"])!;
let state:State;
let prev:string|undefined,strategies:string|undefined;
beforeEach(async()=>{
  prev=process.env.TRADINGSIM_EXECUTION_MODE;strategies=process.env.TRADINGSIM_STRATEGIES;
  process.env.TRADINGSIM_EXECUTION_MODE="paper-auto";process.env.TRADINGSIM_STRATEGIES="orb,resistance";
  setSystemTime(now);
  state=new State(await mkdtemp(join(tmpdir(),"ts-v2-")));
  await state.write("fake-calendar.json",[day]);
  await state.write("fake-quotes.json",{SPY:{t:now.toISOString(),bp:100.99,ap:101}});
});
afterEach(async()=>{
  setSystemTime();
  for(const [key,val] of [["TRADINGSIM_EXECUTION_MODE",prev],["TRADINGSIM_STRATEGIES",strategies]] as const)
    if(val===undefined) delete process.env[key];else process.env[key]=val;
  await rm(state.root,{recursive:true,force:true});
});
test("ORB e resistenza richiedono candela completa, feed autorizzato, liquidità e sessione",()=>{
  const p=signal();expect(p.level).toBe(100);expect(p.targets).toEqual([103,105,107]);
  expect(entryPlan(chart(),day,now,["resistance"])?.strategy).toBe("resistance");
  for(const source of ["Yahoo","Twelve Data"])expect(entryPlan({...chart(),source},day,now,["orb"])).toBeUndefined();
  expect(entryPlan({...chart(),symbol:"BTC-USD"},day,now,["orb"])).toBeUndefined();
  for(const time of [+now-1,+now+300001])expect(entryPlan(chart(),day,new Date(time),["orb"])).toBeUndefined();
  expect(entryPlan(chart(),{...day,close:"10:10"},now,["orb"])).toBeUndefined();
  const c=chart();c.intervals["15Min"].at(-1)!.v=2;expect(entryPlan(c,day,now,["orb"])).toBeUndefined();
});
test("budget aggregato, perdita giornaliera, dati del conto e spread",async()=>{
  const p=signal(),s=await new FakeBroker(state).snapshot();
  expect(capacity(p,s,[],now)).toBe(11);
  expect(capacity(p,{...s,account:{...s.account,equity:"9800"}},[],now)).toBe(0);
  expect(capacity(p,{...s,account:{...s.account,trading_blocked:true}},[],now)).toBe(0);
  expect(capacity(p,{...s,account:{...s.account,cash:"100"}},[],now)).toBe(0);
  expect(capacity(p,{...s,positions:[{symbol:"QQQ",qty:"2",market_value:"1950"}] as Snapshot["positions"]},[],now)).toBe(0);
  expect(confirms(p,{bp:101,ap:102,t:now.toISOString()},+now)).toBe(false);
  expect(confirms(p,{bp:101,ap:101,t:new Date(+now-61000).toISOString()},+now)).toBe(false);
});
async function harness(verdict="approve"){
  const args:Record<string,any>[]=[];
  const mcp=new FakeMcp(state);
  const broker=new FakeBroker(state,{call(name,params){
    if(name==="place_stock_order")args.push(params??{});
    return mcp.call(name,params);
  }});
  const market=new Market(undefined,true);
  market.charts=async()=>[chart()];
  const roles:Role[]=[];
  class Analyst extends FakeAgents{
    async invoke(role:Role,input?:unknown){
      roles.push(role);
      if(role==="review"){
        if(verdict==="expire")setSystemTime(new Date(+now+301000));
        return {verdict:verdict==="reject"?"reject":"approve",reason:"fixture"};
      }
      return super.invoke(role,input);
    }
  }
  const start=()=>run({state,broker,market,agents:new Analyst(),redact:s=>s},wake(day.date,"18:30"),true,now);
  return {start,args,roles,broker};
}
test("auto Paper usa ticket revisionato e bracket MCP, rilancio senza duplicati",async()=>{
  const h=await harness();await h.start();
  expect(h.roles.slice(-3)).toEqual(["challenge","answer","review"]);
  expect(h.args).toHaveLength(1);
  expect(h.args[0]).toMatchObject({side:"buy",symbol:"SPY",qty:"11",order_class:"bracket",
    limit_price:"101",stop_loss_stop_price:"99",take_profit_limit_price:"105"});
  await h.start();expect(await h.broker.orders()).toHaveLength(1);
  expect((await state.intents())[0].plan?.strategy).toBe("orb");
});
for(const scenario of ["reject","expire","holiday","analysis-only","disallowed","missing quote","breaker"])test("Nessun invio: "+scenario,async()=>{
  const h=await harness(scenario);
  if(scenario==="holiday") await state.write("fake-calendar.json",[]);
  if(scenario==="analysis-only")process.env.TRADINGSIM_EXECUTION_MODE=scenario;
  if(scenario==="disallowed")process.env.TRADINGSIM_STRATEGIES="unknown";
  if(scenario==="missing quote")await state.write("fake-quotes.json",{});
  if(scenario==="breaker"){
    for(const id of ["1","1","2"]) await recordHealth(state,day.date,id,true);
    expect(await breakerOpen(new State(state.root),day.date)).toBe(true);
  }
  await h.start();expect(h.args).toHaveLength(0);
});
test("approvazione manuale vincolata al ticket",async()=>{
  process.env.TRADINGSIM_EXECUTION_MODE="approval-required";
  const h=await harness();const pending=h.start();
  let keys:string[]=[];
  for(let i=0;i<120 && !keys.length;i++){await Bun.sleep(20);keys=await state.list("approvals");}
  expect(keys).toHaveLength(1);expect(h.args).toHaveLength(0);
  await state.write("permissions/"+keys[0],{at:now.toISOString()});
  await pending;expect(h.args).toHaveLength(1);
});
test("Replay conservativo su gap, doppio tocco, uscita temporale e ordine non eseguibile",()=>{
  const p=signal();
  const both={...bar(open),o:101,h:110,l:95,c:105};
  expect(outcome(p,[both,both],0)).toEqual({outcome:"stop",r:-1});
  expect(outcome(p,[{...both,o:102},both],0)).toBeUndefined();
  expect(outcome(p,[{...both,h:102,l:100}, {...both,o:94}],0)).toEqual({outcome:"stop",r:-3.5});
  expect(outcome(p,[{...both,h:102,l:100},{...both,o:103}],0)).toEqual({outcome:"time",r:1});
  expect(()=>replay({symbol:"SPY",source:"test",sessions:[{...day,bars:[both]}]},"orb")).toThrow();
});
test("SEC filtra CIK, conserva accession e separa data deposito e disponibilità storica",()=>{
  const rows={cik:320193,filings:{recent:{form:["8-K"],accessionNumber:["0000320193-26-000123"],primaryDocument:["release.htm"],acceptanceDateTime:[now.toISOString()],items:["2.02"]}}};
  expect(filings("AAPL",rows,now)[0].title).toContain("risultati");
  expect(filings("AAPL",rows,new Date(+now-1))).toHaveLength(0);
  expect(()=>filings("MSFT",rows,now)).toThrow();
  const facts={cik:320193,facts:{"us-gaap":{Revenues:{units:{USD:[{frame:"CY2026Q3",filed:"2026-11-24",form:"10-Q",val:999},{frame:"CY2026Q2",filed:"2026-08-01",form:"10-Q",val:20}]}}}}};
  expect(fundamentals("AAPL",facts,now).revenue?.value).toBe(20);
});
test("Scanner giornaliero e modalità sconosciuta",()=>{
  const bars=chart().intervals["1Day"];bars[bars.length-1]={...bars.at(-1)!,o:101,h:103,l:101,c:102};
  expect(setups(bars)).toContain("breakout-20");expect(setups(bars)).toContain("gap");
  process.env.TRADINGSIM_EXECUTION_MODE="live";expect(executionMode).toThrow();
});

test("Uscita temporale modifica solo la gamba target, risposta persa senza reinvio",async()=>{
  const plan=signal(), at=new Date(plan.exitAt+1000);
  setSystemTime(at);
  const intent:Intent={id:"fixture-SPY",order:{side:"buy",symbol:"SPY",qty:2,reason:"fixture"},limit:plan.entry,plan,attemptedAt:now.toISOString()};
  await state.write("intents/"+intent.id+".json",intent);
  const parent={id:"parent",symbol:"SPY",client_order_id:intent.id,side:"buy" as const,qty:"2",filled_qty:"2",limit_price:"101",status:"filled"};
  const leg={...parent,side:"sell" as const,status:"new",filled_qty:"0"};
  const snapshot=await new FakeBroker(state).snapshot();
  let requests=0;
  const broker={bracket:async()=>({parent,legs:[{...leg,id:"tp",limit_price:"105"},{...leg,id:"sl",limit_price:null,stop_price:"99"}]}),
    quote:async()=>({bp:102,ap:102.01,t:at.toISOString()}),find:async()=>undefined,
    snapshot:async()=>({...snapshot,positions:[{symbol:"SPY",qty:"2"}] as Snapshot["positions"]}),calendar:async()=>[day],
    lowerTarget:async(id:string,_key:string,limit:number)=>{expect([id,limit]).toEqual(["tp",102]);requests++;throw Error("risposta persa");},
    cancelUnfilled:async()=>{throw Error("inatteso");}};
  await manageBrackets(state,broker,new FakeAgents(),at);
  await manageBrackets(new State(state.root),broker,new FakeAgents(),at);
  expect(requests).toBe(1);
});
