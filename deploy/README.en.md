# Linux and cloud deployment

English · [Italiano](README.md) · [Windows](windows.md)

Use Docker Engine and Compose v2.24+ on an always-on Linux machine with
persistent Docker storage. This worker needs outbound HTTPS and no inbound
ports. Use one worker and keep the Compose project name `tradingsim` so the
`state` and `codex` volumes remain available across updates.

## First start

Store the Paper credentials as `alpaca-key` and `alpaca-secret` in the private
directory pointed to by `TRADINGSIM_SECRETS_DIR` (default:
`/run/tradingsim-secrets`). Use permissions `0400` and keep the directory
outside the checkout. The official Alpaca MCP server runs in Paper mode.
Initialize the Codex login once using a device code from the container.

```sh
docker compose -p tradingsim -f deploy/compose.yaml build worker
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps \
  --user 10001:10001 --entrypoint codex worker login --device-auth
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker account-check
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker once --fake --slot 15:40
docker compose -p tradingsim -f deploy/compose.yaml up -d --no-build worker
docker compose -p tradingsim -f deploy/compose.yaml ps worker
```

`account-check` only reads the Paper account. The simulated run uses
`state-fake`, separated from `state`. If the build proxy requires a private
CA, pass its verified public certificate to
`docker build --secret id=build-ca,src=/path/to/ca.pem -t tradingsim-worker -f deploy/Dockerfile .`.
The build CA is not embedded in the image.

## Updates

Build the new image and verify the Paper account before stopping the old
worker. Use the same Compose project and secret paths on every run.
Configure the host to bring Docker up at boot after secret files are
available. Do not delete the named volumes when replacing the container.

```sh
docker compose -p tradingsim -f deploy/compose.yaml build worker
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker account-check
docker compose -p tradingsim -f deploy/compose.yaml stop worker
docker compose -p tradingsim -f deploy/compose.yaml up -d --no-build --force-recreate worker
```

## Telegram

Use [BotFather](https://t.me/BotFather) to create a bot and start a private
chat with it. Take the intended destination from `message.chat.id` in
[Telegram getUpdates](https://core.telegram.org/bots/api#getupdates).
Allow HTTPS to `api.telegram.org`. Keep `telegram.env` next to the Paper
credential files, outside the repository:

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
```

Run `docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker telegram-check`
only when you want to send a test notification. After changing the file,
recreate the worker. Telegram sends a summary for every Europe/Rome wake-up,
even when no order is sent. Confirmed order updates and saved watchlist
additions arrive separately. The worker checks open orders approximately
once a minute between wake-ups. Relevant news appears in the summary.
Older queued reports stay local. `chart-report` displays and saves its
report locally. Delivery retries leave the wake-up and its orders alone.
If Telegram accepts a message and its acknowledgment is lost, a retry can
repeat the message.

## Watchlist permission and review

The scanner runs at most every 15 minutes. Two analysts can propose an
instrument from recent market data. View pending proposals and grant
permission from the worker terminal. Replace `PROPOSAL_ID` with the ID you
want reviewed.

```sh
docker compose -p tradingsim -f deploy/compose.yaml exec worker bun src/cli.ts watchlist-pending
docker compose -p tradingsim -f deploy/compose.yaml exec worker bun src/cli.ts watchlist-approve PROPOSAL_ID
docker compose -p tradingsim -f deploy/compose.yaml exec worker bun src/cli.ts discovery-status
```

Permission opens the independent review. The reviewer checks recent
evidence against Stooq or Coinbase Exchange data and asks both analysts to
address the objections. Missing evidence or a veto prevents the addition.
Saved instruments are for monitoring only. The set of eligible Paper orders
is unchanged.

Use `discovery-scan` to probe data sources without notifying Telegram or
changing the watchlist. Use `discovery-status` for coverage and the results
of completed reviews.

### Analysis cache and Codex measurements

Compose defaults `TRADINGSIM_CODEX_MODEL_SCAN` to `gpt-6.1-terra` for
`newsSignals`, `discoveryNews`, and `discoveryCharts`. Other roles use
`TRADINGSIM_CODEX_MODEL`, which defaults to `gpt-6.2-sol`. Both values can be
overridden. An empty scan value falls back to the main model. When the main
value is empty, Codex uses its own default for roles without a model.

News checks default to five minutes. Discovery is scheduled every 15
minutes and does not overlap a previous scan. The 09:00, 15:40, 18:30 and
21:40 Europe/Rome sessions launch independently of discovery.

The watchlist state caches both positive and negative verdicts by asset
category, provider or market, and symbol. The cache stores the inputs
and lasts 60 minutes. News changes, directional changes, an invalidation
breach, and significant price or volume changes trigger a new analysis.
A new candle alone does not. For the precise thresholds see
[the Italian guide](README.md#cache-delle-analisi-e-misure-codex).
An invalid or failed response is retried and never cached as a veto.

The chart prompt keeps precomputed indicators, timestamps, and a small
window of closed candles. Order review still has three stages and gets
only the proposal, risk constraints, and relevant evidence. Feed
checks and model calls are logged separately. Model logs include calls
by role, duration, and JSON payload bytes, which are not token counts.

```sh
bun tests/fixtures/efficiency-bench.ts "$PWD"
bun test
```
