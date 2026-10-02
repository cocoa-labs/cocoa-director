import { NextResponse } from "next/server";

import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;
  if (!job.timelineManifest) {
    return NextResponse.json({ error: "Timeline manifest not found" }, { status: 404 });
  }
  return NextResponse.json({
    timeline: job.timelineManifest,
    qaReport: job.qaReport,
    sources: job.sourceBundle,
  });
}
