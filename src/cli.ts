import { mkdir } from "node:fs/promises";
import { config } from "./config";
import { Alpaca, FakeBroker } from "./broker";
import { ask, CodexAgents, FakeAgents, type Charts } from "./agents";
import { closeCalendar, closeDue, closeReportId, dailyClose, type CloseSchedule } from "./daily-close";
import { Discovery, savedWatchlist } from "./discovery";
import { measureAgents, measureFeed } from "./efficiency-metrics";
import { chartContext } from "./indicators";
import { MonitorFeeds } from "./monitor-feeds";
import { catalog, scan } from "./discovery-sources";
import { chartScenarios } from "./chart-scenarios";
import { enqueue, FakeChannel, UnavailableChat, type Message } from "./chat";
import { AlpacaStdio } from "./mcp";
import { fakeCharts, Market } from "./market";
import { flushNotifications, notificationSelector, pollOrders } from "./notifications";
import { queueNewsSignals } from "./news-signals";
import { run } from "./run";
import { State } from "./state";
import { TelegramChannel } from "./telegram";
import { buildGoldReport, goldBriefing } from "./gold-briefing";
import { newYork, scheduledSlots, nextWake, rome, slots, wake, type Slot } from "./time";

const bun = process.execPath;
const script = import.meta.path;
const args = process.argv.slice(2);
const [command, ...flags] = args;
const fake = flags.includes("--fake");
const force = flags.includes("--force");
const selected = flags.indexOf("--slot");
const rawSlot = selected >= 0 ? flags[selected + 1] : undefined;
const dateIndex = flags.indexOf("--date");
const scheduledDate = dateIndex < 0 ? undefined : flags[dateIndex + 1];
const opts = await config(fake);
const state = new State(opts.root);
const mcp = fake ? undefined : new AlpacaStdio(opts.key, opts.secret);
const feeds = new MonitorFeeds(state,mcp);
const readSeries = feeds.series.bind(feeds);
const market = new Market(mcp, fake);
const marketWithWatchlist = async () => {
  if (fake) return market;
  const watchlist = await savedWatchlist(state);
  return new Market(mcp, false, () => Promise.all(watchlist.map(async item => {
    try { return await readSeries(item); }
    catch { return { symbol: item.symbol, source: item.venue, updated: null, intervals: {}, error: "Fonte watchlist indisponibile" }; }
  })), readSeries);
};
const telegram = opts.telegram && new TelegramChannel(opts.telegram.token, opts.telegram.chatId);
const channel = fake ? new FakeChannel(state, process.env.TRADINGSIM_FAKE_CHAT_FAIL === "1") : telegram ?? new UnavailableChat();
const paper = () => fake ? new FakeBroker(state) : new Alpaca(mcp!);
const mode = fake ? ["--fake"] : [];
await mkdir(state.root, { recursive: true, mode: 0o700 });

