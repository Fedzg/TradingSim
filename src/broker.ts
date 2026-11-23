import { McpError, payload, type Mcp, type McpResult } from "./mcp";
import { validDate } from "./time";
import type { State } from "./state";

export type Side = "buy" | "sell";
export type Proposal = { symbol: string; side: Side; qty: number; reason: string };
export type BrokerOrder = {
  id?: string; submitted_at?: string;
  client_order_id: string; symbol: string; side: Side; qty: string; filled_qty: string;
  status: string; limit_price: string | null; stop_price?: string | null;
};
export type Intent = { id: string; order: Proposal; limit: number | null; attemptedAt: string; submissionRejection?: string; observed?: BrokerOrder };
export type Account = { equity: string; last_equity: string; cash: string; buying_power: string; trading_blocked: boolean };
export type Position = { symbol: string; qty: string; qty_available: string; avg_entry_price: string; current_price: string; market_value: string; unrealized_pl?: string };
export type Clock = { is_open: boolean; timestamp: string };
export type MarketSession = { date: string; open: string; close: string; session_open?: string };
export type Fill = { id: string; order_id: string; symbol: string; side: Side; qty: string; transaction_time: string };
export type Snapshot = { account: Account; positions: Position[]; orders: BrokerOrder[]; openOrders?: BrokerOrder[]; clock: Clock };

export interface Broker {
  calendar(start: string, end: string): Promise<MarketSession[]>;
  clock(): Promise<Clock>;
  snapshot(): Promise<Snapshot>;
  readOpenOrders(): Promise<BrokerOrder[]>;
  tradable(symbol: string): Promise<boolean>;
  find(id: string): Promise<BrokerOrder | undefined>;
  submit(intent: Intent): Promise<BrokerOrder>;
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value));
}

function brokerFields({ client_order_id, symbol, side, qty, filled_qty, status, limit_price, stop_price, id, submitted_at }: BrokerOrder): BrokerOrder {
  if (typeof client_order_id !== "string" || !client_order_id || typeof symbol !== "string" || !symbol ||
      (side !== "buy" && side !== "sell") || !decimal(qty) || !decimal(filled_qty) ||
      typeof status !== "string" || !status || (limit_price !== null && !decimal(limit_price))) {
    throw new Error("Alpaca MCP: risposta ordine non valida o quantità non verificabile.");
  }
  return { client_order_id, symbol, side, qty, filled_qty, status, limit_price, ...(decimal(stop_price) ? { stop_price } : {}),
    ...(typeof id === "string" ? { id } : {}), ...(submitted_at && Number.isFinite(Date.parse(submitted_at)) ? { submitted_at } : {}) };
}

function snapshotOrder(item: BrokerOrder) {
  try { return brokerFields(item); }
  catch { throw new Error("Alpaca MCP: get_orders, dati ordine non verificabili."); }
}

export class Alpaca implements Broker {
  constructor(private readonly mcp: Mcp) {}

  async account(): Promise<Account> {
    const { equity, last_equity, cash, buying_power, trading_blocked } = await payload<Account>(this.mcp, "get_account_info");
    const balances = [equity, last_equity, cash, buying_power];
    if (!balances.every(decimal) ||
        typeof trading_blocked !== "boolean") throw new Error("Alpaca MCP: risposta conto non valida.");
    return { equity, last_equity, cash, buying_power, trading_blocked };
  }

  async clock(): Promise<Clock> {
    const clock = await payload<Clock>(this.mcp, "get_clock");
    if (typeof clock.is_open !== "boolean" || typeof clock.timestamp !== "string" || !Number.isFinite(Date.parse(clock.timestamp))) {
      throw new Error("Alpaca MCP: get_clock, orologio non valido.");
    }
    return { is_open: clock.is_open, timestamp: clock.timestamp };
  }

