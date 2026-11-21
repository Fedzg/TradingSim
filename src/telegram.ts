import { RetryDelivery, type Channel, type Message } from "./chat";

const titles = {
  resoconto: "Resoconto",
  mercato: "Mercato da monitorare",
  notizia: "Notizia rilevante",
  ordine: "Aggiornamento ordine Paper",
  allarmi: "Allarmi",
};

function splitTelegramText(text: string) {
  const limit = 3900;
  const parts: string[] = [];
  while (text.length > limit) {
    let end = text.lastIndexOf("\n", limit - 1) + 1;
    if (end < limit / 2) {
      end = limit;
      const lastCodeUnit = text.charCodeAt(end - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
    }
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  parts.push(text);
  return parts;
}

type TelegramReply = { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } };

export class TelegramChannel implements Channel {
  constructor(private token: string, private chatId: string, private request = fetch) {}

  async send(message: Message, checkpoint: (partsSent: number) => Promise<void>) {
    const header = message.kind ? `TradingSim · ${titles[message.kind]}` : "TradingSim";
    const parts = splitTelegramText(message.text);
    for (let i = message.partsSent ?? 0; i < parts.length; i++) {
      const page = parts.length > 1 ? ` (${i + 1}/${parts.length})` : "";
      await this.sendText(`${header}${page}\n\n${parts[i]}`);
      await checkpoint(i + 1);
    }
  }

  private async sendText(text: string) {
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, link_preview_options: { is_disabled: true } }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Telegram indisponibile o risposta scaduta.");
    }
    const reply = await response.json().catch(() => null) as TelegramReply | null;
    const code = response.ok ? reply?.error_code : response.status;
    if (code === 429) {
      const delay = reply?.parameters?.retry_after;
      const seconds = typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : 60;
      throw new RetryDelivery("Limite di invio Telegram raggiunto.", seconds);
    }
    if (!response.ok || reply?.ok !== true) {
      throw new Error(typeof code === "number" ? `Telegram HTTP ${code}.` : "Risposta Telegram non valida.");
    }
  }
}
