import type { Clock, MarketSession } from "./broker";
import { closedCandles } from "./indicators";
import type { Series } from "./market";
import { newYork, nyInstant } from "./time";

export function briefingSession(days: MarketSession[], clock: Clock, now: Date) {
  const { date } = newYork(now);
  const marketNow = new Date(clock.timestamp);
  if (Math.abs(+marketNow - +now) > 5 * 60_000) throw new Error("Orologio Alpaca non recente.");
  const today = days.find(day => day.date === date);
  const open = today && nyInstant(date, today.open);
  const close = today && nyInstant(date, today.close);
  const regular = open && close && marketNow >= open && marketNow < close;
  if (clock.is_open !== Boolean(regular)) throw new Error("Calendario e orologio Alpaca discordanti.");
  const previous = days.filter(day => nyInstant(day.date, day.close) <= marketNow).at(-1);
  const status = !today ? "mercato USA chiuso da calendario" : regular ? "sessione regolare in corso" :
    marketNow < open! ? "prima dell’apertura regolare USA" : "sessione regolare conclusa";
  return { date, today, previous, status, at: marketNow };
}

export function sessionCandles(series: Series, session: ReturnType<typeof briefingSession>) {
  const { at, today, previous } = session;
  const bars = closedCandles(series, "15Min", at);
  const within = (start: Date, end: Date) => bars.filter(bar => Date.parse(bar.t) >= +start && Date.parse(bar.t) + 900_000 <= +end).at(-1);
  const lastRegular = previous && within(nyInstant(previous.date, previous.open), nyInstant(previous.date, previous.close));
  const priorDaily = previous && (series.intervals["1Day"] ?? []).findLast(bar =>
    Number.isFinite(Date.parse(bar.t)) && newYork(new Date(bar.t)).date === previous.date && Number.isFinite(bar.c) && bar.c > 0);
  const extendedOpen = today?.session_open ?? "0400";
  const premarketStart = nyInstant(session.date, extendedOpen.slice(0, 2) + ":" + extendedOpen.slice(2));
  const premarket = today && within(premarketStart, new Date(Math.min(+at, +nyInstant(today.date, today.open))));
  const canHavePremarket = today && +at >= +premarketStart + 900_000;
  const newest = bars.at(-1);
  return {
    expectedRegularDate: previous?.date ?? null,
    lastRegular: lastRegular?.t ?? null,
    lastRegularPrice: lastRegular?.c ?? null,
    regularGapMinutes: lastRegular && previous ? (+nyInstant(previous.date, previous.close) - Date.parse(lastRegular.t) - 900_000) / 60_000 : null,
    priorDaily: priorDaily?.t ?? null,
    priorDailyPrice: priorDaily?.c ?? null,
    premarket: premarket?.t ?? null,
    premarketPrice: premarket?.c ?? null,
    premarketLagMinutes: premarket && today ? (+new Date(Math.min(+at, +nyInstant(today.date, today.open))) - Date.parse(premarket.t) - 900_000) / 60_000 : null,
    canHavePremarket: Boolean(canHavePremarket),
    lastAvailable: newest?.t ?? null,
    feedError: series.intervalErrors?.["15Min"],
  };
}

export function describeSession(data: ReturnType<typeof sessionCandles>) {
  const regular = data.lastRegular ? `regolare ${data.expectedRegularDate}: ${data.lastRegular}, chiusura ${data.lastRegularPrice}${data.regularGapMinutes! > 45 ? " (ultimo tratto non aggiornato)" : ""}` :
    `intraday regolare assente per ${data.expectedRegularDate ?? "la seduta attesa"}`;
  const premarket = data.premarket ? `premarket ${data.premarket}, chiusura ${data.premarketPrice}${data.premarketLagMinutes! > 45 ? " (dato datato)" : ""}` :
    data.feedError ? "premarket non verificabile, errore del feed" :
    data.canHavePremarket ? "premarket assente dal feed" : "premarket non ancora disponibile o seduta chiusa";
  const historical = !data.lastRegular && data.lastAvailable ? `; storico intraday ${data.lastAvailable}` : "";
  return `${regular}; ${data.priorDaily ? "giornaliero precedente " + data.priorDaily : "giornaliero precedente assente"}; ${premarket}${historical}${data.feedError ? "; errore IEX intraday" : ""}.`;
}
