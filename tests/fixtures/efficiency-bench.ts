import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const root = resolve(process.argv[2] ?? ".");
const { Discovery } = await import(join(root, "src/discovery.ts"));
const { FakeAgents } = await import(join(root, "src/agents.ts"));
const { Market } = await import(join(root, "src/market.ts"));
const { FakeBroker } = await import(join(root, "src/broker.ts"));
const { State } = await import(join(root, "src/state.ts"));
const { run } = await import(join(root, "src/run.ts"));
const { wake } = await import(join(root, "src/time.ts"));
const tmp = await mkdtemp(join(tmpdir(), "tradingsim-bench-"));
try {
  const t0 = Date.parse("2026-11-20T14:40:00Z");
  const discoveryState = new State(join(tmp, "discovery"));
  const counts: Record<string, number> = {};
  const item = { symbol: "AMD", category: "azioni", venue: "Nasdaq", ticker: "AMD" };
  const started = performance.now();
  for (let i = 0; i < 4; i++) {
    const now = new Date(t0 + i * 900_000);
    const at = new Date(+now - 900_000).toISOString();
    const metrics = { dayPct: 2.4, hourPct: 0.6, typicalDayPct: 1, relativeMove: 2.4, volumeMultiple: 1.6, lastClose: 103, invalidation: 101, at };
    const candidate = { instrument: item, metrics, market: { url: "https://example.com/amd", source: "Fonte finta", at, detail: "Movimento sopra la volatilità abituale." } };
    await new Discovery(discoveryState, { async invoke(role: string) {
      counts[role] = (counts[role] ?? 0) + 1;
      await Bun.sleep(20); // Latenza fissa del modello finto, uguale nelle due versioni.
      return { verdict: "approve", reason: "Segnale confermato", doubt: "Volumi", sourceIds: ["mercato"] };
    } }, (s: string) => s).collect({ candidates: [candidate], coverage: [] }, [], now);
  }

  const discoveryMs = Math.round(performance.now() - started);
  const now = new Date(t0);
  const state = new State(join(tmp, "run"));
  const watch = ["AAPL", "MSFT", "NVDA", "SPY", "QQQ", "IWM", "GLD", "TLT", "USOIL", "GBP/USD"];
  const market = new Market(undefined, true);
  const setup = await market.charts(now);
  market.charts = async () => setup.map((series: any) => {
    const intervals = Object.fromEntries(Object.entries(series.intervals).map(([key, bars]: any) => {
      const duration = key === "1Day" ? 86400_000 : 900_000;
      return [key, Array.from({ length: 48 }, (_, i) => ({ ...bars.at(-1), t: new Date(+now - (48-i)*duration).toISOString(), c: 98+2*i/47, v: 1010+i }))];
    }));
    return { ...series, intervals };
  });
  await state.write("news.json", { checked: now.toISOString(), lastSuccess: now.toISOString(), articles: watch.map((symbol, index) => ({
    title: `Aggiornamento di mercato ${symbol}`, source: "Fonte simulata", published: new Date(+now - 60_000).toISOString(),
    symbols: [symbol], link: `https://example.com/${index}`, summary: "La notizia descrive quote, volumi e contesto di mercato per il simbolo. ".repeat(6),
  })) });
  const fake = new FakeAgents();
  const bytes: Record<string, number> = {};
  await run({ state, broker: new FakeBroker(state), market, redact: (s: string) => s,
    agents: { async invoke(role: string, input: unknown) {
      bytes[role] = Buffer.byteLength(JSON.stringify(input), "utf8");
      if (role === "charts") return { limitations: ["Nessuna limitazione per il test."], ideas: watch.map(symbol => ({
        symbol, horizon: "15 minuti", bias: "rialzista", direction: "Rialzo", evidence: "Recupero sopra la media e aumento del volume. ".repeat(4),
        invalidation: "Chiusura sotto 97", uncertainty: "Campione breve",
      })) };
      return fake.invoke(role, input);
    } } }, wake("2026-11-20", "15:40"), true, now);
  console.log("BENCHMARK", JSON.stringify({ calls: counts, fakeModelDelayMs: 20, discoveryMs, bytes, reviewBytes: ["challenge", "answer", "review"].reduce((sum, role) => sum + (bytes[role] ?? 0), 0) }));
} finally { await rm(tmp, { recursive: true, force: true }); }
