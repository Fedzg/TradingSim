import type { Alpaca, BrokerOrder, MarketSession } from "./broker";
import { enqueue, outboxId } from "./chat";
import { briefingSession } from "./market-session";
import { paperAccount } from "./paper-summary";
import type { Baton, State } from "./state";
import { newYork, nyInstant, rome } from "./time";
import { orderStatus } from "./wake-report";

export const closeCalendar = "close-calendar.json";
export type CloseSchedule = { date: string; session: MarketSession | null };
export const closeReportId = (date: string) => outboxId("chiusura", date);
export const closeDue = (day: MarketSession, now: Date) => +now >= +nyInstant(day.date, day.close) + 5 * 60_000;

export async function dailyClose(state: State, broker: Pick<Alpaca, "calendar" | "clock" | "snapshot" | "fills" | "orderById">,
  now: Date, redact: (value: string) => string) {
  const { date } = newYork(now);
  if (await state.read(`outbox/${closeReportId(date)}.json`)) return;
  let schedule = await state.read<CloseSchedule>(closeCalendar);
  if (schedule?.date !== date) {
    schedule = { date, session: (await broker.calendar(date, date))[0] ?? null };
    await state.write(closeCalendar, schedule);
  }
  if (!schedule.session || !closeDue(schedule.session, now)) return;
  const clock = await broker.clock();
  const session = briefingSession([schedule.session], clock, now);
  if (clock.is_open || !session.previous || !closeDue(session.previous, session.at)) return;

  const [account, executions] = await Promise.allSettled([broker.snapshot(), broker.fills(date)]);
  const issue = (error: unknown) => redact(error instanceof Error ? error.message : "Causa non disponibile.");
  const snapshot = account.status === "fulfilled" ? account.value : undefined;
  const current = snapshot && Math.abs(Date.parse(snapshot.clock.timestamp) - +now) <= 5 * 60_000 ? snapshot : undefined;
  const orders = new Map<string, BrokerOrder>();
  for (const order of snapshot?.orders ?? []) {
    if (order.id && order.submitted_at && newYork(new Date(order.submitted_at)).date === date) orders.set(order.id, order);
  }
  const byOrder = new Map<string, { symbol: string; side: string; qty: number }>();
  if (executions.status === "fulfilled") {
    for (const fill of executions.value.filter(item => newYork(new Date(item.transaction_time)).date === date)) {
      const existing = byOrder.get(fill.order_id);
      byOrder.set(fill.order_id, { symbol: fill.symbol, side: fill.side, qty: Number(fill.qty) + (existing?.qty ?? 0) });
    }
  }
  const recentOrders = new Map(snapshot?.orders.flatMap(order => order.id ? [[order.id, order] as const] : []));
  for (const id of byOrder.keys()) {
    if (orders.has(id)) continue;
    try { orders.set(id, recentOrders.get(id) ?? await broker.orderById(id)); } catch {}
  }

  const history = new Map<string, Baton>();
  const days = new Set([date, rome(nyInstant(date, "16:00")).date]);
  const files = await state.list("history");
  for (const name of files.filter(file => [...days].some(day => file.startsWith(day)))) {
    const row = await state.read<Baton>(`history/${name}`).catch(() => undefined);
    if (!row?.wake || !row.savedAt) continue;
    const prior = history.get(row.wake.id);
    if (!prior || prior.savedAt < row.savedAt) history.set(row.wake.id, row);
  }
  const decisions = [...history.values()].sort((a, b) => a.wake.id.localeCompare(b.wake.id)).flatMap(row => {
    const fallback = row.report?.split("\n").filter(line => /^(Proposto dal decisore|Motivazione|Respinto|Nessun ordine discrezionale|⚠)/.test(line)) ?? [];
    const items = row.summary ? [...row.summary.reasons, ...row.summary.alerts, ...fallback.filter(line => line.startsWith("Proposto"))] : fallback;
    return [...new Set(items)].slice(0, 4).map(item => `• ${row.wake.slot} Roma · ${item.slice(0, 230)}`);
  });
  const quantities = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 9 });
  const tradeLines = [...new Set([...orders.keys(), ...byOrder.keys()])].map(id => {
    const order = orders.get(id);
    const fill = byOrder.get(id);
    const qty = executions.status === "fulfilled" ? fill?.qty ?? 0 : order ? Number(order.filled_qty) : undefined;
    const action = (order?.side ?? fill?.side) === "buy" ? "Acquisto" : "Vendita";
    return `• ${order?.symbol ?? fill?.symbol} · ${action} · ${order ? orderStatus(order.status) : "stato non verificabile"} · ${qty === undefined
      ? "eseguite oggi non verificabili" : `eseguite oggi ${quantities.format(qty)}`}`;
  });
  const close = rome(nyInstant(date, schedule.session.close));
  const lines = [
    `Seduta USA ${date} · chiusura ${close.time} Roma`,
    "",
    "Operazioni Paper della giornata",
    ...(tradeLines.length ? tradeLines : snapshot && executions.status === "fulfilled" ? ["Nessuna operazione rilevata."] : []),
    ...(executions.status === "rejected" ? [`Eseguiti non verificabili. ${issue(executions.reason)}`] : []),
    ...(account.status === "rejected" ? [`Elenco ordini della giornata incompleto. ${issue(account.reason)}`] : []),
    "",
    "Conto e posizioni Paper",
    ...paperAccount(current, account.status === "rejected" ? issue(account.reason) : "Timestamp Alpaca non recente."),
    "",
    "Decisioni e problemi registrati fino al riepilogo",
    ...(decisions.length ? decisions : ["Nessuna decisione salvata per questa giornata."]),
  ];
  await enqueue(state, date, "chiusura", redact(lines.join("\n")), date, "daily-close");
}
