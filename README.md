# TradingSim

English · [Italiano](README.it.md)

TradingSim is a Bun and TypeScript worker for **Alpaca Paper only**. It uses the
official Alpaca MCP server, headless Codex CLI, Docker Compose, and optional
Telegram notifications. It does not connect to a live trading account.

- Trading sessions are checked at 09:00, 15:40, 18:30, and 21:40 in
  `Europe/Rome`. The 09:00 briefing does not submit orders. The Alpaca market
  clock governs the other sessions.
- Discretionary orders require an independent review and risk checks. A
  deterministic client order ID lets the worker reconcile uncertain submissions
  without automatically submitting them again. A broker acceptance is distinct
  from a fill.
- Market discovery scans a fixed set of stocks, FX, futures, crypto, and CFD
  underlyings. Two analysts can propose an instrument. The operator grants permission on
  demand, then an independent reviewer makes the final decision. Additions
  are **monitoring only**.

## Quick start

On Linux or WSL 2 with Bun 1.3.14 and util-linux `flock`:

```sh
bun test
bun run once --fake --slot 15:40
bun run status --fake
```

The fake run uses a separate state directory and does not call Alpaca, Codex or
Telegram. For a real Paper worker, follow the instructions for
[Windows with Docker Desktop and WSL 2](deploy/windows.md) or
[Linux and cloud VMs](deploy/README.en.md). Keep all credentials, account data,
and runtime state outside the repository.

## Market data and alerts

The worker uses Alpaca IEX for portfolio charts and Alpaca News for news.
Yahoo Finance supplies additional price series. WTI uses `CL=F`, the
continuous NYMEX front-month futures series. The OANDA S&P 500 CFD is
monitored via its underlying index only. The worker reports unavailable or
insufficient discovery feeds. A functioning feed depends on the deployment
network and provider access.

Telegram sends a summary for every wake-up, even when no order is sent.
It includes the verified Paper account, open orders, and up to three
relevant news items. The 09:00 briefing uses Alpaca’s calendar and clock to
distinguish the previous regular session from any available premarket data.
Five minutes after Alpaca’s scheduled regular close, TradingSim summarizes
fills and decisions already recorded. Early closes and daylight saving time
can shift the time of the closing report.
Confirmed order updates and saved watchlist additions still arrive
separately. Full reports and charts remain in local state. See the
[watchlist commands](deploy/README.en.md#watchlist-permission-and-review)
to inspect proposals and grant permission. Logs may include Paper account data.

## Checks without orders

- `bun src/cli.ts account-check` reads the Paper account through MCP.
- `bun src/cli.ts discovery-scan` reads the discovery feeds without notifying
  Telegram or editing the watchlist.
- `bun src/cli.ts discovery-status` reads the most recent source coverage and
  the saved watchlist.

See [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

### Gold & Futures briefing

At 12:30 Europe/Rome the scheduler sends a read-only gold, commodities and FX
briefing. Run it manually with `bun src/cli.ts once --slot 12:30 --fake`
for a simulation. It uses timestamped indicative Yahoo data and cached news.
For futures it compares volumes among dated, unexpired contracts in an
eight-month window and reports contract changes. Brent refers to NYMEX BZ.
Coverage, quote delay and session status depend on the provider. A licensed
venue feed can supply detailed holiday and maintenance schedules. A Gold CFD
requires its own broker quote. Missing data is identified in the report.
