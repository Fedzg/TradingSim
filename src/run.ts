import { ask, reviewOrder, type Agents, type Charts, type Decision, type NewsAnalysis } from "./agents";
import { FakeBroker, type Broker, type BrokerOrder, type Intent, type Proposal, type Snapshot, watched, universe } from "./broker";
import { chartScenarios } from "./chart-scenarios";
import { enqueue } from "./chat";
import { miniChart, type Market, type News, type Series } from "./market";
import { limitFor, risk, stops, terminal, ticketFor, trading } from "./risk";
import { type Baton, type RunLock, State } from "./state";
import { missed, nextWake, type Wake } from "./time";

type Inputs = { state: State; broker: Broker; agents: Agents; market: Market; redact: (s: string) => string };

function observed(order: BrokerOrder, brokerLabel: string) {
  const filled = Number(order.filled_qty);
  const status = new Map([
    ["new", "nuovo"], ["accepted", "accettato"], ["pending_new", "in attesa di accettazione"], ["filled", "eseguito"],
    ["partially_filled", "eseguito in parte"], ["canceled", "annullato"], ["rejected", "respinto"], ["expired", "scaduto"],
    ["done_for_day", "terminato per oggi"], ["pending_cancel", "annullamento in corso"], ["replaced", "sostituito"],
  ]).get(order.status) ?? `stato ${order.status}`;
  return `${order.client_order_id}: ${status} (${brokerLabel}), eseguite ${Number.isFinite(filled) ? filled : "quantità non verificabile"}/${order.qty}.`;
}

