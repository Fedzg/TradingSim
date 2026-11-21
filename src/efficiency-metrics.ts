import type { Agents, Role } from "./agents";

type Counts = { calls: number; elapsedMs: number; contextBytes: number };
export const elapsed = (started: number) => Math.round(performance.now() - started);
export function metric(event: string, values: object) {
  console.log(JSON.stringify({ event, ...values }));
}

export function measureAgents(workflow: string, agents: Agents) {
  const started = performance.now();
  const roles: Partial<Record<Role, Counts>> = {};
  const measured: Agents = {
    async invoke(role, input) {
      const stats = roles[role] ??= { calls: 0, elapsedMs: 0, contextBytes: 0 };
      stats.calls++;
      stats.contextBytes += Buffer.byteLength(JSON.stringify(input), "utf8");
      const sent = performance.now();
      try { return await agents.invoke(role, input); }
      finally { stats.elapsedMs += elapsed(sent); }
    },
  };
  const summary = () => ({ workflow, elapsedMs: elapsed(started), roles });
  return { agents: measured, summary, log: () => metric("analysis.model", summary()) };
}

export async function measureFeed<T>(feed: string, check: () => Promise<T>) {
  const started = performance.now();
  try { return await check(); }
  finally { metric(`feed.${feed}`, { checks: 1, elapsedMs: elapsed(started) }); }
}
