# Strategie Paper 2.0

La base esaminata e il riferimento dell’audit coincidono in db5f73ebb4f1699fa43e3541d45931c7a78f16d7. Il diff tra i due alberi è vuoto anche per i test. L’audit precedente aveva individuato c0dbf6e sul PC. Il container Windows corrente richiede una nuova verifica locale.

| Skill di riferimento | Base | Candidata |
|---|---|---|
| Scanner | Discovery multi-mercato, RSI e volume | Setup giornalieri sui candidati, ORB su seduta verificata |
| News | Notizie Alpaca, eventi deduplicati e macro | Depositi SEC con data di accettazione, link e CIK |
| Entry | Proposta del decisore | ORB a 15 minuti e resistenza a 20 sedute su candela chiusa |
| Exit | Stop al 3% durante le sveglie | Bracket con stop tecnico/ATR/percentuale, target 2R e tentativo di uscita temporale |
| Time Machine | Assente | Replay, finestre cronologiche e bootstrap con seed |
| Budget | Verifica della quantità proposta | Quantità intera determinata da rischio, stop, esposizione e contante |
| Risk | Whitelist, rischio per simbolo e ordini pendenti | Limiti aggregati, giornalieri e circuit breaker persistente |
| Broker | Alpaca Paper MCP, lock e registro intenti | Ticket con piano e gambe bracket, controlli prima dell’invio |
| Alerts | Coda Telegram con checkpoint | Avvisi strategici deduplicati |
| Analyst | Analisi tecnica e macro | Companyfacts SEC per AAPL, MSFT e NVDA |
| Pelosi | Assente | Valutato e escluso per il ritardo delle dichiarazioni pubbliche |

Con configurazione vuota resta attivo il comportamento precedente. Per la prova configurare TRADINGSIM_EXECUTION_MODE=analysis-only e TRADINGSIM_STRATEGIES=orb,resistance. Per EDGAR impostare TRADINGSIM_SEC_USER_AGENT con un contatto valido. In approval-required usare i comandi order-pending e order-approve HASH durante la validità della proposta. paper-auto richiede abilitazione esplicita e strategie in allowlist. Tutte le modalità usano lo stesso endpoint Paper. Le posizioni precedenti non sono adottate dal gestore dei bracket.

Le strategie valutano gli ingressi alle sveglie operative. Richiedono volume relativo almeno 1,5, controvalore della candela almeno 100.000 USD, spread al massimo 0,2% e segnale di età inferiore a cinque minuti dalla chiusura. Il codice limita il rischio teorico al 0,25% del capitale per ingresso, l’esposizione aggregata al 20%, gli ingressi a tre per seduta. La perdita giornaliera dell’1% sospende gli ingressi. Un gap può peggiorare il prezzo di stop. Il target scelto è 2R fra i livelli 1R, 2R e 3R del piano. Il controllo periodico tenta di annullare gli ingressi scaduti senza eseguiti. Negli ultimi 15 minuti tenta di abbassare il prezzo della gamba target dopo revisione. La liquidazione dipende da worker, liquidità e conferma broker. Un parziale, un guasto o una sospensione possono lasciare una posizione aperta oltre la chiusura.

Comandi di ricerca con Bun da root del repository:

    bun src/cli.ts strategy-backtest tape.json orb 10000 12345 5 --fake
    bun src/cli.ts strategy-performance
    bun src/cli.ts strategy-fundamentals AAPL

Il replay usa il 70% iniziale per lo sviluppo e il resto per la validazione in finestre di cinque sedute, a parametri fissi. I 5 punti base modellano insieme spread, slippage e costi per lato. Il replay accetta un ingresso al successivo open compatibile, privilegia lo stop in caso di doppio tocco e simula l’uscita all’apertura dell’ultima barra. Non replica la profondità del book o gli eseguiti parziali. Il dataset TSLA è solo per ricerca. Su 59 sedute, ORB ha tre trade fuori campione e resistenza zero. Il bootstrap richiede dieci trade chiusi. Il test non dimostra redditività.

Per aggiornare soltanto dopo autorizzazione, seguire [backup e ripristino](audit-rollout.it.md), verificare digest e volumi, usare la modalità di analisi e controllare healthcheck e continuità dello storico. Prima di un rollback verificare su Alpaca eventuali bracket pendenti e posizioni aperte. Il vecchio worker non gestisce le uscite temporali 2.0. Riconciliare gli intenti prima di riprendere il servizio con un solo worker.
