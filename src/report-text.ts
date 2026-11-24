const sentences = new Intl.Segmenter("it", { granularity: "sentence" });

export function shortReport(text: string, limit: number) {
  const original = text.replace(/\s+/gu, " ").trim();
  if (original.length <= limit) return original;
  let result = "";
  for (const { segment } of sentences.segment(original)) {
    if (result.length + segment.trimEnd().length > limit) break;
    result += segment;
  }
  return result.trimEnd() || original;
}
