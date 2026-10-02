/**
 * A Vercel Sandbox API failure worth retrying with a fresh sandbox.
 *
 * Renders intermittently fail with a transient authorization/throttle on a request
 * ("Status code 403/429/5xx is not ok", thrown by @vercel/sandbox's api-client) or a
 * dropped command stream ("Stream ended before command finished"), plus the usual
 * transient network/DNS errors. These resolve on a plain retry.
 *
 * Deterministic failures — ffmpeg exit codes, missing output files, a 404, an empty
 * manifest — are intentionally NOT matched, so they surface immediately instead of
 * looping pointlessly.
 */
export function isTransientSandboxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // Walk the cause chain, collecting messages + error codes.
  let text = "";
  for (let current: unknown = error, depth = 0; current instanceof Error && depth < 6; depth += 1) {
    text += ` ${current.message}`;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") text += ` ${code}`;
    current = (current as { cause?: unknown }).cause;
  }

  return /Stream ended|stream_ended|Status code (?:403|408|409|425|429|5\d\d) is not ok|socket hang up|fetch failed|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR/i.test(
    text,
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
