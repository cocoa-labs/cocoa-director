import { authorizeUpload } from "@/lib/server/upload-callback";
import { ApiRequestError } from "@/lib/server/api-error";
import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

import { apiErrorResponse } from "@/lib/server/api-error";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { addPdfProductionSource, NEWS_PDF_SIZE_LIMIT } from "@/lib/server/production-sources";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ clientUpload: Boolean(process.env.PRIVATE_BLOB_READ_WRITE_TOKEN) });
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await request.json() as HandleUploadBody;
      if (!body || body.type !== "blob.generate-client-token") throw new ApiRequestError("Use the signed callback endpoint.", 400, "invalid_upload_request");
      const auth = await authorizeProjectRequest(request, projectId);
      if (auth?.response) return auth.response;
      const response = await handleUpload({
        request,
        body,
        token: process.env.PRIVATE_BLOB_READ_WRITE_TOKEN,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (!auth?.user) throw new ApiRequestError("Unauthenticated source upload.", 401, "unauthenticated");
          const parsed = parseClientPayload(clientPayload);
          if (parsed.projectId !== projectId) throw new ApiRequestError("Invalid source upload project.", 400, "invalid_upload_request");
          return {
            allowedContentTypes: ["application/pdf"],
            maximumSizeInBytes: NEWS_PDF_SIZE_LIMIT,
            ...await authorizeUpload({ projectId, userId: auth.user.id, kind: "sources", pathname, payload: { originalName: parsed.originalName } }, request),
          };
        },
        onUploadCompleted: async () => { throw new Error("Unexpected completion callback"); },
      });
      return NextResponse.json(response);
    }
    const auth = await authorizeProjectRequest(request, projectId);
    if (auth.response) return auth.response;
    const formData = await request.formData();
    const files = [...formData.getAll("files"), ...formData.getAll("file")]
      .filter((value): value is File => value instanceof File);
    if (files.length === 0) return NextResponse.json({ error: "Select at least one PDF." }, { status: 400 });
    const sources = [];
    for (const file of files) {
      sources.push(await addPdfProductionSource({ projectId, file, user: auth.user }));
    }
    return NextResponse.json({ sources }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    return apiErrorResponse(error, "PDF upload failed");
  }
}

function parseClientPayload(value: string | null | undefined) {
  const parsed = value ? JSON.parse(value) as Record<string, unknown> : {};
  if (!parsed || typeof parsed.projectId !== "string" || typeof parsed.originalName !== "string") throw new ApiRequestError("Invalid PDF upload payload.", 400, "invalid_upload_request");
  return { projectId: parsed.projectId, originalName: parsed.originalName.slice(0, 240) };
}
