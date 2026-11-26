import identity from "./build-identity.json";
export const producer=identity as {commit:string|null;builtAt:string|null;version:string;schema:number;notifications:number;strategy:number};
export function compatibility(origin?:typeof producer){
  if(!origin?.commit) return "LEGACY_UNKNOWN";
  if(origin.schema!==producer.schema || origin.notifications!==producer.notifications) return "INCOMPATIBLE";
  if(origin.strategy!==producer.strategy) return "PREVIOUS_UNVERIFIED";
  return producer.commit===origin.commit?"CURRENT":"PREVIOUS_COMPATIBLE";
}
export function footer(origin?:typeof producer){
  if(!origin) return "Storico legacy · commit sconosciuto";
  if(!origin.commit) return "TradingSim · build con commit sconosciuto";
  return (origin.commit===producer.commit?"TradingSim · commit ":"Storico · commit precedente ")+origin.commit.slice(0,7);
}
