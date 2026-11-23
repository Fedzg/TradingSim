import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import type { State } from "./state";

export class FeedFailure extends Error {
  constructor(readonly code: number, readonly wait = 0) { super(code ? "Feed HTTP " + code : "Feed non raggiungibile o risposta non valida"); }
}
type Entry<T> = { until: number; data?: T; error?: number; failures?: number };
type Budget = { minute: number; count: number; day: string; daily: number; calls: number; errors: number; pause: number;
  recent?: number[]; limits?: Partial<Record<Window,number>>; remaining?: Partial<Record<Window, { left:number; until:number }>> };
type Window = "minute" | "hour" | "day";
type Options = { priority?:boolean; cacheOnly?:boolean };
const responseHeaders = new AsyncLocalStorage<(headers: Headers)=>void>();
const minuteMs=60000, hourMs=3600000, dayMs=86400000;

function accountHeaders(b:Budget, provider:string, headers:Headers, now:number, started:number) {
  // Twelve Data reports the credit weight of this request separately from the account balance.
  const cost=Number(headers.get("api-credits-used"));
  if (provider==="twelve" && Number.isSafeInteger(cost) && cost>1) {
    if (b.day===new Date(started).toISOString().slice(0,10)) b.daily+=cost-1;
    if (now-started<minuteMs) b.recent?.push(...Array(Math.min(cost-1,8)).fill(started));
  }
  const periods = provider==="twelve" ? ["minute","day"] as const : ["hour"] as const;
  b.remaining ??= {};
  for (const period of periods) {
    const limit=headers.get("x-ratelimit-limit-"+period) ?? (period==="hour"?headers.get("x-ratelimit-limit"):null);
    if (limit!==null && /^\d+$/.test(limit)) (b.limits??={})[period]=Number(limit);
    const raw=headers.get("x-ratelimit-remaining-"+period) ??
      (period==="minute" ? headers.get("api-credits-left") : period==="hour" ? headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining") : null);
    if (raw===null || !/^\d+$/.test(raw)) continue;
    const until=period==="day" ? (Math.floor(now/dayMs)+1)*dayMs : now+(period==="minute"?minuteMs:hourMs);
    // Requests for this account are serialized, so the latest response can also report replenishment.
    b.remaining[period]={left:Number(raw),until};
  }
}

// flock on inherited descriptor 0 shares the parent's open file description.
// Closing the parent descriptor (including process death) releases the kernel lock.
async function locked<T>(state: State, key: string, work: () => Promise<T>) {
  await mkdir(state.path("providers"), { recursive: true, mode: 0o700 });
  const file = await open(state.path("providers/"+key+".guard"), "a", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["-x","-w","45","0"], { stdio: [file.fd,"ignore","ignore"] });
      child.once("error",reject);
      child.once("exit",code => code === 0 ? resolve() : reject(new FeedFailure(0)));
    });
    return await work();
  } finally { await file.close(); }
}

