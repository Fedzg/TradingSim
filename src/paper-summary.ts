import type { Snapshot } from "./broker";
import { rome } from "./time";

const usd = new Intl.NumberFormat("it-IT", { style: "currency", currency: "USD", currencyDisplay: "code" });
const percent = new Intl.NumberFormat("it-IT", { style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero" });

export function paperAccount(snapshot: Pick<Snapshot, "account" | "positions" | "clock"> | undefined, error?: string) {
  if (!snapshot) return [`Conto Paper non verificabile.${error ? " " + error : ""}`];
  const { account, positions, clock } = snapshot;
  const equity = Number(account.equity);
  const previous = Number(account.last_equity);
  const pnl = equity - previous;
  const { date, time } = rome(new Date(clock.timestamp));
  return [
    `Alpaca Paper verificato · ${date} ${time} Roma (${clock.timestamp})`,
    `Equity ${usd.format(equity)} · Liquidità ${usd.format(Number(account.cash))}`,
    `P&L giornaliero ${usd.format(pnl)}${previous > 0 ? ` (${percent.format(pnl / previous)})` : " · percentuale non disponibile"}`,
    ...(positions.length ? positions.map(position => {
      const pl = position.unrealized_pl === undefined ? "non disponibile" : usd.format(Number(position.unrealized_pl));
      return `• ${position.symbol} · ${position.qty} · P&L non realizzato ${pl}`;
    }) : ["Nessuna posizione aperta."]),
  ];
}
