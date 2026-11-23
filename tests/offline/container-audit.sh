#!/bin/sh
set -eu
d=$(mktemp -d)
cd "$(dirname "$0")/../.."
image="${1:?fornire il tag della candidata locale}"
digest=$(docker image inspect -f '{{.Id}}' "$image")
rollback="tradingsim:fixture-$(basename "$d" | tr A-Z a-z)"
docker tag "$digest" "$rollback"
test "$(docker image inspect -f '{{.Id}}' "$rollback")" = "$digest"
for f in alpaca-key alpaca-secret; do echo fixture > "$d/$f"; done
echo 'TWELVE_DATA_API_KEY=fixture' > "$d/monitor.env"
echo 'GOLDAPI_KEY=fixture' >> "$d/monitor.env"
echo 'TELEGRAM_BOT_TOKEN=123:fixture' > "$d/telegram.env"
echo 'TELEGRAM_CHAT_ID=123' >> "$d/telegram.env"
chmod 777 "$d"/*
export TRADINGSIM_SECRETS_DIR="$d"
docker compose -p auditfixture -f deploy/compose.yaml config --quiet
id=$(docker run -d --network none -v "$d:/run/secrets/config:ro" -v "$d/alpaca-key:/run/secrets/alpaca-key:ro" -v "$d/alpaca-secret:/run/secrets/alpaca-secret:ro" "$image" schedule --fake)
trap 'docker stop "$id" >/dev/null; docker rm "$id" >/dev/null; docker image rm "$rollback" >/dev/null; rm -rf "$d"' EXIT
for i in $(seq 1 20); do docker exec "$id" bun src/cli.ts healthcheck --fake >"$d/health" && break; sleep 1; done
docker exec "$id" bun src/cli.ts healthcheck --fake >/dev/null
docker exec "$id" sh -ec 'test -r /run/secrets/alpaca-key; test -r /run/secrets/config/monitor.env'
docker exec --user 10001:10001 "$id" sh -ec 'for f in /run/secrets/alpaca-key /run/secrets/alpaca-secret /run/secrets/config/monitor.env /run/secrets/config/telegram.env; do test ! -r "$f"; done; test ! -r /proc/1/environ'
if docker run --rm --network none --user 10001:10001 "$image" status --fake; then exit 1; fi
docker run --rm --network none -v "$d:/run/secrets/config:ro" "$image" api-usage >/dev/null
docker run --rm --network none --tmpfs /var/lib/tradingsim -v "$PWD/tests/offline:/fixtures:ro" -v "$d:/run/secrets/config:ro" -e BUN_OPTIONS=--preload=/fixtures/setup-providers.ts "$image" monitor-check --setup > "$d/setup.json"
python3 - "$d/setup.json" <<'PYTHON'
import json,sys
result=json.load(open(sys.argv[1]))
assert result["gold"] and result["twelve"] and result["telegram"] and not result["alpaca"]
assert result["diagnostics"]["gold"]["timestamp"]=="non verificato"
assert result["diagnostics"]["twelve"]["connection"]=="HTTP 200"
assert result["diagnostics"]["twelve"]["timestamp"].startswith("2026-11-23")
PYTHON
for v in state codex; do
 name="audit-$(basename "$d")-$v"
 docker volume create "$name" >/dev/null
 docker run --rm --network none -v "$name:/data" -v "$d:/backup" --entrypoint sh "$image" -ec "echo fixture >/data/sample; tar cpf /backup/$v.tar -C /data ."
 (cd "$d"; sha256sum "$v.tar" > "$v.sha256"; sha256sum -c "$v.sha256")
 printf '%s\n' "$digest" > "$d/image.id"
 test "$(docker image inspect -f '{{.Id}}' "$rollback")" = "$(cat "$d/image.id")"
 dest="$name-restore"
 docker volume create "$dest" >/dev/null
 docker run --rm --network none -v "$dest:/data" -v "$d:/backup:ro" --entrypoint sh "$image" -ec "tar xpf /backup/$v.tar -C /data; tar dpf /backup/$v.tar -C /data; test xfixture = x\$(cat /data/sample)"
 docker volume rm "$name" "$dest" >/dev/null
done
echo 'permessi, healthcheck, Compose e ripristino fixture OK'
