# Audit della candidata del 24 novembre

Base GitHub verificata 2fed3ae1eba32e97b72b381df43a9ebacbbb22f8. L’ambiente Docker di prova è separato dal PC. Immagine, volumi, log delle tre sveglie, 22 record locali, 48 precedenti e stato delle connessioni con le credenziali Windows devono ancora essere verificati sul dispositivo.

| Esito sulla base | Prova | Modifica |
|---|---|---|
| FAIL | daily-close applicava slice(0,230) a una motivazione | report-text seleziona frasi complete e conserva una frase singola più lunga del limite |
| FAIL | G7b dimostrava due accettazioni della seconda parte dopo risposta persa | chat e telegram sospendono il record ambiguo anche dopo riavvio, il 429 ha ancora il suo retry |
| WARN | lastClosed era l’apertura della candela mentre lagMinutes misurava dalla chiusura | indicators espone apertura, chiusura e istante di valutazione per IEX |
| WARN | entryPlan restituiva undefined senza evidenze per il resoconto | run registra per strategia la fase di rifiuto, il piano disponibile e il sizing |
| WARN | Gold CFD privo di adapter appariva sempre e XAU con quote Twelve saltava la verifica OHLC | briefing omette il CFD privo di simbolo e tenta i timeframe analitici sul feed spot |
| WARN | La coda non identificava il produttore | build versionata da git archive e metadati per record operativi, mantenendo gli ID |
| PASS | Risk e deduplica | Nessuna variazione alle soglie di ingresso o ai client_order_id |

La discovery prenota fino a sei chiamate per scansione e 24 in un’ora mobile per i due analisti iniziali. La prenotazione viene salvata sotto discovery.guard. Un errore prolunga l’attesa fino a un’ora. I ruoli delle sveglie e la revisione indipendente conservano la priorità. Queste soglie sono scelte di implementazione.

Le richieste dal cloud a FRED, Yahoo Finance ed EDGAR sono state bloccate dal proxy prima di ricevere una risposta del provider. Alpaca, Twelve Data, goldApi.dev, Telegram e Codex del worker non sono stati verificati live. L’accesso ai timeframe spot 1m/5m sul piano corrente resta da verificare. Nessun conteggio di record o esito di connessione del PC è inferito da una fixture.

## Rollout e ripristino dopo autorizzazione

1. Verificare sul PC i digest, le etichette Compose, un solo worker e gli ordini/bracket pendenti tramite le letture indicate in audit-rollout.it.md.
2. Costruire con python deploy/build-versioned.py SHA_COMPLETO. Annotare ID immagine e SHA stampati insieme. La build ordinaria resta di provenienza sconosciuta.
3. Nella finestra concordata fermare lo scheduler e acquisire i backup dei volumi secondo audit-rollout.it.md. Conservare separatamente configurazione e immagine precedente.
4. Su una copia offline del volume di stato eseguire python deploy/archive-index.py COPIA_STATO NUOVA_CARTELLA_BACKUP. Rieseguirlo per verificare tutti gli hash. backup contiene gli originali. Il manifest è un indice separato che non decide quali record inviare.
5. Verificare l’immagine candidata in isolamento. Prima dell’avvio operativo confrontare modalità, credenziali montate, intenti, identità broker e checkpoint con la copia. Controllare prima i record DELIVERY_UNKNOWN su Telegram.
6. Per rollback fermare la candidata e riconciliare eventuali ordini registrati dopo il backup. Ripristinare i volumi su destinazioni temporanee e verificarli contro il manifest prima di scegliere i volumi operativi. Ripartire con il digest precedente e un solo scheduler. Un ripristino cieco del vecchio stato può perdere gli intenti successivi al backup.
