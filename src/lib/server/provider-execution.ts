import { actionContext, fingerprint } from "@/lib/server/action-request";
import { ApiRequestError } from "@/lib/server/api-error";
import { assertProvidersEnabled, reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { getDailyBudgetCapUsd } from "@/lib/server/config";
import { getStore } from "@/lib/server/store";
import { cents } from "@/lib/cost";

export async function withJobContext<T>(videoId: string, operation: () => Promise<T>): Promise<T> {
  const job = await getStore().getJob(videoId);
  if (!job) throw new ApiRequestError("Production not found.", 404, "production_not_found");
  if (job.cancellationRequested || job.status === "cancelled") throw new ApiRequestError("Production cancelled.", 409, "production_cancelled");
  const parent = actionContext.getStore();
  return actionContext.run({ ...parent, scope: parent?.scope ?? "workflow", videoId,
    user: parent?.user ?? { id: job.userId, email: "", planTier: "dev", dailyBudgetCents: cents(getDailyBudgetCapUsd()) } }, operation);
}

export async function withSourceContext<T>(sourceId: string, operation: () => Promise<T>): Promise<T> {
  const source = await getStore().getProductionSource(sourceId);
  if (!source) throw new ApiRequestError("Source not found.", 404, "source_not_found");
  const parent = actionContext.getStore();
  return actionContext.run({ ...parent, scope: parent?.scope ?? "source-processing", sourceId,
    user: parent?.user ?? { id: source.userId, email: "", planTier: "dev", dailyBudgetCents: cents(getDailyBudgetCapUsd()) } }, operation);
}

/** Responses calls have explicit token and input bounds; SDK retries must be disabled. */
export async function providerFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  assertProvidersEnabled();
  const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (!address.startsWith("https://api.openai.com/v1/responses")) throw new Error("Unexpected provider endpoint");
  const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
  if (!/^gpt-5[.]6-(?:terra|sol)(?:-\d{4}-\d{2}-\d{2})?$/.test(String(body.model))) throw new ApiRequestError("This model does not have a verified spending allowance.", 503, "unpriced_model");
  body.max_tool_calls = Math.min(Number(body.max_tool_calls) || 5, 5);
  const serialized = JSON.stringify(body.input ?? [], (_key, value) => typeof value === "string" && value.startsWith("data:image/") ? "[image input]" : value);
  if (serialized.length > 200_000) throw new ApiRequestError("Source input is too large for one AI request. Split it into smaller sources.", 413, "provider_input_too_large");
  body.max_output_tokens = Math.min(Number(body.max_output_tokens) || 8192, 8192);
  // Conservative uncached allowance, including image input and reasoning/output tokens.
  const costCents = Math.ceil(Buffer.byteLength(serialized) * 0.0005 + body.max_output_tokens * 0.003) + (body.tools?.length ? 30 : 5);
  const context = actionContext.getStore();
  await reserveProviderAttempt({ scope: `openai:${body.model}`, key: `${context?.scope}:${context?.key ?? context?.videoId ?? context?.sourceId ?? "request"}:${fingerprint(body)}`,
    costCents, videoId: context?.videoId, sourceId: context?.sourceId });
  return fetch(url, { ...init, body: JSON.stringify(body), signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
}
