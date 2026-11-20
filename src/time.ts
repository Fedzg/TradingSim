export const slots = ["09:00", "15:40", "18:30", "21:40"] as const;
export type Slot = typeof slots[number];
export type Wake = { date: string; slot: Slot; id: string };
const format = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function rome(now: Date) {
  const p = Object.fromEntries(format.formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function wake(date: string, slot: Slot): Wake {
  return { date, slot, id: `${date}-${slot.replace(":", "")}` };
}

export function missed(after: Wake, before: Wake) {
  const result: string[] = [];
  const day = new Date(after.date + "T00:00:00Z");
  for (; day.toISOString().slice(0, 10) <= before.date; day.setUTCDate(day.getUTCDate() + 1)) {
    for (const slot of slots) {
      const entry = wake(day.toISOString().slice(0, 10), slot);
      if (entry.id > after.id && entry.id < before.id) result.push(`${entry.date} ${slot}`);
    }
  }
  return result;
}

export function nextWake(now: Date) {
  const { date, time } = rome(now);
  const next = slots.find(slot => slot > time);
  if (next) return `${date} ${next}`;
  const tomorrow = new Date(date + "T00:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return `${tomorrow.toISOString().slice(0, 10)} 09:00`;
}
