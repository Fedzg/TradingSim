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
recreate the worker. The outbox retains unsent reports and checkpoints
multipart delivery.

## Automatic watchlist

Discovery runs at most every 15 minutes regardless of whether Telegram is
configured. It compares completed 15-minute candles with recent daily
volatility. A candidate needs a daily move of at least 1.5 times the median
and a consistent 60-minute move of at least 20% of that median. The worker
reports relative volume where available and flags missing or stale data.
After both analysts agree, the instrument is saved once for monitoring only.
An optional Telegram confirmation contains no approval controls.

Use `discovery-scan` to probe the sources without changing the watchlist or
sending a message, and `discovery-status` to inspect the last saved coverage.
For platform-specific commands see the [Windows guide](windows.md). Inspect
account output and logs locally before sharing them.
