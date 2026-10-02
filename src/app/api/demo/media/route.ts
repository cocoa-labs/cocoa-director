import { getUserContext } from "@/lib/server/auth";
import { apiErrorResponse } from "@/lib/server/api-error";
import { demoMedia } from "@/lib/server/demo-media";
export const runtime = "nodejs";
export const maxDuration = 180;

export async function GET(request: Request) {
  try {
    await getUserContext(request);
    const { body, contentType } = await demoMedia(request.url);
    const headers = new Headers({ "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, body.length - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(body.length - 1, Number(match[2])) : body.length - 1;
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= body.length) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${body.length}` } });
      }
      headers.set("Content-Range", `bytes ${start}-${end}/${body.length}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(new Uint8Array(body.subarray(start, end + 1)), { status: 206, headers });
    }
    headers.set("Content-Length", String(body.length));
    return new Response(new Uint8Array(body), { headers });
  } catch (error) { return apiErrorResponse(error, "Demo media could not be prepared."); }
}