  async calendar(start: string, end: string): Promise<MarketSession[]> {
    const days = await payload<MarketSession[]>(this.mcp, "get_calendar", { start, end });
    const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    if (!Array.isArray(days) || days.some(day => !day || !validDate(day.date) || day.date < start || day.date > end ||
      !time.test(day.open) || !time.test(day.close) || day.open >= day.close ||
      (day.session_open !== undefined && !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(day.session_open))) ||
      new Set(days.map(day => day.date)).size !== days.length) throw new Error("Alpaca MCP: calendario non valido.");
    return [...days].sort((a, b) => a.date.localeCompare(b.date));
  }

  async fills(date: string): Promise<Fill[]> {
    const fills: Fill[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await payload<Fill[]>(this.mcp, "get_account_activities_by_type", {
        activity_type: "FILL", date, direction: "asc", page_size: 100, ...(pageToken ? { page_token: pageToken } : {}),
      });
      if (!Array.isArray(page) || page.length > 100) throw new Error("Alpaca MCP: attività FILL non valide.");
      for (const fill of page) {
        if (!fill?.id || seen.has(fill.id) || !fill.order_id || !fill.symbol || !["buy", "sell"].includes(fill.side) ||
            !decimal(fill.qty) || Number(fill.qty) <= 0 || !Number.isFinite(Date.parse(fill.transaction_time))) {
          throw new Error("Alpaca MCP: attività FILL non verificabili.");
        }
        seen.add(fill.id);
        fills.push(fill);
      }
      pageToken = page.length === 100 ? page.at(-1)!.id : undefined;
    } while (pageToken);
    return fills;
  }

  async orderById(id: string) {
    const order = snapshotOrder(await payload<BrokerOrder>(this.mcp, "get_order_by_id", { order_id: id }));
    if (order.id !== id) throw new Error("Alpaca MCP: ID ordine diverso da quello richiesto.");
    return order;
  }

  async snapshot() {
    const after = new Date(Date.now() - 172800_000).toISOString();
    const [account, positions, orders, clock] = await Promise.all([
      this.account(), payload<Position[]>(this.mcp, "get_all_positions"),
      payload<BrokerOrder[]>(this.mcp, "get_orders", { status: "all", limit: 500, after }),
      this.clock(),
    ]);
    const openOrders = await this.readOpenOrders();
    if (!Array.isArray(positions)) throw new Error("Alpaca MCP: get_all_positions, elenco posizioni non valido.");
    if (!Array.isArray(orders)) throw new Error("Alpaca MCP: get_orders (all), elenco ordini non valido.");
    if (orders.length >= 500) throw new Error("Alpaca MCP: elenco ordini potenzialmente incompleto.");
    const recentOrders = orders.map(snapshotOrder);
    return {
      account,
      positions: positions.map(position => {
        const { symbol, qty, qty_available, avg_entry_price, current_price, market_value, unrealized_pl } = position ?? {};
        if (typeof symbol !== "string" || !symbol || ![qty, qty_available, avg_entry_price, current_price, market_value].every(decimal)) {
          throw new Error("Alpaca MCP: get_all_positions, dati delle posizioni non verificabili.");
        }
        return { symbol, qty, qty_available, avg_entry_price, current_price, market_value, ...(decimal(unrealized_pl) ? { unrealized_pl } : {}) };
      }),
      orders: [...new Map([...recentOrders, ...openOrders].map(order => [order.client_order_id, order])).values()],
      openOrders,
      clock: { is_open: clock.is_open, timestamp: clock.timestamp },
    };
  }

  async readOpenOrders() {
    const open = await payload<BrokerOrder[]>(this.mcp, "get_orders", { status: "open", limit: 500 });
    if (!Array.isArray(open)) throw new Error("Alpaca MCP: get_orders (open), elenco ordini non valido.");
    if (open.length >= 500) throw new Error("Alpaca MCP: elenco ordini aperti potenzialmente incompleto.");
    return open.map(snapshotOrder);
  }

