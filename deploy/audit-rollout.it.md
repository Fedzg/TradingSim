# Candidata audit Windows

## Verifiche prima dell'autorizzazione

Confrontare di nuovo sul PC il container, il suo ID immagine e i nomi dei
volumi. I comandi seguenti mostrano soltanto gli identificatori.

```powershell
docker ps --filter label=com.docker.compose.project=tradingsim --format '{{.Names}} {{.ID}}'
docker inspect -f '{{.Image}}' tradingsim-worker-1
docker inspect -f '{{range .Mounts}}{{.Destination}} {{.Name}}{{println}}{{end}}' tradingsim-worker-1
```

## Solo dopo autorizzazione al rollout

1. Conservare il checkout precedente con il suo Compose originale. Aprire
   PowerShell nella **copia separata** della candidata. Non riutilizzare
   un tag di rollback come prova del contenuto dell'immagine.
2. Eseguire `powershell.exe -NoProfile -STA -File .\TradingSim.ps1`.
   Scegliere il worker Windows. La verifica prepara una cartella temporanea
   privata e una cache di collaudo; usa crediti reali quando si autorizzano
   le letture. Non ricopiare file privati nel checkout.
3. Tra le sveglie, con un solo worker e nessuna riconciliazione Paper
   pendente, scegliere **Applica aggiornamento**. Il wizard arresta il
   worker per la copia consistente, conserva configurazione e archivi in
   `%LOCALAPPDATA%\TradingSim\backup-<GUID>`, registra digest, tag e SHA256
   nel manifest, quindi ricrea il worker usando gli stessi volumi.
4. Controllare `docker ps`, `docker inspect -f '{{.Image}}' tradingsim-worker-1`
   e `docker exec tradingsim-worker-1 bun src/cli.ts healthcheck`. Verificare
   che l'UID 10001 non possa attraversare /run/secrets. Non invocare una
   sveglia per il collaudo. Gli slot saltati scadono, incluso Gold: nessun
   recupero automatico è stato introdotto.

## Solo dopo autorizzazione al rollback

Indicare la directory privata del backup e quella dei segreti originali.
Conservare i volumi attuali per l'analisi. Prima di avviare uno scheduler
con archivi precedenti verificare conto, ordini e client_order_id con il
registro delle operazioni successive al backup: in caso di divergenza
lasciare il servizio fermo per la riconciliazione.

```powershell
$b = Read-Host 'Percorso assoluto backup'
$m = Get-Content -Raw (Join-Path $b manifest.json) | ConvertFrom-Json
if ((docker image inspect -f '{{.Id}}' $m.tag) -ne $m.image) { throw 'Digest rollback errato' }
if ((Get-FileHash $m.compose).Hash -ne (Get-FileHash (Join-Path $b compose-precedente.yaml)).Hash) { throw 'Compose precedente cambiato' }
foreach ($v in 'state','codex') {
  if ((Get-FileHash (Join-Path $b "$v.tar")).Hash -ne $m.files.$v) { throw "Checksum $v errato" }
}
$suffix = [guid]::NewGuid().ToString('N')
foreach ($v in 'state','codex') {
  $dest = "tradingsim-restore-$suffix-$v"
  docker volume create $dest
  if ($LASTEXITCODE) { throw 'Creazione volume fallita' }
  docker run --rm --network none -v "${dest}:/restore" -v "${b}:/backup:ro" --entrypoint tar $m.image -xpf "/backup/$v.tar" -C /restore
  if ($LASTEXITCODE) { throw 'Ripristino fallito' }
}
$override = Join-Path $b 'restore-compose.yaml'
@"
volumes:
  state:
    name: tradingsim-restore-$suffix-state
    external: true
  codex:
    name: tradingsim-restore-$suffix-codex
    external: true
"@ | Set-Content -Encoding ascii $override
```

A riconciliazione conclusa, fermare il worker e ripristinare la
configurazione privata corrispondente. Usare la stessa directory segreti e
lo stesso contesto Docker della precedente installazione.

```powershell
docker stop -t 90 tradingsim-worker-1
if ($LASTEXITCODE) { throw 'Arresto non confermato' }
foreach ($file in 'alpaca-key','alpaca-secret','monitor.env','telegram.env') {
  if (Test-Path (Join-Path $b $file)) { Copy-Item (Join-Path $b $file) (Join-Path $env:TRADINGSIM_SECRETS_DIR $file) -Force }
}
docker tag $m.image $m.name
if ($LASTEXITCODE) { throw 'Tag non ripristinato' }
docker compose -p $m.project -f $m.compose -f $override up -d --no-build worker
if ($LASTEXITCODE) { throw 'Avvio fallito' }
docker compose -p $m.project -f $m.compose -f $override ps worker
docker inspect -f '{{.Image}}' tradingsim-worker-1
```

Il rollback verso la vecchia immagine ripristina anche il suo precedente
comportamento di sicurezza. Conservare gli archivi Codex solo in locale
con ACL private.

## Import del calendario

Consultare il calendario ufficiale del prodotto CME/NYMEX. Verificare
contratto e mese, **Last Trade Date**, ora di cessazione e fuso nella
specifica ufficiale. Escludere i record per cui si conosce soltanto il
giorno. Salvare una CSV con intestazione
`symbol,lastTradeAt,timezone,source`. Usare l'istante ISO con offset,
il nome IANA della zona e l'URL della pagina del prodotto. Il file è
uno snapshot completo: conservare e ricontrollare le righe ancora valide.

```sh
python3 deploy/import-futures-calendar.py verificato.csv futures-calendar.json
```

Controllare il JSON prima di installarlo, solo su autorizzazione, come
`state/futures-calendar.json`. L'import verifica forma, offset e dominio;
la verifica del contenuto della pagina spetta a chi prepara la CSV.
Un continuo non prova la scadenza del contratto.
