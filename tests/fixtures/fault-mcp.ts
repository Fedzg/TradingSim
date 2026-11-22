// Solo stdio locale. Nessuna rete e nessun broker esterno.
import { createInterface } from "node:readline";
import { FakeMcp } from "../../src/broker";
import { State } from "../../src/state";
const state = new State(process.argv[2]);
const fake = new FakeMcp(state);
const fault = process.argv[3];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (!id) continue;
  if (method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }));
    continue;
  }
  const { name, arguments: args } = params;
  await Bun.write(state.path(`wire-${id}.json`), JSON.stringify({ name, args, at: performance.now() }));
  if (name === "place_stock_order" && fault) {
    if (fault.startsWith("accepted")) await fake.call(name, args);
    if (!fault.endsWith("-upstream")) continue; // Scade il timer del client MCP.
    // Il socket locale non risponde. Scade davvero la richiesta HTTP del broker simulato.
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      await fetch(upstream.url, { signal: AbortSignal.timeout(30_000) });
      throw new Error("Il broker di prova non doveva rispondere.");
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "TimeoutError") throw error;
      await state.write("upstream-timeout.json", { name: error.name, at: performance.now() });
      console.log(JSON.stringify({ jsonrpc: "2.0", id, result: {
        structuredContent: { _alpaca_mcp_security: {}, data: { error: { timeout: true } } },
      } }));
    } finally { upstream.stop(true); }
    continue;
  }
  const result = await fake.call(name, args);
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
