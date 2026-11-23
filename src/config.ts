import { resolve } from "node:path";
export const PAPER = "https://paper-api.alpaca.markets";
const names = ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"] as const;
export async function config(fake: boolean) {
  const endpoint = process.env.APCA_API_BASE_URL;
  const paperFlag = process.env.ALPACA_PAPER_TRADE;
  if (paperFlag !== undefined && !["true", "1", "yes"].includes(paperFlag.toLowerCase())) {
    throw new Error("Configurazione Alpaca MCP live non consentita.");
  }
  if (endpoint && endpoint.replace(/\/$/, "") !== PAPER) throw new Error("Endpoint ordini non consentito. Uso esclusivo di Alpaca Paper.");
  const path = resolve(import.meta.dir, "../secrets.ts");
  const local = !fake && await Bun.file(path).exists() ? (await import(path)).default : {};
  const [key, secret] = fake ? ["", ""] : await Promise.all(names.map(async name => {
    const file = process.env[name + "_FILE"];
    if (file) return (await Bun.file(file).text()).trim();
    return process.env[name] || local[name] || "";
  }));
  const token = fake ? "" : (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = fake ? "" : (process.env.TELEGRAM_CHAT_ID ?? "").trim();
  if ((token || chatId) && (!/^\d+:[\w-]+$/.test(token) || !/^-?\d+$/.test(chatId))) {
    throw new Error("Configurazione Telegram non valida. Verifica TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID.");
  }
  const telegram = token ? { token, chatId } : undefined;
  const values = [key, secret, token, process.env.GOLDAPI_KEY, process.env.TWELVE_DATA_API_KEY].filter(Boolean);
  const redact = (value: string) => values.reduce((result, credential) => result.replaceAll(credential, "[omesso]"), value);
  return { key, secret, telegram, redact, root: resolve(process.env.TRADINGSIM_STATE_DIR || ".", fake ? "state-fake" : "state") };
}
