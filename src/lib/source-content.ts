/** Source text is evidence, never a continuation of the creative brief. */
export function sourceBodyText(value: string) {
  let text = value.replace(/\r/g, "");
  // Papers commonly put affiliations and correspondence before the abstract.
  const abstract = /(?:^|\n)\s*(?:\d+\s+)?abstract\s*[:\n]/i.exec(text);
  if (abstract) text = text.slice(abstract.index + abstract[0].length);
  const references = /\n\s*(?:\d+\.?\s+)?(?:references|bibliography|acknowledg(?:e)?ments)\s*\n/i.exec(text);
  if (references) text = text.slice(0, references.index);
  return text.split(/\n+/).map((line) => line.trim()).filter((line) => line && !isSourceMetadata(line)).join("\n\n");
}

export function isSourceMetadata(value: string) {
  return /^(?:site search|search|menu|mega menu|topics|load more|sign in|log in|desktop logo|mobile logo|toggle|view pdf|download pdf|html\s*\(experimental\)|full.text links?|submission history)\s*[:.]?$/i.test(value)
    || /^(?:authors?|affiliations?|e-?mail|subjects?|cite as|comments)\s*:/i.test(value)
    || /^(?:submitted on|last revised|arxiv:|copyright|all rights reserved)\s/i.test(value)
    || /^view a pdf of (?:the|this) paper\b/i.test(value)
    || /^computer science\s*>/i.test(value)
    || /\b(?:desktop|mobile) logo\b|\b(?:site search|mega menu) toggle\b/i.test(value);
}

export function sourceSentences(value: string) {
  return sourceBodyText(value).split(/\n+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length > 0 && !isSourceMetadata(sentence));
}

/** Preserve complete excerpts distributed over the document, including its end. */
export function sourceContext(value: string, maxCharacters: number) {
  const text = sourceBodyText(value);
  if (text.length <= maxCharacters) return text;
  const chunks = text.match(/[\s\S]{1,1200}(?:\s|$)/g) ?? [text];
  const count = Math.max(1, Math.floor(maxCharacters / 1250));
  return Array.from({ length: Math.min(count, chunks.length) }, (_, index) => {
    const position = count === 1 ? 0 : Math.round(index * (chunks.length - 1) / (count - 1));
    return chunks[position];
  }).join("\n\n[... excerpt gap ...]\n\n").slice(0, maxCharacters);
}

/** A no-provider draft still covers the body rather than reading the first page. */
export function selectExplainerUnits<T extends { sentence: string; sourceId: string }>(units: T[], wordBudget: number) {
  const substantive = units.filter((unit) => unit.sentence.split(/\s+/).length >= 6 && unit.sentence.length <= 1500);
  const pool = substantive.length ? substantive : units;
  const sources = [...new Set(pool.map((unit) => unit.sourceId))];
  const selected: T[] = [];
  let remaining = wordBudget;
  for (const [sourceIndex, sourceId] of sources.entries()) {
    const candidates = pool.filter((unit) => unit.sourceId === sourceId);
    const sourceBudget = Math.floor(remaining / (sources.length - sourceIndex));
    const averageWords = candidates.reduce((sum, unit) => sum + wordCount(unit.sentence), 0) / candidates.length;
    const count = Math.max(1, Math.min(candidates.length, Math.floor(sourceBudget / averageWords)));
    const positions = new Set(Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(index * (candidates.length - 1) / (count - 1))));
    let used = 0;
    for (const position of positions) {
      const unit = candidates[position];
      const words = wordCount(unit.sentence);
      if (used + words > sourceBudget) continue;
      selected.push(unit);
      used += words;
    }
    remaining -= used;
  }
  return selected;
}

function wordCount(value: string) { return value.split(/\s+/).filter(Boolean).length; }
