/**
 * Only treat language as breaking when it makes an explicit recency claim.
 * Generic page chrome such as "Latest" and ordinary phrases ending in
 * "today" are not sufficient evidence that a narrated claim is breaking.
 */
export function isExplicitBreakingClaim(text: string) {
  return /(?:^|[.!?]\s)(?:breaking(?: news)?|developing(?: story)?)(?=[:\s])/i.test(text)
    || /\b(?:just announced|announced moments ago)\b/i.test(text)
    || /\b(?:happened|occurred|announced|reported|released|launched|filed|issued)\s+today\b/i.test(text);
}
