# Worker cloud

[English](README.en.md) · Italiano · [Windows](windows.it.md)
Serve una VM Linux sempre accesa con Docker Engine e Compose v2.24 o successivo, un disco persistente
per il data root di Docker e accesso HTTPS a ChatGPT, Alpaca Paper, Alpaca Data e Yahoo
Finance. Mantieni un solo worker e lo stesso nome progetto Compose `tradingsim`.
I volumi `state` e `codex` contengono rispettivamente dati dell'app e login ChatGPT.
Non rimuoverli durante gli aggiornamenti. Non esporre porte pubbliche.

Dal gestore dei segreti del provider, rendi disponibili sulla VM le due credenziali
Paper come file `alpaca-key` e `alpaca-secret` in `/run/tradingsim-secrets` (o nella
directory indicata da `TRADINGSIM_SECRETS_DIR`). Configura il recupero al boot con
l'identità della VM. I file devono essere leggibili solo da root con permessi
`0400` e si montano in sola lettura nel worker. Il processo Codex ha un UID separato. Il worker lancia il server MCP ufficiale
`alpaca-mcp-server==2.4.1` via stdio e forza `ALPACA_PAPER_TRADE=true`.
Il container ha bisogno delle proprie credenziali Paper. Il collegamento di
un plugin alla chat non rende le sue credenziali o i suoi strumenti disponibili
al container.

Dalla radice del checkout, costruisci l'immagine e inizializza una sola volta
l'autenticazione del CLI con il tuo account ChatGPT tramite codice dispositivo.

```sh
docker compose -p tradingsim -f deploy/compose.yaml build
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps \
  --user 10001:10001 --entrypoint codex worker login --device-auth
```

Se la rete della VM usa un proxy con una CA privata, usa il certificato
pubblico verificato del proxy durante la build con
`docker build --secret id=build-ca,src=/percorso/ca.pem -t tradingsim-worker -f deploy/Dockerfile .`.
Il certificato di build non viene aggiunto all'immagine.

Completa il login sulla pagina indicata dal CLI. Verifica la possibilità di una
risposta headless e poi verifica l'accesso Alpaca Paper senza inviare ordini.

```sh
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps \
  --user 10001:10001 --entrypoint codex worker --ask-for-approval never exec \
  --ephemeral --skip-git-repo-check --ignore-user-config --sandbox read-only \
  -c features.shell_tool=false 'Rispondi solamente OK.' </dev/null
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker account-check
```

`account-check` usa lo stesso server MCP, le credenziali e i mount del worker.
Invoca solo `get_account_info` e non stampa il conto. Lo scheduler esegue
questa stessa lettura all’avvio prima di accettare sveglie.

Esegui una sveglia finta prima di attivare il worker. Lo stato finto usa
`state-fake` sullo stesso volume, separato da `state`. Un secondo container
deve ritrovare il testimone e la consegna finta.

```sh
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker once --fake --slot 15:40
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker status --fake
docker compose -p tradingsim -f deploy/compose.yaml up -d --no-build
docker compose -p tradingsim -f deploy/compose.yaml logs -f worker
```

Aggiornamento da un commit verificato, dalla radice del checkout aggiornato, e arresto.

```sh
docker compose -p tradingsim -f deploy/compose.yaml build
docker compose -p tradingsim -f deploy/compose.yaml stop worker
docker compose -p tradingsim -f deploy/compose.yaml up -d --no-build
# Arresto manuale
docker compose -p tradingsim -f deploy/compose.yaml stop worker
```

Usa `docker compose ... exec worker bun src/cli.ts status` durante l'esecuzione.
Configura Docker per l'avvio al boot. Verifica che il recupero dei segreti preceda
il riavvio automatico dei container, oppure avvia Compose dal servizio di boot
del provider dopo il recupero dei segreti. Il disco va protetto con permessi
privati e conservato anche se la VM viene sostituita.

## Telegram