export async function cached<T>(state: State, provider: string, key: string, ttl: number | ((value:T)=>number), load: () => Promise<T>, minuteLimit = 60, dayLimit = 3000, options:Options = {}) {
  const hash = new Bun.CryptoHasher("sha256").update(provider+"/"+key).digest("hex");
  const path = "providers/"+hash+".json";
  const budgetPath = "providers/"+provider+".json";
  return locked(state, hash, async () => {
    const previous = await state.read<Entry<T>>(path);
    if (previous && previous.until > Date.now()) {
      if (previous.error !== undefined) throw new FeedFailure(previous.error);
      return previous.data!;
    }
    if (options.cacheOnly) {
      if (previous?.data !== undefined) return previous.data;
      throw new Error("Mercato chiuso, cache non disponibile");
    }
    const free=provider==="twelve" || provider==="gold";
    const execute = async () => {
      const budget = (fn: (b: Budget) => void) => locked(state,provider,async () => {
        const time = Date.now(), minute = Math.floor(time/60000), day = new Date(time).toISOString().slice(0,10);
        const b = await state.read<Budget>(budgetPath) ?? { minute,count:0,day,daily:0,calls:0,errors:0,pause:0 };
        if (free && !b.recent) {
          const legacy=provider==="gold" && b.day===day ? b.daily : b.minute>=minute-1 ? b.count : 0;
          b.recent=Array(Math.min(legacy,100)).fill(time);
        }
        if (b.minute !== minute) Object.assign(b,{minute,count:0});
        if (b.day !== day) Object.assign(b,{day,daily:0});
        fn(b);
        await state.write(budgetPath,b);
      });
      let started=0;
      await budget(b => {
        const now=started=Date.now();
        if (b.pause>now || b.count>=minuteLimit || b.daily>=dayLimit) throw new FeedFailure(429);
        if (free) {
          const gold=provider==="gold";
          const span=gold?hourMs:minuteMs;
          b.recent=(b.recent??[]).filter(t=>t>now-span);
          const cap=gold?(options.priority?80:64):(options.priority?8:6);
          const dailyCap=options.priority?700:640;
          if (b.recent.length>=Math.min(cap,b.limits?.[gold?"hour":"minute"]??Infinity) || (!gold && b.daily>=Math.min(dailyCap,b.limits?.day??Infinity))) throw new FeedFailure(429);
          for (const [period,ledger] of Object.entries(b.remaining??{})) {
            if (ledger.until<=now) continue;
            const reserve=period==="day"?800-dailyCap:gold?100-cap:8-cap;
            if (ledger.left<=reserve) throw new FeedFailure(429);
          }
          for (const ledger of Object.values(b.remaining??{})) if (ledger.until>now) ledger.left--;
          b.recent.push(now);
        }
        b.calls++; b.count++; b.daily++;
      });
      let data: T;
      let received:Headers|undefined;
      try { data=free?await responseHeaders.run(h=>{received=h},load):await load(); }
      catch (e) {
        const failure = e instanceof FeedFailure ? e : new FeedFailure(0);
        const failures = (previous?.failures ?? 0)+1;
        const delay = [401,403,404].includes(failure.code) ? 86400000 :
          Math.max(failure.wait, failure.code === 429 ? (provider==="gold"?hourMs:minuteMs) : 0, 5000 * 2 ** Math.min(failures-1,8));
        await state.write(path,{error:failure.code, failures, until:Date.now()+delay});
        await budget(b => { if(received) accountHeaders(b,provider,received,Date.now(),started); b.errors++; if ([401,429].includes(failure.code)) b.pause = Math.max(b.pause,Date.now()+delay); });
        throw failure;
      }
      if(received) await budget(b=>accountHeaders(b,provider,received!,Date.now(),started));
      await state.write(path,{data,until:Date.now()+(typeof ttl==="number"?ttl:ttl(data))});
      return data;
    };
    return free ? locked(state,provider+"-request",execute) : execute();
  });
}
export async function freeUsage(state:State, now=Date.now()) {
  const day=new Date(now).toISOString().slice(0,10);
  return Promise.all(["twelve","gold"].map(async provider=>{
    const b=await state.read<Budget>("providers/"+provider+".json");
    const span=provider==="gold"?hourMs:minuteMs;
    return {provider, sinceStart:b?.calls??0, todayUTC:b?.day===day?b.daily:0,
      window:provider==="gold"?"60 min":"60 s", windowUnits:(b?.recent??[]).filter(at=>at>now-span).length,
      providerRemaining:Object.fromEntries(Object.entries(b?.remaining??{}).filter(([,entry])=>entry.until>now)),
      errors:b?.errors??0};
  }));
}
export async function publicResponse(url: URL, headers?: Record<string,string>) {
  const response = await fetch(url,{headers,signal:AbortSignal.timeout(8000),redirect:"error"});
  responseHeaders.getStore()?.(response.headers);
  if (!response.ok) {
    const retry = response.headers.get("retry-after") ?? "";
    const wait = /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
    throw new FeedFailure(response.status, Number.isFinite(wait) ? Math.max(0,wait) : 0);
  }
  return response;
}