function child(lock: string, command: string, options: string[]) {
  // Il kernel libera il guard anche dopo SIGKILL. Il lock JSON resta per la riconciliazione.
  return Bun.spawn(["flock", "--no-fork", "-n", "-E", "75", state.path(lock), bun, script, command, ...options], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
}

function exitStatus(code: number) {
  if (code === 75) {
    console.log("Un processo con lo stesso lock è già attivo.");
    return 0;
  }
  return code;
}

async function status() {
  const guard = Bun.spawn(["flock", "--no-fork", "-n", "-E", "75", state.path("run.guard"), "true"]);
  const status = await guard.exited;
  const queue = await Promise.all((await state.list("outbox")).map(file => state.read<Message>(`outbox/${file}`)));
  const select = await notificationSelector(state, opts.redact);
  const pending = queue.filter((item): item is Message => !!item && !item.delivered);
  const eligible = (await Promise.all(pending.map(select))).filter(item => !!item);
  const local = {
    modalità: fake ? "finta" : "Alpaca Paper", guard: status === 0 ? "libero" : status === 75 ? "occupato" : "non verificato",
    lock: await state.read("run.lock") ?? null, ...await state.baton(), notizie: await market.cachedNews(state),
    consegna: { totale: queue.length, in_coda: eligible.length, solo_locale: pending.length - eligible.length,
      ultimo_errore: eligible.filter(x => x.error).at(-1)?.error ?? null },
    prossima_sveglia: nextWake(new Date()),
  };
  console.log(opts.redact(JSON.stringify(local, null, 2)));
  try {
    const { account, clock } = await paper().snapshot();
    console.log(opts.redact(JSON.stringify({ conto: { valore: account.equity, liquidità: account.cash }, mercato: clock }, null, 2)));
  } catch (error) { console.error(opts.redact(String(error))); process.exitCode = 1; }
}

async function once() {
  if (selected >= 0 && !scheduledSlots.some(slot => slot === rawSlot)) throw new Error("Slot non valido. Usa 09:00, 12:30, 15:40, 18:30 o 21:40.");
  const { date, time } = rome(new Date());
  const slot = rawSlot ?? scheduledSlots.filter(x => x <= time).at(-1);
  if (!slot) throw new Error("Nessuna sveglia di oggi è ancora trascorsa.");
  if (slot > time && !fake) throw new Error("La sveglia scelta è ancora futura in ora di Roma.");
  const proc = child(slot === "12:30" ? "gold.guard" : "run.guard", slot === "12:30" ? "_gold" : "_run", [...mode, "--slot", slot, "--date", date, ...(force ? ["--force"] : [])]);
  process.exitCode = exitStatus(await proc.exited);
  await child("outbox.guard", "_flush", mode).exited;
}

async function schedule() {
  if (!fake) {
    await paper().account();
    mcp?.close();
  }
  const interval = Number(process.env.TRADINGSIM_NEWS_SECONDS ?? "300") * 1000;
  if (!(interval >= 30_000 && Number.isFinite(interval))) throw new Error("Intervallo delle notizie non valido: minimo 30 secondi.");
  let lastChecked = 0;
  let lastLaunch = "";
  let goldDay = "";
  let active: ReturnType<typeof child> | undefined;
  let discovering = false;
  let polling = false;
  let lastOrders = 0;
  let lastCloseCheck = 0;
  let closing = false;
  const jobs = new Set<ReturnType<typeof child>>();
  let stopping = false;
  function background(lock: string, command: string) {
    const proc = child(lock, command, mode);
    jobs.add(proc);
    void proc.exited.then(() => {
      jobs.delete(proc);
      if (command === "_discover") discovering = false;
      if (command === "_orders") polling = false;
      if (command === "_close") closing = false;
      if ((command === "_orders" || command === "_discover" || command === "_close" || command === "_gold") && !stopping) background("outbox.guard", "_flush");
    });
  }
  let wakeUp: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wakeUp?.();
    active?.kill("SIGTERM");
    for (const job of jobs) job.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`Scheduler attivo. Fuso Europe/Rome. Prossima sveglia ${nextWake(new Date())}. Monitoraggio notizie ogni ${interval / 1000} secondi.`);
  while (!stopping) {
    const now = new Date();
    const { date, time } = rome(now);
    try {
      if (slots.includes(time as Slot) && !active && lastLaunch !== date + time) {
        const prior = await state.baton();
        const entry = wake(date, time as Slot);
        if (!prior.baton || prior.baton.wake.id < entry.id) {
          const proc = child("run.guard", "_run", [...mode, "--slot", time, "--date", date]);
          active = proc;
          lastLaunch = date + time;
          void proc.exited.then(code => {
            console.log(`Sveglia ${entry.id}: processo terminato (codice ${code}).`);
            if (code === 75) lastLaunch = "";
            active = undefined;
            if (!stopping) background("outbox.guard", "_flush");
          });
        }
      }
      if (time === "12:30" && goldDay !== date) {
        background("gold.guard", "_gold");
        goldDay = date;
      }
      if (!discovering) {
        discovering = true;
        background("discovery.guard", "_discover");
      }
      if ((telegram || fake) && !polling && +now - lastOrders >= 60_000) {
        lastOrders = +now;
        polling = true;
        background("orders.guard", "_orders");
      }
      if (!closing && +now - lastCloseCheck >= 60_000) {
        lastCloseCheck = +now;
        const day = newYork(now);
        const saved = await state.read<CloseSchedule>(closeCalendar);
        const due = saved?.date === day.date ? saved.session && closeDue(saved.session, now) : day.time >= "09:00";
        if (due && !await state.read(`outbox/${closeReportId(day.date)}.json`)) {
          closing = true;
          background("close.guard", "_close");
        }
      }
      if (+now - lastChecked >= interval) {
        lastChecked = +now;
        background("news.guard", "_news");
      }
    } catch (error) { console.error(opts.redact(`Scheduler: ${String(error)}`)); }
    if (!stopping) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 30_000);
      wakeUp = () => { clearTimeout(timer); resolve(); };
    });
  }
  await Promise.all([active?.exited, ...[...jobs].map(job => job.exited)]);
}

