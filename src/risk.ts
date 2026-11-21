import { universe, type BrokerOrder, type Proposal, type Snapshot } from "./broker";
import type { Series } from "./market";
import type { Wake } from "./time";

export const riskLimits = { maxPositions: 5, maxExposure: 0.2, stopLoss: 0.03, wholeShares: true, shortSelling: false, leverage: false } as const;

export const terminal = new Set(["filled", "canceled", "expired", "rejected", "replaced"]);
export const trading = (wake: Wake, snapshot: Snapshot) => wake.slot !== "09:00" && snapshot.clock.is_open === true;

function remaining(order: BrokerOrder) {
  return Math.max(0, Number(order.qty) - Number(order.filled_qty));
}

export function stops(snapshot: Snapshot): Proposal[] {
  return snapshot.positions.flatMap(position => {
    const avg = Number(position.avg_entry_price);
    const current = Number(position.current_price);
    if (!(avg > 0 && current > 0 && current <= avg * (1 - riskLimits.stopLoss))) return [];
    const qty = Math.floor(Math.min(Number(position.qty), Number(position.qty_available)));
    return [{ symbol: position.symbol, side: "sell", qty, reason: "Stop obbligatorio: perdita di almeno il 3% dal prezzo medio." }];
  });
}

export function limitFor(order: Proposal, charts: Series[], now: Date) {
  if (order.side === "sell") return null;
  const last = charts.find(x => x.symbol === order.symbol)?.intervals["15Min"]?.at(-1);
  const age = last ? +now - Date.parse(last.t) : Infinity;
  if (!last || !(age >= 0 && age <= 45 * 60_000) || !Number.isFinite(last.c) || last.c <= 0) return null;
  const decimals = last.c >= 1 ? 100 : 10000;
  return Math.floor(last.c * decimals) / decimals;
}

export function ticketFor(order: Proposal, limit: number | null) {
  return JSON.stringify({ symbol: order.symbol, side: order.side, qty: order.qty, type: limit === null ? "market" : "limit", limit, timeInForce: "day" });
}

export function risk(order: Proposal, limit: number | null, snapshot: Snapshot, entry: Wake): string | undefined {
  if (!universe.some(symbol => symbol === order.symbol)) return "Simbolo fuori dall’universo operativo Alpaca Paper.";
  if (!trading(entry, snapshot)) return entry.slot === "09:00" ? "Il briefing non invia ordini." : "Alpaca indica mercato chiuso.";
  if (snapshot.account.trading_blocked !== false) return "Alpaca segnala operatività bloccata o non verificabile.";
  if (!Number.isSafeInteger(order.qty) || order.qty <= 0) return "Quantità intera disponibile insufficiente.";
  const open = snapshot.orders.filter(item => !terminal.has(item.status));
  const held = snapshot.positions.find(position => position.symbol === order.symbol);
  const available = Math.min(Number(held?.qty ?? 0), Number(held?.qty_available ?? 0));
  if (order.side === "sell") {
    const reserved = open.filter(x => x.side === "sell" && x.symbol === order.symbol).reduce((sum, x) => sum + remaining(x), 0);
    const unreserved = Math.min(available, Number(held?.qty ?? 0) - reserved);
    if (!(unreserved >= order.qty)) return "Azioni disponibili insufficienti, compresi gli ordini di vendita pendenti.";
    return;
  }

  if (limit === null || !(limit > 0)) return "Prezzo limite non calcolabile: candela intraday assente o vecchia.";
  const pending = open.filter(x => x.side === "buy");
  if (pending.some(x => !(Number(x.limit_price) > 0) || !Number.isFinite(remaining(x)))) return "Esposizione di un acquisto pendente non quantificabile.";
  const titles = new Set([...snapshot.positions.filter(x => Number(x.qty) !== 0).map(x => x.symbol),
    ...pending.filter(x => remaining(x) > 0).map(x => x.symbol), order.symbol]);
  if (titles.size > riskLimits.maxPositions) return "Il portafoglio supererebbe cinque titoli.";
  const cost = order.qty * limit;
  const pendingCost = (items: BrokerOrder[]) => items.reduce((sum, x) => sum + remaining(x) * Number(x.limit_price), 0);
  const exposure = Math.abs(Number(held?.market_value ?? 0)) + pendingCost(pending.filter(x => x.symbol === order.symbol)) + cost;
  if (!(exposure <= Number(snapshot.account.equity) * riskLimits.maxExposure)) return "L’esposizione supererebbe il 20% del conto o non è verificabile.";
  if (!(cost + pendingCost(pending) <= Number(snapshot.account.cash) && cost <= Number(snapshot.account.buying_power))) return "Liquidità disponibile insufficiente considerando gli ordini pendenti.";
}
