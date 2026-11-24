import type {MarketSession} from "./broker";
import {newYork,nyInstant} from "./time";

export function intradayTime(timestamp:string, provider:string, evaluatedAt:Date, receivedAt?:string, session?:MarketSession, convention:"open"|"close"|"unknown"=provider==="Alpaca IEX"?"open":"unknown"){
  const stamp=Date.parse(timestamp);
  const open=convention==="open"?stamp:convention==="close"?stamp-900000:NaN;
  const close=open+900000;
  const iso=(n:number)=>Number.isFinite(n)?new Date(n).toISOString():null;
  const age=Number.isFinite(close)?+evaluatedAt-close:null;
  let sessionType="unknown";
  if(session && Number.isFinite(open) && newYork(new Date(open)).date===session.date){
    const start=+nyInstant(session.date,session.open), end=+nyInstant(session.date,session.close);
    sessionType=close<=start?"premarket":open>=end?"after-hours":open>=start && close<=end?"regular":"unknown";
  }
  return {barOpenTime:iso(open),barCloseTime:iso(close),timeframe:"15Min",receivedAt:receivedAt??null,evaluatedAt:evaluatedAt.toISOString(),provider,sessionType,
    isClosed:age===null?null:age>=0,dataAgeMs:age===null || age<0?null:age,isStale:age===null?null:age>75*60000};
}
