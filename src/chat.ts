import { createHash } from "node:crypto";
import type { State } from "./state";

type Kind = "resoconto" | "mercato" | "notizia" | "notizia-operativa" | "ordine" | "allarmi";
export type Message = {
  id: string;
  text: string;
  kind?: Kind;
  delivered?: string;
  attempts?: number;
  error?: string;
  partsSent?: number;
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

export async function enqueue(state: State, run: string, kind: Kind, content: string, dedupeKey?: string) {
  const id = dedupeKey === undefined
    ? `${run}-${kind}-${crypto.randomUUID()}`
    : `${kind}-${createHash("sha256").update(dedupeKey).digest("hex")}`;
  const path = `outbox/${id}.json`;
  if (dedupeKey !== undefined && await state.read<Message>(path)) return;
  await state.write(path, { id, kind, text: `run ${run}\n${content}` });
}

export async function flush(state: State, channel: Channel, now = new Date()) {
  for (const file of await state.list("outbox")) {
    const path = `outbox/${file}`;
    const message = await state.read<Message>(path);
    if (!message || message.delivered) continue;
    if (message.retryAt && Date.parse(message.retryAt) > +now) break;
    message.attempts = (message.attempts ?? 0) + 1;
    delete message.retryAt;
    try {
      await channel.send(message, async partsSent => {
        message.partsSent = partsSent;
        await state.write(path, message);
      });
      message.delivered = now.toISOString();
      delete message.error;
      console.log(`Messaggio ${message.id}: consegnato.`);
    } catch (error) {
      message.error = error instanceof Error ? error.message : "Errore di consegna.";
      if (message.attempts === 1) console.log(`Messaggio ${message.id}: in coda. ${message.error}`);
      if (error instanceof RetryDelivery) message.retryAt = new Date(+now + error.seconds * 1000).toISOString();
    }
    await state.write(path, message);
    if (message.retryAt) break;
  }
}
