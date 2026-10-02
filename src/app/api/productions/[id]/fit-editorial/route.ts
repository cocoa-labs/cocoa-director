import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/server/api-error";
import { fitProductionEditorialDraft } from "@/lib/server/productions";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const job = await fitProductionEditorialDraft(auth.job, auth.user);
    return NextResponse.json({
      productionId: job.id,
      job,
      fitted: true,
      invalidated: ["approvals", "storyboard", "narration", "generation", "timeline", "render"],
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, error instanceof Error ? error.message : "Editorial fit failed");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
