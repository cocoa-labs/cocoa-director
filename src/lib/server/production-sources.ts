import { createHash, randomUUID } from "node:crypto";

import type { ProductionSource } from "@/lib/schemas";
import type { UserContext } from "@/lib/server/auth";
import { getProviderMode } from "@/lib/server/config";
import { deletePrivateSource, readPrivateSource, uploadPrivateSource } from "@/lib/server/source-blob";
import { canonicalSourceUrl, processProductionSource } from "@/lib/server/source-processing";
import { getStore } from "@/lib/server/store";
import { ApiRequestError } from "@/lib/server/api-error";

export const NEWS_SOURCE_LIMIT = 25;
export const NEWS_PDF_SIZE_LIMIT = 50 * 1024 * 1024;
export const NEWS_PDF_TOTAL_LIMIT = 200 * 1024 * 1024;
export const NEWS_SOURCE_TEXT_LIMIT = 200_000;
export const NEWS_SOURCE_STALE_MS = 2 * 60 * 1_000;

export async function listOwnedProductionSources(projectId: string, user: UserContext) {
  await requireOwnedProject(projectId, user);
  return reconcileStaleProductionSources(projectId);
}

export async function reconcileStaleProductionSources(
  projectId: string,
  options: { nowMs?: number; staleMs?: number } = {},
) {
  const store = getStore();
  const sources = await store.listProductionSources(projectId);
  const nowMs = options.nowMs ?? Date.now();
  const staleMs = options.staleMs ?? NEWS_SOURCE_STALE_MS;
  const stale = sources.filter((source) =>
    (source.processingState === "pending" || source.processingState === "processing")
    && nowMs - Date.parse(source.updatedAt) >= staleMs,
  );
  if (stale.length === 0) return sources;
  const replacements = new Map((await Promise.all(stale.map(async (source) => {
    const updated = await store.updateProductionSource(source.id, {
      processingState: "failed",
      error: "Source extraction stopped before completion. Retry it, paste the text, use it as a web-research lead, or remove it from this draft.",
    });
    console.error(JSON.stringify({ event: "news_source_processing_stale", sourceId: source.id, previousState: source.processingState, updatedAt: source.updatedAt }));
    return [source.id, updated] as const;
  }))).map((entry) => entry));
  return sources.map((source) => replacements.get(source.id) ?? source);
}

export async function addTextProductionSource(input: {
  projectId: string;
  title: string;
  text: string;
  user: UserContext;
}) {
  await assertSourceCapacity(input.projectId, input.user);
  const text = normalizeSourceText(input.text);
  if (!text) throw new ApiRequestError("Text source is empty.", 400, "empty_source");
  if (text.length > NEWS_SOURCE_TEXT_LIMIT) throw new ApiRequestError("Text sources are limited to 200,000 characters.", 413, "source_too_large");
  const hash = sha256(text);
  const duplicate = await findDuplicate(input.projectId, hash);
  if (duplicate) return duplicate;
  const store = getStore();
  const source = await store.createProductionSource({
    projectId: input.projectId,
    userId: input.user.id,
    kind: "text",
    title: input.title.trim() || "Pasted text",
    sha256: hash,
    byteSize: Buffer.byteLength(text),
    suppliedAt: new Date().toISOString(),
    rights: "user_authorized",
    processingState: "ready",
    extractionVersion: "source-v3-intelligent",
    warnings: [],
  });
  await store.replaceSourceFragments(source.id, [{
    sourceId: source.id,
    ordinal: 0,
    section: source.title,
    text,
    textHash: hash,
    extractionMethod: "plain_text",
  }]);
  return source;
}

export async function addUrlProductionSource(input: {
  projectId: string;
  title?: string;
  url: string;
  user: UserContext;
}) {
  await assertSourceCapacity(input.projectId, input.user);
  const canonicalUrl = canonicalSourceUrl(input.url);
  const existing = (await getStore().listProductionSources(input.projectId)).find(
    (source) => source.canonicalUrl === canonicalUrl || source.url === canonicalUrl,
  );
  if (existing) return existing;
  const source = await getStore().createProductionSource({
    projectId: input.projectId,
    userId: input.user.id,
    kind: "url",
    title: (input.title?.trim() || canonicalUrl).slice(0, 200),
    url: canonicalUrl,
    canonicalUrl,
    suppliedAt: new Date().toISOString(),
    rights: "evidence_only",
    processingState: "pending",
    extractionVersion: "source-v3-intelligent",
    warnings: [],
  });
  await startSourceProcessing(source.id);
  return getStore().getProductionSource(source.id) as Promise<ProductionSource>;
}

