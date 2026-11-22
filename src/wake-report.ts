import type { Charts, NewsAnalysis } from "./agents";
import type { BrokerOrder, Intent } from "./broker";
import { terminal } from "./risk";
import type { Wake } from "./time";

const states = new Map([
  ["new", "nuovo"], ["accepted", "accettato"], ["pending_new", "in attesa di accettazione"],
  ["filled", "eseguito"], ["partially_filled", "eseguito in parte"], ["canceled", "annullato"],
  ["rejected", "respinto"], ["expired", "scaduto"], ["done_for_day", "terminato per oggi"],
  ["pending_cancel", "annullamento in corso"], ["replaced", "sostituito"],
]);

export const orderStatus = (status: string) => states.get(status) ?? status;

type Event = NewsAnalysis["events"][number];
type Outcome = { intent: Intent; observed?: BrokerOrder };
type Report = {
  entry: Wake;
  simulated: boolean;
  outcomes: Outcome[];
  reasons: string[];
  active?: BrokerOrder[];
  activeError?: string;
  events: Event[];
  newsError?: string;
  charts: Charts["ideas"];
};

const short = (value: string, limit: number) => {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return Array.from(text).slice(0, limit - 1).join("") + "…";
};

const side = (value: BrokerOrder["side"]) => value === "buy" ? "Acquisto" : "Vendita";
const quantity = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 9 });
const show = (value: number | string) => quantity.format(Number(value));

function execution({ intent, observed }: Outcome, charts: Charts["ideas"], events: Event[]) {
  const { symbol, side: action, qty, reason } = intent.order;
  const order = observed?.symbol === symbol && observed.side === action ? observed : undefined;
  const filled = Number(order?.filled_qty);
  const validFill = order && Number.isFinite(filled) && filled >= 0 && filled <= Number(order.qty);
  const status = !order ? "invio tentato, esito non verificabile" : `inviato · ${orderStatus(order.status)}`;
  const fill = !validFill ? "quantità eseguita non verificabile" : filled === 0 ? "0 eseguite" :
    `${action === "buy" ? "acquistato" : "venduto"}: ${show(filled)}`;
  const chart = charts.find(item => item.symbol === symbol);
  const news = events.find(item => item.symbols.includes(symbol));
  return [
    `• ${symbol} · ${side(action)} · richieste ${show(qty)} · ${status}, ${fill}`,
    `  Motivo: ${short(reason, 240)}`,
    ...(intent.submissionRejection ? [`  ${short(intent.submissionRejection, 180)}`] : []),
    ...(chart ? [`  Grafico (${chart.horizon}): ${short(chart.evidence, 115)}`] : []),
    ...(news ? [`  Notizia pertinente: ${short(news.title, 105)}`] : []),
  ];
}

export function wakeReport({ entry, simulated, outcomes, reasons, active, activeError, events, newsError, charts }: Report) {
  const details = [...new Set(reasons)].slice(0, 4).map(reason => `• ${short(reason, 260)}`);
  const open = active?.filter(order => !terminal.has(order.status));
  const [year, month, day] = entry.date.split("-");
  return [
    `${day}/${month}/${year} · ${entry.slot} · Europe/Rome${simulated ? " · SIMULAZIONE" : ""}`,
    "",
    "Esito della sveglia",
    ...(outcomes.length ? [...outcomes.flatMap(order => execution(order, charts, events)), ...details] : [
      "Nessun ordine inviato.",
      ...(details.length ? details :
        ["Motivo preciso non disponibile."]),
    ]),
    "",
    "Ordini Paper attivi",
    ...(open === undefined ? [`Ordini attivi non verificabili.${activeError ? ` ${short(activeError, 240)}` : ""}`] :
      open.length === 0 ? ["Nessun ordine attivo."] : open.map(order => [
        `• ${order.symbol} · ${side(order.side)} · ${orderStatus(order.status)}`,
        `eseguite ${show(order.filled_qty)}, residue ${show(Math.max(0, Number(order.qty) - Number(order.filled_qty)))}`,
        ...(order.limit_price ? [`limite ${show(order.limit_price)}`] : []),
        ...(order.stop_price ? [`stop ${show(order.stop_price)}`] : []),
      ].join(" · "))),
    "",
    "Notizie con possibile impatto Paper",
    ...(newsError ? [`Notizie non verificabili. ${short(newsError, 240)}`] :
      events.length === 0 ? ["Nessuna notizia rilevante."] : events.slice(0, 3).flatMap(item => [
        `• ${short(item.title, 160)} (${item.symbols.join(", ")})`,
        `  ${short(item.impact, 200)}`,
        `  ${item.link}`,
      ])),
  ].join("\n");
}
