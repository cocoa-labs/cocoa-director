import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { z } from "zod";
import { DurationMode } from "@/lib/schemas";

import { ApiRequestError, apiErrorResponse } from "@/lib/server/api-error";
import { regenerateNewsEditorialDraft } from "@/lib/server/productions";
import { authorizeVideoRequest } from "@/lib/server/videos";
import { assertVideoActionAllowed, spendGuardResponse } from "@/lib/server/video-action-guard";
import { SpendGuardError } from "@/lib/server/spend-guard";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const raw = await request.text();
    const policy = z.object({ durationMode: DurationMode.optional(), targetDurationSeconds: z.number().int().min(15).max(600).optional(), preserveScript: z.boolean().optional(), excludedClaimIds: z.array(z.string().min(1)).max(500).optional() }).parse(raw ? JSON.parse(raw) : {});
    if (auth.job.status === "running" || auth.job.cancellationRequested) throw new ApiRequestError("Wait for the current run before changing this draft.", 409, "production_not_editable");
    if (!["explainer", "news_digest"].includes(auth.job.contentType ?? "")) throw new ApiRequestError("Duration revisions are available for editorial productions.", 409, "editorial_required");
    if (Object.keys(policy).length > 0 && !request.headers.get("idempotency-key")) throw new ApiRequestError("An Idempotency-Key is required for a duration or scope revision.", 400, "idempotency_key_required");
    if (policy.preserveScript && policy.excludedClaimIds !== undefined) throw new ApiRequestError("Changing source coverage requires replanning the script. Remove preserveScript for a scope revision.", 400, "scope_requires_replan");
    if (!policy.preserveScript) await assertVideoActionAllowed({ action: "regenerate_editorial_outline", job: auth.job, user: auth.user, estimatedCostCents: 200, allowanceMode: "remaining", idempotencyKey: request.headers.get("idempotency-key") ?? undefined });
    const job = await regenerateNewsEditorialDraft(auth.job, auth.user, policy);
    return NextResponse.json({ productionId: job.id, job });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    return apiErrorResponse(error, error instanceof Error ? error.message : "Editorial regeneration failed");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
