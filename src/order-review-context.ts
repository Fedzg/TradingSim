import type { Charts, NewsAnalysis } from "./agents";
import type { Proposal, Snapshot } from "./broker";
import type { Series } from "./market";
import { marketEvidence } from "./indicators";
import { riskLimits, terminal, trading } from "./risk";
import type { Wake } from "./time";

export type OrderReviewContext = ReturnType<typeof orderReviewContext>;
export function orderReviewContext(order: Proposal, limit: number | null, snapshot: Snapshot, entry: Wake,
  chart: Series | undefined, analysis: Charts | undefined, news: NewsAnalysis | undefined, now: Date) {
  const open = snapshot.orders.filter(item => !terminal.has(item.status));
  const held = snapshot.positions.find(position => position.symbol === order.symbol);
  const outstanding = (item: typeof open[number]) => Math.max(0, Number(item.qty) - Number(item.filled_qty));
  const pendingBuy = open.filter(item => item.side === "buy");
  const pendingCost = (items: typeof open) => items.reduce((total, item) => total + outstanding(item) * Number(item.limit_price), 0);
  const heldValue = Math.abs(Number(held?.market_value ?? 0));
  const sameSymbolBuy = pendingCost(pendingBuy.filter(item => item.symbol === order.symbol));
  const knownCost = !pendingBuy.some(item => !(Number(item.limit_price) > 0) || !Number.isFinite(outstanding(item)));
  const pendingSells = open.filter(item => item.side === "sell" && item.symbol === order.symbol).reduce((total, item) => total + outstanding(item), 0);
  const heldSymbols = new Set([...snapshot.positions.filter(x => Number(x.qty) !== 0).map(x => x.symbol),
    ...pendingBuy.filter(x => outstanding(x) > 0).map(x => x.symbol), order.symbol]);

  const indicator = chart && marketEvidence(chart, now);
  return {
    reason: order.reason.slice(0, 600),
    risk: {
      slot: entry.slot, tradableNow: trading(entry, snapshot), tradingBlocked: snapshot.account.trading_blocked,
      limits: riskLimits, cash: snapshot.account.cash, buyingPower: snapshot.account.buying_power,
      estimatedCost: limit === null ? null : order.qty * limit,
      maxSymbolValue: Number(snapshot.account.equity) * riskLimits.maxExposure,
      projectedSymbolValue: limit === null || !knownCost ? null : heldValue + sameSymbolBuy + order.qty * limit,
      pendingBuyCost: knownCost ? pendingCost(pendingBuy) : null,
      projectedPositions: heldSymbols.size,
      availableShares: Math.min(Number(held?.qty_available ?? 0), Number(held?.qty ?? 0) - pendingSells),
      position: held ? { qty: held.qty, avgEntry: held.avg_entry_price, price: held.current_price } : null,
    },
    evidence: {
      chart: indicator && { source: indicator.source, sourceIssue: indicator.sourceIssue,
        intervals: Object.fromEntries(Object.entries(indicator.intervals).map(([key, { candles, ...summary }]) =>
          [key, { ...summary, lastClose: candles.at(-1)?.[4] ?? null }])) },
      scenarios: (analysis?.ideas ?? []).filter(idea => idea.symbol === order.symbol).slice(0, 2)
        .map(({ horizon, direction, evidence, invalidation, uncertainty }) =>
          ({ horizon, direction: direction.slice(0, 120), evidence: evidence.slice(0, 300), invalidation: invalidation.slice(0, 180), uncertainty: uncertainty.slice(0, 180) })),
      news: (news?.events ?? []).filter(item => item.symbols.includes(order.symbol)).slice(0, 3)
        .map(({ title, source, link, published, classification, impact }) =>
          ({ title: title.slice(0, 180), source, link, published, classification, impact: impact.slice(0, 260) })),
      chartLimitations: analysis?.limitations.slice(0, 2).map(item => item.slice(0, 180)),
      newsLimitations: news?.limitations.slice(0, 2).map(item => item.slice(0, 180)),
    },
  };
}
