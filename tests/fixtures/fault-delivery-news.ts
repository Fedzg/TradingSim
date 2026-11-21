import { State } from "../../src/state";
import { flush } from "../../src/chat";
import { TelegramChannel } from "../../src/telegram";
import { queueNewsSignals } from "../../src/news-signals";
const [root, scenario, phase] = process.argv.slice(2);
const state = new State(root);
if (scenario === "news") {
  const now = new Date("2026-11-20T20:00:00Z");
  const published = new Date(+now - 60_000).toISOString();
  const news = { checked: now.toISOString(), lastSuccess: now.toISOString(), articles: [{
    title: "NVIDIA aggiorna le previsioni", link: "https://example.com/nvda", source: "Fonte originale",
    published, symbols: ["NVDA"], summary: "Articolo sintetico.",
  }] };
  try {
    console.log("avvisi", await queueNewsSignals(state, { async invoke() {
      if (phase === "fail") throw new Error("Analista indisponibile");
      if (phase === "repeat") throw new Error("L’articolo già processato non andava analizzato");
      return { signals: [
        { articleId: 99, symbols: ["NVDA"], reason: "ID inesistente" },
        { articleId: 1, symbols: ["AAPL"], reason: "Simbolo fuori insieme" },
        { articleId: 1, symbols: ["NVDA"], reason: "Previsioni aggiornate" },
      ] };
    } }, news, new Date(+now + (phase === "fail" ? 0 : phase === "repeat" ? 600_000 : 300_000)), x => x));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
} else {
  const request = (async (_url: string, init: RequestInit) => {
    const part = Number(JSON.parse(String(init.body)).text.match(/\((\d)\/2\)/)[1]);
    const calls = await state.read<{ part: number; accepted: boolean; at: number }[]>("requests.json") ?? [];
    const limited = scenario === "429" && calls.length === 1;
    calls.push({ part, accepted: !limited, at: Date.now() });
    await state.write("requests.json", calls);
    if (limited) {
      await Bun.sleep(1100);
      await state.write("limited-at.json", Date.now());
      return Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 });
    }
    if (scenario === "lost" && calls.length === 2) throw new Error("Risposta persa dopo accettazione");
    return Response.json({ ok: true });
  }) as typeof fetch;
  await flush(state, new TelegramChannel("0:fixture", "0", request));
}
