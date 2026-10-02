import { NextResponse } from "next/server";

import { fetchBlobUrl } from "@/lib/server/blob";
import { promoteFinalRenderToLibrary } from "@/lib/server/library-vault";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(request: Request, context: RouteContext<"/api/videos/[id]/download">) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const { job } = auth;

  if (!job.finalVideoUrl) {
    return NextResponse.json({ error: "Final video is not ready yet" }, { status: 409 });
  }

  await promoteFinalRenderToLibrary(job);

  const upstream = await fetchBlobUrl(job.finalVideoUrl);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: "Final video could not be downloaded" }, { status: 502 });
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("content-type") ?? "video/mp4");
  headers.set("Content-Disposition", `attachment; filename="${downloadFileName(id)}"`);
  headers.set("Cache-Control", "no-store");

  const contentLength = upstream.headers.get("content-length");
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(upstream.body, { headers });
}

function downloadFileName(videoId: string) {
  return `cocoa-director-${videoId.slice(0, 8)}.mp4`;
}
