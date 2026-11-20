import { createInterface } from "node:readline";
import { Readable } from "node:stream";

export type McpResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};
export interface Mcp { call(name: string, args?: object): Promise<McpResult> }

export class McpError extends Error {
  constructor(tool: string, readonly notFound = false) {
    super(`Alpaca MCP: ${tool} ${notFound ? "risorsa non trovata (404)" : "ha restituito un errore"}.`);
  }
}

export async function payload<T>(mcp: Mcp, tool: string, args?: object): Promise<T> {
  const result = await mcp.call(tool, args);
  const blocks = result.content?.filter(x => x.type === "text") ?? [];
  if (result.isError) {
    const notFound = blocks.some(x => /\b404(?::| )\s*Not Found\b|\b40410000\b/i.test(x.text ?? ""));
    throw new McpError(tool, notFound);
  }
  let value = result.structuredContent;
  if (value === undefined) {
    try {
      value = blocks.length > 1 ? blocks.map(block => JSON.parse(block.text ?? "")) : JSON.parse(blocks[0]?.text ?? "");
    } catch { throw new McpError(tool); }
  }
  if (value && typeof value === "object" && "_alpaca_mcp_security" in value && "data" in value) value = value.data;
  if (value && typeof value === "object" && "result" in value && Object.keys(value).length === 1) value = value.result;
  if (value === null || typeof value !== "object" || "error" in value) throw new McpError(tool);
  return value as T;
}

type Waiting = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export class AlpacaStdio implements Mcp {
  private proc?: ReturnType<typeof this.spawn>;
  private ready?: Promise<void>;
  private waiting = new Map<number, Waiting>();
  private sequence = 0;
  private closed = false;

  constructor(private readonly key: string, private readonly secret: string) {}

  private spawn() {
    if (!this.key || !this.secret) throw new Error("Alpaca MCP nel worker: credenziali Paper mancanti.");
    const env = Object.fromEntries(["PATH", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]
      .flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
    try {
      return Bun.spawn(["alpaca-mcp-server", "--transport", "stdio"], {
        env: { ...env, ALPACA_API_KEY: this.key, ALPACA_SECRET_KEY: this.secret, ALPACA_PAPER_TRADE: "true" },
        stdin: "pipe", stdout: "pipe", stderr: "ignore",
      });
    } catch { throw new Error("Alpaca MCP nel worker: eseguibile alpaca-mcp-server non disponibile."); }
  }

  private abort(error: Error) {
    for (const entry of this.waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.waiting.clear();
  }

  private async initialize() {
    const proc = this.proc = this.spawn();
    const lines = createInterface({ input: Readable.fromWeb(proc.stdout as any), crlfDelay: Infinity });
    lines.on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const entry = this.waiting.get(message?.id);
      if (!entry) return;
      this.waiting.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error("Alpaca MCP: errore JSON-RPC."));
      else entry.resolve(message.result);
    });
    lines.on("error", () => this.abort(new Error("Alpaca MCP: errore nella lettura del trasporto.")));
    void proc.exited.then(() => this.abort(new Error("Alpaca MCP: server stdio terminato.")));
    const result = await this.request("initialize", {
      protocolVersion: versions[0], capabilities: {}, clientInfo: { name: "TradingSim", version: "1" },
    });
    if (!versions.includes(result?.protocolVersion) || !result?.capabilities?.tools) {
      throw new Error("Alpaca MCP: protocollo o capacità strumenti incompatibili.");
    }
    this.send({ method: "notifications/initialized" });
  }

  private send(message: object) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || this.closed) throw new Error("Alpaca MCP: trasporto chiuso.");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    void proc.stdin.flush();
  }

  private request(method: string, params: object) {
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Alpaca MCP: timeout ${method}.`));
      }, 35_000);
      this.waiting.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.waiting.delete(id); reject(error); }
    });
  }

  async call(name: string, args: object = {}): Promise<McpResult> {
    this.ready ??= this.initialize();
    await this.ready;
    const result = await this.request("tools/call", { name, arguments: args });
    if (!result || typeof result !== "object") throw new McpError(name);
    return result;
  }

  close() {
    this.closed = true;
    this.abort(new Error("Alpaca MCP: sessione terminata."));
    if (this.proc?.exitCode === null) this.proc.kill("SIGTERM");
  }
}
