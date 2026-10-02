import { NextResponse } from "next/server";

import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/videos/[id]/manifest">) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;
  if (!job?.renderManifest) {
    return NextResponse.json({ error: "Manifest not found" }, { status: 404 });
  }
  return NextResponse.json(job.renderManifest);
}
