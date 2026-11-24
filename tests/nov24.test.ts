import {test,expect} from "bun:test";
import {intradayTime} from "../src/bar-time";
import {shortReport} from "../src/report-text";
import { closeReportId, dailyClose } from "../src/daily-close";
import { State } from "../src/state";
import { wake } from "../src/time";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Il riepilogo USA conserva la motivazione completa anche nel testo mobile", async () => {
  const root = await mkdtemp(join(tmpdir(), "tradingsim-close-"));
  const state = new State(root);
  const date = "2026-11-24";
  const now = new Date(date + "T21:05:30Z");
  const sentence = "Le ultime barre a 15 minuti riportano il timestamp delle 20:15 UTC, circa 25 minuti prima della rilevazione.";
  const reason = "La prima osservazione risale alla seduta regolare. ".repeat(8) + sentence;
  try {
    const entry = wake(date, "21:40");
    await state.write(`history/${entry.id}.json`, { wake: entry, savedAt: now.toISOString(), summary: { reasons: [reason], alerts: [] } });
    await dailyClose(state, {
      async calendar() { return [{ date, open: "09:30", close: "16:00" }]; },
      async clock() { return { timestamp: now.toISOString(), is_open: false, next_open: "2026-11-25T14:30:00Z", next_close: "2026-11-25T21:00:00Z" }; },
      async snapshot() { throw Error("fixture"); },
      async fills() { return []; },
      async orderById() { throw Error("fixture"); },
    }, now, text => text);
    const report = await state.read<{ text: string; mobileText: string }>(`outbox/${closeReportId(date)}.json`);
    expect(report?.text).toContain(sentence);
    expect(report?.mobileText).toContain(sentence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
