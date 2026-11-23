import {entryPlan,validBar,type Plan,type Bar,type Strategy} from "./strategies";
import {nyInstant,validDate} from "./time";
import type {MarketSession} from "./broker";

export type Tape={symbol:string; source:string; sessions:(MarketSession & {bars:Bar[]})[]};
type Trade={date:string;strategy:Strategy;outcome:"stop"|"target"|"time";r:number};
export function outcome(plan:Plan,bars:Bar[],bps:number):Omit<Trade,"strategy"|"date">|undefined{
  const first=bars[0];
  if(!first || first.o>plan.entry) return; // Require a fillable limit at the next open.
  const fill=Math.min(plan.entry,first.o*(1+bps/10000));
  const risk=plan.entry-plan.stop;
  const result=(outcome:Trade["outcome"],price:number)=>({outcome,r:(price*(1-bps/10000)-fill)/risk});
  for(const [index,bar] of bars.entries()){
    if (index === bars.length-1) return result(bar.o <= plan.stop ? "stop" : "time",bar.o);
    if(bar.l<=plan.stop) return result("stop",Math.min(bar.o,plan.stop));
    if(bar.h>=plan.targets[1]) return result("target",plan.targets[1]);
  }
  throw Error("Serie di uscita incompleta");
}
function metrics(trades:Trade[]){
  const closed=trades, wins=closed.filter(t=>t.r>0);
  const gains=wins.reduce((s,t)=>s+t.r,0), losses=closed.reduce((s,t)=>s-Math.min(0,t.r),0);
  let pnl=0,peak=0,drawdown=0;
  for(const t of closed){pnl+=t.r;peak=Math.max(peak,pnl);drawdown=Math.max(drawdown,peak-pnl);}
  return {trades:trades.length,closed:closed.length,stillOpen:trades.length-closed.length,
    winRate:closed.length?wins.length/closed.length:null,profitFactor:losses>0?gains/losses:null,
    expectancyR:closed.length?pnl/closed.length:null,maximumDrawdownR:drawdown,targetR:2};
}
export function replay(tape:Tape, strategy:Strategy, simulations=1000, seed=12345, bps=5){
  if(!Number.isInteger(simulations)||simulations<1||simulations>10000 || !Number.isSafeInteger(seed) || !Number.isFinite(bps)||bps<0||bps>100)
    throw Error("Parametri di simulazione non validi");
  if(!["orb","resistance"].includes(strategy)||!tape.symbol || !tape.source || !Array.isArray(tape.sessions)) throw Error("Archivio non valido");
  const trades:Trade[]=[], daily:Bar[]=[], history:Bar[]=[];
  const split=Math.max(20,Math.floor(tape.sessions.length*.7));
  for(const [i,session] of tape.sessions.entries()){
    const bars=session.bars;
    if(!validDate(session.date)||!/^\d\d:\d\d$/.test(session.open)||!/^\d\d:\d\d$/.test(session.close)||
      (i && session.date<=tape.sessions[i-1].date))throw Error("Calendario non ordinato");
    const start=+nyInstant(session.date,session.open),end=+nyInstant(session.date,session.close);
    if(!bars.length || bars.length*900000!==end-start || bars.some((b,i)=>!validBar(b)||Date.parse(b.t)!==start+i*900000))
      throw Error("Sessione incompleta: "+session.date);
    let traded=false;
    for(const [j,b] of bars.entries()){
      history.push(b);
      if(traded || daily.length<20) continue;
      const now=new Date(Date.parse(b.t)+900000);
      const plan=entryPlan({symbol:tape.symbol,source:tape.source,updated:b.t,intervals:{"1Day":daily,"15Min":history.slice(-48)}},session,now,[strategy],true);
      const trade=plan && outcome(plan,bars.slice(j+1),bps);
      if(trade){trades.push({...trade,date:session.date,strategy});traded=true;}
    }
    daily.push({t:nyInstant(session.date,"00:00").toISOString(),o:bars[0].o,h:Math.max(...bars.map(b=>b.h)),
      l:Math.min(...bars.map(b=>b.l)),c:bars.at(-1)!.c,v:bars.reduce((s,b)=>s+(b.v??0),0)});
  }
  const boundary=tape.sessions[split]?.date;
  const validation=trades.filter(t=>boundary && t.date>=boundary);
  const pool=validation;
  // Chronological expanding history. Rules and parameters stay fixed across folds.
  const walkForward=[];
  for(let start=split; start<tape.sessions.length; start+=5){
    const dates=tape.sessions.slice(start,start+5).map(s=>s.date);
    walkForward.push({historyThrough:tape.sessions[start-1].date,from:dates[0],through:dates.at(-1),
      ...metrics(validation.filter(t=>dates.includes(t.date)))});
  }
  let rng=seed>>>0;
  const means:number[]=[];
  if(pool.length>=10) for(let i=0;i<simulations;i++){
    let sum=0;
    for(let j=0;j<pool.length;j++){rng=(Math.imul(1664525,rng)+1013904223)>>>0;sum+=pool[Math.floor(rng/4294967296*pool.length)].r;}
    means.push(sum/pool.length);
  }
  means.sort((a,b)=>a-b);
  return {symbol:tape.symbol,source:tape.source,strategy,sessions:tape.sessions.length,seed,bps,validationStart:boundary,
    walkForward,development:metrics(trades.filter(t=>!boundary||t.date<boundary)),outOfSample:metrics(validation),
    bootstrap:means.length?{simulations,p05:means[Math.floor(means.length*.05)],p95:means[Math.floor(means.length*.95)]}:"campione insufficiente",
    trades};
}
