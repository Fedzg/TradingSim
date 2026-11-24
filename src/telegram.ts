import {footer} from "./version";
import { PermanentDeliveryFailure, DeliveryUnknown, RetryDelivery, type Channel, type Message } from "./chat";

const titles = {
  strategia: "Strategia Paper",
  gold: "Gold & Futures",
  chiusura: "Riepilogo chiusura USA",
  resoconto: "Resoconto",
  mercato: "Mercato da monitorare",
  notizia: "Notizia rilevante",
  "notizia-operativa": "Notizia con possibile impatto Paper",
  "scenario-grafici": "Scenari di rialzo e ribasso",
  ordine: "Aggiornamento ordine Paper",
  allarmi: "Allarmi",
  watchlist: "Watchlist",
};

const escapeHtml=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");

function splitTelegramText(text: string) {
  const limit = 3900;
  const parts: string[] = [];
  while (text.length > limit) {
    let end = text.lastIndexOf("\n", limit - 1) + 1;
    if (end === 0) {
      const boundary=[...text.slice(0,limit).matchAll(/[.!?](?=\s)/gu)].at(-1);
      if(boundary) end=boundary.index!+1;
    }
    if (end === 0) {
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
    const parts = splitTelegramText((message.mobileText??message.text)+"\n\n"+footer(message.producer));
    for (let i = message.partsSent ?? 0; i < parts.length; i++) {
      const page = parts.length > 1 ? ` (${i + 1}/${parts.length})` : "";
      const html=!!message.mobileText;
      const body=html ? parts[i].split("\n").map(line=>{
        const value=line.trim();
        if(value.startsWith("https://") && URL.canParse(value) && !/\s/.test(value)) return '<a href="'+escapeHtml(value)+'">Fonte · '+escapeHtml(new URL(value).hostname)+'</a>';
        return escapeHtml(line);
      }).join("\n") : parts[i];
      await this.sendText((html?"<b>"+escapeHtml(header+page)+"</b>":header+page)+"\n\n"+body,html);
      await checkpoint(i + 1);
    }
  }

  private async sendText(text: string, html:boolean) {
    let response: Response;
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, ...(html?{parse_mode:"HTML"}:{}), link_preview_options: { is_disabled: true } }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new DeliveryUnknown("Esito Telegram incerto: risposta persa. Verificare la consegna.");
    }
    const reply = await response.json().catch(() => null) as TelegramReply | null;
    const code = response.ok ? reply?.error_code : response.status;
    if (code === 429) {
      const delay = reply?.parameters?.retry_after;
      const seconds = typeof delay === "number" && Number.isFinite(delay) && delay > 0 ? delay : 60;
      throw new RetryDelivery("Limite di invio Telegram raggiunto.", seconds);
    }
    if (!response.ok || reply?.ok !== true) {
      if (!reply || response.status >= 500) throw new DeliveryUnknown("Esito Telegram incerto: risposta non verificabile.");
      if(code && code>=400 && code<500) throw new PermanentDeliveryFailure("Telegram HTTP "+code+".");
      throw new Error(typeof code === "number" ? `Telegram HTTP ${code}.` : "Esito Telegram incerto: risposta non valida; possibile duplicato al ritentativo.");
    }
  }
}
