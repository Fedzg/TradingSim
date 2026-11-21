import { link, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Wake } from "./time";
import { slots, wake } from "./time";
import type { Intent } from "./broker";

export type Baton = { wake: Wake; savedAt: string; planNext: string; report: string; pending: string[] };
export type RunLock = { wake: Wake; pid: number; startedAt: string; intents: string[] };

export class State {
  constructor(readonly root: string) {}
  path(name: string) { return join(this.root, name); }

  async read<T>(name: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(name), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(name: string, value: unknown, once = false) {
    const path = this.path(name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = path + "." + crypto.randomUUID() + ".tmp";
    const file = await open(temp, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value, null, 2) + "\n");
        await file.sync();
      } finally { await file.close(); }
      if (once) {
        try { await link(temp, path); }
        catch (error) { if (error.code === "EEXIST") return; throw error; }
      } else await rename(temp, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async remove(name: string) {
    await unlink(this.path(name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }

  async list(directory: string) {
    try { return (await readdir(this.path(directory))).filter(file => file.endsWith(".json")).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async baton() {
    try {
      const baton = await this.read<Baton>("baton.json");
      if (baton === undefined) return { baton };
      const date = baton?.wake?.date;
      const day = new Date(date + "T00:00:00Z");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== date ||
        !slots.includes(baton.wake.slot) || wake(baton.wake.date, baton.wake.slot).id !== baton.wake.id ||
        typeof baton.savedAt !== "string" || !Number.isFinite(Date.parse(baton.savedAt)) || typeof baton.planNext !== "string" ||
        typeof baton.report !== "string" || !Array.isArray(baton.pending) || !baton.pending.every(id => typeof id === "string")) {
        throw new SyntaxError("testimone non valido");
      }
      return { baton };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return { warning: "Testimone corrotto. Uso i dati Alpaca." };
      throw error;
    }
  }

  async intents() {
    const entries = await Promise.all((await this.list("intents")).map(file => this.read<Intent>(`intents/${file}`)));
    return entries.filter((entry): entry is Intent => !!entry);
  }
}
