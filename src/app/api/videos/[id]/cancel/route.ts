import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: RouteContext<"/api/videos/[id]/cancel">) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const { cancelVideo } = await import("@/workflow");
    const job = await cancelVideo(id);
    return NextResponse.json({ videoId: job.id, state: job.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cancel failed";
    console.error("POST /api/videos/[id]/cancel failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/videos/[id]/cancel">) {
  return actionRequest(request, () => handlePOST(request, context));
}