  async tradable(symbol: string) {
    const asset = await payload<{ tradable: boolean; status: string; class: string }>(this.mcp, "get_asset", { symbol_or_asset_id: symbol });
    return asset.tradable === true && asset.status === "active" && asset.class === "us_equity";
  }

  async find(id: string) {
    try {
      const result = await payload<BrokerOrder>(this.mcp, "get_order_by_client_id", { client_order_id: id });
      if (result.client_order_id !== id) throw new Error("Alpaca MCP: ID ordine diverso da quello richiesto.");
      return brokerFields(result);
    } catch (error) { if (error instanceof McpError && error.notFound) return undefined; throw error; }
  }

  submit({ id, order, limit }: Intent) {
    return payload<BrokerOrder>(this.mcp, "place_stock_order", {
      symbol: order.symbol, side: order.side, qty: String(order.qty), time_in_force: "day",
      client_order_id: id, ...(limit === null ? { type: "market" } : { type: "limit", limit_price: String(limit) }),
    }).then(brokerFields);
  }
}

export const universe = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"] as const;
export const watched = [...universe, "USOIL", "GBP/USD"];

export class FakeBroker extends Alpaca {
  constructor(private state: State, mcp: Mcp = new FakeMcp(state)) { super(mcp); }
  async orders() { return await this.state.read<BrokerOrder[]>("fake-broker.json") ?? []; }
}

export class FakeMcp implements Mcp {
  constructor(private state: State) {}
  async orders() { return await this.state.read<BrokerOrder[]>("fake-broker.json") ?? []; }
  private async snapshot(): Promise<Snapshot> {
    return {
      account: { equity: "10000", last_equity: "9950", cash: "8000", buying_power: "8000", trading_blocked: false },
      positions: await this.state.read<Position[]>("fake-positions.json") ?? [],
      orders: await this.orders(),
      clock: { is_open: await this.state.read<boolean>("fake-open.json") ?? true, timestamp: new Date().toISOString() },
    };
  }
  async call(name: string, args: Record<string, any> = {}): Promise<McpResult> {
    const snapshot = await this.snapshot();
    const reply = (data: unknown) => ({ structuredContent: { _alpaca_mcp_security: {}, data: Array.isArray(data) ? { result: data } : data } });
    switch (name) {
      case "get_account_info": return reply(snapshot.account);
      case "get_all_positions": return reply(snapshot.positions);
      case "get_clock": return reply(await this.state.read<Clock>("fake-clock.json") ?? snapshot.clock);
      case "get_calendar": return reply((await this.state.read<MarketSession[]>("fake-calendar.json") ?? [])
        .filter(day => day.date >= args.start && day.date <= args.end));
      case "get_account_activities_by_type": return reply(await this.state.read<Fill[]>("fake-fills.json") ?? []);
      case "get_order_by_id": {
        const order = snapshot.orders.find(item => item.id === args.order_id);
        return order ? reply(order) : { isError: true };
      }
      case "get_orders": return reply(snapshot.orders);
      case "get_asset": return reply({ tradable: universe.some(x => x === args.symbol_or_asset_id), status: "active", class: "us_equity" });
      case "get_order_by_client_id": {
        const item = await this.find(args.client_order_id);
        return item ? reply(item) : { isError: true, content: [{ type: "text", text: "Error calling tool 'get_order_by_client_id': HTTP error 404: Not Found" }] };
      }
      case "place_stock_order": return reply(await this.submit({
        id: args.client_order_id, order: { symbol: args.symbol, side: args.side, qty: Number(args.qty), reason: "MCP finto" },
        limit: args.limit_price === undefined ? null : Number(args.limit_price), attemptedAt: new Date().toISOString(),
      }));
      default: return { isError: true, content: [{ type: "text", text: "Strumento MCP finto non supportato." }] };
    }
  }
  private async find(id: string) { return (await this.orders()).find(x => x.client_order_id === id); }
  private async submit({ id, order, limit }: Intent) {
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
