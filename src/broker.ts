import { PAPER } from "./config";
import type { State } from "./state";

export type Side = "buy" | "sell";
export type Proposal = { symbol: string; side: Side; qty: number; reason: string };
export type BrokerOrder = {
  client_order_id: string; symbol: string; side: Side; qty: string; filled_qty: string;
  status: string; limit_price: string | null;
};
export type Intent = { id: string; order: Proposal; limit: number | null; attemptedAt: string; observed?: BrokerOrder };
export type Account = { equity: string; last_equity: string; cash: string; buying_power: string; trading_blocked: boolean };
export type Position = { symbol: string; qty: string; qty_available: string; avg_entry_price: string; current_price: string; market_value: string };
export type Snapshot = { account: Account; positions: Position[]; orders: BrokerOrder[]; clock: { is_open: boolean; timestamp: string } };

export interface Broker {
  snapshot(): Promise<Snapshot>;
  tradable(symbol: string): Promise<boolean>;
  find(id: string): Promise<BrokerOrder | undefined>;
  submit(intent: Intent): Promise<BrokerOrder>;
}

export class HttpError extends Error {
  constructor(readonly status: number, service: string) { super(`${service}: HTTP ${status}`); }
}

export function alpacaHeaders(key: string, secret: string) {
  return { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
}

function brokerFields({ client_order_id, symbol, side, qty, filled_qty, status, limit_price }: BrokerOrder): BrokerOrder {
  return { client_order_id, symbol, side, qty, filled_qty, status, limit_price };
}

export class Alpaca implements Broker {
  constructor(private key: string, private secret: string) {
    if (!key || !secret) throw new Error("Credenziali Alpaca Paper mancanti.");
  }
  private async request<T>(path: string, body?: object): Promise<T> {
    let response: Response;
    try {
      response = await fetch(PAPER + path, {
        method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
        redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: { ...alpacaHeaders(this.key, this.secret), "Content-Type": "application/json" },
      });
    } catch { throw new Error("Alpaca Paper: connessione interrotta o scaduta."); }
    if (!response.ok) throw new HttpError(response.status, "Alpaca Paper");
    return response.json() as Promise<T>;
  }

  async snapshot() {
    const after = encodeURIComponent(new Date(Date.now() - 172800_000).toISOString());
    const [account, positions, orders, clock] = await Promise.all([
      this.request<Account>("/v2/account"), this.request<Position[]>("/v2/positions"),
      this.request<BrokerOrder[]>(`/v2/orders?status=all&limit=500&after=${after}`),
      this.request<Snapshot["clock"]>("/v2/clock"),
    ]);
    const open = await this.request<BrokerOrder[]>("/v2/orders?status=open&limit=500");
    if (orders.length >= 500) throw new Error("Alpaca Paper: elenco ordini recenti potenzialmente incompleto.");
    if (open.length >= 500) throw new Error("Alpaca Paper: elenco ordini aperti potenzialmente incompleto.");
    const { equity, last_equity, cash, buying_power, trading_blocked } = account;
    return {
      account: { equity, last_equity, cash, buying_power, trading_blocked },
      positions: positions.map(({ symbol, qty, qty_available, avg_entry_price, current_price, market_value }) =>
        ({ symbol, qty, qty_available, avg_entry_price, current_price, market_value })),
      orders: [...new Map([...orders, ...open].map(x => [x.client_order_id, brokerFields(x)])).values()],
      clock: { is_open: clock.is_open, timestamp: clock.timestamp },
    };
  }

  async tradable(symbol: string) {
    const asset = await this.request<{ tradable: boolean; status: string; class: string }>(`/v2/assets/${encodeURIComponent(symbol)}`);
    return asset.tradable === true && asset.status === "active" && asset.class === "us_equity";
  }

  async find(id: string) {
    try { return brokerFields(await this.request<BrokerOrder>(`/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(id)}`)); }
    catch (error) { if (error instanceof HttpError && error.status === 404) return undefined; throw error; }
  }

  submit({ id, order, limit }: Intent) {
    return this.request<BrokerOrder>("/v2/orders", {
      symbol: order.symbol, side: order.side, qty: String(order.qty), time_in_force: "day",
      client_order_id: id, ...(limit === null ? { type: "market" } : { type: "limit", limit_price: String(limit) }),
    }).then(brokerFields);
  }
}

export const universe = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"] as const;
export const watched = [...universe, "USOIL", "GBP/USD"];

export class FakeBroker implements Broker {
  constructor(private state: State) {}
  async orders() { return await this.state.read<BrokerOrder[]>("fake-broker.json") ?? []; }
  async snapshot(): Promise<Snapshot> {
    return {
      account: { equity: "10000", last_equity: "9950", cash: "8000", buying_power: "8000", trading_blocked: false },
      positions: await this.state.read<Position[]>("fake-positions.json") ?? [],
      orders: await this.orders(),
      clock: { is_open: await this.state.read<boolean>("fake-open.json") ?? true, timestamp: new Date().toISOString() },
    };
  }
  async tradable(symbol: string) { return universe.some(x => x === symbol); }
  async find(id: string) { return (await this.orders()).find(x => x.client_order_id === id); }
  async submit({ id, order, limit }: Intent) {
    const orders = await this.orders();
    if (orders.some(x => x.client_order_id === id)) throw new Error("ID duplicato nel broker finto.");
    const item: BrokerOrder = {
      client_order_id: id, symbol: order.symbol, side: order.side, qty: String(order.qty),
      limit_price: limit === null ? null : String(limit), status: "accepted", filled_qty: "0",
    };
    await this.state.write("fake-broker.json", [...orders, item]);
    if (process.env.TRADINGSIM_FAKE_CRASH === "after-submit") process.kill(process.pid, "SIGKILL");
    return item;
  }
}
