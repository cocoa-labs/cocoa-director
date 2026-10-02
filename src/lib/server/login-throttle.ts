import { createHmac } from "node:crypto";
import { ApiRequestError } from "@/lib/server/api-error";
import { criticalSection } from "@/lib/server/critical-section";
import { getSql, hasDatabase } from "@/lib/server/db";

const attempts = new Map<string, { count: number; resetsAt: number }>();
const WINDOW_MS = 15 * 60_000;

export async function throttleLogin(request: Request, code: string) {
  const address = process.env.VERCEL === "1"
    ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
    : "local";
  for (const [identity, limit] of [[`address:${address}`, 20], [`code:${code.trim()}`, 10]] as const) {
    const key = createHmac("sha256", process.env.AUTH_SECRET ?? "local-login-throttle").update(identity).digest("hex");
    const count = await criticalSection(`login:${key}`, async () => {
      if (hasDatabase()) {
        const [row] = await getSql()`insert into login_attempts(key_hash, attempts, resets_at)
          values (${key}, 1, now() + interval '15 minutes')
          on conflict (key_hash) do update set
            attempts = case when login_attempts.resets_at <= now() then 1 else login_attempts.attempts + 1 end,
            resets_at = case when login_attempts.resets_at <= now() then now() + interval '15 minutes' else login_attempts.resets_at end
          returning attempts`;
        return Number(row.attempts);
      }
      const now = Date.now();
      for (const [key, value] of attempts) if (value.resetsAt <= now) attempts.delete(key);
      const value = attempts.get(key) ?? { count: 0, resetsAt: now + WINDOW_MS };
      value.count += 1;
      attempts.set(key, value);
      return value.count;
    });
    if (count > limit) throw new ApiRequestError("Too many login attempts. Try again in 15 minutes.", 429, "login_throttled");
  }
}
