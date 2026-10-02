const NEGATION = "(?:no|not|without|avoid|exclude|omit|ban|remove|don't|do not|never)";

export function stripDirectorInterventions(prompt: string) {
  return prompt.split(/\n\s*Director style intervention \(/i)[0]?.trim() || prompt.trim();
}

export function hasPositivePromptMatch(prompt: string, pattern: RegExp, negativePattern?: RegExp) {
  const source = stripDirectorInterventions(prompt);
  return pattern.test(source) && !negativePattern?.test(source);
}

export function negativePatternFor(patternSource: string) {
  return new RegExp(`\\b${NEGATION}\\b[^.\\n]{0,90}\\b(?:${patternSource})\\b`, "i");
}
