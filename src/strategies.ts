import { universe, type Intent, type MarketSession, type Snapshot } from "./broker";
import { relativeVolume,rsi14 } from "./indicators";
import type { Series } from "./market";
import { newYork,nyInstant } from "./time";
import {terminal} from "./risk";
export type Bar=Series["intervals"][string][number];
export const strategies=["orb","resistance"] as const;
export type Strategy=typeof strategies[number];
export type Plan={strategy:Strategy;symbol:string;bar:string;expires:number;exitAt:number;entry:number;stop:number;targets:number[];source:string;level:number;rvol:number};
export const modes=["analysis-only","approval-required","paper-auto"] as const;
export function executionMode(){
  const mode=process.env.TRADINGSIM_EXECUTION_MODE;
  if(mode===undefined || mode==="") return "legacy";
  if(!modes.some(x=>x===mode)) throw Error("Modalità di esecuzione non valida");
  return mode;
}
export function allowedStrategies(){
  return strategies.filter(s=>(process.env.TRADINGSIM_STRATEGIES??"").split(",").map(v=>v.trim()).includes(s));
}
const quarter=900000;
export function validBar(b:Bar){
  return Number.isFinite(Date.parse(b.t)) && [b.o,b.c,b.l,b.h].every(n=>Number.isFinite(n)&&n>0) &&
    b.h>=Math.max(b.o,b.c) && b.l<=Math.min(b.o,b.c);
}
export function setups(bars:Bar[]){
  if(bars.length<22 || bars.some(b=>!validBar(b))) return [];
  const last=bars.at(-1)!, prev=bars.at(-2)!, past=bars.slice(-21,-1);
  const avg=past.reduce((s,b)=>s+b.c,0)/20;
  const rsi=rsi14(bars.map(b=>b.c))!;
  const out:string[]=[];
  if(last.c>Math.max(...past.map(b=>b.h))) out.push("breakout-20");
  if(prev.c<=avg && last.c>avg) out.push("recupero-SMA20");
  if(rsi<30) out.push("RSI-oversold");
  if(rsi14(bars.slice(0,-1).map(b=>b.c))!<30 && last.c>prev.h) out.push("oversold-bounce");
  if(last.o>prev.h || last.o<prev.l) out.push("gap");
  const flag=past.slice(-4);
  if(flag[0].c>past.at(-8)!.c*1.05 && flag.slice(1).every((b,i)=>b.h<=flag[i].h && b.l>past.at(-8)!.c) && last.c>flag[0].h) out.push("bull-flag");
  return out;
}
export function entryPlan(series:Series,session:MarketSession,now:Date,allowed:readonly Strategy[], research=false,reason?:(text:string)=>void):Plan|undefined{
  if(newYork(now).date!==session.date || (!research && (!universe.some(s=>s===series.symbol)|| series.source!=="Alpaca IEX")) || series.error || series.intervalErrors?.["15Min"] || series.intervalErrors?.["1Day"]) {reason?.("Identità o feed non verificabili");return;}
  const open=+nyInstant(session.date,session.open), close=+nyInstant(session.date,session.close);
  if(!(open+2*quarter<=+now && +now<close-quarter)) {reason?.("Fuori finestra di ingresso");return;}
  const completed=(bars:Bar[],duration:number)=>bars.filter(b=>Date.parse(b.t)+duration<=+now);
  const all=completed(series.intervals["15Min"]??[],quarter);
  const daily=completed(series.intervals["1Day"]??[],86400000).filter(b=>newYork(new Date(b.t)).date<session.date);
  if([all,daily].some(bars=>bars.some((b,i)=>!validBar(b)||(i>0 && Date.parse(b.t)<=Date.parse(bars[i-1].t))))) {reason?.("Barre non valide o fuori ordine");return;}
  const today=all.filter(b=>Date.parse(b.t)>=open);
  if(today.length<2 || today.some((b,i)=>Date.parse(b.t)!==open+i*quarter) || daily.length<20 ||
     +now-Date.parse(daily.at(-1)!.t)>5*86400000) {reason?.("Storico insufficiente, discontinuo o datato");return;}
  const last=today.at(-1)!, prev=today.at(-2)!, at=Date.parse(last.t)+quarter;
  const rvol=relativeVolume(all);
  if(+now-at>5*60000 || rvol===null || rvol<1.5 || last.c*(last.v??0)<100000 || last.c<1) {reason?.("Prezzo, volume o freschezza insufficienti");return;}
  const atr=daily.slice(-14).reduce((sum,b,i)=>{const prior=daily[daily.length-15+i].c;
    return sum+Math.max(b.h-b.l,Math.abs(b.h-prior),Math.abs(b.l-prior));},0)/14;
  if(!(atr>0 && atr/last.c<=0.08)) {reason?.("Volatilità fuori limite");return;}
  for(const strategy of allowed){
    const level=strategy==="orb"?today[0].h:Math.max(...daily.slice(-20).map(b=>b.h));
    if(prev.c>level || last.c<=level || last.c<=last.o || last.o>prev.c*1.02) {reason?.("Rottura non confermata o gap oltre il limite");continue;}
    const entry=Math.ceil(last.c*100)/100;
    const support=strategy==="orb"?today[0].l:prev.l;
    const stop=Math.floor(Math.max(entry*.97,entry-atr,support-.01)*100)/100;
    const distance=entry-stop;
    if(distance<entry*.002 || distance>entry*.031) {reason?.("Distanza dello stop fuori limite");continue;}
    return {symbol:series.symbol,strategy,level,entry,stop,targets:[1,2,3].map(r=>Math.round((entry+r*distance)*100)/100),
      rvol,bar:last.t,exitAt:close-quarter,expires:Math.min(at+5*60000,close-quarter),source:series.source};
  }
}
export function capacity(p:Plan,s:Snapshot,intents:Intent[],now:Date):number{
  const equity=Number(s.account.equity), prior=Number(s.account.last_equity);
  const clock=Date.parse(s.clock.timestamp);
  if(!(s.clock.is_open && !s.account.trading_blocked && Math.abs(+now-clock)<=60000 && now.getTime()<=p.expires &&
    prior>0 && equity>prior*.99 && p.entry>p.stop && p.stop>0 && p.targets[1]-p.entry>=1.999*(p.entry-p.stop))) return 0;
  if(s.positions.filter(x=>Number(x.qty)>0).length>=5) return 0;
  if(s.positions.some(x=>x.symbol===p.symbol || Number(x.qty)<0)) return 0;
  const day=newYork(now).date;
  if (intents.some(i=>i.plan && i.plan.symbol===p.symbol && i.plan.bar===p.bar)) return 0;
  const journal=intents.filter(i=>i.order.side==="buy" && newYork(new Date(i.attemptedAt)).date===day);
  const recent=s.orders.filter(o=>o.side==="buy" && (!o.submitted_at || newYork(new Date(o.submitted_at)).date===day));
  if(new Set([...journal.map(i=>i.id),...recent.map(o=>o.client_order_id)]).size>=3) return 0;
  if(journal.some(i=>!i.plan || i.submissionRejection) || recent.some(o=>!journal.some(i=>i.id===o.client_order_id))) return 0;
  const pending=s.orders.filter(o=>o.side==="buy"&&!terminal.has(o.status));
  if(pending.some(o=>o.symbol===p.symbol || !(Number(o.limit_price)>0))) return 0;
  const reserved=pending.reduce((sum,o)=>sum+Math.max(0,Number(o.qty)-Number(o.filled_qty))*Number(o.limit_price),0);
  const exposure=s.positions.reduce((sum,x)=>sum+Math.abs(Number(x.market_value)),0)+reserved;
  const loss=p.entry-p.stop+p.entry*.002;
  const used=journal.reduce((sum,i)=>sum+i.order.qty*(i.plan!.entry-i.plan!.stop+i.plan!.entry*.002),0);
  const budget=Math.min(equity*.0025,prior*.01-Math.max(0,prior-equity)-used);
  const qty=Math.floor(Math.min(budget/loss,(equity*.2-exposure)/p.entry,(Number(s.account.cash)-reserved)/p.entry,Number(s.account.buying_power)/p.entry));
  return Number.isSafeInteger(qty)?Math.max(0,qty):0;
}
