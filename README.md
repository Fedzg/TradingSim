# TradingSim

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
compila i campi Paper e accedi inizialmente con `codex login`. Rimuovi `--fake`
per operare sul conto simulato del broker. `bun run once` sceglie l'ultimo slot
di oggi e `--force` consente di ripeterlo con i medesimi ID. Per il worker
sempre acceso segui le [istruzioni di deploy](deploy/README.md).

I grafici del portafoglio sono Alpaca IEX, le notizie provengono da Alpaca News.
Il WTI usa la serie Yahoo Finance `CL=F`, futures NYMEX front-month continuo.
GBP/USD usa `GBPUSD=X`. Queste due serie sono solo di monitoraggio. Un acquisto
ha prezzo limite fissato prima della revisione e può rimanere ineseguito.
Un invio incerto rimane registrato e viene riconciliato per ID senza reinvio
automatico. Se il broker non rende l'esito verificabile, controlla il registro
`intents/` e il conto Paper prima di intervenire.

Il resoconto di ogni sveglia, gli allarmi e le domande sui mercati sono
persistiti nella coda `outbox/`. La consegna a questa conversazione non è
disponibile. `bun run status` mostra la coda e il motivo di mancata consegna.
Per una prova offline, il canale finto scrive in `fake-chat/`. Se si simula
un errore con `TRADINGSIM_FAKE_CHAT_FAIL=1`, lo si può ritentare con
`bun src/cli.ts deliver --fake`, che esegue solo la consegna.
