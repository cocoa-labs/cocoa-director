import { ApiRequestError } from "@/lib/server/api-error";
import { validateUploadBytes } from "@/lib/server/upload-validation";
import { randomUUID } from "node:crypto";

import {
  LibraryAssetCreateRequest,
  LibraryUrlImportRequest,
  MediaGenerationCreateRequest,
  MediaSessionCreateRequest,
  MediaSessionGenerationRequest,
  type LibraryAsset,
  type MediaAsset,
  type MediaKind,
  type MediaSession,
  type MediaSessionMessage,
  type MediaSessionVersion,
} from "@/lib/schemas";
import { fetchBlobUrl, uploadPublicBlob } from "@/lib/server/blob";
import { getStore } from "@/lib/server/store";
import { createProjectMediaGeneration } from "@/lib/server/media";

type SessionWithDetails = MediaSession & { versions: MediaSessionVersion[]; messages: MediaSessionMessage[] };

export async function createLibraryAssetForProject(
  projectId: string,
  userId: string,
  request: LibraryAssetCreateRequest,
  id?: string,
) {
  const store = getStore();
  const libraryAsset = (id ? await store.getLibraryAsset(userId, id) : null) ?? await store.createLibraryAsset({
    id,
    userId,
    kind: request.kind,
    name: request.name,
    role: request.role,
    url: request.url,
    mimeType: request.mimeType,
    source: request.source,
    tags: request.tags,
    metadata: request.metadata,
  });
  const mediaAsset = request.pinToProject
    ? await pinLibraryAssetToProject(projectId, libraryAsset)
    : null;
  return { libraryAsset, mediaAsset };
}

export async function importLibraryUrlForProject(
  projectId: string,
  userId: string,
  request: LibraryUrlImportRequest,
) {
  const name = request.name ?? filenameFromUrl(request.url) ?? `${request.kind} import`;
  const contentType = request.mimeType ?? mimeTypeForKind(request.kind);
  const response = await fetchBlobUrl(request.url);
  if (!response.ok) throw new Error("Imported file could not be downloaded.");
  const bytes = Buffer.from(await response.arrayBuffer());
  validateUploadBytes(bytes, request.kind, contentType);
  const blob = await uploadPublicBlob({
    pathname: `library/${userId}/${randomUUID()}-${slugFilename(name)}`,
    body: bytes, contentType, immutable: true,
  });
  return createLibraryAssetForProject(
    projectId,
    userId,
    LibraryAssetCreateRequest.parse({
      kind: request.kind,
      name,
      role: request.role,
      url: blob.url,
      mimeType: contentType,
      source: "url",
      tags: request.tags,
      metadata: { importedFrom: request.url },
      pinToProject: request.pinToProject,
    }),
  );
}

export async function pinLibraryAssetToProject(projectId: string, libraryAsset: LibraryAsset) {
  const store = getStore();
  const existingLink = (await store.listProjectAssetLinks(projectId))
    .find((link) => link.libraryAssetId === libraryAsset.id);
  if (existingLink) {
    const existingAsset = await store.getMediaAsset(projectId, existingLink.mediaAssetId);
    if (existingAsset) return existingAsset;
  }

  const mediaAsset = await store.createMediaAsset({
    projectId,
    kind: libraryAsset.kind,
    role: libraryAsset.role,
    url: libraryAsset.url,
    mimeType: libraryAsset.mimeType,
    metadata: {
      ...libraryAsset.metadata,
      libraryAssetId: libraryAsset.id,
      name: libraryAsset.name,
      tags: libraryAsset.tags,
      source: libraryAsset.source,
    },
  });
  await store.createProjectAssetLink({
    projectId,
    libraryAssetId: libraryAsset.id,
    mediaAssetId: mediaAsset.id,
  });
  return mediaAsset;
}

