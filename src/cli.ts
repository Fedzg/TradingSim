import { mkdir } from "node:fs/promises";
import { config } from "./config";
import { Alpaca, FakeBroker } from "./broker";
import { CodexAgents, FakeAgents } from "./agents";
import { enqueue, FakeChannel, flush, UnavailableChat, type Message } from "./chat";
import { AlpacaStdio } from "./mcp";
import { Market } from "./market";
import { run } from "./run";
import { State } from "./state";
import { nextWake, rome, slots, wake, type Slot } from "./time";

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
const market = new Market(mcp, fake);
const channel = fake ? new FakeChannel(state, process.env.TRADINGSIM_FAKE_CHAT_FAIL === "1") : new UnavailableChat();
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
  const local = {
    modalità: fake ? "finta" : "Alpaca Paper", guard: status === 0 ? "libero" : status === 75 ? "occupato" : "non verificato",
    lock: await state.read("run.lock") ?? null, ...await state.baton(), notizie: await market.cachedNews(state),
    consegna: { totale: queue.length, in_coda: queue.filter(x => x && !x.delivered).length,
      ultimo_errore: queue.filter(x => x?.error).at(-1)?.error ?? null },
    prossima_sveglia: nextWake(new Date()),
  };
  console.log(opts.redact(JSON.stringify(local, null, 2)));
  try {
    const { account, clock } = await paper().snapshot();
    console.log(opts.redact(JSON.stringify({ conto: { valore: account.equity, liquidità: account.cash }, mercato: clock }, null, 2)));
  } catch (error) { console.error(opts.redact(String(error))); process.exitCode = 1; }
}

async function once() {
  if (selected >= 0 && !slots.includes(rawSlot as Slot)) throw new Error("Slot non valido. Usa 09:00, 15:40, 18:30 o 21:40.");
  const { date, time } = rome(new Date());
  const slot = rawSlot as Slot | undefined ?? slots.filter(x => x <= time).at(-1);
  if (!slot) throw new Error("Nessuna sveglia di oggi è ancora trascorsa.");
  if (slot > time && !fake) throw new Error("La sveglia scelta è ancora futura in ora di Roma.");
  const proc = child("run.guard", "_run", [...mode, "--slot", slot, "--date", date, ...(force ? ["--force"] : [])]);
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
  let active: ReturnType<typeof child> | undefined;
  const jobs = new Set<ReturnType<typeof child>>();
  function background(lock: string, command: string) {
    const proc = child(lock, command, mode);
    jobs.add(proc);
    void proc.exited.then(() => jobs.delete(proc));
  }
  let stopping = false;
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
      if (+now - lastChecked >= interval) {
        lastChecked = +now;
        background("news.guard", "_news");
        background("outbox.guard", "_flush");
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
    case "deliver": process.exitCode = exitStatus(await child("outbox.guard", "_flush", mode).exited); break;
    case "schedule": await supervise(); break;
    case "_schedule": await schedule(); break;
    case "_news": {
      const previous = await market.cachedNews(state);
      const now = new Date();
      const news = await market.poll(state, now);
      if (news.error && news.error !== previous.error) {
        const { date, time } = rome(now);
        await enqueue(state, `${date}-${time.replace(":", "")}-news`, "allarmi",
          opts.redact(`⚠ ${news.error} Ultimo aggiornamento: ${news.lastSuccess ?? "assente"}.`));
      }
      console.log(`Monitor notizie: ${news.error ?? `${news.articles.length} articoli in cache`}; ultimo aggiornamento ${news.lastSuccess ?? "assente"}.`);
      break;
    }
    case "_flush": await flush(state, channel); break;
    case "_run": {
      if (!scheduledDate || !slots.includes(rawSlot as Slot)) throw new Error("Sveglia interna non valida.");
      await run({ state, broker: paper(), agents: fake ? new FakeAgents() : new CodexAgents(opts.redact), market, redact: opts.redact },
        wake(scheduledDate, rawSlot as Slot), force);
      break;
    }
    default: throw new Error("Comandi disponibili: once, schedule, status, deliver, account-check.");
  }
} catch (error) {
  console.error(opts.redact(String(error)));
  process.exitCode = 1;
} finally {
  mcp?.close();
}
