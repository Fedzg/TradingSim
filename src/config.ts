import { resolve } from "node:path";
export const PAPER = "https://paper-api.alpaca.markets";
const names = ["APCA_API_KEY_ID", "APCA_API_SECRET_KEY"] as const;
export async function config(fake: boolean) {
  const endpoint = process.env.APCA_API_BASE_URL;
  if (endpoint && endpoint.replace(/\/$/, "") !== PAPER) throw new Error("Endpoint ordini non consentito. Uso esclusivo di Alpaca Paper.");
  const path = resolve(import.meta.dir, "../secrets.ts");
  const local = !fake && await Bun.file(path).exists() ? (await import(path)).default : {};
  const [key, secret] = fake ? ["", ""] : await Promise.all(names.map(async name => {
    const file = process.env[name + "_FILE"];
    if (file) return (await Bun.file(file).text()).trim();
    return process.env[name] || local[name] || "";
  }));
  const values = [key, secret].filter(Boolean);
  const redact = (value: string) => values.reduce((result, credential) => result.replaceAll(credential, "[omesso]"), value);
  return { key, secret, redact, root: resolve(process.env.TRADINGSIM_STATE_DIR || ".", fake ? "state-fake" : "state") };
}
