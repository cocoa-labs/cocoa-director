import { NextResponse } from "next/server";

import { dollars } from "@/lib/cost";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;
  return NextResponse.json({
    productionId: job.id,
    contentType: job.contentType ?? "music_video",
    workflowVersion: job.workflowVersion ?? "music-video-v1",
    state: job.status,
    currentPhase: job.currentPhase,
    workflowSteps: job.workflowSteps ?? [],
    estimatedCostUsd: dollars(job.estimatedCostCents),
    actualCostUsd: dollars(job.actualCostCents),
    timeline: job.timelineManifest,
    sources: job.sourceBundle,
    script: job.script,
    editorialPlan: job.editorialPlan,
    storyboard: job.storyboard,
    visualPlan: job.visualPlan,
    visualStylePreset: job.visualStylePreset ?? "auto",
    approvals: job.approvals ?? [],
    artifactVersions: job.artifactVersions,
    delivery: {
      videoUrl: job.finalVideoUrl,
      thumbnailUrl: job.thumbnailUrl,
      urls: job.artifactVersions.filter((version) => version.scope === "render").at(-1)?.urls ?? {},
    },
    qaReport: job.qaReport,
    error: job.error,
    job,
  });
}
