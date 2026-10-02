import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/server/api-error";
import { fitProductionEditorialDraft } from "@/lib/server/productions";
import { withJobContext } from "@/lib/server/provider-execution";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    if (!idempotencyKeyFromRequest(request)) return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    const job = await withJobContext(id, () => fitProductionEditorialDraft(auth.job, auth.user));
    const recordingRetained = job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId === auth.job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId;
    return NextResponse.json({
      productionId: job.id,
      job,
      fitted: true,
      recordingRetained,
      invalidated: recordingRetained ? [] : ["approvals", "storyboard", "narration", "generation", "timeline", "render"],
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, error instanceof Error ? error.message : "Editorial fit failed");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
