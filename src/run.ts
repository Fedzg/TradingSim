import {intradayTime} from "./bar-time";
import {breakerOpen, confirms, manualPermission, recordHealth, strategyAlert} from "./strategy-controls";
import {allowedStrategies,capacity,entryPlan,executionMode,setups,type Plan} from "./strategies";
import {closedCandles} from "./indicators";
import { ask, reviewOrder, type Agents, type Charts, type Decision, type NewsAnalysis } from "./agents";
import { FakeBroker, type Broker, type BrokerOrder, type Intent, type Proposal, type Snapshot, watched, universe } from "./broker";
import { measureAgents, measureFeed } from "./efficiency-metrics";
import { analyzeWakeNews, verifyEvents } from "./event-news";
import { briefingSession, describeSession, sessionCandles } from "./market-session";
import { paperAccount } from "./paper-summary";
import { technicalDetails } from "./technical-report";
import { chartContext } from "./indicators";
import { orderReviewContext } from "./order-review-context";
import { chartScenarios } from "./chart-scenarios";
import { enqueue } from "./chat";
import { queueOrder } from "./notifications";
import { OrderRejected } from "./mcp";
import { miniChart, type Market, type News, type Series } from "./market";
import { limitFor, risk, stops, terminal, ticketFor, trading } from "./risk";
import { type Baton, type RunLock, State } from "./state";
import { orderStatus, wakeReport } from "./wake-report";
import { dateOffset, missed, newYork, nextWake, type Wake } from "./time";

type Inputs = { state: State; broker: Broker; agents: Agents; market: Market; redact: (s: string) => string };

function observed(order: BrokerOrder, brokerLabel: string) {
  const filled = Number(order.filled_qty);
  const status = orderStatus(order.status);
  return `${order.client_order_id}: ${status} (${brokerLabel}), eseguite ${Number.isFinite(filled) ? filled : "quantità non verificabile"}/${order.qty}.`;
}

export async function run(input: Inputs, entry: Wake, force: boolean, now = new Date()) {
  const metrics = measureAgents(`run/${entry.id}`, input.agents);
  try { await runOnce({ ...input, agents: metrics.agents }, entry, force, now); }
  finally { metrics.log(); }
}

