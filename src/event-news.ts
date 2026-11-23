import { createHash } from "node:crypto";
import { ask, type Agents, type NewsAnalysis } from "./agents";
import { closedCandles, pct } from "./indicators";
import type { Article, News, Series } from "./market";
import type { State } from "./state";
import { dateOffset, newYork, validDate } from "./time";

type Event = NewsAnalysis["events"][number];
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();
const file = "wake-news-analysis.json";

export async function analyzeWakeNews(state: State, agents: Agents, now: Date, news: News | undefined, watched: string[], original: Article[] = []) {
  const seen = new Set<string>();
  const articles = news?.articles.filter(article => {
    const fingerprint = JSON.stringify([normalize(article.title), normalize(article.summary), [...article.symbols].sort(), article.published.slice(0, 10)]);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
  const byLink = new Map(original.map(article => [article.link, article.summary]));
  const key = createHash("sha256").update(JSON.stringify([articles?.map(article => [article, byLink.get(article.link)]), watched])).digest("hex");
  const cached = await state.read<{ key: string; analysis: NewsAnalysis; at: string }>(file);
  const age = +now - Date.parse(cached?.at ?? "");
  if (news?.lastSuccess && !news.error && cached?.key === key && age >= 0 && age < 6 * 3600_000) return cached.analysis;
  const analysis = await ask<NewsAnalysis>(agents, "news", { now, news: news && { ...news, articles }, watched });
  if (news?.lastSuccess && !news.error) await state.write(file, { key, analysis, at: now.toISOString() });
  return analysis;
}

function dateInQuote(event: Event, article: Article) {
  if (!validDate(event.effectiveDate) || !event.dateQuote || ![article.title, article.summary].some(text => text.includes(event.dateQuote))) return;
  const published = Date.parse(article.published);
  if (!Number.isFinite(published) || event.effectiveDate > newYork(new Date(published)).date) return;
  const [year, month, day] = event.effectiveDate.split("-");
  const date = new Date(event.effectiveDate + "T12:00:00Z");
  const monthName = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(date).toLowerCase();
  const number = String(Number(day));
  const word = normalize(event.dateQuote);
  const textual = new RegExp(`\\b(?:${monthName}|${monthName.slice(0, 3)}) ${number}(?:st|nd|rd|th)? ${year}\\b|\\b${number} (?:${monthName}|${monthName.slice(0, 3)}) ${year}\\b`);
  if (event.dateQuote.includes(`${year}-${month}-${day}`) || textual.test(word)) return event.effectiveDate;
}

export function verifyEvents(events: Event[], articles: Article[], charts: Series[], now: Date) {
  const seen = new Set<string>();
  return events.flatMap(event => {
    const article = articles.find(item => item.link === event.link && item.published === event.published && item.source === event.source);
    if (!article || !/^https:\/\//.test(article.link)) return [];
    const effectiveDate = dateInQuote(event, article);
    const symbols = [...new Set(event.symbols)].sort();
    const status = !effectiveDate ? "Data dell’evento non verificata" :
      effectiveDate < dateOffset(newYork(now).date, -1) ? "notizia storica" :
      event.update === "sì" ? "aggiornamento di un evento precedente" : "evento nuovo";
    const key = JSON.stringify(effectiveDate
      ? [normalize(event.eventType), normalize(event.subject), effectiveDate, event.update, event.update === "sì" ? normalize(article.title) : ""]
      : [symbols, normalize(article.title), normalize(article.summary)]);
    if (seen.has(key)) return [];
    seen.add(key);
    const series = charts.find(item => symbols.includes(item.symbol) && item.source === "Alpaca IEX");
    const following = effectiveDate && series ? closedCandles(series, "1Day", now)
      .filter(bar => newYork(new Date(bar.t)).date > effectiveDate).slice(0, 2) : [];
    const movement = following.length === 2 && series
      ? `${series.symbol} ${pct(following[0].c, following[1].c).toFixed(2)}% fra le prime due chiusure disponibili successive (${following[0].t}, ${following[1].t} · ${series.source}). Causalità non verificata.`
      : undefined;
    return [{ ...event, title: article.title, symbols, effectiveDate, status, movement, key }];
  });
}
