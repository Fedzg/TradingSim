import {cached,publicResponse} from "./provider-cache";
import type {Article} from "./market";
import type {State} from "./state";
export const issuers={AAPL:"0000320193",MSFT:"0000789019",NVDA:"0001045810"} as const;
export const edgarUserAgent = () => process.env.TRADINGSIM_SEC_USER_AGENT?.trim() || undefined;
type Issuer=keyof typeof issuers;
export function filings(symbol:Issuer,data:any,now:Date):Article[]{
  if(Number(data.cik)!==Number(issuers[symbol])) throw Error("CIK SEC non corrispondente");
  const r=data.filings.recent;
  return r.form.flatMap((form:string,i:number)=>{
    const acc=r.accessionNumber[i], doc=r.primaryDocument[i], at=r.acceptanceDateTime[i];
    if(!["8-K","10-Q","10-K"].includes(form) || !/^\d{10}-\d{2}-\d{6}$/.test(acc)||!/^[-\w.]+\.htm[l]?$/.test(doc) ||
       !Number.isFinite(Date.parse(at)) || Date.parse(at)>+now || +now-Date.parse(at)>48*3600000)return [];
    const items=String(r.items?.[i]??"").split(",").map((s:string)=>s.trim());
    const tag=items.includes("2.02")?"risultati":items.includes("5.02")?"management":items.includes("2.01")?"operazione societaria":"comunicazione regolamentare";
    return [{title:`${symbol} · SEC ${form} · ${tag}`,link:`https://www.sec.gov/Archives/edgar/data/${Number(issuers[symbol])}/${acc.replaceAll("-","")}/${doc}`,
      source:"SEC EDGAR",published:new Date(at).toISOString(),summary:"Accettazione deposito SEC "+acc+"; data dell’evento da verificare.",symbols:[symbol]}];
  });
}
export function fundamentals(symbol:Issuer,data:any,at:Date){
  if(Number(data.cik)!==Number(issuers[symbol])) throw Error("CIK SEC non corrispondente");
  const concepts=data.facts?.["us-gaap"]??{};
  const values=(tags:string[],unit:string)=>{
    const rows=new Map<string,any>();
    for(const tag of tags)for(const fact of concepts[tag]?.units?.[unit]??[]){
      if(!/^CY\d{4}Q[1-4]$/.test(fact.frame)||!Number.isFinite(fact.val)||!/^\d{4}-\d\d-\d\d$/.test(fact.filed)||
        fact.filed>=at.toISOString().slice(0,10)||!["10-K","10-Q","10-K/A","10-Q/A"].includes(fact.form)) continue;
      if(!rows.has(fact.frame)||rows.get(fact.frame).filed<fact.filed) rows.set(fact.frame,fact);
    }
    return [...rows.values()].sort((a,b)=>b.frame.localeCompare(a.frame));
  };
  const rev=values(["Revenues","RevenueFromContractWithCustomerExcludingAssessedTax"],"USD"), income=values(["NetIncomeLoss"],"USD"), eps=values(["EarningsPerShareDiluted"],"USD/shares");
  const summary=(rows:any[])=>{
    const row=rows[0]; if(!row)return null;
    const year=Number(row.frame.slice(2,6)),q=Number(row.frame.at(-1));
    const growth=(frame:string)=>{const past=rows.find(x=>x.frame===frame);return past && past.val>0?row.val/past.val-1:null};
    return {period:row.frame,value:row.val,filed:row.filed,accession:row.accn,qoq:growth(q===1?`CY${year-1}Q4`:`CY${year}Q${q-1}`),yoy:growth(`CY${year-1}Q${q}`)};
  };
  return {symbol,source:"SEC EDGAR companyfacts",revenue:summary(rev),netIncome:summary(income),eps:summary(eps),
    netMargin:rev[0]?.val>0 && rev[0].frame===income[0]?.frame?income[0].val/rev[0].val:null};
}
export async function secData(state:State,symbol:Issuer,facts:boolean){
  const agent=edgarUserAgent();
  if(!agent) throw Error("SEC EDGAR disattivato: impostare TRADINGSIM_SEC_USER_AGENT con un contatto reale.");
  if(!Object.hasOwn(issuers,symbol)) throw Error("SEC EDGAR: emittente non supportato.");
  const url="https://data.sec.gov/"+(facts?"api/xbrl/companyfacts/":"submissions/")+"CIK"+issuers[symbol]+".json";
  return cached(state,"sec",url,facts?86400000:900000,async()=>await (await publicResponse(new URL(url),{"User-Agent":agent})).json(),8,500);
}
