import { NextResponse } from "next/server";

import { dollars } from "@/lib/cost";
import { promoteFinalRenderToLibrary } from "@/lib/server/library-vault";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/videos/[id]">) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;

  if (job.finalVideoUrl) {
    await promoteFinalRenderToLibrary(job);
  }

  return NextResponse.json({
    videoId: job.id,
    currentPhase: job.currentPhase,
    state: job.status,
    estimatedCostUsd: dollars(job.estimatedCostCents),
    actualCostUsd: dollars(job.actualCostCents),
    artifacts: {
      treatment: job.creativeBrief ? `/api/videos/${job.id}/artifacts/treatment` : undefined,
      musicPlan: job.musicPlan ? `/api/videos/${job.id}/artifacts/music-plan` : undefined,
      music: job.musicTrack?.url,
      anchors: job.anchorAssets[0]?.url,
      shotPlan: job.shotPlan ? `/api/videos/${job.id}/artifacts/shot-plan` : undefined,
      final: job.finalVideoUrl,
    },
    error: job.error,
    job,
  });
}