export async function addPdfProductionSource(input: {
  projectId: string;
  file: File;
  user: UserContext;
}) {
  await assertSourceCapacity(input.projectId, input.user);
  if (input.file.size > NEWS_PDF_SIZE_LIMIT) throw new ApiRequestError("PDFs are limited to 50 MB each.", 413, "source_too_large");
  if (input.file.type && input.file.type !== "application/pdf") throw new ApiRequestError("Only PDF uploads are supported.", 415, "invalid_upload_type");
  const existingSources = await getStore().listProductionSources(input.projectId);
  const currentBytes = existingSources
    .filter((source) => source.kind === "document")
    .reduce((sum, source) => sum + (source.byteSize ?? 0), 0);
  if (currentBytes + input.file.size > NEWS_PDF_TOTAL_LIMIT) {
    throw new ApiRequestError("This project exceeds the 200 MB total PDF source limit.", 413, "source_storage_limit");
  }
  const body = Buffer.from(await input.file.arrayBuffer());
  if (body.subarray(0, 5).toString("ascii") !== "%PDF-") throw new ApiRequestError("Uploaded file is not a valid PDF.", 415, "invalid_upload_type");
  const hash = sha256(body);
  const duplicate = await findDuplicate(input.projectId, hash);
  if (duplicate) return duplicate;
  const sourceId = randomUUID();
  const stored = await uploadPrivateSource({
    pathname: `news-sources/${input.user.id}/${input.projectId}/${sourceId}.pdf`,
    body,
    contentType: "application/pdf",
  });
  try {
    const source = await getStore().createProductionSource({
      id: sourceId,
      projectId: input.projectId,
      userId: input.user.id,
      kind: "document",
      title: input.file.name.replace(/\.pdf$/i, "").slice(0, 200) || "Uploaded PDF",
      originalName: input.file.name.slice(0, 240),
      blobUrl: stored.url,
      mimeType: "application/pdf",
      byteSize: body.length,
      sha256: hash,
      suppliedAt: new Date().toISOString(),
      rights: "user_authorized",
      processingState: "pending",
      extractionVersion: "source-v3-intelligent",
      warnings: [],
    });
    await startSourceProcessing(source.id);
    return getStore().getProductionSource(source.id) as Promise<ProductionSource>;
  } catch (error) {
    await deletePrivateSource(stored.url);
    throw error;
  }
}