export async function run({ state, broker, agents, market, redact }: Inputs, entry: Wake, force: boolean, now = new Date()) {
  const { baton: previous, warning } = await state.baton();
  const interrupted = await state.read<RunLock>("run.lock");
  if (!interrupted && previous && previous.wake.id >= entry.id && !force) return;

  const lock: RunLock = { wake: entry, pid: process.pid, startedAt: now.toISOString(), intents: [] };
  const alerts: string[] = [];
  const simulated = broker instanceof FakeBroker;
  const brokerLabel = simulated ? "broker finto" : "Alpaca Paper";
  const lines: string[] = simulated ? ["SIMULAZIONE OFFLINE. Dati, ordini e consegne finti."] : [];
  const pending = new Set<string>();
  const unresolved = new Set<string>();
  const uncertainSymbols = new Set<string>();
  const recoveredSides = new Set<string>();
  const confirmed = new Map<string, BrokerOrder>();
  const errorText = (error: unknown) => redact(error instanceof Error ? error.message : "Errore inatteso.");
  const note = (message: string) => lines.push(redact(message));
  const notifyOrder = (order: BrokerOrder) => enqueue(state, entry.id, "ordine",
    redact(`${order.symbol} ${order.side === "buy" ? "acquisto" : "vendita"} × ${order.qty}\n${observed(order, brokerLabel)}`),
    JSON.stringify([order.client_order_id, order.status, Number(order.filled_qty)]));
  if (warning) alerts.push(warning);
  if (interrupted) alerts.push(`Sveglia ${interrupted.wake.id} interrotta. Verifica degli intenti registrati con Alpaca.`);
  if (previous) {
    const skipped = missed(previous.wake, entry);
    if (skipped.length) alerts.push(`Sveglie saltate (ora di Roma): ${skipped.join(", ")}.`);
  }

  const intents = await state.intents();
  for (const id of interrupted?.intents ?? []) {
    if (!intents.some(intent => intent.id === id)) throw new Error("Intento mancante nel registro persistente.");
  }
  await state.write("run.lock", lock);

  async function reconcile(intent: Intent) {
    try {
      const order = await broker.find(intent.id);
      if (order) {
        if (order.status !== intent.observed?.status || Number(order.filled_qty) !== Number(intent.observed?.filled_qty)) {
          await notifyOrder(order);
        }
        await state.write(`intents/${intent.id}.json`, { ...intent, observed: order });
        confirmed.set(intent.id, order);
        note(observed(order, brokerLabel));
        if (interrupted?.intents.includes(intent.id) || !intent.observed) recoveredSides.add(`${order.symbol}/${order.side}`);
        if (!terminal.has(order.status)) pending.add(intent.id);
        return;
      }
    } catch (error) { alerts.push(`Verifica di ${intent.id} non riuscita: ${errorText(error)}`); }
    unresolved.add(intent.id);
    uncertainSymbols.add(intent.order.symbol);
    pending.add(intent.id);
    alerts.push(`${intent.id}: esito non verificato. Il codice non ripeterà l’invio.`);
  }

  for (const intent of intents) {
    if (!intent.observed || !terminal.has(intent.observed.status) || interrupted?.intents.includes(intent.id)) await reconcile(intent);
  }

  let snapshot: Snapshot | undefined;
  let charts: Series[] = [];
  let news: News | undefined;
  let chartAnalysis: Charts | undefined;
  let newsAnalysis: NewsAnalysis | undefined;
  let decision: Decision | undefined;

  async function execute(order: Proposal, limit: number | null, approvalTicket?: string, mandatory = false) {
    const label = `${order.symbol} ${order.side} × ${order.qty}`;
    const reject = (reason: string) => note(`Respinto ${label}: ${reason}`);
    const id = `${entry.id}-${order.symbol}-${order.side}`;
    if (!universe.some(symbol => symbol === order.symbol)) return reject("Simbolo fuori dall’universo operativo Alpaca Paper.");
    if (!mandatory && approvalTicket !== ticketFor(order, limit)) return reject("Condizioni diverse da quelle approvate. Serve una nuova revisione.");
    if (pending.has(id) || intents.some(item => item.id === id)) return note(`Nessun reinvio per ${id}: intento già registrato.`);
    if (recoveredSides.has(`${order.symbol}/${order.side}`)) return reject("Ordine della sveglia interrotta appena riconciliato.");
    if (uncertainSymbols.has(order.symbol) || (order.side === "buy" && unresolved.size)) return reject("Invio precedente ancora da riconciliare.");
    try {
      const already = await broker.find(id);
      if (already) return note(observed(already, brokerLabel));
      const current = await broker.snapshot();
      const visible = new Set(current.orders.map(item => item.client_order_id));
      for (const [knownId, item] of confirmed) {
        if (!visible.has(knownId)) {
          if (item.status === "filled" || Number(item.filled_qty) > 0) {
            return reject("Un eseguito recente non compare ancora nello snapshot del conto.");
          }
          if (!terminal.has(item.status)) current.orders.push(item);
        }
      }
      if (mandatory && !stops(current).some(candidate => candidate.symbol === order.symbol && candidate.qty >= order.qty)) {
        return reject("Lo stop o la quantità autorizzata non risultano confermati dal nuovo snapshot.");
      }
      const issue = risk(order, limit, current, entry);
      if (issue) return reject(issue);
      if (!await broker.tradable(order.symbol)) return reject("Titolo non negoziabile su Alpaca Paper.");
    } catch (error) {
      alerts.push(`Verifica broker prima di ${id}: ${errorText(error)}`);
      return reject("Impossibile verificare il broker prima dell’invio.");
    }

    const intent: Intent = { id, order, limit, attemptedAt: new Date().toISOString() };
    await state.write(`intents/${id}.json`, intent);
    intents.push(intent);
    lock.intents.push(id);
    await state.write("run.lock", lock);
    note(`Richiesta di invio al broker per ${id}.`);
    try {
      const result = await broker.submit(intent);
      if (result.client_order_id !== id) throw new Error("ID inatteso nella risposta di Alpaca.");
      await notifyOrder(result);
      await state.write(`intents/${id}.json`, { ...intent, observed: result });
      confirmed.set(id, result);
      note(observed(result, brokerLabel));
      if (!terminal.has(result.status)) pending.add(id);
    } catch (error) {
      alerts.push(`Risposta all’invio ${id}: ${errorText(error)}`);
      await reconcile(intent);
    }
  }

  try { snapshot = await broker.snapshot(); }
  catch (error) { alerts.push(`Conto, posizioni, ordini e orologio non verificati: ${errorText(error)}`); }

  if (snapshot && trading(entry, snapshot)) {
    for (const order of stops(snapshot)) {
      note(`Stop obbligatorio proposto dal codice: ${order.symbol} × ${order.qty}.`);
      await execute(order, null, undefined, true);
    }
  }

  try { charts = await market.charts(now); }
  catch (error) { alerts.push(`Grafici indisponibili: ${errorText(error)}`); }
  try {
    news = await market.cachedNews(state);
    if (!news.checked) news = await market.poll(state, now);
    if (news.error || !news.lastSuccess || +now - Date.parse(news.lastSuccess) > 30 * 60_000) {
      alerts.push(`${news.error ?? "Cache notizie non recente."} Ultimo aggiornamento: ${news.lastSuccess ?? "assente"}.`);
    }
  } catch (error) { alerts.push(`Notizie indisponibili: ${errorText(error)}`); }

  const analysts = await Promise.allSettled([
    ask<Charts>(agents, "charts", { now, charts }),
    ask<NewsAnalysis>(agents, "news", { now, news: news && { ...news, articles: news.articles.slice(0, 30) }, watched }),
  ]);
  if (analysts[0].status === "fulfilled") chartAnalysis = analysts[0].value;
  else alerts.push(`Analisi grafici mancante: ${errorText(analysts[0].reason)}`);
  if (analysts[1].status === "fulfilled") newsAnalysis = analysts[1].value;
  else alerts.push(`Analisi notizie mancante: ${errorText(analysts[1].reason)}`);

  for (const series of charts) {
    if (series.error || !series.updated || +now - Date.parse(series.updated) > 45 * 60_000) {
      note(`${series.symbol} (${series.source}): ${series.error ?? "dati intraday non recenti"}; ultimo dato ${series.updated ?? "assente"}.`);
    }
  }
  for (const series of charts.filter(x => !universe.some(symbol => symbol === x.symbol))) {
    note(`${series.symbol}: solo monitoraggio. Serie ${series.source}.`);
    for (const interval of ["15Min", "1Day"]) {
      const graph = miniChart(series, interval);
      if (graph) note(`Chiusure ${series.symbol}, ${graph}`);
    }
  }
  for (const idea of chartAnalysis?.ideas ?? []) {
    if (watched.includes(idea.symbol)) note(`${idea.symbol} (${idea.horizon}): ${idea.direction}. ${idea.evidence}. Invalidazione: ${idea.invalidation}. Incertezza: ${idea.uncertainty}.`);
  }
  for (const item of chartAnalysis?.limitations ?? []) note(item);
  for (const item of newsAnalysis?.limitations ?? []) note(item);
  for (const event of newsAnalysis?.events ?? []) {
    if (news?.articles.some(article => article.link === event.link && article.published === event.published && article.source === event.source)) {
      const summary = `${event.classification}: ${event.title} (${event.symbols.join(", ")}). ${event.impact} — ${event.source}, ${event.published}, ${event.link}`;
      note(summary);
      await enqueue(state, entry.id, "notizia", redact(summary), JSON.stringify([event.link, event.published]));
    }
  }
  for (const idea of newsAnalysis?.newMarkets ?? []) {
    const source = news?.articles.find(article => article.link === idea.link && article.published === idea.published && article.source === idea.source);
    if (!source || watched.some(symbol => symbol.toUpperCase() === idea.symbol.toUpperCase())) continue;
    await enqueue(state, entry.id, "mercato", redact(`Vuoi aggiungere ${idea.name} (${idea.symbol}) al monitoraggio? ${idea.event}. ${idea.reason}. Fonte: ${source.source}, ${source.published}, ${source.link}`),
      JSON.stringify([idea.symbol.toUpperCase(), source.link, source.published]));
  }

  const analysisCharts = chartAnalysis && { ...chartAnalysis, ideas: chartAnalysis.ideas.map(({ bias: _bias, ...idea }) => idea) };
  const context = { entry, account: snapshot?.account, positions: snapshot?.positions, recentOrders: snapshot?.orders.slice(0, 30),
    clock: snapshot?.clock, plan: previous?.planNext, pending: [...pending], analysisCharts, analysisNews: newsAnalysis, universe };
  if (snapshot && chartAnalysis && newsAnalysis) {
    try { decision = await ask<Decision>(agents, "decide", context); }
    catch (error) { alerts.push(`Decisione mancante: ${errorText(error)}`); }
  }

  if (snapshot && decision) {
    for (const [i, order] of decision.orders.entries()) {
      note(`Proposto dal decisore: ${order.symbol} ${order.side} × ${order.qty}. ${order.reason}`);
      const limit = limitFor(order, charts, now);
      const issue = risk(order, limit, snapshot, entry);
      if (issue || i >= 5) {
        note(`Respinto ${order.symbol} ${order.side}: ${issue ?? "Oltre cinque proposte nella stessa sveglia."}`);
        continue;
      }
      try {
        const approval = await reviewOrder(agents, ticketFor(order, limit), context);
        if (approval.review.verdict !== "approve") {
          note(`Respinto dal revisore ${order.symbol} ${order.side}: ${approval.review.reason}`);
          continue;
        }
        note(`Approvato dal revisore ${order.symbol} ${order.side}: ${approval.review.reason}`);
        await execute(order, limit, approval.ticket);
      } catch (error) {
        alerts.push(`Revisione o esecuzione non completata per ${order.symbol}: ${errorText(error)}`);
        note(`Ordine ${order.symbol} ${order.side} non confermato. Vedi l’allarme e il registro degli intenti.`);
      }
    }
  }
  if (snapshot) {
    try { snapshot = await broker.snapshot(); }
    catch (error) { alerts.push(`Dati finali del conto indisponibili: ${errorText(error)}. Riporto lo snapshot iniziale.`); }
    note(`Conto: USD ${snapshot.account.equity}. P&L del giorno: USD ${(Number(snapshot.account.equity) - Number(snapshot.account.last_equity)).toFixed(2)}. Orologio (${brokerLabel}): ${snapshot.clock.timestamp}.`);
    for (const order of snapshot.orders.filter(x => lock.intents.includes(x.client_order_id))) {
      const status = observed(order, brokerLabel);
      if (!lines.includes(status)) {
        note(status);
        await notifyOrder(order);
      }
      if (terminal.has(order.status)) pending.delete(order.client_order_id);
    }
  } else note("Conto e P&L del giorno non verificati.");
  if (!decision?.orders.length) note("Nessun ordine discrezionale proposto.");
  if (decision) {
    const sentences = decision.reasoning.split(/(?<=[.!?])\s+/);
    const split = Math.ceil(sentences.length / 2);
    note(`Motivazione: ${sentences.slice(0, split).join(" ")}`);
    if (sentences.length > split) note(sentences.slice(split).join(" "));
  } else note("Decisione discrezionale non disponibile.");
  const toCheck = redact([decision?.planNext ?? previous?.planNext ?? "Verificare conto, posizioni e fonti.",
    ...alerts, ...[...pending].map(id => `Ricontrollare ${id} su Alpaca.`)].join("\n"));
  note(`Piano: ${toCheck.split("\n")[0]}\nProssima sveglia: ${nextWake(new Date(Math.max(+now, Date.now())))} (ora di Roma).`);
  const baton: Baton = { wake: entry, savedAt: new Date().toISOString(), planNext: toCheck, report: lines.join("\n"), pending: [...pending] };
  const event = `${entry.id}-${crypto.randomUUID()}.json`;
  await state.write(`history/${event}`, baton);
  await state.write(`logs/${event}`, { run: entry.id, report: baton.report, alerts: alerts.map(redact) });
  await enqueue(state, entry.id, "resoconto", baton.report);
  const scenarios = chartAnalysis && chartScenarios(chartAnalysis, charts, now);
  if (scenarios) await enqueue(state, entry.id, "scenario-grafici", redact(scenarios), entry.id);
  if (alerts.length) await enqueue(state, entry.id, "allarmi", redact(`⚠ ${alerts.join("\n⚠ ")}`));
  if (!previous || previous.wake.id <= entry.id) await state.write("baton.json", baton);
  await state.remove("run.lock");
  console.log(`run ${entry.id}\n${baton.report}${alerts.length ? "\n⚠ " + redact(alerts.join("\n⚠ ")) : ""}`);
}
