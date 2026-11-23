# Deploy su Windows

[English](windows.md) · Italiano

Usa Docker Desktop con **WSL 2 e container Linux** e Docker Compose v2.24
o successivo. Il PC deve essere sveglio e Docker Desktop attivo. Se vuoi
riavviare il worker dopo un riavvio di Windows, abilita Docker Desktop
all’accesso. La politica del container è `unless-stopped`.

## Aggiornare un worker esistente

Aggiorna tra due sveglie. Usa lo stesso contesto Docker, lo stesso progetto
Compose `tradingsim` e la stessa directory privata dei segreti del worker
esistente. Così conservi `tradingsim_state` e `tradingsim_codex`.
Evita `docker compose down -v`. Prima di toccare il worker, prepara un
nuovo checkout oppure aggiorna un checkout pulito di `main`.

Dal nuovo checkout in PowerShell, se la directory dei segreti non è già
impostata, assegna il suo percorso Windows assoluto. Contiene
`alpaca-key`, `alpaca-secret` e, se usato, `telegram.env`, fuori dal repository.

```powershell
$env:TRADINGSIM_SECRETS_DIR = 'C:\percorso\privato\tradingsim-secrets'
$compose = @('compose', '-p', 'tradingsim', '-f', 'deploy/compose.yaml')

docker @compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Configurazione Compose non valida.' }
docker @compose build worker
if ($LASTEXITCODE -ne 0) { throw 'Build fallita; il worker esistente è ancora attivo.' }
docker @compose run --rm --no-deps worker account-check
if ($LASTEXITCODE -ne 0) { throw 'Lettura Paper fallita; il worker esistente è ancora attivo.' }

docker @compose stop worker
if ($LASTEXITCODE -ne 0) { throw 'Impossibile arrestare il worker esistente.' }
docker @compose up -d --no-build --force-recreate worker
if ($LASTEXITCODE -ne 0) { throw 'Impossibile avviare il worker aggiornato.' }
docker @compose ps worker
```

Se configuri il worker da WSL, usa la stessa shell e un percorso assoluto
come `/mnt/c/…` visibile a Docker Desktop. La [guida Linux](README.md)
spiega il primo login Codex e la [configurazione Telegram](README.md#telegram).

```powershell
docker @compose exec worker bun src/cli.ts discovery-scan
docker @compose exec worker bun src/cli.ts discovery-status
```

Questi controlli non inviano ordini o messaggi Telegram. Usa
`docker @compose stop worker` per fermare lo scheduler. I log possono
contenere dati Paper. Consultali localmente e oscura i dati prima di condividerli.

### Finestra guidata per Windows e KICKPI

Dal checkout aggiornato aprire PowerShell nella directory che contiene
`TradingSim.ps1` ed eseguire:

```powershell
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File .\TradingSim.ps1
```

Per il PC scegliere **Aggiorna il worker sul PC Windows**. La finestra individua
il progetto Compose e la cartella privata, verifica l’immagine in un container
temporaneo e propone l’aggiornamento dopo le letture dirette di tutti i servizi.
La verifica usa la rete solo dopo i test offline. Telegram usa getChat.
Per Gold, updatedAt indica l’ora della risposta. Un prezzo senza timestamp
di mercato resta di freschezza non verificata.

Per la scheda avviare prima una distribuzione Linux con SSH e configurare
l’accesso con chiave OpenSSH dal PC. Confrontare l’impronta SSH con quella
visualizzata localmente sulla scheda al primo collegamento. Il wizard richiede
Docker utilizzabile dall’utente e Compose 2.24 o successivo. Compila e prova
sulla CPU effettiva; la compatibilità della singola immagine di sistema
si verifica sul dispositivo. I segreti della scheda sono in
`~/.local/share/tradingsim-secrets`. Il pulsante Codex avvia il login ufficiale
via dispositivo in una console. Preparare la KICKPI non avvia il suo scheduler.