async function runOnce({ state, broker, agents, market, redact }: Inputs, entry: Wake, force: boolean, now: Date) {
  const { baton: previous, warning } = await state.baton();
  const interrupted = await state.read<RunLock>("run.lock");
  if (!interrupted && previous && previous.wake.id >= entry.id && !force) return;

  const lock: RunLock = { wake: entry, pid: process.pid, startedAt: now.toISOString(), intents: [] };
  const mode=executionMode();
  const sessionDate = newYork(now).date;
  const suspended = mode !== "legacy" && await breakerOpen(state, sessionDate);
  let strategyFault = false;
  const signalAlert = (key: string, text: string) => strategyAlert(state, entry.id, key, redact(text));
  const alerts: string[] = [];
  const simulated = broker instanceof FakeBroker;
  const brokerLabel = simulated ? "broker finto" : "Alpaca Paper";
  const lines: string[] = simulated ? ["SIMULAZIONE OFFLINE. Dati, ordini e consegne finti."] : [];
  lines.push("Modalità: "+mode);
  const reasons: string[] = [];
  const explain = (reason: string) => { reasons.push(reason); note(reason); };
  const reportIssue = (reason: string) => { reasons.push(reason); alerts.push(reason); };
  const pending = new Set<string>();
  const unresolved = new Set<string>();
  const uncertainSymbols = new Set<string>();
  const recoveredSides = new Set<string>();
  const confirmed = new Map<string, BrokerOrder>();
  const errorText = (error: unknown) => redact(error instanceof Error ? error.message : "Errore inatteso.");
  const note = (message: string) => lines.push(redact(message));
  const notifyOrder = (order: BrokerOrder, intent: Intent) => queueOrder(state, order, intent, brokerLabel, redact);
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
      let order = await broker.find(intent.id);
      if (!order && intent.submissionRejection) {
        order = { client_order_id: intent.id, symbol: intent.order.symbol, side: intent.order.side,
          qty: String(intent.order.qty), limit_price: intent.limit?.toString() ?? null, status: "rejected", filled_qty: "0" };
      }
      if (order) {
        if (order.status !== intent.observed?.status || Number(order.filled_qty) !== Number(intent.observed?.filled_qty)) {
          await notifyOrder(order, intent);
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
  let ordersVerified = false;
  let accountError: string | undefined;
  let newsError: string | undefined;

  async function execute(order: Proposal, limit: number | null, approvalTicket?: string, mandatory = false, plan?:Plan) {
    const label = `${order.symbol} ${order.side} × ${order.qty}`;
    const reject = (reason: string) => explain(`Respinto ${label}: ${reason}`);
    const id = `${entry.id}-${order.symbol}-${order.side}`;
    if (!universe.some(symbol => symbol === order.symbol)) return reject("Simbolo fuori dall’universo operativo Alpaca Paper.");
    if(mode==="analysis-only") return reject("Modalità di sola analisi.");
    if(!mandatory && mode!=="legacy" && !plan) return reject("Piano strategico mancante.");
    if (!mandatory && approvalTicket !== ticketFor(order, limit,plan)) return reject("Condizioni diverse da quelle approvate. Serve una nuova revisione.");
    if (pending.has(id) || intents.some(item => item.id === id)) return explain(`Nessun reinvio per ${id}: intento già registrato.`);
    if (recoveredSides.has(`${order.symbol}/${order.side}`)) return reject("Ordine della sveglia interrotta appena riconciliato.");
    if (uncertainSymbols.has(order.symbol) || (order.side === "buy" && unresolved.size)) return reject("Invio precedente ancora da riconciliare.");
    if(mode==="approval-required"){
      const ticket=ticketFor(order,limit,plan);
      if(!await manualPermission(state,id,ticket,plan?.expires??Date.now()+60000)) return reject("Approvazione manuale scaduta.");
    }
    try {
      const already = await broker.find(id);
      if (already) {
        confirmed.set(id, already);
        return explain(`${label}: Alpaca aveva già registrato l’ordine ${id}.`);
      }
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
      if(plan){
        const instant=new Date();
        if(suspended || strategyFault || !allowedStrategies().includes(plan.strategy) || capacity(plan,current,intents,instant)<order.qty)
          return reject("Scadenza, capitale o rischio cambiati dopo revisione.");
        const date=newYork(instant).date;
        const day=(await broker.calendar(date,date))[0];
        if(!day || !briefingSession([day],current.clock,instant).today) return reject("Calendario non verificato.");
        const fresh=charts.find(c=>c.symbol===order.symbol && c.source==="Alpaca IEX");
        const checked=fresh && entryPlan(fresh,day,instant,[plan.strategy]);
        if(!broker.quote || !confirms(plan, await broker.quote(order.symbol), Date.now()))
          return reject("Spread, timestamp o prezzo corrente non confermano il segnale.");
        if(JSON.stringify(checked)!==JSON.stringify(plan)) return reject("Segnale cambiato dopo revisione.");
      }
      if (!await broker.tradable(order.symbol)) return reject("Titolo non negoziabile su Alpaca Paper.");
    } catch (error) {
      strategyFault = true;
      alerts.push(`Verifica broker prima di ${id}: ${errorText(error)}`);
      reasons.push(errorText(error));
      return reject("Impossibile verificare il broker prima dell’invio.");
    }

    if (plan && Date.now() >= plan.expires) return reject("Segnale scaduto.");
    const intent: Intent = { id, order, limit, ...(plan?{plan}:{}), attemptedAt: new Date().toISOString() };
    await state.write(`intents/${id}.json`, intent);
    intents.push(intent);
    lock.intents.push(id);
    await state.write("run.lock", lock);
    note(`Richiesta di invio al broker per ${id}.`);
    try {
      const result = await broker.submit(intent);
      if (result.client_order_id !== id) throw new Error("ID inatteso nella risposta di Alpaca.");
      await notifyOrder(result, intent);
      await state.write(`intents/${id}.json`, { ...intent, observed: result });
      confirmed.set(id, result);
      note(observed(result, brokerLabel));
      if (!terminal.has(result.status)) pending.add(id);
    } catch (error) {
      strategyFault = true;
      alerts.push(`Risposta all’invio ${id}: ${errorText(error)}`);
      if (error instanceof OrderRejected) {
        intent.submissionRejection = error.message;
        await state.write(`intents/${id}.json`, intent);
      }
      await reconcile(intent);
    }
  }

  try { snapshot = await broker.snapshot(); }
  catch (error) {
    accountError = errorText(error);
    reportIssue(`Conto, posizioni, ordini e orologio non verificati: ${errorText(error)}`);
  }

  if (mode!=="analysis-only" && snapshot && trading(entry, snapshot)) {
    for (const order of stops(snapshot)) {
      note(`Stop obbligatorio proposto dal codice: ${order.symbol} × ${order.qty}.`);
      if (mode!=="legacy") {
        const ticket=ticketFor(order,null);
        try {
          const stopReview=await reviewOrder(agents,ticket,orderReviewContext(order,null,snapshot,entry,undefined,undefined,undefined,now));
          if(stopReview.ticket!==ticket || stopReview.review.verdict!=="approve") {
            explain("Stop respinto dal revisore: "+order.symbol);continue;
          }
        } catch {reportIssue("Revisione dello stop indisponibile: "+order.symbol);continue;}
      }
      await execute(order, null, undefined, true);
    }
  }

  try { charts = await measureFeed("charts", () => market.charts(now)); }
  catch (error) { alerts.push(`Grafici indisponibili: ${errorText(error)}`); }
  try {
    news = await market.cachedNews(state);
    if (!news.checked) news = await measureFeed("news", () => market.poll(state, now));
    if (news.error || !news.lastSuccess || +now - Date.parse(news.lastSuccess) > 30 * 60_000) {
      newsError = `${news.error ?? "Cache notizie non recente."} Ultimo aggiornamento: ${news.lastSuccess ?? "assente"}.`;
      alerts.push(newsError);
    }
  } catch (error) {
    newsError = `Notizie indisponibili: ${errorText(error)}`;
    alerts.push(newsError);
  }

  if(mode!=="legacy") for(const chart of charts.filter(c=>universe.some(s=>s===c.symbol))) note(chart.symbol+" · setup giornalieri: "+(setups(closedCandles(chart,"1Day",now)).join(", ")||"nessuno"));
  if(mode!=="legacy") for(const chart of charts.filter(c=>c.source==="Alpaca IEX")){
    const bars=closedCandles(chart,"15Min",now);
    const last=bars.at(-1), history=bars.slice(-21,-1);
    if(!last || history.length<20 || +now-Date.parse(last.t)>1200000) continue;
    if(last.c<Math.min(...history.map(b=>b.l)))
      await signalAlert("support/"+chart.symbol+"/"+last.t,chart.symbol+" · supporto a 20 barre rotto in chiusura 15 minuti · "+last.c+" · "+last.t);
    const typical=history.reduce((n,b)=>n+b.h-b.l,0)/history.length;
    if(typical>0 && last.h-last.l>3*typical)
      await signalAlert("range/"+chart.symbol+"/"+last.t,chart.symbol+" · range 15 minuti superiore a 3 volte la media delle 20 barre precedenti · "+last.t);
  }
  const monitored = [...new Set([...watched, ...charts.map(series => series.symbol)])];
  const newsInput = news && {
    ...news,
    articles: news.articles.slice(0, 30).map(article => ({
      ...article, summary: Array.from(article.summary).slice(0, 180).join(""),
    })),
  };
  const chartInput = chartContext(charts, now);
  const sessions = new Map<string, ReturnType<typeof sessionCandles>>();
  const session: string[] = [];
  if (entry.slot === "09:00") {
    const day = newYork(now).date;
    try {
      const marketClock = snapshot?.clock ?? await broker.clock();
      const info = briefingSession(await broker.calendar(dateOffset(day, -14), day), marketClock, now);
      if (!info.previous) session.push(info.status + ". Ultima seduta regolare non verificabile.");
      else session.push(`${info.status}. Ultima seduta completata: ${info.previous.date}.`);
      for (const chart of charts.filter(item => item.source === "Alpaca IEX")) {
        const data = sessionCandles(chart, info);
        sessions.set(chart.symbol, data);
        note(`${chart.symbol} (Alpaca IEX): ${describeSession(data)}`);
        if (session.length <= 2 && ["SPY", "QQQ"].includes(chart.symbol)) session.push(`${chart.symbol}: ${describeSession(data)}`);
      }
    } catch (error) {
      session.push(`Sessione USA non verificabile. ${errorText(error)}`);
      note(session[0]);
    }
  }
  const analysts = await Promise.allSettled([
    ask<Charts>(agents, "charts", sessions.size ? {
      ...chartInput, sessions: Object.fromEntries(sessions),
    } : chartInput),
    analyzeWakeNews(state, agents, now, newsInput, monitored, news?.articles),
  ]);
  if (analysts[0].status === "fulfilled") chartAnalysis = analysts[0].value;
  else {
    reportIssue(`Analisi grafici mancante: ${errorText(analysts[0].reason)}`);
  }
  if (analysts[1].status === "fulfilled") newsAnalysis = analysts[1].value;
  else {
    const message = `Analisi notizie mancante: ${errorText(analysts[1].reason)}`;
    newsError = [message, newsError].filter(Boolean).join(" ");
    reportIssue(message);
  }

  for (const [index, series] of charts.entries()) {
    if (sessions.has(series.symbol)) continue;
    if (series.source === "Alpaca IEX") {
      const { intervals } = chartInput.charts[index];
      const closed = snapshot?.clock.is_open === false;
      const details = (["15Min", "1Day"] as const).map(interval => {
        const data = intervals[interval];
        const stale = interval === "15Min" && data.lastClosed
          ? +now - Date.parse(data.lastClosed) > 45 * 60_000 : data.stale;
        const status = data.feedError ?? (!data.lastClosed ? "serie assente" :
          stale ? "dato datato" : data.count < 15 ? "serie breve" : "recente");
        return { status, text: `${interval} ${status} (ultima candela chiusa: ${data.lastClosed ?? "assente"})` };
      });
      if (closed || details.some(detail => detail.status !== "recente")) {
        note(`${series.symbol} (${series.source}): ${closed ? "mercato chiuso. " : ""}${details.map(detail => detail.text).join(". ")}.`);
      }
      continue;
    }
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
  const details = (chartAnalysis?.ideas ?? []).flatMap(idea => {
    const series = charts.find(item => item.symbol === idea.symbol);
    if (!series) return [];
    note(`${idea.symbol} (${idea.horizon}): ${idea.direction}. ${idea.evidence}. Invalidazione proposta: ${idea.invalidation}. Incertezza: ${idea.uncertainty}.`);
    const technical = technicalDetails(series, idea, now);
    note(technical.full);
    return [{ symbol: series.symbol, horizon: idea.horizon, ...technical }];
  });
  for (const item of chartAnalysis?.limitations ?? []) note(item);
  for (const item of newsAnalysis?.limitations ?? []) note(item);
  const verifiedEvents = verifyEvents(newsAnalysis?.events ?? [], news?.articles ?? [], charts, now);
  for (const event of verifiedEvents) {
    const summary = `${event.classification}: ${event.title} (${event.symbols.join(", ")}). ${event.impact} — ${event.source}, ${event.published}, ${event.link}`;
    const detail = `${summary} · ${event.effectiveDate ? "Evento " + event.effectiveDate + " · " : ""}${event.status}.${event.movement ? " " + event.movement : ""}`;
    note(detail);
    await enqueue(state, entry.id, "notizia", redact(detail), event.key);
  }
  const analysisCharts = chartAnalysis && { ...chartAnalysis, ideas: chartAnalysis.ideas.filter(idea => watched.includes(idea.symbol)).map(({ bias: _bias, ...idea }) => idea) };
  const analysisNews = newsAnalysis && { ...newsAnalysis, newMarkets: [],
    events: verifiedEvents.filter(event => event.symbols.some(symbol => watched.includes(symbol))) };
  const context = { entry, account: snapshot?.account, positions: snapshot?.positions, recentOrders: snapshot?.orders.slice(0, 30),
    clock: snapshot?.clock, plan: previous?.planNext, pending: [...pending], analysisCharts, analysisNews, universe };
  if (snapshot && chartAnalysis && newsAnalysis) {
    try { decision = await ask<Decision>(agents, "decide", context); }
    catch (error) {
      reportIssue(`Decisione mancante: ${errorText(error)}`);
    }
  }

  const diagnostics:{symbol:string;strategy:string;timeframe:string;at:string;bar:unknown;reason:string;plan:Plan|null;theoreticalQty:number|null}[]=[];
  const plans=new Map<string,Plan>();
  if(mode!=="legacy" && snapshot && decision){
    decision={...decision,orders:[]};
    try {
      const date=newYork(now).date;
      const day=(await broker.calendar(date,date))[0];
      if(!day || !snapshot.clock.is_open || !trading(entry,snapshot)) explain("Sessione di ingresso chiusa.");
      else if(suspended) explain("Circuit breaker attivo per la seduta USA.");
      else if(newsError || warning || interrupted || unresolved.size || alerts.length) explain("Ingressi sospesi: dati o riconciliazione incompleti.");
      else {
        briefingSession([day],snapshot.clock,now);
        for(const chart of charts){
          if(!universe.some(s=>s===chart.symbol)) continue;
          const evaluations=allowedStrategies().map(strategy=>{
            let reason:string|undefined;
            const plan=entryPlan(chart,day,now,[strategy],false,text=>{reason=text;});
            const last=closedCandles(chart,"15Min",now).at(-1);
            diagnostics.push({symbol:chart.symbol,strategy,timeframe:"15Min",at:now.toISOString(),bar:last?intradayTime(last.t,chart.source,now,last.receivedAt,day):null,
              reason:reason??"segnale confermato",plan:plan??null,theoreticalQty:plan?capacity(plan,snapshot!,intents,now):null});
            return {strategy,plan,reason};
          });
          for(const evaluation of evaluations)
            note(chart.symbol+" · "+evaluation.strategy+" · "+(evaluation.reason??"segnale confermato"));
          const plan=evaluations.find(e=>e.plan)?.plan;
          if(!plan) continue;
          const qty=capacity(plan,snapshot,intents,now);
          const reason=`${plan.strategy} · ${plan.source} · candela ${plan.bar} · ingresso ${plan.entry} · stop ${plan.stop} · target 2R ${plan.targets[1]} · quantità ${qty} · perdita teorica ${(qty*(plan.entry-plan.stop)).toFixed(2)} USD · RVOL ${plan.rvol.toFixed(2)}`;
          await signalAlert("breakout/"+plan.symbol+"/"+plan.bar, "Breakout confermato: "+reason);
          if(!qty){
            explain("Limite di rischio: "+reason);
            await signalAlert("budget/"+date+"/"+plan.symbol, "Ingresso bloccato dai limiti di rischio o di capitale. "+reason);
            continue;
          }
          plans.set(chart.symbol,plan);
          decision.orders.push({symbol:chart.symbol,side:"buy",qty,reason});
          explain(reason);
        }
        if(!plans.size) explain("Nessun ingresso autorizzato su candela confermata.");
      }
    } catch(e){decision.orders=[];reportIssue("Circuit breaker strategia: "+errorText(e));}
  }
  if (snapshot && decision) {
    for (const [i, order] of decision.orders.entries()) {
      note(`Proposto dal decisore: ${order.symbol} ${order.side} × ${order.qty}. ${order.reason}`);
      const plan=plans.get(order.symbol);
      const limit = plan?.entry ?? limitFor(order, charts, now);
      const issue = risk(order, limit, snapshot, entry);
      if (issue || i >= 5) {
        explain(`Respinto ${order.symbol} ${order.side}: ${issue ?? "Oltre cinque proposte nella stessa sveglia."}`);
        continue;
      }
      try {
        const pertinent = orderReviewContext(order, limit, snapshot, entry,
          charts.find(series => series.symbol === order.symbol), chartAnalysis, newsAnalysis, now);
        if(plan && !simulated && process.env.TRADINGSIM_SEC_USER_AGENT){
          const {issuers,secData,fundamentals}=await import("./edgar");
          if(Object.hasOwn(issuers,order.symbol)){
            const issuer=order.symbol as keyof typeof issuers;
            try {Object.assign(pertinent.evidence,{fundamentals:fundamentals(issuer,await secData(state,issuer,true),now)});}
            catch {Object.assign(pertinent.evidence,{fundamentals:"SEC non verificabile"});}
          }
        }
        const approval = await reviewOrder(agents, ticketFor(order, limit,plan), pertinent);
        if (approval.review.verdict !== "approve") {
          if(plan) await signalAlert("review/"+entry.id+"/"+plan.symbol,"Respinto dal revisore: "+plan.symbol+" · "+approval.review.reason);
          explain(`Respinto dal revisore ${order.symbol} ${order.side}: ${approval.review.reason}`);
          continue;
        }
        if(plan) await signalAlert("review/"+entry.id+"/"+plan.symbol, "Approvato dal revisore: "+plan.symbol+" · "+approval.review.reason);
        note(`Approvato dal revisore ${order.symbol} ${order.side}: ${approval.review.reason}`);
        await execute(order, limit, approval.ticket,false,plan);
      } catch (error) {
        reportIssue(`Revisione o esecuzione non completata per ${order.symbol}: ${errorText(error)}`);
        note(`Ordine ${order.symbol} ${order.side} non confermato. Vedi l’allarme e il registro degli intenti.`);
      }
    }
  }
  if (snapshot) {
    try { snapshot = await broker.snapshot(); ordersVerified = true; }
    catch (error) {
      accountError = errorText(error);
      alerts.push(`Dati finali del conto indisponibili: ${accountError}. Riporto lo snapshot iniziale.`);
    }
    note(`Conto: USD ${snapshot.account.equity}. P&L del giorno: USD ${(Number(snapshot.account.equity) - Number(snapshot.account.last_equity)).toFixed(2)}. Orologio (${brokerLabel}): ${snapshot.clock.timestamp}.`);
    for (const order of snapshot.orders.filter(x => lock.intents.includes(x.client_order_id))) {
      const status = observed(order, brokerLabel);
      if (!lines.includes(status)) {
        note(status);
        const intent = intents.find(item => item.id === order.client_order_id);
        if (intent) await notifyOrder(order, intent);
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
  for (const alert of alerts) note("⚠ " + alert);


  let active = ordersVerified ? snapshot?.openOrders ?? snapshot?.orders : undefined;
  let activeError: string | undefined;
  if (!active) {
    try { active = await broker.readOpenOrders(); }
    catch (error) { activeError = errorText(error); }
  }
  const paperEvents = [...new Map(verifiedEvents.filter(item => /^https:\/\//i.test(item.link))
    .map(item => ({ ...item, symbols: universe.filter(symbol => item.symbols.includes(symbol)) }))
    .filter(item => item.symbols.length > 0).map(item => [item.link, item])).values()];
  const outcomes = intents.filter(intent => intent.id.startsWith(entry.id + "-")).map(intent => ({
    intent,
    observed: (ordersVerified ? snapshot?.orders.find(order => order.client_order_id === intent.id) : undefined)
      ?? confirmed.get(intent.id) ?? intent.observed,
  }));
  if (entry.slot === "09:00") reasons.unshift("Briefing programmato, senza operazioni.");
  else if (snapshot?.clock.is_open === false) reasons.unshift("Alpaca indica mercato chiuso.");
  if (decision && !decision.orders.length) reasons.push(decision.reasoning);
  const submitted = new Set(outcomes.map(item => item.intent.order.symbol));
  const proposed = new Set(decision?.orders.map(item => item.symbol));
  const technical = [...details].sort((a, b) => Number(proposed.has(b.symbol)) - Number(proposed.has(a.symbol)))
    .filter(item => !submitted.has(item.symbol) && universe.some(symbol => symbol === item.symbol))
    .slice(0, 2).map(item => item.short);
  const snapshotAge = Math.abs(Date.now() - Date.parse(snapshot?.clock.timestamp ?? ""));
  const account = paperAccount(ordersVerified && snapshotAge <= 5 * 60_000 ? snapshot : undefined,
    accountError ?? (ordersVerified ? "Timestamp Alpaca non recente." : undefined));
  const report = wakeReport({ entry, simulated, outcomes, reasons, active, activeError, technical, session, account,
    events: newsError ? [] : paperEvents, newsError, charts: details });
  const baton: Baton = { wake: entry, savedAt: new Date().toISOString(), planNext: toCheck, report: lines.join("\n"),
    pending: [...pending], summary: { reasons: reasons.map(redact), alerts: alerts.map(redact) } };
  if(mode !== "legacy" && entry.slot !== "09:00") {
    await recordHealth(state,sessionDate,entry.id,strategyFault || !snapshot || !decision || !!newsError || unresolved.size > 0 || alerts.some(a=>a.startsWith("Revisione o esecuzione")));
    for(const event of paperEvents.filter(e=>e.status !== "notizia storica").slice(0,3))
      await signalAlert("news/"+event.key,event.title+" · "+event.impact+" "+event.link);
  }
  const event = `${entry.id}-${crypto.randomUUID()}.json`;
  await state.write(`history/${event}`, baton);
  await state.write(`logs/${event}`, { run: entry.id, report: baton.report, diagnostics, alerts: alerts.map(redact), technical: details.map(row => redact(row.full)) });
  await enqueue(state, entry.id, "resoconto", redact(report), entry.id, "wake-report");
  const scenarios = chartAnalysis && chartScenarios(chartAnalysis, charts, now);
  if (scenarios) await enqueue(state, entry.id, "scenario-grafici", redact(scenarios), entry.id);
  if (alerts.length) await enqueue(state, entry.id, "allarmi", redact(`⚠ ${alerts.join("\n⚠ ")}`));
  if (!previous || previous.wake.id <= entry.id) await state.write("baton.json", baton);
  await state.remove("run.lock");
  console.log(`run ${entry.id}\n${baton.report}`);
}
