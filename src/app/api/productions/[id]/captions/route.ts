import { timelineToSrt, timelineToVtt } from "@/lib/captions";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const timeline = auth.job.timelineManifest;
  if (!timeline) return Response.json({ error: "Timeline manifest not found" }, { status: 404 });

  const format = new URL(request.url).searchParams.get("format")?.toLowerCase() ?? "vtt";
  if (format !== "vtt" && format !== "srt") {
    return Response.json({ error: "Caption format must be vtt or srt" }, { status: 400 });
  }
  const body = format === "srt" ? timelineToSrt(timeline) : timelineToVtt(timeline);
  return new Response(body, {
    headers: {
      "Content-Type": format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
      "Content-Disposition": `attachment; filename="cocoa-${id}.${format}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