async function supervise() {
  const proc = child("schedule.guard", "_schedule", mode);
  const terminate = () => proc.kill("SIGTERM");
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  process.exitCode = exitStatus(await proc.exited);
}

try {
  switch (command) {
    case "once": await once(); break;
    case "status": await status(); break;
    case "account-check":
      await paper().account();
      console.log(fake ? "Lettura MCP finta riuscita." : "Lettura MCP del conto Alpaca Paper riuscita.");
      break;
    case "telegram-check":
      if (!telegram) throw new Error("Configura Telegram per inviare il messaggio di prova.");
      await telegram.send({ id: "telegram-check", text: "Connessione Telegram riuscita. Questo è un messaggio di prova." }, async () => {});
      console.log("Messaggio di prova Telegram inviato.");
      break;
    case "chart-report": {
      const now = new Date();
      const model = measureAgents("chart-report", fake ? new FakeAgents() : new CodexAgents(opts.redact));
      const charts = await measureFeed("charts", async () => (await marketWithWatchlist()).charts(now));
      const analysis = await ask<Charts>(model.agents, "charts", chartContext(charts, now)).finally(model.log);
      const scenarios = chartScenarios(analysis, charts, now)
        ?? "Nessuno scenario direzionale con dati sufficienti nell’ultimo controllo.";
      const { date, time } = rome(now);
      await enqueue(state, `${date}-${time.replace(":", "")}-grafici`, "scenario-grafici", opts.redact(scenarios));
      console.log(opts.redact(scenarios));
      break;
    }
    case "deliver": process.exitCode = exitStatus(await child("outbox.guard", "_flush", mode).exited); break;
    case "schedule": await supervise(); break;
    case "_schedule": await schedule(); break;
    case "_news": {
      const previous = await market.cachedNews(state);
      const now = new Date();
      const news = await measureFeed("news", () => market.poll(state, now));
      if (news.error && news.error !== previous.error) {
        const { date, time } = rome(now);
        await enqueue(state, `${date}-${time.replace(":", "")}-news`, "allarmi",
          opts.redact(`⚠ ${news.error} Ultimo aggiornamento: ${news.lastSuccess ?? "assente"}.`));
      }
      console.log(`Monitor notizie: ${news.error ?? `${news.articles.length} articoli in cache`}; ultimo aggiornamento ${news.lastSuccess ?? "assente"}.`);
      if (!fake && !news.error) {
        try {
          const model = measureAgents("news", new CodexAgents(opts.redact));
          const queued = await queueNewsSignals(state, model.agents, news, now, opts.redact).finally(model.log);
          console.log(`Notizie con possibile impatto Paper: ${queued} avvisi in coda.`);
        } catch (error) {
          console.error(opts.redact(`Analisi notizie operative non riuscita: ${String(error)}`));
        }
      }
      break;
    }
    case "discovery-status": {
      const engine = new Discovery(state, new CodexAgents(opts.redact), opts.redact);
      const { scanAt, coverage } = await engine.status();
      const revisioni = (await engine.proposals()).filter(item => item.status !== "pending")
        .map(item => ({ id: item.id, simbolo: item.candidate.instrument.symbol, stato: item.status, motivo: item.reason }));
      console.log(opts.redact(JSON.stringify({ scanAt, coverage, watchlist: await savedWatchlist(state), revisioni }, null, 2)));
      break;
    }
    case "monitor-check": {
      if (fake) throw new Error("Usa bun test per le verifiche offline dei provider.");
      console.log(opts.redact((await buildGoldReport(state,new Date(),false)).text));
      for (const item of catalog) {
        try {
          const series=await readSeries(item);
          console.log(JSON.stringify({symbol:item.symbol,...series.observation,error:series.error}));
        } catch { console.log(JSON.stringify({symbol:item.symbol,error:"catalogo o feed non verificabile"})); }
      }
      break;
    }
    case "discovery-scan": {
      if (fake) throw new Error("La scansione offline si verifica con bun test.");
      console.log(JSON.stringify(await scan(new Date(), readSeries), null, 2));
      break;
    }
    case "watchlist-pending": {
      const engine = new Discovery(state, new CodexAgents(opts.redact), opts.redact);
      console.log(opts.redact(JSON.stringify((await engine.proposals()).filter(item => item.status === "pending"), null, 2)));
      break;
    }
    case "watchlist-approve": {
      const id = flags.find(flag => /^[a-f0-9]{24}$/.test(flag));
      if (!id) throw new Error("Uso: watchlist-approve ID, dopo aver consultato watchlist-pending.");
      const code = await child("discovery.guard", "_watchlist-approve", [id, ...mode]).exited;
      if (code === 75) throw new Error("Scoperta in corso. Riprova tra poco.");
      process.exitCode = code;
      break;
    }
    case "_watchlist-approve": {
      const id = flags[0];
      if (!/^[a-f0-9]{24}$/.test(id ?? "")) throw new Error("ID proposta non valido.");
      await new Discovery(state, new CodexAgents(opts.redact), opts.redact).approve(id);
      console.log("Permesso salvato. Il worker sottoporrà la proposta alla revisione indipendente.");
      break;
    }
    case "_discover": {
      const model = measureAgents("discovery", fake ? new FakeAgents() : new CodexAgents(opts.redact));
      const engine = new Discovery(state, model.agents, opts.redact, readSeries);
      const { scanAt } = await engine.status();
      const now = new Date();
      try {
        if (!scanAt || +now - Date.parse(scanAt) >= 15 * 60_000) {
          const source = fake ? async (item: { symbol: string }) => ({ ...fakeCharts(now)[0], symbol: item.symbol }) : readSeries;
          const result = await measureFeed("discovery", () => scan(now, source));
          await engine.collect(result, (await market.cachedNews(state)).articles, now);
        }
        // Anche con una revisione operatore in attesa, il controllo dovuto ha priorità.
        if (!fake) await engine.reviewApproved(now);
      } finally {
        await engine.publish();
        model.log();
      }
      break;
    }
    case "_gold": await goldBriefing(state, new Date(), fake, opts.redact); break;
    case "_close": await dailyClose(state, paper(), new Date(), opts.redact); break;
    case "_orders": await pollOrders(state, paper(), opts.redact); break;
    case "_flush": await flushNotifications(state, channel, opts.redact); break;
    case "_run": {
      if (!scheduledDate || !slots.includes(rawSlot as Slot)) throw new Error("Sveglia interna non valida.");
      await run({ state, broker: paper(), agents: fake ? new FakeAgents() : new CodexAgents(opts.redact), market: await marketWithWatchlist(), redact: opts.redact },
        wake(scheduledDate, rawSlot as Slot), force);
      break;
    }
    default: throw new Error("Comandi disponibili: once, schedule, status, deliver, account-check, telegram-check, chart-report, discovery-status, discovery-scan, watchlist-pending, watchlist-approve.");
  }
} catch (error) {
  console.error(opts.redact(String(error)));
  process.exitCode = 1;
} finally {
  mcp?.close();
}
