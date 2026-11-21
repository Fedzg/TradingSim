import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../src/agents";

const scanRole: Record<Role, boolean> = {
  charts: false, news: false, newsSignals: true,
  discoveryNews: true, discoveryCharts: true, discoveryChallenge: false,
  discoveryNewsAnswer: false, discoveryChartsAnswer: false, discoveryReview: false,
  decide: false, challenge: false, answer: false, review: false,
};

test("codex exec usa il modello previsto per ciascun ruolo e omette --model per il predefinito", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tradingsim-model-"));
  try {
    await writeFile(join(dir, "codex"), `#!/bin/sh
model=""
count=0
result=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --model) shift; model="$1"; count=$((count + 1)) ;;
    --output-last-message) shift; result="$1" ;;
  esac
  shift
done
test -n "$result" || exit 1
printf '{"model":"%s","count":%s}\\n' "$model" "$count" > "$result"
`, { mode: 0o700 });

    const roles = Object.keys(scanRole) as Role[];
    const probe = `
      import { CodexAgents } from "./src/agents";
      const agent = new CodexAgents(text => text);
      for (const role of JSON.parse(process.argv.at(-1))) {
        console.log(JSON.stringify(await agent.invoke(role, {})));
      }
    `;
    for (const [main, scan] of [[" gpt-6.2-sol ", " gpt-6.1-terra "], ["gpt-6.2-sol", " "], ["", "gpt-6.1-terra"], ["", ""], [undefined, undefined]]) {
      const proc = Bun.spawn([process.execPath, "-e", probe, JSON.stringify(roles)], {
        cwd: join(import.meta.dir, ".."),
        env: {
          PATH: `${dir}:${process.env.PATH}`, TRADINGSIM_CODEX_ISOLATE: "0",
          ...(main === undefined ? {} : { TRADINGSIM_CODEX_MODEL: main }),
          ...(scan === undefined ? {} : { TRADINGSIM_CODEX_MODEL_SCAN: scan }),
        },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([proc.exited, proc.stdout.text(), proc.stderr.text()]);
      expect(code, stderr).toBe(0);
      expect(stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual(roles.map(role => {
        const model = (scanRole[role] ? scan?.trim() : "") || main?.trim() || "";
        return { model, count: model ? 1 : 0 };
      }));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
