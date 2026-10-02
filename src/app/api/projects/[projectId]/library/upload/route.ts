import { authorizeUpload } from "@/lib/server/upload-callback";
import { ApiRequestError } from "@/lib/server/api-error";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { getUserContext } from "@/lib/server/auth";
import { requireEnv } from "@/lib/server/config";
import {
  allowedContentTypesForKind,
  parseUploadPayload,
  uploadLimitForKind,
} from "@/lib/server/library-upload";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: Request, context: RouteContext<"/api/projects/[projectId]/library/upload">) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const body = (await request.json()) as HandleUploadBody;
    if (!body || body.type !== "blob.generate-client-token") throw new ApiRequestError("Use the signed callback endpoint.", 400, "invalid_upload_request");
    const response = await handleUpload({
      request,
      body,
      token: requireEnv("BLOB_READ_WRITE_TOKEN"),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = parseUploadPayload(clientPayload);
        if (!payload || payload.projectId !== projectId) {
          throw new Error("Invalid upload request");
        }
        return {
          allowedContentTypes: allowedContentTypesForKind(payload.kind),
          maximumSizeInBytes: uploadLimitForKind(payload.kind),
          ...await authorizeUpload({ userId: user.id, projectId, kind: "library", pathname,
            payload: { ...payload, name: payload.name || "Uploaded media", mimeType: "application/octet-stream" } }, request),
        };
      },
      onUploadCompleted: async () => { throw new Error("Unexpected completion callback"); },
    });
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    console.error("POST /api/projects/[projectId]/library/upload failed", error);
    return apiErrorResponse(error, message);
  }
}
