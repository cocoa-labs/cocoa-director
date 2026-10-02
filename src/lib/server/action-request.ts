import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { getUserContext, type UserContext } from "@/lib/server/auth";
import { apiErrorResponse, ApiRequestError } from "@/lib/server/api-error";
import { criticalSection } from "@/lib/server/critical-section";
import { getSql, hasDatabase } from "@/lib/server/db";
import { getStore } from "@/lib/server/store";

type Claim = { fingerprint: string; status?: number; body?: unknown };
type ActionContext = { user: UserContext; scope: string; key?: string; reservationId?: string; fingerprint?: string; videoId?: string; sourceId?: string };
export const actionContext = new AsyncLocalStorage<ActionContext>();
const claims = new WeakMap<object, Map<string, Claim>>();

export function fingerprint(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]),
    );
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function memoryClaims() {
  const store = getStore();
  let map = claims.get(store);
  if (!map) { map = new Map(); claims.set(store, map); }
  return map;
}

async function readClaim(user: string, scope: string, key: string): Promise<Claim | undefined> {
  if (!hasDatabase()) return memoryClaims().get(JSON.stringify([user, scope, key]));
  const [row] = await getSql()`select fingerprint, response_status, response_body from action_requests
    where user_id = ${user} and scope = ${scope} and request_key = ${key}`;
  return row ? { fingerprint: String(row.fingerprint), status: row.response_status ? Number(row.response_status) : undefined, body: row.response_body } : undefined;
}

async function saveClaim(user: string, scope: string, key: string, claim: Claim) {
  if (!hasDatabase()) { memoryClaims().set(JSON.stringify([user, scope, key]), claim); return; }
  await getSql()`insert into action_requests(user_id, scope, request_key, fingerprint, state, response_status, response_body)
    values (${user}, ${scope}, ${key}, ${claim.fingerprint}, ${claim.status ? "complete" : "pending"}, ${claim.status ?? null}, ${JSON.stringify(claim.body ?? null)}::jsonb)
    on conflict (user_id, scope, request_key) do update set state = excluded.state,
      response_status = excluded.response_status, response_body = excluded.response_body, updated_at = now()`;
}

/** Save resource identity before launching a durable workflow, so a restart can replay it. */
export async function rememberActionResource(body: unknown, status = 200) {
  const context = actionContext.getStore();
  if (!context?.key || !context.fingerprint) return;
  await criticalSection(`request:${context.user.id}:${context.scope}:${context.key}`, () =>
    saveClaim(context.user.id, context.scope, context.key!, { fingerprint: context.fingerprint!, body, status }));
}

/** Claims commit before external work; network calls are never made inside the claim transaction. */
export async function actionRequest(request: Request, operation: () => Promise<Response>): Promise<Response> {
  try {
    const user = await getUserContext(request);
    const scope = `${request.method}:${new URL(request.url).pathname}`;
    let payload: Record<string, unknown> = {};
    if (request.body && !request.headers.get("content-type")?.includes("multipart/form-data")) {
      const text = await boundedRequestText(request.clone());
      if (text.length > 1_048_576) throw new ApiRequestError("Request is too large.", 413, "request_too_large");
      if (text) payload = JSON.parse(text);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ApiRequestError("Expected a JSON object.", 400, "invalid_request");
    }
    const key = request.headers.get("idempotency-key") ?? payload.idempotencyKey;
    if (key !== undefined && key !== null && (typeof key !== "string" || !key.trim() || key.length > 200)) {
      throw new ApiRequestError("Invalid idempotency key.", 400, "invalid_idempotency_key");
    }
    const context: ActionContext = { user, scope, key: typeof key === "string" ? key : undefined };
    if (context.key) {
      const { idempotencyKey: _key, ...input } = payload;
      void _key;
      context.fingerprint = fingerprint(input);
      const replay = await criticalSection(`request:${user.id}:${scope}:${context.key}`, async () => {
        const existing = await readClaim(user.id, scope, context.key!);
        if (existing) {
          if (existing.fingerprint !== context.fingerprint) throw new ApiRequestError("This idempotency key was already used with different input.", 409, "idempotency_conflict");
          if (existing.status) return existing.status === 204
            ? new Response(null, { status: 204, headers: { "Idempotency-Replayed": "true" } })
            : Response.json(existing.body, { status: existing.status, headers: { "Idempotency-Replayed": "true" } });
          return Response.json({ error: "This request is already in progress. Refresh the project before retrying.", code: "request_in_progress" }, { status: 409, headers: { "Retry-After": "3" } });
        }
        await saveClaim(user.id, scope, context.key!, { fingerprint: context.fingerprint! });
        return undefined;
      });
      if (replay) return replay;
    }
    return await actionContext.run(context, async () => {
      let response: Response;
      try { response = await operation(); }
      catch (error) { response = error instanceof Response ? error : apiErrorResponse(error, "Request failed."); }
      if (context.key) {
        const body = response.status === 204 ? null : await response.clone().json();
        // A created resource remains replayable even if launching its workflow later fails.
        const existing = await readClaim(user.id, scope, context.key);
        if (!existing?.status || response.ok) await rememberActionResource(body, response.status);
      }
      return response;
    });
  } catch (error) { return error instanceof Response ? error : apiErrorResponse(error, "Request failed."); }
}

async function boundedRequestText(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 1_048_576) {
      void reader.cancel();
      throw new ApiRequestError("Request is too large.", 413, "request_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
