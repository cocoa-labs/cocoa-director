import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { z } from "zod";

import { ApiRequestError, apiErrorResponse } from "@/lib/server/api-error";
import { approveNewsGate, assertDurationProposal, assertEditorialStoryboardReady } from "@/lib/server/news-editorial";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { assertVideoActionAllowed, spendGuardResponse } from "@/lib/server/video-action-guard";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

const ApprovalRequest = z.object({
  gate: z.enum(["script", "storyboard"]),
  artifactVersionId: z.string().uuid(),
  confirmSpend: z.boolean().optional(),
  acceptedDurationSeconds: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const body = ApprovalRequest.parse(await request.json());
    const alreadyApproved = auth.job.approvals?.some((approval) => approval.gate === body.gate && approval.artifactVersionId === body.artifactVersionId);
    if (body.gate === "storyboard" && !alreadyApproved) {
      assertDurationProposal(auth.job, body.acceptedDurationSeconds);
      if (!body.confirmSpend) throw new ApiRequestError("Spend confirmation is required before narration and asset generation.", 409, "spend_confirmation_required");
      const currentVersion = auth.job.workflowSteps?.find((step) => step.id === "storyboard")?.artifactVersionId;
      if (currentVersion !== body.artifactVersionId) throw new ApiRequestError("This storyboard approval is stale. Review the latest version before approving.", 409, "stale_approval");
      const scriptVersion = auth.job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId;
      if (!scriptVersion || !auth.job.approvals?.some((approval) => approval.gate === "script" && approval.artifactVersionId === scriptVersion)) throw new ApiRequestError("Approve the current cited script before approving the storyboard.", 409, "current_approval_required");
      if (auth.job.cancellationRequested || auth.job.status === "cancelled") throw new ApiRequestError("Production cancelled.", 409, "production_cancelled");
      assertEditorialStoryboardReady(auth.job);
      const idempotencyKey = idempotencyKeyFromRequest(request, body);
      if (!idempotencyKey) return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
      const guard = await assertVideoActionAllowed({
        action: "approve_editorial_storyboard_and_generate",
        estimatedCostCents: auth.job.estimatedCostCents + auth.job.recoveryBudgetCents,
        allowanceMode: "remaining",
        idempotencyKey,
        job: auth.job,
        metadata: {
          artifactVersionId: body.artifactVersionId,
          contentType: auth.job.contentType,
          baseEstimateCents: auth.job.estimatedCostCents,
          recoveryReserveCents: auth.job.recoveryBudgetCents,
          maximumAuthorizedCents: auth.job.estimatedCostCents + auth.job.recoveryBudgetCents,
        },
        user: auth.user,
      });
      if (guard.replayed) return NextResponse.json({ productionId: auth.job.id, approvals: auth.job.approvals ?? [], workflowSteps: auth.job.workflowSteps ?? [], state: auth.job.status, replayed: true });
    }
    const job = await approveNewsGate({ job: auth.job, user: auth.user, ...body });
    return NextResponse.json({ productionId: job.id, approvals: job.approvals ?? [], workflowSteps: job.workflowSteps ?? [], state: job.status });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    const message = error instanceof Error ? error.message : "Approval failed";
    if (/stale|Approve|Unsupported|uncited|two independent|Spend confirmation|only available/i.test(message)) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