Crea un bot con [@BotFather](https://t.me/BotFather), apri la chat con il nuovo
bot e premi **Avvia**. Puoi ricavare l'ID numerico della chat da
`message.chat.id` nella risposta a [getUpdates](https://core.telegram.org/bots/api#getupdates)
del tuo bot. Verifica che la chat sia quella prevista: i resoconti possono
contenere dati del tuo conto Alpaca Paper.

Conserva `telegram.env` nella directory privata indicata da
`TRADINGSIM_SECRETS_DIR`, insieme ai file Alpaca, fuori dal checkout. Su
Linux usa proprietario `root` e permessi `0400`. Il file contiene due righe:

```dotenv
TELEGRAM_BOT_TOKEN=token-del-bot
TELEGRAM_CHAT_ID=id-numerico-della-chat
```

Consenti HTTPS in uscita verso `api.telegram.org`. Dalla radice del repository,
dopo la build, verifica la destinazione con un messaggio di prova:

```sh
docker compose -p tradingsim -f deploy/compose.yaml run --rm --no-deps worker telegram-check
```

Ricrea il worker con `docker compose -p tradingsim -f deploy/compose.yaml up -d --no-build`
per caricare la configurazione. Telegram invia un riepilogo per ogni sveglia
in ora di Roma, anche senza operazioni, oltre agli aggiornamenti degli
ordini Paper e alle aggiunte salvate nella watchlist. Tra le sveglie il
worker ricontrolla gli ordini circa ogni minuto. Le notizie pertinenti
compaiono nel riepilogo. I vecchi resoconti in coda restano locali.
La coda ritenta la consegna senza ripetere la sveglia. Se Telegram accetta
l’invio ma la risposta si perde, il ritentativo può produrre un duplicato.

`chart-report` produce un resoconto locale senza inviare ordini o messaggi.

### Permesso e revisione della watchlist

La scansione propone strumenti dopo la conferma dei due analisti.
Per leggere le proposte in attesa e concedere il tuo permesso usa il
terminale del worker. Sostituisci `ID_PROPOSTA` con l’ID restituito:

```sh
docker compose -p tradingsim -f deploy/compose.yaml exec worker bun src/cli.ts watchlist-pending
docker compose -p tradingsim -f deploy/compose.yaml exec worker bun src/cli.ts watchlist-approve ID_PROPOSTA
docker compose -p tradingsim -f deploy/compose.yaml exec worker bun src/cli.ts discovery-status
```

Il permesso abilita la revisione, che può respingere la proposta. Il
revisore verifica il segnale aggiornato, mette a confronto fonti
indipendenti e chiede un riscontro ai due analisti. I confronti usano
Stooq o Coinbase Exchange quando sono disponibili. Se mancano prove
sufficienti, lo strumento resta fuori. Le aggiunte abilitate sono di
solo monitoraggio e l’universo negoziabile resta invariato.

`discovery-scan` legge i dati di mercato senza inviare messaggi né
modificare la watchlist. `discovery-status` mostra la copertura osservata
e l’esito delle revisioni. La scansione parte al massimo ogni 15 minuti.

### Cache delle analisi e misure Codex

Compose imposta `TRADINGSIM_CODEX_MODEL_SCAN=gpt-6.1-terra` per
`newsSignals`, `discoveryNews` e `discoveryCharts`. Gli altri ruoli usano
`TRADINGSIM_CODEX_MODEL=gpt-6.2-sol`. Puoi sovrascrivere entrambi i valori.
Un valore di scansione vuoto usa il modello principale. Se manca anche
quello principale, il CLI usa il suo predefinito.

Lo scheduler controlla le notizie ogni 5 minuti per impostazione predefinita
e avvia la scoperta ogni 15 minuti quando il processo precedente è terminato.
La scoperta e le sveglie delle 09:00, 15:40, 18:30 e 21:40
(`Europe/Rome`) usano processi e lock separati. Una scansione già in corso
non ritarda l’avvio di una sveglia. In caso di sovraccarico non partono due
scansioni concorrenti.

`watchlist.json` conserva i verdetti dei due analisti, anche se negativi,
con fonti, dati e ora dell’analisi. La chiave è categoria, mercato o provider
e simbolo. La cache dura 60 minuti. Un errore o una risposta non valida
viene ritentato alla scansione utile e non diventa un veto. Una candela
nuova non invalida da sola il verdetto. La prima scansione utile rivaluta se:

- cambia una fonte o una notizia pertinente fra le quattro più recenti;
- cambia il segno del movimento giornaliero o orario, oppure il prezzo
  oltrepassa il livello di invalidazione, anche se poi recupera;
- la variazione giornaliera cambia di almeno il maggiore fra **0,25 punti
  percentuali** e metà della volatilità giornaliera tipica. Per l’ora la
  soglia è il maggiore fra **0,15 punti** e un quarto della volatilità;
- il movimento relativo cambia di almeno **0,5×**, o il volume relativo
  cambia di almeno il maggiore fra **0,5×** e il **30%** del riferimento.
  Anche la perdita o il ritorno del dato di volume invalida il verdetto;
- scade la cache. Dati di mercato troppo vecchi o incompleti non generano
  un candidato nuovo.

Ai grafici arrivano variazione, SMA 5/20, RSI 14, volume relativo, massimi
e minimi recenti, fonti e timestamp. Il payload include al massimo sei
candele a 15 minuti e quattro giornaliere per serie. Esclude le candele
prima della chiusura dell’intervallo. Per il giornaliero considera
concluso l’intervallo 24 ore dopo il timestamp della fonte. Indicatori
mancanti sono `null`; i dati datati sono segnalati. Per la revisione di un
ordine, il modello riceve i parametri esatti, la motivazione, i vincoli
e le prove riferite a quel simbolo. Mantiene obiezioni, risposta e
verdetto, con gli stessi controlli prima dell’invio.

I log `feed.*` contano i controlli dei feed. `analysis.model` conta le
invocazioni del modello per ruolo, durata e byte UTF-8 del payload JSON.
`analysis.discovery-cache` riporta analisi nuove, riusi, rivalutazioni,
errori e cause di invalidazione. I byte non sono token. Il benchmark
riproducibile usa servizi finti e non misura tempi di rete o token del
provider:

```sh
bun tests/fixtures/efficiency-bench.ts "$PWD"
bun test
```
