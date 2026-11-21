import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../src/agents";

const roles: Record<Role, number> = {
  news: 150_000,
  charts: 120_000, newsSignals: 120_000, discoveryNews: 120_000, discoveryCharts: 120_000,
  discoveryChallenge: 120_000, discoveryNewsAnswer: 120_000, discoveryChartsAnswer: 120_000, discoveryReview: 120_000,
  decide: 120_000, challenge: 120_000, answer: 120_000, review: 120_000,
};

test("Codex finto: diagnostica redatta, scadenza per ruolo e prompt breve con array vuoti", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradingsim-diagnostics-"));
  try {
    await writeFile(join(dir, "codex"), `#!/bin/sh
case "$(cat "$(dirname "$0")/mode")" in
  usage) printf '%s\\n' 'HTTP 429: usage_limit_reached SECRET-MARKER' >&2; exit 1 ;;
  auth) printf '%s\\n' 'HTTP 401: Unauthorized SECRET-MARKER' >&2; exit 1 ;;
  exit) printf '%s\\n' 'unexpected failure SECRET-MARKER' >&2; exit 7 ;;
  json) printf '%s\\n' 'invalid output SECRET-MARKER' >&2 ;;
  timeout) printf '%s\\n' 'waiting SECRET-MARKER' >&2; exec sleep 10 ;;
  prompt)
    body=$(cat)
    case "$body" in
      *"al massimo 6 eventi pertinenti"*"2 nuovi mercati motivati"*"frase breve"*"array vuoti"*) ;;
      *) exit 9 ;;
    esac ;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output-last-message ]; then
    shift
    if [ "$(cat "$(dirname "$0")/mode")" = json ]; then
      printf '%s' '{"SECRET-MARKER":' > "$1"
    else
      printf '%s' '{"events":[],"newMarkets":[],"limitations":[]}' > "$1"
    fi
    exit 0
  fi
  shift
done
exit 8
`, { mode: 0o700 });

    const cases = [
      ["news", "usage"], ["news", "auth"], ["news", "exit"], ["news", "json"], ["news", "prompt"],
      ...Object.keys(roles).map(role => [role, "timeout"]),
    ];
    const probe = `
      import { CodexAgents, ask } from "./src/agents";
      import { writeFile } from "node:fs/promises";
      const agent = new CodexAgents(text => text);
      const [dir, cases] = process.argv.slice(-2);
      const timer = globalThis.setTimeout;
      let budget;
      globalThis.setTimeout = (callback, ms, ...args) => {
        if (ms === 120000 || ms === 150000) {
          budget = ms;
          return timer(callback, 35, ...args);
        }
        return timer(callback, ms, ...args);
      };
      for (const [role, mode] of JSON.parse(cases)) {
        await writeFile(dir + "/mode", mode);
        budget = undefined;
        try {
          const result = await ask(agent, role, { promptMarker: "PROMPT-MARKER" });
          console.log(JSON.stringify({ role, mode, budget, result }));
        } catch (error) {
          console.log(JSON.stringify({ role, mode, budget, message: error.message }));
        }
      }
    `;
    const proc = Bun.spawn([process.execPath, "-e", probe, dir, JSON.stringify(cases)], {
      cwd: join(import.meta.dir, ".."), env: { PATH: `${dir}:${process.env.PATH}`, TRADINGSIM_CODEX_ISOLATE: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()]);
    expect(code, stderr).toBe(0);
    expect(stdout + stderr).not.toMatch(/SECRET-MARKER|PROMPT-MARKER/);
    const outcomes = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(outcomes).toHaveLength(cases.length);
    expect(outcomes.find(row => row.mode === "prompt")?.result).toEqual({ events: [], newMarkets: [], limitations: [] });
    const expected = { usage: /limite di utilizzo/, auth: /autenticazione/, exit: /codice di uscita 7/, json: /output JSON/ };
    for (const row of outcomes) {
      const role = row.role as Role;
      expect(row.budget).toBe(roles[role]);
      if (row.mode === "prompt") continue;
      expect(row.message).toMatch(new RegExp(`codex exec ${role}: .+ \\(\\d+ ms\\)\\.`));
      expect(row.message).toMatch(row.mode === "timeout" ? new RegExp(`timeout dopo ${roles[role] / 1000} s`) : expected[row.mode as keyof typeof expected]);
      expect(stderr).toContain(row.message);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