export async function createMediaSession(
  projectId: string,
  request: MediaSessionCreateRequest,
) {
  const store = getStore();
  const sourceAsset = request.sourceAssetId
    ? await store.getMediaAsset(projectId, request.sourceAssetId)
    : null;
  if (request.sourceAssetId && !sourceAsset) {
    throw new Error("Source asset does not belong to this project");
  }

  const session = await store.createMediaSession({
    projectId,
    kind: request.kind,
    title: request.title ?? defaultSessionTitle(request.kind, sourceAsset),
    sourceAssetId: request.sourceAssetId,
    currentAssetId: request.sourceAssetId,
    goal: request.goal,
    settings: request.settings,
  });

  if (sourceAsset) {
    await store.createMediaSessionVersion({
      sessionId: session.id,
      assetId: sourceAsset.id,
      label: "Source",
      prompt: request.goal,
      controls: request.settings,
      notes: "Initial source asset.",
    });
  }

  return store.getMediaSession(projectId, session.id) as Promise<SessionWithDetails>;
}

export async function createMediaSessionGeneration(
  projectId: string,
  sessionId: string,
  request: MediaSessionGenerationRequest,
) {
  const store = getStore();
  const session = await store.getMediaSession(projectId, sessionId);
  if (!session) throw new ApiRequestError("Media session not found", 404, "not_found");
  const mediaKind = mediaKindForSession(session.kind);
  if (!mediaKind) throw new Error(`${session.kind} sessions do not support standalone generation yet`);

  const existingVersion = request.idempotencyKey
    ? session.versions.find((version) => version.controls.__idempotencyKey === request.idempotencyKey)
    : undefined;
  if (existingVersion) {
    const asset = await store.getMediaAsset(projectId, existingVersion.assetId);
    const generation = existingVersion.generationId
      ? await store.getMediaGeneration(projectId, existingVersion.generationId)
      : null;
    if (asset && generation) {
      return { session, generation, version: existingVersion, asset };
    }
  }

  const generationResult = await createProjectMediaGeneration(
    projectId,
    MediaGenerationCreateRequest.parse({
      kind: mediaKind,
      provider: request.provider,
      prompt: request.prompt,
      controls: request.controls,
      inputAssetIds: request.inputAssetIds,
      execute: request.execute,
      idempotencyKey: request.idempotencyKey,
      label: request.label ?? `${session.title} iteration`,
    }),
  );
  const asset = generationResult.assets[0];
  if (!asset) {
    let generation = generationResult.generation;
    let updatedSession: MediaSession = session;
    if (generationResult.generation.status === "queued" || generationResult.generation.status === "running") {
      const parentVersion = session.versions.find((version) => version.assetId === session.currentAssetId);
      generation = await store.updateMediaGeneration(generationResult.generation.id, {
        metadata: {
          ...generationResult.generation.metadata,
          mediaSessionId: session.id,
          parentVersionId: parentVersion?.id,
          versionLabel: request.label ?? `Version ${session.versions.length + 1}`,
        },
      });
      updatedSession = await store.updateMediaSession(sessionId, {
        settings: rememberedSessionSettings(session.settings, request.prompt, request.controls, request.provider),
      });
    }
    return { session: { ...updatedSession, versions: session.versions, messages: session.messages }, generation, version: null, asset: null };
  }

  const parentVersion = session.versions.find((version) => version.assetId === session.currentAssetId);
  const version = await store.createMediaSessionVersion({
    sessionId,
    assetId: asset.id,
    generationId: generationResult.generation.id,
    label: request.label ?? `Version ${session.versions.length + 1}`,
    prompt: request.prompt,
    controls: request.idempotencyKey
      ? { ...request.controls, __idempotencyKey: request.idempotencyKey }
      : request.controls,
    parentVersionId: parentVersion?.id,
    notes: "Generated from Media Session.",
  });
  const updated = await store.updateMediaSession(sessionId, {
    currentAssetId: asset.id,
    status: "active",
    settings: rememberedSessionSettings(session.settings, request.prompt, request.controls, request.provider),
  });

  return {
    session: { ...updated, versions: [version, ...session.versions], messages: session.messages },
    generation: generationResult.generation,
    version,
    asset,
  };
}

