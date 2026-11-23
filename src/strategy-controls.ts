import type { State } from "./state";
import type { Plan } from "./strategies";
import { enqueue } from "./chat";

export type Quote = { bp: number; ap: number; t: string };
export function quoteValid(quote: Quote, now: number) {
  const age = now - Date.parse(quote.t);
  return age >= 0 && age <= 60000 && Number.isFinite(quote.ap) &&
    quote.bp > 0 && quote.ap >= quote.bp && quote.ap / quote.bp <= 1.002;
}

export function confirms(plan: Plan, quote: Quote, now: number) {
  return now < plan.expires && quoteValid(quote, now) &&
    quote.bp > plan.level && quote.bp > plan.stop && quote.ap <= plan.entry * 1.002;
}

type Breaker = { failures: number; lastWake: string };
export async function breakerOpen(state: State, date: string) {
  const row = await state.read<Breaker>("strategy-health/" + date + ".json");
  if (!row) return false;
  if (!Number.isSafeInteger(row.failures) || row.failures < 0) throw Error("Contatore guasti non verificabile");
  return row.failures >= 2;
}

export async function recordHealth(state: State, date: string, wake: string, failed: boolean) {
  const path = "strategy-health/" + date + ".json";
  const previous = await state.read<Breaker>(path);
  if (previous?.lastWake === wake || (previous?.failures ?? 0) >= 2) return;
  const failures = failed ? (previous?.failures ?? 0) + 1 : 0;
  await state.write(path, { failures, lastWake: wake });
  if (failures >= 2) await strategyAlert(state, wake, "breaker/" + date,
    "Circuit breaker attivo dopo due sveglie con errori. Ingressi sospesi per la seduta USA.");
}

export function strategyAlert(state: State, wake: string, key: string, text: string) {
  return enqueue(state, wake, "strategia", text, key, "strategy-alert");
}

export async function manualPermission(state:State,id:string,ticket:string,deadline:number) {
  const key=new Bun.CryptoHasher("sha256").update(id+ticket).digest("hex");
  const path="approvals/"+key+".json";
  const expires=Math.min(deadline,Date.now()+60000);
  await state.write(path,{ticket,id,expires},true);
  const saved=await state.read<{expires:number}>(path);
  console.log("In attesa di autorizzazione: "+key);
  while(Date.now()<Math.min(saved?.expires??0,expires)){
    if(await state.read("permissions/"+key+".json")) return true;
    await Bun.sleep(500);
  }
  return false;
}