export async function registerPrivatePdfBlob(input: {
  projectId: string;
  userId: string;
  sourceId: string;
  url: string;
  originalName: string;
  contentType?: string;
  byteSize?: number;
  verifiedBody?: Buffer;
  deferProcessing?: boolean;
}) {
  const project = await getStore().getProject(input.projectId);
  if (!project || project.userId !== input.userId) throw new ApiRequestError("Project not found.", 404, "project_not_found");
  const prior = await getStore().getProductionSource(input.sourceId);
  if (prior) {
    if (prior.userId !== input.userId || prior.projectId !== input.projectId || prior.blobUrl !== input.url) throw new ApiRequestError("Source upload conflict.", 409, "upload_conflict");
    return prior;
  }
  const body = input.verifiedBody ?? await readPrivateSource(input.url);
  if (body.length > NEWS_PDF_SIZE_LIMIT || (input.byteSize && input.byteSize > NEWS_PDF_SIZE_LIMIT)) {
    await deletePrivateSource(input.url);
    throw new ApiRequestError("PDFs are limited to 50 MB each.", 413, "source_too_large");
  }
  if (body.subarray(0, 5).toString("ascii") !== "%PDF-") {
    await deletePrivateSource(input.url);
    throw new ApiRequestError("Uploaded file is not a valid PDF.", 415, "invalid_upload_type");
  }
  const existing = await getStore().listProductionSources(input.projectId);
  if (existing.length >= NEWS_SOURCE_LIMIT) {
    await deletePrivateSource(input.url);
    throw new ApiRequestError(`A production can contain up to ${NEWS_SOURCE_LIMIT} sources.`, 409, "source_count_limit");
  }
  const totalBytes = existing.filter((source) => source.kind === "document").reduce((sum, source) => sum + (source.byteSize ?? 0), 0);
  if (totalBytes + body.length > NEWS_PDF_TOTAL_LIMIT) {
    await deletePrivateSource(input.url);
    throw new ApiRequestError("This project exceeds the 200 MB total PDF source limit.", 413, "source_storage_limit");
  }
  const hash = sha256(body);
  const duplicate = existing.find((source) => source.sha256 === hash);
  if (duplicate) { await deletePrivateSource(input.url); return duplicate; }
  const source = await getStore().createProductionSource({
    id: input.sourceId,
    projectId: input.projectId,
    userId: input.userId,
    kind: "document",
    title: input.originalName.replace(/\.pdf$/i, "").slice(0, 200) || "Uploaded PDF",
    originalName: input.originalName.slice(0, 240),
    blobUrl: input.url,
    mimeType: input.contentType ?? "application/pdf",
    byteSize: body.length,
    sha256: hash,
    suppliedAt: new Date().toISOString(),
    rights: "user_authorized",
    processingState: "pending",
    extractionVersion: "source-v3-intelligent",
    warnings: [],
  });
  if (!input.deferProcessing) await startSourceProcessing(source.id);
  return source;
}

export async function retryProductionSource(sourceId: string, projectId: string, user: UserContext) {
  const source = await requireOwnedSource(sourceId, projectId, user);
  await getStore().updateProductionSource(source.id, { processingState: "pending", error: undefined });
  await startSourceProcessing(source.id);
  return getStore().getProductionSource(source.id) as Promise<ProductionSource>;
}

export async function removeProductionSource(sourceId: string, projectId: string, user: UserContext) {
  const source = await requireOwnedSource(sourceId, projectId, user);
  await assertSourceEditable(source);
  const removed = await getStore().deleteProductionSource(source.id);
  await deletePrivateSource(source.blobUrl);
  return removed;
}

export async function assertSourceEditable(source: ProductionSource) {
  const jobs = await getStore().listProjectJobs(source.projectId);
  if (jobs.some((job) => job.status === "running" && job.sourceBundle?.inputs.some((input) => input.sourceRecordId === source.id))) {
    throw new ApiRequestError("Wait for the production using this source to finish before changing it.", 409, "source_in_use");
  }
}

export async function requireOwnedSource(sourceId: string, projectId: string, user: UserContext) {
  await requireOwnedProject(projectId, user);
  const source = await getStore().getProductionSource(sourceId);
  if (!source || source.projectId !== projectId || source.userId !== user.id) throw new ApiRequestError("Source not found.", 404, "source_not_found");
  return source;
}

async function requireOwnedProject(projectId: string, user: UserContext) {
  const project = await getStore().getProject(projectId);
  if (!project || project.userId !== user.id) throw new ApiRequestError("Project not found.", 404, "project_not_found");
  return project;
}

async function assertSourceCapacity(projectId: string, user: UserContext) {
  await requireOwnedProject(projectId, user);
  if ((await getStore().listProductionSources(projectId)).length >= NEWS_SOURCE_LIMIT) {
    throw new ApiRequestError(`A production can contain up to ${NEWS_SOURCE_LIMIT} sources.`, 409, "source_count_limit");
  }
}

async function findDuplicate(projectId: string, hash: string) {
  return (await getStore().listProductionSources(projectId)).find((source) => source.sha256 === hash);
}

export async function startSourceProcessing(sourceId: string) {
  if (getProviderMode() === "mock" || process.env.NODE_ENV === "test") {
    await processProductionSource(sourceId);
    return;
  }
  const { start } = await import("workflow/api");
  const { processNewsSourceWorkflow } = await import("@/workflow/news");
  const run = await start(processNewsSourceWorkflow, [sourceId]);
  console.log(JSON.stringify({ event: "news_source_workflow_started", sourceId, runId: run.runId }));
}

function normalizeSourceText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
