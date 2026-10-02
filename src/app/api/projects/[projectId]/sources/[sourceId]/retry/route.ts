import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/server/api-error";
import { getUserContext } from "@/lib/server/auth";
import { retryProductionSource } from "@/lib/server/production-sources";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    const user = await getUserContext(request);
    const { projectId, sourceId } = await context.params;
    return NextResponse.json({ source: await retryProductionSource(sourceId, projectId, user) });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Source retry failed";
    if (message.includes("not found")) return NextResponse.json({ error: message }, { status: 404 });
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
