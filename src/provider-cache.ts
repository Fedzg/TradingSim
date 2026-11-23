import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import type { State } from "./state";

export class FeedFailure extends Error {
  constructor(readonly code: number, readonly wait = 0) { super(code ? "Feed HTTP " + code : "Feed non raggiungibile o risposta non valida"); }
}
type Entry<T> = { until: number; data?: T; error?: number; failures?: number };
type Budget = { minute: number; count: number; day: string; daily: number; calls: number; errors: number; pause: number };

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

export async function cached<T>(state: State, provider: string, key: string, ttl: number | ((value:T)=>number), load: () => Promise<T>, minuteLimit = 60, dayLimit = 3000) {
  const hash = new Bun.CryptoHasher("sha256").update(provider+"/"+key).digest("hex");
  const path = "providers/"+hash+".json";
  const budgetPath = "providers/"+provider+".json";
  return locked(state, hash, async () => {
    const previous = await state.read<Entry<T>>(path);
    if (previous && previous.until > Date.now()) {
      if (previous.error !== undefined) throw new FeedFailure(previous.error);
      return previous.data!;
    }
    const budget = (fn: (b: Budget) => void) => locked(state,provider,async () => {
      const time = Date.now(), minute = Math.floor(time/60000), day = new Date(time).toISOString().slice(0,10);
      const b = await state.read<Budget>(budgetPath) ?? { minute,count:0,day,daily:0,calls:0,errors:0,pause:0 };
      if (b.minute !== minute) Object.assign(b,{minute,count:0});
      if (b.day !== day) Object.assign(b,{day,daily:0});
      fn(b);
      await state.write(budgetPath,b);
    });
    await budget(b => {
      if (b.pause > Date.now() || b.count >= minuteLimit || b.daily >= dayLimit) throw new FeedFailure(429);
      b.calls++; b.count++; b.daily++;
    });
    let data: T;
    try { data = await load(); }
    catch (e) {
      const failure = e instanceof FeedFailure ? e : new FeedFailure(0);
      const failures = (previous?.failures ?? 0)+1;
      const delay = [401,403,404].includes(failure.code) ? 86400000 :
        Math.max(failure.wait, failure.code === 429 ? 60000 : 0, 5000 * 2 ** Math.min(failures-1,8));
      await state.write(path,{error:failure.code, failures, until:Date.now()+delay});
      await budget(b => { b.errors++; if ([401,429].includes(failure.code)) b.pause = Math.max(b.pause,Date.now()+delay); });
      throw failure;
    }
    await state.write(path,{data,until:Date.now()+(typeof ttl==="number"?ttl:ttl(data))});
    return data;
  });
}
export async function publicResponse(url: URL, headers?: Record<string,string>) {
  const response = await fetch(url,{headers,signal:AbortSignal.timeout(8000),redirect:"error"});
  if (!response.ok) {
    const retry = response.headers.get("retry-after") ?? "";
    const wait = /^\d+$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now();
    throw new FeedFailure(response.status, Number.isFinite(wait) ? Math.max(0,wait) : 0);
  }
  return response;
}
