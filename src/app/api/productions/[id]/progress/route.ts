import { NextResponse } from "next/server";

import { apiErrorResponse } from "@/lib/server/api-error";
import { getProductionProgress } from "@/lib/server/production-progress";
import { authorizeVideoRequest } from "@/lib/server/videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const snapshot = await getProductionProgress(id);
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, error instanceof Error ? error.message : "Production progress could not be loaded.");
  }
}
