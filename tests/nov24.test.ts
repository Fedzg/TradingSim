import {test,expect} from "bun:test";
import {intradayTime} from "../src/bar-time";
import {shortReport} from "../src/report-text";
test("IEX distingue apertura e chiusura al confine della barra",()=>{
  const at=new Date("2026-11-24T17:30:00Z");
  const session={date:"2026-11-24",open:"09:30",close:"16:00"};
  const timing=intradayTime("2026-11-24T17:15:00Z","Alpaca IEX",at,undefined,session);
  expect(timing).toMatchObject({barCloseTime:at.toISOString(),dataAgeMs:0,isClosed:true,isStale:false,sessionType:"regular"});
  expect(intradayTime(at.toISOString(),"Alpaca IEX",at).isClosed).toBe(false);
  expect(intradayTime(at.toISOString(),"altro",at).isClosed).toBeNull();
  expect(intradayTime(at.toISOString(),"altro",at,undefined,session,"close").barOpenTime).toBe(timing.barOpenTime);
});
test("La sintesi non tronca numeri e Unicode",()=>{
  expect(shortReport("Prezzo 25,13 €. 📊 Seconda frase lunga.",17)).toBe("Prezzo 25,13 €.");
  const long="Una sola frase 📊 ".repeat(50).trim()+".";
  expect(shortReport(long,20)).toBe(long);
});

import {compatibility,producer} from "../src/version";
test("Compatibilità basata sugli schemi e provenienza legacy incerta",()=>{
  expect(compatibility()).toBe("LEGACY_UNKNOWN");
  expect(compatibility({...producer,commit:"a".repeat(40)})).toBe("PREVIOUS_COMPATIBLE");
  expect(compatibility({...producer,commit:"a".repeat(40),schema:99})).toBe("INCOMPATIBLE");
});
test("Orari NY dopo il cambio ora e chiusura anticipata",()=>{
  const day={date:"2026-11-27",open:"09:30",close:"13:00"};
  const evaluated=new Date("2026-11-27T20:00Z");
  for(const [stamp,session] of [["14:00","premarket"],["14:30","regular"],["18:00","after-hours"]])
    expect(intradayTime(day.date+"T"+stamp+"Z","Alpaca IEX",evaluated,undefined,day).sessionType).toBe(session);
});
