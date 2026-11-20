import type { State } from "./state";
export type Message = { id: string; text: string; delivered?: string; attempts?: number; error?: string };
export interface Channel { send(message: Message): Promise<void> }

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

export async function enqueue(state: State, run: string, kind: string, content: string) {
  const id = `${run}-${kind}-${crypto.randomUUID()}`;
  await state.write(`outbox/${id}.json`, { id, text: `run ${run}\n${content}` });
}

export async function flush(state: State, channel: Channel, now = new Date()) {
  for (const file of await state.list("outbox")) {
    const path = `outbox/${file}`;
    const message = await state.read<Message>(path);
    if (!message || message.delivered) continue;
    message.attempts = (message.attempts ?? 0) + 1;
    try {
      await channel.send(message);
      message.delivered = now.toISOString();
      delete message.error;
      console.log(`Messaggio ${message.id}: consegnato.`);
    } catch (error) {
      message.error = error instanceof Error ? error.message : "Errore di consegna.";
      if (message.attempts === 1) console.log(`Messaggio ${message.id}: in coda. ${message.error}`);
    }
    await state.write(path, message);
  }
}
