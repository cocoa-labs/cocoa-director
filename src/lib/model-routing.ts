/** Central model defaults. Environment variables remain the release valve for
 * snapshot pinning, canaries, and provider rollback without a code deploy. */
export function editorialModel() {
  return process.env.OPENAI_AGENT_MODEL ?? "gpt-5.6-terra";
}

export function styleModel() {
  return process.env.OPENAI_STYLE_MODEL ?? editorialModel();
}

export function lyricsModel() {
  return process.env.OPENAI_LYRICS_MODEL ?? styleModel();
}

export function factualAuditModel() {
  return process.env.OPENAI_FACTUAL_AUDIT_MODEL ?? "gpt-5.6-sol";
}

export function visionAuditModel() {
  return process.env.OPENAI_VISION_AUDIT_MODEL ?? factualAuditModel();
}
