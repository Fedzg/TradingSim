#!/bin/sh
set -eu
dir=/run/secrets
test "$(id -u)" = 0
test ! -L "$dir"
if mountpoint -q "$dir"; then echo "Montare i file sotto /run/secrets" >&2; exit 1; fi
install -d -o root -g root -m 0700 "$dir"
test "$(stat -c '%u:%a' "$dir")" = 0:700
setpriv --reuid=10001 --regid=10001 --clear-groups sh -ec 'test "$(id -u)" = 10001; test ! -x /run/secrets'
exec bun src/cli.ts "$@"
