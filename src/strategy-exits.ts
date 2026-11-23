import type { Alpaca, Intent } from "./broker";
import { reviewOrder, type Agents } from "./agents";
import type { State } from "./state";
import { executionMode } from "./strategies";
import { manualPermission, quoteValid, strategyAlert } from "./strategy-controls";
import { briefingSession } from "./market-session";
import { nyInstant, newYork } from "./time";
import { terminal } from "./risk";

type ExitBroker = Pick<Alpaca,"bracket"|"snapshot"|"calendar"|"quote"|"find"|"lowerTarget"|"cancelUnfilled">;

// The exclusive run.guard is shared with entries. Only children returned by a
// nested lookup of our journaled parent can be changed. Never flatten by symbol.
export async function manageBrackets(state: State, broker: ExitBroker, agents: Agents, now=new Date()) {
  const mode=executionMode();
  if (mode==="legacy") return;
  const writable=mode==="approval-required"||mode==="paper-auto";
  for(const intent of (await state.intents()).filter(i=>i.plan && !i.submissionRejection)){
    const plan=intent.plan!;
    const session=newYork(new Date(plan.bar)).date;
    if(session!==newYork(now).date || await state.read("strategy-closed/"+intent.id+".json")) continue;
    const alert=(key:string,text:string)=>strategyAlert(state,intent.id,intent.id+"/"+key,plan.symbol+" · "+text);
    try {
      const {parent,legs}=await broker.bracket(intent);
      for(const leg of legs.filter(l=>Number(l.filled_qty)>0)) {
        const label=leg.stop_price?"Stop":"Target";
        await alert([leg.id,leg.status,leg.filled_qty].join("/"),label+" · "+leg.status+" · vendute "+leg.filled_qty+" di "+leg.qty);
      }
      const fills=Number(parent.filled_qty);
      if(terminal.has(parent.status) && legs.reduce((n,l)=>n+Number(l.filled_qty),0)===fills){
        await state.write("strategy-closed/"+intent.id+".json",{at:now.toISOString()});continue;
      }
      if(!writable) continue;
      if(+now>=plan.expires && !fills && ["accepted","new"].includes(parent.status) && parent.id) {
        // Only send once. Observe broker state on subsequent polls even on response loss.
        const path="strategy-actions/"+intent.id+"-cancel.json";
        if(!await state.read(path)){
          await state.write(path,{at:now.toISOString(),brokerId:parent.id},true);
          await broker.cancelUnfilled(parent.id);
          await alert("expiry","Segnale scaduto. Annullamento richiesto, in attesa del broker.");
        }
        continue;
      }
      if(+now<plan.exitAt || !fills) continue;
      const snapshot=await broker.snapshot();
      const calendar=await broker.calendar(session,session);
      const day=briefingSession(calendar,snapshot.clock,new Date()).today;
      if(!day || !snapshot.clock.is_open || +nyInstant(day.date,day.close)-900000!==plan.exitAt) {
        await alert("missed-close","Uscita temporale non confermata dal broker. Verificare posizione e protezioni.");continue;
      }
      const clientId=intent.id+"-exit";
      const prior=await broker.find(clientId);
      if(prior){await alert("exit/"+prior.status+"/"+prior.filled_qty,"Uscita temporale · "+prior.status+" · eseguite "+prior.filled_qty+"/"+prior.qty);continue;}
      const path="strategy-actions/"+clientId+".json";
      if(await state.read(path)){await alert("unknown-exit","Esito della sostituzione non verificabile. Controllare le gambe del bracket.");continue;}
      const exit=await exitTerms(broker,intent);
      if(!exit){await alert("time-review","Uscita temporale non verificabile. Controllare la posizione Paper.");continue;}
      const ticket=JSON.stringify(exit);
      const review=await reviewOrder(agents,ticket,{reason:"Uscita temporale negli ultimi 15 minuti della seduta. Sostituzione del solo limite di vendita del bracket esistente."});
      if(review.review.verdict!=="approve" || review.ticket!==ticket) {await alert("exit-rejected","Revisore contrario all’uscita temporale.");continue;}
      if(mode==="approval-required" && !await manualPermission(state,clientId,ticket,plan.exitAt+900000)) continue;
      if(Date.now()>=plan.exitAt+900000 || ticket!==JSON.stringify(await exitTerms(broker,intent))) continue;
      await state.write(path,{at:new Date().toISOString(),ticket},true);
      const updated=await broker.lowerTarget(exit.legId,clientId,exit.limit);
      if(updated.client_order_id!==clientId) throw Error("Risposta sostituzione non verificabile");
      await alert("time-exit","Richiesta uscita temporale · limite "+exit.limit+" · eseguite "+updated.filled_qty+"/"+updated.qty);
    } catch {
      await alert("unverified","Gestione del bracket non verificabile. Controllare stato e protezioni sul conto Paper.");
    }
  }
}
async function exitTerms(broker:ExitBroker,intent:Intent){
  const {parent,legs}=await broker.bracket(intent);
  const snapshot=await broker.snapshot();
  if(!snapshot.clock.is_open || snapshot.account.trading_blocked || Math.abs(Date.now()-Date.parse(snapshot.clock.timestamp))>60000) return;
  const target=legs.find(l=>l.limit_price && !l.stop_price);
  const stop=legs.find(l=>l.stop_price && Number(l.stop_price)===intent.plan!.stop);
  const held=snapshot.positions.find(p=>p.symbol===intent.order.symbol);
  if(parent.status!=="filled" || legs.length!==2 || !target?.id || !stop ||
     ![target,stop].every(l=>["new","accepted"].includes(l.status) && Number(l.qty)===intent.order.qty && Number(l.filled_qty)===0) ||
     Number(held?.qty)!==intent.order.qty || !held) return;
  const quote=await broker.quote(held.symbol);
  const limit=Math.floor(quote.bp*100)/100;
  if(!quoteValid(quote,Date.now()) || limit<=intent.plan!.stop || limit>=Number(target.limit_price)) return;
  return {symbol:held.symbol,side:"sell",qty:intent.order.qty,legId:target.id,limit,stop:intent.plan!.stop};
}
