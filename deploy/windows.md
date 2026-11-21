# Windows deployment

English · [Italiano](windows.it.md)

Use Docker Desktop with the **WSL 2 backend and Linux containers** and
Docker Compose v2.24 or later. Keep the host awake and Docker Desktop
running. Enable Docker Desktop at sign-in if you want the worker to restart
after a Windows reboot. The container policy is `unless-stopped`.

## Update an existing worker

Run the update between scheduled sessions. Use the same Docker context,
Compose project name `tradingsim`, and private secrets directory as the
existing worker. This preserves `tradingsim_state` and `tradingsim_codex`.
Do not run `docker compose down -v`. Prepare the new checkout or an updated
clean checkout of `main` before touching the running worker.

From the new checkout in PowerShell, if the secrets directory is not already
set, assign its absolute Windows path. It contains `alpaca-key`,
`alpaca-secret`, and optionally `telegram.env`, outside the repository.

```powershell
$env:TRADINGSIM_SECRETS_DIR = 'C:\path\to\private\tradingsim-secrets'
$compose = @('compose', '-p', 'tradingsim', '-f', 'deploy/compose.yaml')

docker @compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Invalid Compose configuration.' }
docker @compose build worker
if ($LASTEXITCODE -ne 0) { throw 'Build failed; the existing worker is still running.' }
docker @compose run --rm --no-deps worker account-check
if ($LASTEXITCODE -ne 0) { throw 'Paper account check failed; the existing worker is still running.' }

docker @compose stop worker
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the existing worker.' }
docker @compose up -d --no-build --force-recreate worker
if ($LASTEXITCODE -ne 0) { throw 'Could not start the updated worker.' }
docker @compose ps worker
```

If you configure the worker from WSL instead, use the same shell and an
absolute path such as `/mnt/c/…` visible to Docker Desktop. The Linux guide
covers the first-time [Codex login](README.en.md#first-start) and
[Telegram configuration](README.en.md#telegram).

```powershell
docker @compose exec worker bun src/cli.ts discovery-scan
docker @compose exec worker bun src/cli.ts discovery-status
```

These checks do not submit orders or send Telegram messages. Use
`docker @compose stop worker` to stop the scheduler. Worker logs may contain
Paper account data. Inspect them locally and redact them before sharing.
