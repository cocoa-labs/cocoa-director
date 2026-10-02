import { NextResponse } from "next/server";

import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: RouteContext<"/api/videos/[id]/artifacts/[phase]">,
) {
  const { id, phase } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;

  const artifacts: Record<string, unknown> = {
    treatment: job.creativeBrief,
    "music-plan": job.musicPlan,
    music: job.musicTrack,
    "beat-grid": job.beatGrid,
    anchors: job.anchorAssets,
    "shot-plan": job.shotPlan,
    shots: job.generatedShots,
    manifest: job.renderManifest,
  };

  const artifact = artifacts[phase];
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  return NextResponse.json(artifact);
}