export async function restoreMediaSessionVersion(
  projectId: string,
  sessionId: string,
  versionId: string,
) {
  const store = getStore();
  const session = await store.getMediaSession(projectId, sessionId);
  if (!session) throw new ApiRequestError("Media session not found", 404, "not_found");
  const version = await store.getMediaSessionVersion(sessionId, versionId);
  if (!version) throw new Error("Media session version not found");
  const asset = await store.getMediaAsset(projectId, version.assetId);
  if (!asset) throw new Error("Version asset is no longer available");
  const restoredVersion = await store.createMediaSessionVersion({
    sessionId,
    assetId: asset.id,
    generationId: version.generationId,
    label: `Restored: ${version.label}`,
    prompt: version.prompt,
    controls: version.controls,
    parentVersionId: version.id,
    notes: `Restored from ${version.label}; no provider call was made.`,
  });
  const updated = await store.updateMediaSession(sessionId, {
    currentAssetId: asset.id,
    settings: rememberedSessionSettings(session.settings, version.prompt, version.controls),
  });
  return { session: { ...updated, versions: [restoredVersion, ...session.versions], messages: session.messages }, version: restoredVersion, asset };
}

export async function exportMediaSessionVersion(projectId: string, sessionId: string, versionId?: string) {
  const store = getStore();
  const session = await store.getMediaSession(projectId, sessionId);
  if (!session) throw new ApiRequestError("Media session not found", 404, "not_found");
  const version = versionId
    ? await store.getMediaSessionVersion(sessionId, versionId)
    : session.versions.find((candidate) => candidate.assetId === session.currentAssetId) ?? session.versions[0];
  if (!version) throw new Error("No exportable version exists yet");
  const asset = await store.getMediaAsset(projectId, version.assetId);
  if (!asset) throw new Error("Export asset is no longer available");
  return { session, version, asset, downloadUrl: asset.url, fileName: mediaSessionExportFileName(session, version, asset) };
}

export function mediaSessionExportFileName(
  session: MediaSession,
  version: MediaSessionVersion,
  asset: MediaAsset,
) {
  const baseName = slugFilename(`${session.title}-${version.label}`) || `cocoa-${asset.kind}`;
  return `${baseName}-${version.id.slice(0, 8)}.${extensionForMimeType(asset.mimeType, asset.kind)}`;
}

function mediaKindForSession(kind: MediaSession["kind"]): MediaKind | null {
  if (kind === "image" || kind === "video" || kind === "music" || kind === "render") return kind;
  return null;
}

function defaultSessionTitle(kind: MediaSession["kind"], sourceAsset: MediaAsset | null) {
  const sourceName = typeof sourceAsset?.metadata.name === "string" ? sourceAsset.metadata.name : null;
  if (sourceName) return sourceName;
  if (kind === "image") return "Image session";
  if (kind === "video") return "Video session";
  if (kind === "music") return "Music session";
  return "Media session";
}

function rememberedSessionSettings(
  settings: Record<string, unknown>,
  prompt?: string | null,
  controls: Record<string, unknown> = {},
  provider?: string,
) {
  return {
    ...settings,
    lastPrompt: prompt ?? settings.lastPrompt,
    lastControls: controls,
    ...(provider ? { lastProvider: provider } : {}),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function extensionForMimeType(mimeType: string, kind: MediaKind) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return kind === "music" ? "m4a" : "mp4";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  if (kind === "image") return "png";
  if (kind === "video" || kind === "render") return "mp4";
  if (kind === "music") return "mp3";
  return "bin";
}

function filenameFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split("/").filter(Boolean).pop();
  } catch {
    return null;
  }
}

function slugFilename(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}

function mimeTypeForKind(kind: MediaKind) {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  if (kind === "music") return "audio/mpeg";
  return "application/json";
}
