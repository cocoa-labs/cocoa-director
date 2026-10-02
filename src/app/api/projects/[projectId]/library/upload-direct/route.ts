import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { LibraryAssetCreateRequest, MediaKind } from "@/lib/schemas";
import { apiErrorResponse } from "@/lib/server/api-error";
import { getUserContext } from "@/lib/server/auth";
import { uploadPublicBlob } from "@/lib/server/blob";
import {
  allowedContentTypesForKind,
  mimeTypeForKind,
  slugFilename,
  uploadLimitForKind,
} from "@/lib/server/library-upload";
import { createLibraryAssetForProject } from "@/lib/server/media-sessions";
import { getStore } from "@/lib/server/store";
import { validateUploadBytes } from "@/lib/server/upload-validation";

export const runtime = "nodejs";

/**
 * Server-side ("direct") upload that writes through uploadPublicBlob — which falls back to
 * local /dev-blob/ files when BLOB_READ_WRITE_TOKEN is absent. The client uses this only when
 * the Vercel Blob client-upload flow can't mint a token (i.e. local dev without a Blob token);
 * in production the client-upload path is used, so large files still bypass the body limit.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/projects/[projectId]/library/upload-direct">,
) {
  try {
    const user = await getUserContext(request);
    const { projectId } = await context.params;
    const project = await getStore().getProject(projectId);
    if (!project || project.userId !== user.id) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing upload file." }, { status: 400 });
    }

    const kind = MediaKind.parse(stringField(form, "kind"));
    const role = stringField(form, "role")?.trim() || "reference";
    const name = (stringField(form, "name")?.trim() || file.name || `${kind} upload`).slice(0, 160);
    const tags = parseTags(stringField(form, "tags"));

    const contentType = file.type || mimeTypeForKind(kind);
    if (!allowedContentTypesForKind(kind).includes(contentType)) {
      return NextResponse.json({ error: `Unsupported ${kind} type: ${contentType}` }, { status: 415 });
    }
    if (file.size > uploadLimitForKind(kind)) {
      return NextResponse.json({ error: `That file is larger than the ${kind} upload limit.` }, { status: 413 });
    }

    const body = Buffer.from(await file.arrayBuffer());
    const validation = validateUploadBytes(body.subarray(0, 64), kind, contentType);

    const blob = await uploadPublicBlob({
      pathname: `library/${user.id}/${randomUUID()}-${slugFilename(name)}`,
      body,
      contentType: validation.mime || contentType,
    });

    const result = await createLibraryAssetForProject(
      projectId,
      user.id,
      LibraryAssetCreateRequest.parse({
        kind,
        name,
        role,
        url: blob.url,
        mimeType: validation.mime || contentType,
        source: "upload",
        tags,
        metadata: { pathname: blob.pathname },
        pinToProject: true,
      }),
    );

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload failed";
    console.error("POST /api/projects/[projectId]/library/upload-direct failed", error);
    return apiErrorResponse(error, message);
  }
}

function stringField(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}
