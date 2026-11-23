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
La copertura dei feed indicativi dipende dal provider e dal piano.
Per ogni future si confrontano i contratti datati dei prossimi otto mesi con
scadenza verificata, usando il volume di seduta disponibile. Il cambio di
contratto è indicato esplicitamente. Ogni analisi usa una sola scadenza.
Lo stato della sessione dipende dai metadati del singolo mercato.
Per calendari completi di festività e pause, dati tick e VWAP ufficiali
servirebbe un feed autorizzato CME/ICE. Per Gold CFD serve il feed del
broker specifico. I prezzi spot e futures non rappresentano quel CFD.

#### Provider di monitoraggio

La discovery e la watchlist leggono le azioni e gli ETF da Alpaca IEX (con
controllo del catalogo) e le crypto da Alpaca Crypto. Il simbolo persistente
BTC-USD o ETH-USD viene tradotto solo nella richiesta al provider. UGL e GLL
sono ETF a leva giornaliera. Il CFD SPX500_USD mostra solo il sottostante
S&P 500. Per consultare questi feed in sola lettura usare
`bun src/cli.ts monitor-check`. Il comando usa la cache e non invia Telegram.

Alle 12:30 i metalli spot usano goldApi.dev e il Forex usa Twelve Data.
DXY e futures indicativi usano Yahoo Chart v8; il rendimento decennale
è l'osservazione giornaliera FRED DGS10. Le serie continue dei futures
restano riferimenti quando il contratto non è identificabile. Per un
contratto datato servono scadenza verificata, borsa corrispondente e volumi
della stessa sessione rilevati a distanza massima di cinque minuti.
È possibile integrare la scadenza mancante con la tabella locale
`state/futures-calendar.json`, un array con `symbol`, `lastTradeAt`
(istante con fuso) e `source` (URL della scheda CME verificata).
Il criterio confronta i contratti del periodo considerato, otto mesi.
L'OHLC spot e il VWAP possono essere assenti. I periodi senza barre
consecutive sufficienti sono segnalati. Calendari o pause non confermati
restano esplicitamente non verificabili.

Configurazione Windows: creare `monitor.env` **nella directory privata
già indicata da TRADINGSIM_SECRETS_DIR**, con le stesse ACL ristrette dei
segreti Alpaca. Compose lo legge facoltativamente. Impostare localmente
`TWELVE_DATA_API_KEY` e `GOLDAPI_KEY`. Per goldApi.dev impostare anche
`GOLDAPI_URL_TEMPLATE` con l'endpoint HTTPS USD indicato dal proprio piano,
inserendo `{metal}` al posto di XAU o XAG. Il worker accetta goldapi.dev e
api.goldapi.dev. Il nome dell'header chiave è configurabile con
`GOLDAPI_AUTH_HEADER` (default X-API-Key). Il parser richiede identità del
metallo, valuta USD, prezzo e timestamp nella risposta JSON o nel campo data.
Verificare endpoint, formato, condizioni d'uso e quota nel pannello del piano.
Non inviare chiavi in chat. Ogni richiesta gratuita prenota il credito nello stato persistente prima
dell'invio. Discovery, briefing e analisi operative condividono cache e budget.
Per Twelve Data Basic si applicano 8 crediti in 60 secondi mobili e un tetto
prudenziale di 700 per giorno UTC (piano dichiarato: 800). Le attività secondarie
si fermano a 6/minuto o 640/giorno. Per goldApi.dev Free si usano solo quotazioni
spot: tetto di 80 richieste in 60 minuti mobili (piano dichiarato: 100), di cui
16 riservate all'oro prioritario. Gli eventuali limiti locali inferiori impostati
con `TWELVE_DATA_DAILY_LIMIT` e `GOLDAPI_DAILY_LIMIT` continuano ad applicarsi.
Il worker contabilizza il peso dichiarato della richiesta e il saldo comunicato
dal provider, anche quando altri programmi usano la stessa chiave. In mancanza
di header può misurare solo il proprio traffico. Un 429 sospende le richieste
anche dopo un riavvio e rispetta Retry-After.

`bun src/cli.ts api-usage` mostra chiamate totali, unità consumate oggi (UTC),
consumo nella finestra mobile e ultimi saldi validi senza consultare le API.
Per i metalli e il Forex una fonte spot equivalente viene interrogata solo
quando quella preferita manca o non è abbastanza recente o completa.
Per i confronti conta il timestamp del prezzo o della chiusura della candela.
Il briefing mostra esplicitamente il provider di fallback. Nella pausa settimanale
OTC (intervallo prudenziale da venerdì 18:00 a domenica 16:00 a New York) si riusa la cache; per le azioni
si usa la prossima apertura indicata da Alpaca. La crypto mantiene la sessione 24/7.

Documentazione: [Twelve Data](https://twelvedata.com/docs),
[goldApi.dev](https://goldapi.dev), [FRED DGS10](https://fred.stlouisfed.org/series/DGS10),
[termini Yahoo](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html).
