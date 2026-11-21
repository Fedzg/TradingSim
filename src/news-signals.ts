import { ask, type Agents, type NewsSignals } from "./agents";
import { universe } from "./broker";
import { enqueue } from "./chat";
import type { Article, News } from "./market";
import type { State } from "./state";
import { rome } from "./time";

const stateFile = "news-signals.json";
const macroHeadline = /\b(FOMC|Federal Reserve|Fed rate|CPI|PCE|nonfarm payrolls|jobs report|Treasury yields|tariffs|GDP|inflation)\b/i;
const macroSymbols = ["SPY", "QQQ", "IWM", "TLT", "GLD"];

function eligibleSymbols(article: Article) {
  const tagged = new Set(article.symbols.map(symbol => symbol.toUpperCase()));
  if (macroHeadline.test(article.title)) {
    for (const symbol of macroSymbols) tagged.add(symbol);
  }
  return universe.filter(symbol => tagged.has(symbol));
}

export async function queueNewsSignals(state: State, agents: Agents, news: News, now: Date, redact: (text: string) => string) {
  const saved = await state.read<{ since: number; processed: string[] }>(stateFile);
  const since = saved?.since ?? +now - 30 * 60_000;
  const cutoff = Math.max(since, +now - 2 * 60 * 60_000);
  const processed = new Set(saved?.processed ?? []);
  const recent = news.articles
    .filter(article => {
      const published = Date.parse(article.published);
      return published >= cutoff && published <= +now && /^https:\/\//.test(article.link);
    })
    .map(article => ({ article, key: JSON.stringify([article.link, article.published]), allowedSymbols: eligibleSymbols(article) }));
  const candidates = recent.filter(candidate => candidate.allowedSymbols.length && !processed.has(candidate.key)).slice(0, 12);

  if (!saved) await state.write(stateFile, { since, processed: [] });
  if (!candidates.length) return 0;
  const { signals } = await ask<NewsSignals>(agents, "newsSignals", {
    now, candidates: candidates.map(({ article, allowedSymbols }, index) => ({ articleId: index + 1, ...article, allowedSymbols })),
  });
  const { date, time } = rome(now);
  const alerted = new Set<string>();
  for (const signal of signals) {
    const candidate = candidates[signal.articleId - 1];
    if (!candidate || alerted.has(candidate.key)) continue;
    const symbols = candidate.allowedSymbols.filter(symbol => signal.symbols.includes(symbol));
    if (!symbols.length) continue;
    const { article } = candidate;
    await enqueue(state, `${date}-${time.replace(":", "")}-news`, "notizia-operativa", redact([
      article.title,
      `Strumenti Paper da valutare: ${symbols.join(", ")}.`,
      `Possibile impatto: ${signal.reason.slice(0, 600)}`,
      `Fonte: ${article.source}, ${article.published}`,
      article.link,
      "Avviso informativo. Questo controllo non ha inviato ordini.",
    ].join("\n")), candidate.key);
    alerted.add(candidate.key);
    if (alerted.size === 3) break;
  }
  for (const candidate of candidates) processed.add(candidate.key);
  await state.write(stateFile, { since, processed: recent.filter(candidate => processed.has(candidate.key)).map(candidate => candidate.key) });
  return alerted.size;
}
