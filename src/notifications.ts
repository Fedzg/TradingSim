import { FakeBroker, type Broker, type BrokerOrder, type Intent } from "./broker";
import { enqueue, flush, outboxId, type Channel, type Message } from "./chat";
import { terminal } from "./risk";
import type { State } from "./state";

const states: Record<string, string> = {
  accepted: "accettato", partially_filled: "eseguito in parte", filled: "eseguito",
  rejected: "respinto", canceled: "annullato", expired: "scaduto",
};
const orderKey = (order: BrokerOrder) => JSON.stringify([order.client_order_id, order.status, Number(order.filled_qty)]);

function orderText(order: BrokerOrder, intent: Intent, source: string) {
  const status = Object.hasOwn(states, order.status) ? states[order.status] : undefined;
  const requested = Number(order.qty), filled = Number(order.filled_qty);
  if (!status || !Number.isFinite(requested) || requested <= 0 || !Number.isFinite(filled) || filled < 0 ||
      (order.status === "filled" && filled <= 0) || order.client_order_id !== intent.id ||
      order.symbol !== intent.order.symbol || order.side !== intent.order.side) return;
  return [
    `${order.symbol} · ${order.side === "buy" ? "Acquisto" : "Vendita"} · ${source}`,
    `Stato: ${status}${order.status === "accepted" && filled === 0 ? ", in attesa di esecuzione" : ""}.`,
    `Quantità richiesta: ${requested}. Quantità eseguita: ${filled}.`,
    `Motivo dell’ordine: ${intent.order.reason.slice(0, 700)}`,
    `ID: ${order.client_order_id}`,
  ].join("\n");
}

export async function queueOrder(state: State, order: BrokerOrder, intent: Intent, source: string, redact: (text: string) => string) {
  const text = orderText(order, intent, source);
  if (text) await enqueue(state, intent.id, "ordine", redact(text), orderKey(order), "order");
}

export async function pollOrders(state: State, broker: Broker, redact: (text: string) => string) {
  const source = broker instanceof FakeBroker ? "broker finto" : "Alpaca Paper";
  for (const intent of await state.intents()) {
    if (intent.observed && terminal.has(intent.observed.status)) continue;
    try {
      const order = await broker.find(intent.id);
      if (order) await queueOrder(state, order, intent, source, redact);
    } catch (error) { console.error(redact(`Verifica ordine ${intent.id}: ${String(error)}`)); }
  }
}

export async function notificationSelector(state: State, redact: (text: string) => string) {
  const registry = await state.read<{ watchlist: Record<string, unknown>; proposals?: Record<string, { status: string }> }>("watchlist.json");
  const additionIds = new Set(Object.keys(registry?.watchlist ?? {})
    .filter(id => registry?.proposals?.[id]?.status === "added")
    .map(id => outboxId("watchlist", `${id}/outcome`)));
  const intents = new Map((await state.intents()).map(intent => [intent.id, intent]));
  return async (message: Message) => {
    if(!message.producer || message.deliveryStatus==="DELIVERY_UNKNOWN") return;
    if (message.kind === "watchlist" && message.notification === "watchlist-addition" && additionIds.has(message.id) &&
        message.text.includes("Aggiunto alla watchlist. Solo monitoraggio.")) return message;
    if (message.kind === "strategia" && message.notification === "strategy-alert") return message;
    if (message.kind === "gold" && message.notification === "gold-report") return message;
    if (message.kind === "chiusura" && message.notification === "daily-close") return message;
    if (message.kind === "resoconto" && message.notification === "wake-report") return message;
    if (message.kind !== "ordine") return;
    if (message.notification === "order") return message;
    // I vecchi eventi hanno stato e quantità nel testo ma non il motivo dell’intento.
    const old = /^run [^\n]+\n\S+ (?:acquisto|vendita) × ([\d.]+)\n([^\s:]+): ([^\n]+) \((Alpaca Paper|broker finto)\), eseguite ([\d.]+)\/[\d.]+\.$/.exec(message.text);
    if (!old) return;
    const [, qty, id, label, source, filled_qty] = old;
    const intent = intents.get(id);
    const status = Object.entries(states).find(([, value]) => value === label)?.[0];
    if (!intent || !status) return;
    const order = { client_order_id: id, symbol: intent.order.symbol, side: intent.order.side, qty, filled_qty, status, limit_price: null };
    if (outboxId("ordine", orderKey(order)) !== message.id) return;
    const text = orderText(order, intent, source);
    if (text) return { ...message, text: redact(text), notification: "order" };
  };
}

export async function flushNotifications(state: State, channel: Channel, redact: (text: string) => string) {
  await flush(state, channel, undefined, await notificationSelector(state, redact));
}
