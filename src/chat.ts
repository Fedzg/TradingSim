import { createHash } from "node:crypto";
import type { State } from "./state";

type Kind = "resoconto" | "mercato" | "notizia" | "notizia-operativa" | "scenario-grafici" | "ordine" | "allarmi" | "watchlist";
export type Message = {
  id: string;
  text: string;
  kind?: Kind;
  delivered?: string;
  queuedAt?: string;
  attempts?: number;
  error?: string;
  partsSent?: number;
  notification?: "order" | "watchlist-addition" | "wake-report";
  retryAt?: string;
};
export interface Channel { send(message: Message, checkpoint: (partsSent: number) => Promise<void>): Promise<void> }

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
  await state.write(path, { id, kind, text: notification === "wake-report" ? content : `run ${run}\n${content}`, queuedAt: new Date().toISOString(), notification }, dedupeKey !== undefined);
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
    if (!message || message.delivered) continue;
    // Elimina le richieste interattive rimaste in coda dalla versione precedente.
    if (message.kind === "watchlist" && "buttons" in message && Array.isArray(message.buttons) && message.buttons.length) {
      await state.remove(path);
      continue;
    }
    if (select) message = await select(message);
    if (!message) continue;
    if (message.retryAt && Date.parse(message.retryAt) > +currentTime()) break;
    message.attempts = (message.attempts ?? 0) + 1;
    delete message.retryAt;
    try {
      await channel.send(message, async partsSent => {
        message.partsSent = partsSent;
        await state.write(path, message);
      });
      message.delivered = currentTime().toISOString();
      delete message.error;
      console.log(`Messaggio ${message.id}: consegnato.`);
    } catch (error) {
      message.error = error instanceof Error ? error.message : "Errore di consegna.";
      if (message.attempts === 1) console.log(`Messaggio ${message.id}: in coda. ${message.error}`);
      if (error instanceof RetryDelivery) message.retryAt = new Date(+currentTime() + error.seconds * 1000).toISOString();
    }
    await state.write(path, message);
    if (message.retryAt) break;
  }
}
