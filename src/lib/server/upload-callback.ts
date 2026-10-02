import { randomUUID } from "node:crypto";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { z } from "zod";
import { LibraryAssetCreateRequest } from "@/lib/schemas";
import { ApiRequestError, apiErrorResponse } from "@/lib/server/api-error";
import { criticalSection } from "@/lib/server/critical-section";
import { ensureDatabaseSchema, getSql, hasDatabase } from "@/lib/server/db";
import { getStore } from "@/lib/server/store";
import { storagePath } from "@/lib/server/storage-path";
import { createLibraryAssetForProject } from "@/lib/server/media-sessions";
import { registerPrivatePdfBlob, startSourceProcessing } from "@/lib/server/production-sources";
import { readPrivateSource } from "@/lib/server/source-blob";
import { validateRemoteUpload } from "@/lib/server/upload-validation";

const Authorization = z.object({
  id: z.uuid(), userId: z.string().min(1), projectId: z.uuid(), kind: z.enum(["library", "sources"]),
  pathname: z.string().min(1).max(512), payload: z.record(z.string(), z.unknown()), completedUrl: z.string().optional(),
});
type Authorization = z.infer<typeof Authorization>;
const records = new WeakMap<object, Map<string, Authorization>>();
function memory() {
  const store = getStore();
  let map = records.get(store);
  if (!map) { map = new Map(); records.set(store, map); }
  return map;
}
async function save(record: Authorization) {
  if (!hasDatabase()) { memory().set(record.id, structuredClone(record)); return; }
  await ensureDatabaseSchema();
  await getSql()`insert into upload_authorizations(id, user_id, project_id, kind, pathname, payload, completed_url)
    values (${record.id}, ${record.userId}, ${record.projectId}, ${record.kind}, ${record.pathname}, ${JSON.stringify(record.payload)}::jsonb, ${record.completedUrl ?? null})
    on conflict (id) do update set completed_url = excluded.completed_url`;
}
async function read(id: string): Promise<Authorization | undefined> {
  if (!hasDatabase()) return memory().get(id);
  await ensureDatabaseSchema();
  const [row] = await getSql()`select * from upload_authorizations where id = ${id}`;
  return row ? Authorization.parse({ id: row.id, userId: row.user_id, projectId: row.project_id, kind: row.kind,
    pathname: row.pathname, payload: row.payload, completedUrl: row.completed_url ?? undefined }) : undefined;
}

export async function authorizeUpload(input: Omit<Authorization, "id" | "completedUrl">, request: Request) {
  storagePath("/upload", input.pathname);
  const record = Authorization.parse({ ...input, id: randomUUID() });
  await save(record);
  const origin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : new URL(request.url).origin;
  return { tokenPayload: JSON.stringify({ uploadId: record.id }), callbackUrl: `${origin}/api/uploads/${record.kind}/completed`,
    validUntil: Date.now() + 15 * 60_000, allowOverwrite: false as const, addRandomSuffix: true as const };
}

/** Only called by handleUpload after the Blob SDK verifies the callback signature. */
export async function completeAuthorizedUpload(kind: Authorization["kind"], blob: { url: string; pathname: string; contentType: string }, tokenPayload: string | null | undefined) {
  const { uploadId } = z.object({ uploadId: z.uuid() }).parse(JSON.parse(tokenPayload ?? "null"));
  const authorization = await read(uploadId);
  if (!authorization || authorization.kind !== kind) throw new ApiRequestError("Unknown upload.", 400, "invalid_upload");
  const project = await getStore().getProject(authorization.projectId);
  if (!project || project.userId !== authorization.userId) throw new ApiRequestError("Project not found.", 404, "project_not_found");
  // Random suffixes are inserted before the extension by Blob. Keep the authorized directory and basename.
  const escaped = authorization.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dot = escaped.lastIndexOf("\\.");
  const pattern = dot >= 0 ? `${escaped.slice(0, dot)}-[A-Za-z0-9]+${escaped.slice(dot)}` : `${escaped}-[A-Za-z0-9]+`;
  if (!new RegExp(`^${pattern}$`).test(blob.pathname)) throw new ApiRequestError("Upload path does not match its authorization.", 400, "invalid_upload_path");
  const url = new URL(blob.url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".blob.vercel-storage.com")) throw new ApiRequestError("Invalid upload origin.", 400, "invalid_upload_origin");
  if (authorization.completedUrl) {
    if (authorization.completedUrl !== blob.url) throw new ApiRequestError("Upload already completed.", 409, "upload_conflict");
    return;
  }
  const library = kind === "library" ? LibraryAssetCreateRequest.parse({ ...authorization.payload, url: blob.url, source: "upload", pinToProject: true }) : undefined;
  const verifiedBody = kind === "sources" ? await readPrivateSource(blob.url) : undefined;
  if (library) await validateRemoteUpload(blob.url, library.kind, blob.contentType);
  let sourceId: string | undefined;
  await criticalSection(`upload:${uploadId}`, async () => {
    const current = await read(uploadId);
    if (current?.completedUrl) {
      if (current.completedUrl !== blob.url) throw new ApiRequestError("Upload already completed.", 409, "upload_conflict");
      return;
    }
    if (library) await createLibraryAssetForProject(authorization.projectId, authorization.userId,
      { ...library, mimeType: blob.contentType, metadata: { pathname: blob.pathname } }, uploadId);
    else {
      const source = await registerPrivatePdfBlob({ projectId: authorization.projectId, userId: authorization.userId, sourceId: uploadId,
        url: blob.url, originalName: String(authorization.payload.originalName), contentType: "application/pdf", verifiedBody, deferProcessing: true });
      sourceId = source.processingState === "pending" ? source.id : undefined;
    }
    await save({ ...authorization, completedUrl: blob.url });
  });
  if (sourceId) {
    try { await startSourceProcessing(sourceId); }
    catch { await getStore().updateProductionSource(sourceId, { processingState: "failed", error: "Processing could not start. Retry this source." }); }
  }
}

export async function uploadCompletion(request: Request, kind: Authorization["kind"]) {
  try {
    const body = await request.json() as HandleUploadBody;
    if (!body || body.type !== "blob.upload-completed") throw new ApiRequestError("Invalid callback.", 400, "invalid_callback");
    if (!/^[a-f0-9]{64}$/i.test(request.headers.get("x-vercel-signature") ?? "")) throw new ApiRequestError("Invalid callback signature.", 401, "invalid_callback_signature");
    const response = await handleUpload({ request, body,
      token: kind === "library" ? process.env.BLOB_READ_WRITE_TOKEN : process.env.PRIVATE_BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async () => { throw new ApiRequestError("Token issuance requires authentication.", 401, "unauthenticated"); },
      onUploadCompleted: ({ blob, tokenPayload }) => completeAuthorizedUpload(kind, blob, tokenPayload),
    });
    return Response.json(response);
  } catch (error) {
    if (error instanceof Error && /callback signature/.test(error.message)) return Response.json({ error: "Invalid callback signature.", code: "invalid_callback_signature" }, { status: 401 });
    return apiErrorResponse(error, "Upload callback failed.");
  }
}
