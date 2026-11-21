import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBroker, type BrokerOrder, type Intent } from "../src/broker";
import { enqueue } from "../src/chat";
import { flushNotifications, pollOrders, queueOrder } from "../src/notifications";
import { State } from "../src/state";
import { TelegramChannel } from "../src/telegram";

const roots: string[] = [];
const redact = (text: string) => text;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tradingsim-notify-"));
  roots.push(root);
  const state = new State(root);
  const sent: string[] = [];
  const deliver = (current = new State(root)) => flushNotifications(current, new TelegramChannel("0:fake", "42", (async (url, init) => {
    expect(String(url)).toEndWith("/sendMessage");
    sent.push(JSON.parse(String(init?.body)).text);
    return Response.json({ ok: true });
  }) as typeof fetch), redact);
  const poll = (current = new State(root)) => pollOrders(current, new FakeBroker(current), redact);
  return { state, sent, deliver, poll };
}

function records(symbol: string, side: "buy" | "sell", status: string, fills: string) {
  const id = `2026-11-21-1540-${symbol}-${side}`;
  const reason = side === "buy" ? "Segnale approvato sul trend." : "Stop obbligatorio al 3%.";
  const intent: Intent = { id, order: { symbol, side, qty: 5, reason }, limit: null, attemptedAt: "2026-11-21T14:40:00Z" };
  const order: BrokerOrder = { client_order_id: id, symbol, side, qty: "5", filled_qty: fills, status, limit_price: null };
  return { intent, order };
}

test("broker finto: acquisto accettato, più eseguiti parziali e vendita eseguita senza duplicati", async () => {
  const f = await fixture();
  const buy = records("SPY", "buy", "accepted", "0");
  const sell = records("QQQ", "sell", "filled", "5");
  for (const { intent } of [buy, sell]) await f.state.write(`intents/${intent.id}.json`, intent);
  await f.state.write("fake-broker.json", [buy.order, sell.order]);
  await Promise.all([f.poll(), queueOrder(f.state, buy.order, buy.intent, "broker finto", redact)]);
  await f.deliver();
  expect(f.sent).toHaveLength(2);
  expect(f.sent.find(x => x.includes("SPY"))).toContain("accettato, in attesa di esecuzione");
  expect(f.sent.find(x => x.includes("SPY"))).toContain("richiesta: 5. Quantità eseguita: 0");
  expect(f.sent.find(x => x.includes("SPY"))).toContain(buy.intent.order.reason);
  expect(f.sent.find(x => x.includes("QQQ"))).toContain("Vendita");
  expect(f.sent.find(x => x.includes("QQQ"))).toContain("Stato: eseguito.");
  expect(f.sent.find(x => x.includes("QQQ"))).toContain("richiesta: 5. Quantità eseguita: 5");
  expect(f.sent.find(x => x.includes("QQQ"))).toContain(sell.intent.order.reason);

  for (const filled_qty of ["1", "3"]) {
    await f.state.write("fake-broker.json", [{ ...buy.order, status: "partially_filled", filled_qty }, sell.order]);
    await f.poll();
    await f.deliver();
    await f.poll();
    await f.deliver();
    expect(f.sent.at(-1)).toContain(`eseguita: ${filled_qty}`);
    expect(f.sent.at(-1)).toContain("eseguito in parte");
  }
  await f.state.write("fake-broker.json", [{ ...buy.order, status: "filled", filled_qty: "5" }, sell.order]);
  await f.poll();
  await f.deliver();
  expect(f.sent).toHaveLength(5);
  expect(f.sent.at(-1)).toContain("Stato: eseguito.");
  expect((await new FakeBroker(f.state).orders()).length).toBe(2);
});

test("respinto, annullato e scaduto sono notificabili, un invio non confermato resta locale", async () => {
  const f = await fixture();
  const states = [["SPY", "rejected"], ["QQQ", "canceled"], ["IWM", "expired"], ["GLD", "pending_new"]];
  const orders: BrokerOrder[] = [];
  for (const [symbol, status] of states) {
    const { intent, order } = records(symbol, "buy", status, "0");
    await f.state.write(`intents/${intent.id}.json`, intent);
    orders.push(order);
  }
  await f.state.write("fake-broker.json", orders);
  await f.poll();
  await f.deliver();
  await f.poll();
  await f.deliver();
  expect(f.sent).toHaveLength(3);
  for (const status of ["respinto", "annullato", "scaduto"]) expect(f.sent.join("\n")).toContain(`Stato: ${status}.`);
  expect(f.sent.join("\n")).not.toContain("GLD");
});

test("la consegna filtra le code vecchie e nuove senza cancellare resoconti o bloccare gli ordini", async () => {
  const f = await fixture();
  for (const kind of ["notizia", "notizia-operativa", "scenario-grafici", "resoconto", "allarmi", "mercato", "watchlist"] as const) {
    await enqueue(f.state, "local", kind, `Locale: ${kind}`);
  }
  await f.state.write("outbox/000.json", { id: "000", kind: "resoconto", text: "Briefing preesistente", retryAt: "2099-01-01T00:00:00Z" });
  const { intent, order } = records("SPY", "buy", "accepted", "0");
  await f.state.write(`intents/${intent.id}.json`, intent);
  await enqueue(f.state, "legacy", "ordine", `SPY acquisto × 5\n${intent.id}: accettato (broker finto), eseguite 0/5.`,
    JSON.stringify([intent.id, order.status, Number(order.filled_qty)]));
  await f.deliver();
  await f.deliver();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toContain(intent.order.reason);
  expect(await f.state.list("outbox")).toHaveLength(9);
  expect(await f.state.read("outbox/000.json")).toMatchObject({ text: "Briefing preesistente" });
});
