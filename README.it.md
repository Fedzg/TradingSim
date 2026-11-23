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

Telegram invia un riepilogo per sveglia anche senza operazioni, oltre agli
aggiornamenti degli ordini Paper e alle aggiunte salvate nella watchlist.
Il riepilogo include il conto Paper verificato, gli ordini attivi e fino a
tre notizie pertinenti. Nel briefing delle 09:00 il calendario e l’orologio
Alpaca distinguono la seduta regolare precedente dal premarket disponibile.
Cinque minuti dopo la chiusura regolare indicata da Alpaca, TradingSim
riepiloga gli eseguiti e le decisioni già salvate. L’orario di questo
riepilogo varia con le chiusure anticipate e con l’ora legale.
I grafici completi e gli altri messaggi in coda restano consultabili
localmente. Lo stato e il testimone sono visibili con `bun run status`,
i resoconti completi sono in `state/history/` e i log in `state/logs/`.

Le proposte per la watchlist si consultano su richiesta. L’aggiunta richiede
prima il permesso dell’operatore e poi una revisione indipendente.
Vedi [Permesso e revisione della watchlist](deploy/README.md#permesso-e-revisione-della-watchlist).

Vedi [Contribuire](CONTRIBUTING.md#italiano) e [Sicurezza](SECURITY.md#italiano).

### Briefing Gold & Futures

Alle 12:30 Europe/Rome lo scheduler crea un briefing informativo separato.
Avvio manuale: `bun src/cli.ts once --slot 12:30` (aggiungere `--fake` per simulare).
Il feed indicativo Yahoo può richiedere autorizzazione o non coprire alcuni simboli.
Per ogni future si confrontano i contratti datati dei prossimi otto mesi con
scadenza verificata, usando il volume di seduta disponibile. Il cambio di
contratto è indicato esplicitamente. Ogni analisi usa una sola scadenza.
Lo stato della sessione dipende dai metadati del singolo mercato.
Per calendari completi di festività e pause, dati tick e VWAP ufficiali
servirebbe un feed autorizzato CME/ICE. Per Gold CFD serve il feed del
broker specifico. I prezzi spot e futures non rappresentano quel CFD.
