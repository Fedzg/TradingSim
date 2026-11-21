// Accelerates only the scheduler sleep. All jobs still run in real Bun processes.
import { existsSync, readFileSync } from "node:fs";
import { State } from "../../src/state";

const Original = Date;
const clock = () => Number(readFileSync(process.env.TEST_SCHEDULER_CLOCK!, "utf8"));
globalThis.Date = class extends Original {
  constructor(...args: [] | [string | number]) { super(args.length ? args[0] : clock()); }
  static now() { return clock(); }
} as DateConstructor;

if (process.argv[2] === "_schedule") {
  const delay = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    delay(fn, ms === 30_000 ? 25 : ms, ...args)) as typeof setTimeout;
}

if (process.argv[2] === "_discover") {
  const write = State.prototype.write;
  State.prototype.write = async function (name, value, once) {
    if (name === "watchlist.json" && !existsSync(this.path("test-scan-start.json"))) {
      await write.call(this, "test-scan-start.json", { at: new Date().toISOString() });
      while (!existsSync(this.path("test-scan-resume.json"))) await Bun.sleep(10);
    }
    return write.call(this, name, value, once);
  };
}
