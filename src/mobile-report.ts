import {shortReport} from "./report-text";
const italian=new Intl.DateTimeFormat("it-IT",{timeZone:"Europe/Rome",dateStyle:"short",timeStyle:"short"});
export function mobileReport(kind:string,original:string){
  let lines=original.split("\n");
  if(kind==="gold"){
    lines=lines.filter(line=>!/^Min\/max seduta|^Volume seduta|^Scenari |^\d+[mhd] · |^VWAP seduta/.test(line));
    const next=lines.indexOf("PROSSIMO CONTROLLO"), end=lines.indexOf("OPERAZIONI");
    if(next>=0 && end>next) lines.splice(next,end-next);
  }
  return lines.map(line=>shortReport(line,320)
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,t=>italian.format(new Date(t))+" Roma")
    .replaceAll("sessione 24/7 · sessione 24/7","sessione 24/7")).join("\n");
}
