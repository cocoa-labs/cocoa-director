import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { privateSourceResponse } from "@/lib/server/source-blob";
import { requireOwnedSource } from "@/lib/server/production-sources";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    const user = await getUserContext(request);
    const { projectId, sourceId } = await context.params;
    const source = await requireOwnedSource(sourceId, projectId, user);
    if (!source.blobUrl) return NextResponse.json({ error: "This source does not contain a downloadable file." }, { status: 404 });
    return privateSourceResponse(source.blobUrl, source.originalName ?? `${source.title}.pdf`, source.mimeType ?? "application/pdf");
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : "Source download failed";
    if (message === "Source not found." || message === "Project not found.") return NextResponse.json({ error: message, code: "source_not_found" }, { status: 404 });
    return apiErrorResponse(error, "Source download failed");
  }
}
