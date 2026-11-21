# TradingSim

[English](README.md) · Italiano

Worker Bun e TypeScript per simulare ordini su Alpaca Paper. Le sveglie sono
alle 09:00, 15:40, 18:30 e 21:40 in ora di Roma. Il briefing delle 09:00 non
invia ordini. L'orologio di Alpaca governa gli altri slot.

Su Linux con Bun 1.3.14 e `flock` di util-linux:

```sh
bun test
bun run once --fake --slot 15:40
bun run status --fake
bun run schedule --fake
```

Per usare Alpaca Paper localmente, copia `secrets.example.ts` in `secrets.ts`,
compila i campi Paper, installa `alpaca-mcp-server==2.4.1` sul PATH (ad esempio
`uv tool install alpaca-mcp-server==2.4.1`) e accedi con `codex login`.
`bun src/cli.ts account-check` legge solo il conto via MCP e usa la stessa
configurazione del worker. Il programma richiede MCP per Alpaca. Rimuovi `--fake`
per operare sul conto simulato del broker. `bun run once` sceglie l'ultimo slot
di oggi e `--force` consente di ripeterlo con i medesimi ID. Per il worker segui le istruzioni per [Windows con Docker Desktop e WSL 2](deploy/windows.it.md) oppure [Linux e VM](deploy/README.md).

I grafici del portafoglio sono Alpaca IEX, le notizie provengono da Alpaca News.
Il WTI usa la serie Yahoo Finance `CL=F`, futures NYMEX front-month continuo.
GBP/USD usa `GBPUSD=X`. Queste due serie sono solo di monitoraggio. Un acquisto
ha prezzo limite fissato prima della revisione e può rimanere ineseguito.
Un invio incerto rimane registrato e viene riconciliato per ID senza reinvio
automatico. Se il broker non rende l'esito verificabile, controlla il registro
`intents/` e il conto Paper prima di intervenire.

I resoconti, gli allarmi, le notizie selezionate, le aggiunte alla watchlist e
gli aggiornamenti degli ordini Paper sono persistiti in `outbox/`.
Per riceverli su Telegram configura il [canale HTTP](deploy/README.md#telegram).
`bun run status` mostra la coda e il motivo di mancata consegna.
Per una prova offline, il canale finto scrive in `fake-chat/`. Se si simula
un errore con `TRADINGSIM_FAKE_CHAT_FAIL=1`, lo si può ritentare con
`bun src/cli.ts deliver --fake`, che esegue solo la consegna.

Per la ricerca di nuovi strumenti e l’aggiunta diretta dopo la conferma dei due
analisti, vedi [Scoperta automatica della watchlist](deploy/README.md#scoperta-automatica-della-watchlist).

Vedi [Contribuire](CONTRIBUTING.md#italiano) e [Sicurezza](SECURITY.md#italiano).
