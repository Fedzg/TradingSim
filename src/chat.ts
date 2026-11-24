import {mobileReport} from "./mobile-report";
import { createHash } from "node:crypto";
import type { State } from "./state";

type Kind = "strategia" | "gold" | "chiusura" | "resoconto" | "mercato" | "notizia" | "notizia-operativa" | "scenario-grafici" | "ordine" | "allarmi" | "watchlist";
export type Message = {
  producer?:typeof import("./version").producer;
  id: string;
  text: string;
  mobileText?:string;
  summarized?:boolean;
  kind?: Kind;
  delivered?: string;
  deliveryStatus?: "QUEUED"|"SENDING"|"PARTIALLY_SENT"|"DELIVERED"|"LOCAL_ONLY"|"DELIVERY_UNKNOWN"|"FAILED_RETRYABLE";
  deliveryReason?: string;
  queuedAt?: string;
  attempts?: number;
  error?: string;
  partsSent?: number;
  notification?: "strategy-alert" | "order" | "watchlist-addition" | "wake-report" | "daily-close" | "gold-report";
  retryAt?: string;
};
export interface Channel { send(message: Message, checkpoint: (partsSent: number) => Promise<void>): Promise<void> }

export class DeliveryUnknown extends Error {}

export class RetryDelivery extends Error {
  constructor(message: string, readonly seconds: number) { super(message); }
}

export class UnavailableChat implements Channel {
  async send() { throw new Error("Consegna automatica verso questa conversazione indisponibile."); }
}

export class FakeChannel implements Channel {
  constructor(private state: State, private fail = false) {}
  async send(message: Message) {
    if (this.fail) throw new Error("Consegna finta non riuscita.");
    await this.state.write(`fake-chat/${message.id}.json`, message);
  }
}

export const outboxId = (kind: Kind, key: string) => `${kind}-${createHash("sha256").update(key).digest("hex")}`;

export async function enqueue(state: State, run: string, kind: Kind, content: string, dedupeKey?: string, notification?: Message["notification"]) {
  const id = dedupeKey === undefined
    ? `${run}-${kind}-${crypto.randomUUID()}`
    : outboxId(kind, dedupeKey);
  const path = `outbox/${id}.json`;
  if (dedupeKey !== undefined && await state.read<Message>(path)) return;
  const mobile=notification ? mobileReport(kind,content) : undefined;
  await state.write(path, { id, kind, ...(mobile ? {mobileText:mobile,summarized:mobile!==content}:{}), text: (notification === "wake-report" || notification === "daily-close" || notification === "gold-report") ? content : `run ${run}\n${content}`, deliveryStatus: notification ? "QUEUED" : "LOCAL_ONLY", deliveryReason: notification ? "Evento con politica di invio" : "Archivio locale secondo la politica di notifica", queuedAt: new Date().toISOString(), notification }, dedupeKey !== undefined);
}

export async function flush(state: State, channel: Channel, now?: Date, select?: (message: Message) => Promise<Message | undefined>) {
  const currentTime = () => now ?? new Date();
  const files = await state.list("outbox");
  const records = await Promise.all(files.map(async file => {
    const path = `outbox/${file}`;
    return { path, message: await state.read<Message>(path) };
  }));
  if (select) records.sort((a, b) => (a.message?.queuedAt ?? "").localeCompare(b.message?.queuedAt ?? ""));
  for (const record of records) {
    const { path } = record;
    let { message } = record;
    if (!message || message.delivered || message.deliveryStatus==="DELIVERY_UNKNOWN") continue;
    if(message.deliveryStatus==="SENDING" || message.deliveryStatus==="PARTIALLY_SENT"){
      await state.write(path,{...message,deliveryStatus:"DELIVERY_UNKNOWN",deliveryReason:"Processo interrotto durante la consegna"});
      continue;
    }
    // Elimina le richieste interattive rimaste in coda dalla versione precedente.
    if (message.kind === "watchlist" && "buttons" in message && Array.isArray(message.buttons) && message.buttons.length) {
      continue;
    }
    if (select) message = await select(message);
    if (!message) continue;
    if (message.retryAt && Date.parse(message.retryAt) > +currentTime()) break;
    message.attempts = (message.attempts ?? 0) + 1;
    delete message.retryAt;
    message.deliveryStatus="SENDING";
    await state.write(path,message);
    try {
      await channel.send(message, async partsSent => {
        message.partsSent = partsSent;
        message.deliveryStatus="PARTIALLY_SENT";
        await state.write(path, message);
      });
      message.deliveryStatus="DELIVERED";
      message.deliveryReason="Consegna confermata";
      message.delivered = currentTime().toISOString();
      delete message.error;
      console.log(`Messaggio ${message.id}: consegnato.`);
    } catch (error) {
      message.error = error instanceof Error ? error.message : "Errore di consegna.";
      message.deliveryStatus=error instanceof DeliveryUnknown ? "DELIVERY_UNKNOWN" : "FAILED_RETRYABLE";
      message.deliveryReason=message.error;
      if (message.attempts === 1) console.log(`Messaggio ${message.id}: in coda. ${message.error}`);
      if (error instanceof RetryDelivery) message.retryAt = new Date(+currentTime() + error.seconds * 1000).toISOString();
    }
    await state.write(path, message);
    if (message.retryAt) break;
  }
}
