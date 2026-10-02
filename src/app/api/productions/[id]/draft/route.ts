import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { z } from "zod";

import { HybridVisualPlanV2, NewsStoryboard, SourceClaim, VisualStylePreset } from "@/lib/schemas";
import { apiErrorResponse } from "@/lib/server/api-error";
import { updateNewsDraft } from "@/lib/server/news-editorial";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

const DraftUpdate = z.object({
  script: z.string().trim().min(1).max(50_000).optional(),
  claims: z.array(SourceClaim).max(1_000).optional(),
  storyboard: NewsStoryboard.optional(),
  visualPlan: HybridVisualPlanV2.optional(),
  visualStylePreset: VisualStylePreset.optional(),
}).refine((value) => value.script !== undefined || value.claims !== undefined || value.storyboard !== undefined || value.visualPlan !== undefined || value.visualStylePreset !== undefined, "Supply a draft field to update");

async function handlePATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const job = await updateNewsDraft({ job: auth.job, ...DraftUpdate.parse(await request.json()) });
    return NextResponse.json({ productionId: job.id, job, invalidated: ["approvals", "narration", "generation", "timeline", "render"] });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, error instanceof Error ? error.message : "Draft update failed");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionRequest(request, () => handlePATCH(request, context));
}
