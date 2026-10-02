// All download tests stub fetch; resolve their fixture hosts without external DNS.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as getLibraryDownload } from "@/app/api/projects/[projectId]/library/[assetId]/download/route";
import { POST as postLibraryPin } from "@/app/api/projects/[projectId]/library/[assetId]/pin/route";
import { PATCH as patchLibraryAsset } from "@/app/api/projects/[projectId]/library/[assetId]/route";
import { POST as postLibraryCollection } from "@/app/api/projects/[projectId]/library/collections/route";
import { PATCH as patchLibraryCollection } from "@/app/api/projects/[projectId]/library/collections/[collectionId]/route";
import {
  DELETE as deleteLibraryCollectionAsset,
  POST as postLibraryCollectionAsset,
} from "@/app/api/projects/[projectId]/library/collections/[collectionId]/assets/[assetId]/route";
import { POST as postLibraryCollectionPin } from "@/app/api/projects/[projectId]/library/collections/[collectionId]/pin/route";
import { GET as getGenerationDownload } from "@/app/api/projects/[projectId]/media/generations/[generationId]/download/route";
import { POST as postProjectAgentMessage } from "@/app/api/projects/[projectId]/agent/message/route";
import { POST as postSessionAgentMessage } from "@/app/api/projects/[projectId]/media-sessions/[sessionId]/agent/message/route";
import { MediaGenerationCreateRequest, VideoCreateRequest, type AgentActionProposal, type CreativeBrief, type MediaKind, type MusicPlan } from "@/lib/schemas";
import { promoteFinalRenderToLibrary, syncProjectMediaToLibrary } from "@/lib/server/library-vault";
import { createProjectMediaGeneration, injectMediaGeneration } from "@/lib/server/media";
import {
  createLibraryAssetForProject,
  createMediaSession,
  createMediaSessionGeneration,
  exportMediaSessionVersion,
  restoreMediaSessionVersion,
} from "@/lib/server/media-sessions";
import { authorizeProjectRequest } from "@/lib/server/projects";
import { assertMediaGenerationAllowed, SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import { assertVideoActionAllowed, estimateCreateVideoCents } from "@/lib/server/video-action-guard";
import { authorizeVideoRequest } from "@/lib/server/videos";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createDownloadableGeneration(kind: MediaKind, mimeType: string, ownerId = `download-${kind}-user`) {
  const store = getStore();
  const project = await store.createProject({
    userId: ownerId,
    name: `Download ${kind} project`,
  });
  const generation = await store.createMediaGeneration({
    projectId: project.id,
    kind,
    provider: "mock",
    model: `mock-${kind}`,
    status: "success",
    prompt: `Downloadable ${kind} output.`,
    controls: {},
    inputAssetIds: [],
    outputUrls: {},
    metadata: {},
    costCents: 0,
  });
  const asset = await store.createMediaAsset({
    projectId: project.id,
    generationId: generation.id,
    kind,
    role: `${kind}_asset`,
    url: `https://assets.test/${generation.id}`,
    mimeType,
    metadata: {},
  });
  const updated = await store.updateMediaGeneration(generation.id, {
    outputUrls: { [kind]: asset.url },
    metadata: { assetId: asset.id },
  });
  return { project, generation: updated, asset, ownerId };
}

function mockAssetFetch(mimeType: string, body: string) {
  const fetchMock = vi.fn(async () =>
    new Response(body, {
      headers: {
        "content-length": String(body.length),
        "content-type": mimeType,
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("project media library", () => {
  it("creates standalone media records and assets in the project library", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A monochrome samurai music video with one red sun accent.",
        durationSeconds: 60,
      }),
      {
        id: "media-test-user",
        email: "media@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );

    const result = await createProjectMediaGeneration(
      job.projectId,
      MediaGenerationCreateRequest.parse({
        videoJobId: job.id,
        kind: "image",
        provider: "mock",
        prompt: "Monochrome ink-wash anchor image with a red sun.",
        controls: { role: "style", size: "1024x1536", quality: "high", outputFormat: "png" },
      }),
    );
    const library = await store.listProjectMedia(job.projectId);

    expect(result.generation.status).toBe("success");
    expect(result.assets).toHaveLength(1);
    expect(library.generations.some((generation) => generation.id === result.generation.id)).toBe(true);
    expect(library.assets.some((asset) => asset.generationId === result.generation.id)).toBe(true);
    const vault = await store.listLibraryAssets(job.userId);
    expect(vault.some((asset) => asset.source === "generation" && asset.metadata.generationId === result.generation.id)).toBe(true);
  });

  it("routes standalone music with a genre control through the genre engine (not the generic instrumental fallback)", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({ userId: "music-genre-user", name: "Genre" });
    const result = await createProjectMediaGeneration(
      project.id,
      MediaGenerationCreateRequest.parse({
        kind: "music",
        provider: "mock",
        prompt: "A standalone metal cue with relentless riffs.",
        controls: {
          durationSeconds: 60,
          musicControls: { genre: "metal", vocals: "auto", tempo: "auto", intensity: "auto" },
        },
      }),
    );

    const plan = result.generation.metadata.plan as MusicPlan;
    expect(plan.styleSummary ?? "").toMatch(/metal|distorted|guitar/i);
    expect(plan.vocal).toBe(true);
    expect(plan.voiceFamily).toBe("male");
    expect(plan.sections.some((section) => (section.lyrics ?? "").length > 0)).toBe(true);
  });

  it("keeps the generic instrumental plan for standalone music with no genre control", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({ userId: "music-plain-user", name: "Plain" });
    const result = await createProjectMediaGeneration(
      project.id,
      MediaGenerationCreateRequest.parse({
        kind: "music",
        provider: "mock",
        prompt: "A standalone ambient texture.",
        controls: { durationSeconds: 48 },
      }),
    );

    const plan = result.generation.metadata.plan as MusicPlan;
    expect(plan.vocal).toBe(false);
    expect(plan.voiceFamily).toBe("instrumental");
  });

  it.each([
    ["image", "Vault image prompt."],
    ["video", "Vault video prompt."],
    ["music", "Vault music prompt."],
  ] as const)("auto-saves successful %s generations into the user vault without duplicates", async (kind, prompt) => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: `vault-${kind}-user`,
      name: `Vault ${kind} project`,
    });

    const result = await createProjectMediaGeneration(
      project.id,
      MediaGenerationCreateRequest.parse({
        kind,
        provider: "mock",
        prompt,
        controls: kind === "video" ? { durationSeconds: 8 } : kind === "music" ? { durationSeconds: 30 } : { role: "style" },
        execute: true,
        idempotencyKey: `vault-${kind}-key`,
      }),
    );
    const replay = await createProjectMediaGeneration(
      project.id,
      MediaGenerationCreateRequest.parse({
        kind,
        provider: "mock",
        prompt,
        controls: kind === "video" ? { durationSeconds: 8 } : kind === "music" ? { durationSeconds: 30 } : { role: "style" },
        execute: true,
        idempotencyKey: `vault-${kind}-key`,
      }),
    );
    const vault = await store.listLibraryAssets(project.userId);
    const links = await store.listProjectAssetLinks(project.id);

    expect(result.generation.status).toBe("success");
    expect(replay.generation.id).toBe(result.generation.id);
    expect(vault.filter((asset) => asset.metadata.generationId === result.generation.id)).toHaveLength(1);
    expect(vault[0].source).toBe("generation");
    expect(vault[0].metadata.mediaAssetId).toBe(result.assets[0]?.id);
    expect(links.some((link) => link.libraryAssetId === vault[0].id && link.mediaAssetId === result.assets[0]?.id)).toBe(true);
  });

  it.each([
    ["image", "image/png"],
    ["video", "video/mp4"],
    ["music", "audio/mpeg"],
  ] as const)("backfills distinct %s generations even when their output URLs match", async (kind, mimeType) => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: `vault-collision-${kind}-user`,
      name: `Vault collision ${kind} project`,
    });
    const sharedUrl = `https://assets.test/shared-${kind}`;
    const createPersistedGeneration = async (label: string) => {
      const generation = await store.createMediaGeneration({
        projectId: project.id,
        kind,
        provider: "mock",
        model: `mock-${kind}`,
        status: "success",
        prompt: `${label} prompt`,
        controls: {},
        inputAssetIds: [],
        outputUrls: {},
        metadata: { label },
        costCents: 0,
      });
      const asset = await store.createMediaAsset({
        projectId: project.id,
        generationId: generation.id,
        kind,
        role: `${kind}_asset`,
        url: sharedUrl,
        mimeType,
        metadata: { label },
      });
      const updated = await store.updateMediaGeneration(generation.id, {
        outputUrls: { [kind]: asset.url },
        metadata: { ...generation.metadata, assetId: asset.id },
      });
      return { generation: updated, asset };
    };
    const first = await createPersistedGeneration("first");
    const second = await createPersistedGeneration("second");

    const existing = await store.createLibraryAsset({
      userId: project.userId,
      kind,
      name: "Existing generated asset",
      role: `${kind}_asset`,
      url: sharedUrl,
      mimeType,
      source: "generation",
      tags: ["generated", kind],
      metadata: {
        generationId: first.generation.id,
        mediaAssetId: first.asset.id,
      },
    });
    await store.createProjectAssetLink({
      projectId: project.id,
      libraryAssetId: existing.id,
      mediaAssetId: first.asset.id,
    });

    await syncProjectMediaToLibrary(project.id);

    const vault = await store.listLibraryAssets(project.userId);
    const promoted = vault.filter((asset) =>
      [first.generation.id, second.generation.id].includes(String(asset.metadata.generationId)),
    );
    const links = await store.listProjectAssetLinks(project.id);

    expect(promoted).toHaveLength(2);
    expect(new Set(promoted.map((asset) => asset.metadata.mediaAssetId))).toEqual(
      new Set([first.asset.id, second.asset.id]),
    );
    expect(promoted.filter((asset) => asset.url === sharedUrl)).toHaveLength(2);
    expect(links.filter((link) => promoted.some((asset) => asset.id === link.libraryAssetId))).toHaveLength(2);
  });

  it("promotes completed final renders into the user vault without losing rerenders", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A complete neon synthwave music video with rain and mirror-lit dancers.",
        durationSeconds: 90,
        aspectRatio: "9:16",
      }),
      {
        id: "final-render-vault-user",
        email: "render-vault@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );
    const renderManifest = {
      videoId: job.id,
      music: {
        url: "https://assets.test/final-render/music.mp3",
        durationSeconds: 90,
      },
      shots: [],
      beatGrid: {
        videoId: job.id,
        bpm: 124,
        events: [],
      },
      aspectRatio: "9:16" as const,
    };
    const completed = await store.updateJob(job.id, {
      status: "complete",
      currentPhase: 9,
      actualCostCents: 1234,
      renderManifest,
      finalVideoUrl: "https://assets.test/final-render/final-a.mp4",
      thumbnailUrl: "https://assets.test/final-render/thumb-a.png",
    });

    const first = await promoteFinalRenderToLibrary(completed);
    const replay = await promoteFinalRenderToLibrary(completed);
    let vault = await store.listLibraryAssets(job.userId);
    let renderAssets = vault.filter((asset) => asset.source === "render" && asset.metadata.videoJobId === job.id);
    let media = await store.listProjectMedia(job.projectId);

    expect(first?.libraryAsset.id).toBe(replay?.libraryAsset.id);
    expect(renderAssets).toHaveLength(1);
    expect(renderAssets[0].kind).toBe("render");
    expect(renderAssets[0].role).toBe("final_music_video");
    expect(renderAssets[0].tags).toEqual(expect.arrayContaining(["finished", "music-video", "render"]));
    expect(renderAssets[0].metadata.thumbnailUrl).toBe("https://assets.test/final-render/thumb-a.png");
    expect(renderAssets[0].metadata.durationSeconds).toBe(90);
    expect(renderAssets[0].metadata.aspectRatio).toBe("9:16");
    expect(renderAssets[0].metadata.renderManifest).toBeDefined();
    expect(media.assets.filter((asset) => asset.kind === "render" && asset.videoJobId === job.id)).toHaveLength(1);

    const rerendered = await store.updateJob(job.id, {
      finalVideoUrl: "https://assets.test/final-render/final-b.mp4",
      thumbnailUrl: "https://assets.test/final-render/thumb-b.png",
    });
    await promoteFinalRenderToLibrary(rerendered);
    vault = await store.listLibraryAssets(job.userId);
    renderAssets = vault.filter((asset) => asset.source === "render" && asset.metadata.videoJobId === job.id);
    media = await store.listProjectMedia(job.projectId);

    expect(renderAssets).toHaveLength(2);
    expect(new Set(renderAssets.map((asset) => asset.url))).toEqual(new Set([
      "https://assets.test/final-render/final-a.mp4",
      "https://assets.test/final-render/final-b.mp4",
    ]));
    expect(media.assets.filter((asset) => asset.kind === "render" && asset.videoJobId === job.id)).toHaveLength(2);
  });

  it("recovers completed final renders during project media sync", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A completed final video should appear in the vault when the project reloads.",
        durationSeconds: 75,
        aspectRatio: "9:16",
      }),
      {
        id: "final-render-sync-user",
        email: "render-sync@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );
    const completed = await store.updateJob(job.id, {
      status: "complete",
      currentPhase: 9,
      renderManifest: {
        videoId: job.id,
        music: {
          url: "https://assets.test/final-render-sync/music.mp3",
          durationSeconds: 75,
        },
        shots: [],
        beatGrid: {
          videoId: job.id,
          bpm: 118,
          events: [],
        },
        aspectRatio: "9:16",
      },
      finalVideoUrl: "https://assets.test/final-render-sync/final.mp4",
      thumbnailUrl: "https://assets.test/final-render-sync/thumb.png",
    });

    expect((await store.listLibraryAssets(job.userId)).some((asset) =>
      asset.source === "render" && asset.metadata.videoJobId === job.id
    )).toBe(false);

    await syncProjectMediaToLibrary(job.projectId);
    await syncProjectMediaToLibrary(job.projectId);

    const vault = await store.listLibraryAssets(job.userId);
    const media = await store.listProjectMedia(job.projectId);
    const renderAssets = vault.filter((asset) =>
      asset.source === "render" && asset.metadata.videoJobId === job.id
    );

    expect(renderAssets).toHaveLength(1);
    expect(renderAssets[0].url).toBe(completed.finalVideoUrl);
    expect(renderAssets[0].role).toBe("final_music_video");
    expect(renderAssets[0].metadata.thumbnailUrl).toBe(completed.thumbnailUrl);
    expect(media.assets.some((asset) =>
      asset.kind === "render" &&
      asset.videoJobId === job.id &&
      asset.url === completed.finalVideoUrl
    )).toBe(true);
  });

  it.each([
    ["image", "image/png", "png"],
    ["video", "video/mp4", "mp4"],
    ["music", "audio/mpeg", "mp3"],
  ] as const)("downloads a successful %s generation as an attachment", async (kind, mimeType, extension) => {
    process.env.PROVIDER_MODE = "mock";
    const { project, generation, ownerId } = await createDownloadableGeneration(kind, mimeType);
    const fetchMock = mockAssetFetch(mimeType, `${kind}-asset`);

    const response = await getGenerationDownload(
      new Request("https://local.test", { headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: project.id, generationId: generation.id }) } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(mimeType);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="cocoa-director-${kind}-${generation.id.slice(0, 8)}.${extension}"`,
    );
    expect(await response.text()).toBe(`${kind}-asset`);
    expect(fetchMock).toHaveBeenCalledWith(`https://assets.test/${generation.id}`, expect.objectContaining({ cache: "no-store", redirect: "manual", dispatcher: expect.anything(), signal: expect.any(AbortSignal) }));
  });

  it("downloads a library asset through the project-authenticated vault route", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const ownerId = "vault-download-user";
    const project = await store.createProject({ userId: ownerId, name: "Vault download project" });
    const asset = await store.createLibraryAsset({
      userId: ownerId,
      kind: "music",
      name: "Rock cue",
      role: "music_reference",
      url: "https://assets.test/rock-cue.mp3",
      mimeType: "audio/mpeg",
      source: "upload",
      tags: ["uploaded"],
      metadata: {},
    });
    const fetchMock = mockAssetFetch("audio/mpeg", "rock-cue");

    const response = await getLibraryDownload(
      new Request("https://local.test", { headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: project.id, assetId: asset.id }) } as never,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="rock-cue-${asset.id.slice(0, 8)}.mp3"`,
    );
    expect(await response.text()).toBe("rock-cue");
    expect(fetchMock).toHaveBeenCalledWith("https://assets.test/rock-cue.mp3", expect.objectContaining({ cache: "no-store", redirect: "manual", dispatcher: expect.anything(), signal: expect.any(AbortSignal) }));
  });

  it("pins user-wide library assets into the active project for reuse", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const ownerId = "vault-pin-user";
    const firstProject = await store.createProject({ userId: ownerId, name: "First project" });
    const secondProject = await store.createProject({ userId: ownerId, name: "Second project" });
    const { libraryAsset } = await createLibraryAssetForProject(firstProject.id, ownerId, {
      kind: "image",
      name: "Shared comet plate",
      role: "reference",
      url: "https://assets.test/comet.png",
      mimeType: "image/png",
      source: "generation",
      tags: ["generated"],
      metadata: { generationId: "00000000-0000-0000-0000-000000000001" },
      pinToProject: true,
    });

    const response = await postLibraryPin(
      new Request("https://local.test", { method: "POST", headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: secondProject.id, assetId: libraryAsset.id }) } as never,
    );
    const json = await response.json() as { mediaAsset?: { id: string }; libraryAssets?: unknown[] };
    const links = await store.listProjectAssetLinks(secondProject.id);

    expect(response.status).toBe(200);
    expect(json.mediaAsset?.id).toBeDefined();
    expect(json.libraryAssets?.length).toBeGreaterThan(0);
    expect(links.some((link) => link.libraryAssetId === libraryAsset.id && link.mediaAssetId === json.mediaAsset?.id)).toBe(true);
  });

  it("updates library asset favorites and tags through the vault route", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const ownerId = "vault-curation-user";
    const project = await store.createProject({ userId: ownerId, name: "Curation project" });
    const asset = await store.createLibraryAsset({
      userId: ownerId,
      kind: "image",
      name: "Original plate",
      role: "reference",
      url: "https://assets.test/original.png",
      mimeType: "image/png",
      source: "upload",
      tags: ["starter"],
      metadata: { prompt: "A starter plate." },
    });

    const response = await patchLibraryAsset(
      new Request("https://local.test", {
        method: "PATCH",
        headers: { "x-user-id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Favorite comet plate",
          tags: ["cosmic", "reference"],
          favorite: true,
          metadata: { mood: "high contrast" },
        }),
      }),
      { params: Promise.resolve({ projectId: project.id, assetId: asset.id }) } as never,
    );
    const json = await response.json() as { libraryAsset?: { favoriteAt?: string; tags?: string[]; metadata?: Record<string, unknown> } };

    expect(response.status).toBe(200);
    expect(json.libraryAsset?.favoriteAt).toBeDefined();
    expect(json.libraryAsset?.tags).toEqual(["cosmic", "reference"]);
    expect(json.libraryAsset?.metadata?.prompt).toBe("A starter plate.");
    expect(json.libraryAsset?.metadata?.mood).toBe("high contrast");
  });

  it("creates, renames, archives, and edits reference pack membership idempotently", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const ownerId = "vault-pack-user";
    const project = await store.createProject({ userId: ownerId, name: "Pack project" });
    const first = await store.createLibraryAsset({
      userId: ownerId,
      kind: "image",
      name: "Pack image",
      role: "reference",
      url: "https://assets.test/pack-image.png",
      mimeType: "image/png",
      source: "upload",
      tags: ["image"],
      metadata: {},
    });
    const second = await store.createLibraryAsset({
      userId: ownerId,
      kind: "music",
      name: "Pack audio",
      role: "music_reference",
      url: "https://assets.test/pack-audio.mp3",
      mimeType: "audio/mpeg",
      source: "upload",
      tags: ["music"],
      metadata: {},
    });

    const createResponse = await postLibraryCollection(
      new Request("https://local.test", {
        method: "POST",
        headers: { "x-user-id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alien world pack", assetIds: [first.id] }),
      }),
      { params: Promise.resolve({ projectId: project.id }) } as never,
    );
    const createJson = await createResponse.json() as { collection?: { id: string; assetIds: string[] } };
    const collectionId = createJson.collection?.id ?? "";

    expect(createResponse.status).toBe(201);
    expect(createJson.collection?.assetIds).toEqual([first.id]);

    await postLibraryCollectionAsset(
      new Request("https://local.test", { method: "POST", headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: project.id, collectionId, assetId: second.id }) } as never,
    );
    const duplicateAdd = await postLibraryCollectionAsset(
      new Request("https://local.test", { method: "POST", headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: project.id, collectionId, assetId: second.id }) } as never,
    );
    const duplicateJson = await duplicateAdd.json() as { collection?: { assetIds: string[] } };

    expect(duplicateJson.collection?.assetIds.filter((id) => id === second.id)).toHaveLength(1);

    const removeResponse = await deleteLibraryCollectionAsset(
      new Request("https://local.test", { method: "DELETE", headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: project.id, collectionId, assetId: first.id }) } as never,
    );
    const removeJson = await removeResponse.json() as { collection?: { assetIds: string[] } };
    expect(removeJson.collection?.assetIds).toEqual([second.id]);

    const renameResponse = await patchLibraryCollection(
      new Request("https://local.test", {
        method: "PATCH",
        headers: { "x-user-id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Neon fight pack" }),
      }),
      { params: Promise.resolve({ projectId: project.id, collectionId }) } as never,
    );
    const renameJson = await renameResponse.json() as { collection?: { name: string } };
    expect(renameJson.collection?.name).toBe("Neon fight pack");

    const archiveResponse = await patchLibraryCollection(
      new Request("https://local.test", {
        method: "PATCH",
        headers: { "x-user-id": ownerId, "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      }),
      { params: Promise.resolve({ projectId: project.id, collectionId }) } as never,
    );
    const archiveJson = await archiveResponse.json() as { libraryCollections?: unknown[]; archivedCollectionId?: string };

    expect(archiveJson.archivedCollectionId).toBe(collectionId);
    expect(archiveJson.libraryCollections).toHaveLength(0);
  });

  it("pins every asset in a reference pack into another project without duplicate project links", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const ownerId = "vault-pack-pin-user";
    const sourceProject = await store.createProject({ userId: ownerId, name: "Source project" });
    const targetProject = await store.createProject({ userId: ownerId, name: "Target project" });
    const first = await store.createLibraryAsset({
      userId: ownerId,
      kind: "image",
      name: "Pack still",
      role: "reference",
      url: "https://assets.test/still.png",
      mimeType: "image/png",
      source: "upload",
      tags: [],
      metadata: {},
    });
    const second = await store.createLibraryAsset({
      userId: ownerId,
      kind: "video",
      name: "Pack clip",
      role: "video_reference",
      url: "https://assets.test/clip.mp4",
      mimeType: "video/mp4",
      source: "upload",
      tags: [],
      metadata: {},
    });
    const collection = await store.createLibraryCollection({
      userId: ownerId,
      name: "Cross-project pack",
      metadata: {},
      assetIds: [first.id, second.id],
    });

    const request = () => new Request("https://local.test", { method: "POST", headers: { "x-user-id": ownerId } });
    await postLibraryCollectionPin(
      request(),
      { params: Promise.resolve({ projectId: targetProject.id, collectionId: collection.id }) } as never,
    );
    const response = await postLibraryCollectionPin(
      request(),
      { params: Promise.resolve({ projectId: targetProject.id, collectionId: collection.id }) } as never,
    );
    const json = await response.json() as { mediaAssets?: Array<{ id: string }> };
    const links = await store.listProjectAssetLinks(targetProject.id);
    const sourceLinks = await store.listProjectAssetLinks(sourceProject.id);

    expect(response.status).toBe(200);
    expect(json.mediaAssets).toHaveLength(2);
    expect(links.filter((link) => link.libraryAssetId === first.id)).toHaveLength(1);
    expect(links.filter((link) => link.libraryAssetId === second.id)).toHaveLength(1);
    expect(sourceLinks).toHaveLength(0);
  });

  it("returns 409 when a generation output is not ready for download", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const ownerId = "queued-download-user";
    const project = await store.createProject({
      userId: ownerId,
      name: "Queued download project",
    });
    const generation = await store.createMediaGeneration({
      projectId: project.id,
      kind: "video",
      provider: "mock",
      model: "mock-video",
      status: "queued",
      prompt: "Queued amusement park clip.",
      controls: {},
      inputAssetIds: [],
      outputUrls: {},
      metadata: {},
      costCents: 0,
    });

    const response = await getGenerationDownload(
      new Request("https://local.test", { headers: { "x-user-id": ownerId } }),
      { params: Promise.resolve({ projectId: project.id, generationId: generation.id }) } as never,
    );
    const json = await response.json() as { error?: string };

    expect(response.status).toBe(409);
    expect(json.error).toBe("Media generation output is not ready yet");
  });

  it("keeps generation downloads scoped to the owning project user", async () => {
    process.env.PROVIDER_MODE = "mock";
    const { project, generation } = await createDownloadableGeneration("image", "image/png", "private-download-owner");

    const denied = await getGenerationDownload(
      new Request("https://local.test", { headers: { "x-user-id": "not-the-owner" } }),
      { params: Promise.resolve({ projectId: project.id, generationId: generation.id }) } as never,
    );
    const missing = await getGenerationDownload(
      new Request("https://local.test", { headers: { "x-user-id": "private-download-owner" } }),
      { params: Promise.resolve({ projectId: project.id, generationId: "00000000-0000-0000-0000-000000000000" }) } as never,
    );

    expect(denied.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("stages standalone media generation drafts without executing provider calls", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A neon courier image exploration.",
        durationSeconds: 60,
      }),
      {
        id: "media-draft-user",
        email: "media-draft@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );

    const result = await createProjectMediaGeneration(
      job.projectId,
      MediaGenerationCreateRequest.parse({
        kind: "image",
        provider: "mock",
        prompt: "Draft a rain-slick neon alley anchor.",
        controls: { role: "style", quality: "high" },
        execute: false,
        idempotencyKey: "media-draft-key-1",
        label: "Neon draft",
      }),
    );
    const replay = await createProjectMediaGeneration(
      job.projectId,
      MediaGenerationCreateRequest.parse({
        kind: "image",
        provider: "mock",
        prompt: "Draft a rain-slick neon alley anchor.",
        controls: { role: "style", quality: "high" },
        execute: false,
        idempotencyKey: "media-draft-key-1",
        label: "Neon draft",
      }),
    );
    const library = await store.listProjectMedia(job.projectId);

    expect(result.generation.status).toBe("draft");
    expect(replay.generation.id).toBe(result.generation.id);
    expect(result.assets).toHaveLength(0);
    expect(library.assets.some((asset) => asset.generationId === result.generation.id)).toBe(false);
  });

  it("injects media explicitly without changing unrelated job fields", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A future city clip with black-and-white comic panels.",
        durationSeconds: 60,
      }),
      {
        id: "media-inject-user",
        email: "media-inject@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );
    const brief: CreativeBrief = {
      videoId: job.id,
      durationSeconds: 60,
      aspectRatio: "9:16",
      visualMode: "conceptual",
      storySpine: "A comic-panel city evolves into a music-video signal.",
      visualWorld: "Black ink, paper texture, hard light, and one red accent.",
      subject: { type: "abstract", description: "A comic-panel signal city." },
      energyArc: ["build", "peak", "drop"],
      mood: "kinetic",
      genre: "electronic",
      safetyNotes: [],
    };
    await store.updateJob(job.id, {
      creativeBrief: brief,
      generatedShots: [
        {
          shotIndex: 0,
          providerRequestId: "old",
          videoUrl: "https://example.com/old-shot.mp4",
          durationSeconds: 8,
          seed: 1,
          costUsd: 1,
          latencyMs: 10,
          attempts: 1,
        },
      ],
    });

    const result = await createProjectMediaGeneration(
      job.projectId,
      MediaGenerationCreateRequest.parse({
        videoJobId: job.id,
        kind: "video",
        provider: "mock",
        prompt: "Replace shot one with a slower black-and-white city dolly.",
        controls: { durationSeconds: 8, resolution: "720p", seedanceTier: "standard" },
      }),
    );
    const injected = await injectMediaGeneration(job.projectId, result.generation.id, {
      videoJobId: job.id,
      action: "replace_selected_shot",
      shotIndex: 0,
    });

    expect(injected.job.generatedShots).toHaveLength(1);
    expect(injected.job.generatedShots[0].videoUrl).not.toBe("https://example.com/old-shot.mp4");
    expect(injected.job.artifactVersions.length).toBeGreaterThan(0);
    expect(injected.job.creativeBrief?.storySpine).toBe(brief.storySpine);
  });

  it("creates, versions, restores, and exports image media sessions", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const user = {
      id: "media-session-user",
      email: "media-session@example.com",
      planTier: "dev" as const,
      dailyBudgetCents: 5000,
    };
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A single painterly red-sun hero image for a music video.",
        durationSeconds: 60,
      }),
      user,
    );
    const { libraryAsset, mediaAsset } = await createLibraryAssetForProject(job.projectId, user.id, {
      kind: "image",
      name: "Source hero frame",
      role: "reference",
      url: "https://example.com/source.png",
      mimeType: "image/png",
      source: "url",
      tags: ["source"],
      metadata: {},
      pinToProject: true,
    });
    const session = await createMediaSession(job.projectId, {
      kind: "image",
      sourceAssetId: mediaAsset?.id,
      goal: "Iterate this frame with stronger ink texture.",
      settings: { quality: "high" },
    });
    const generated = await createMediaSessionGeneration(job.projectId, session.id, {
      prompt: "Make the image more graphic with a sharper red sun.",
      provider: "mock",
      controls: { role: "style", size: "1024x1536", quality: "high", outputFormat: "png" },
      inputAssetIds: mediaAsset ? [mediaAsset.id] : [],
      label: "Sharper red sun",
      execute: true,
    });
    const restored = await restoreMediaSessionVersion(job.projectId, session.id, session.versions[0].id);
    const exported = await exportMediaSessionVersion(job.projectId, session.id, generated.version?.id);

    expect(libraryAsset.name).toBe("Source hero frame");
    expect(session.versions[0].label).toBe("Source");
    expect(generated.asset?.kind).toBe("image");
    expect(generated.session.currentAssetId).toBe(generated.asset?.id);
    expect(generated.session.settings.lastPrompt).toBe("Make the image more graphic with a sharper red sun.");
    expect(generated.session.settings.lastControls).toMatchObject({ role: "style", quality: "high" });
    expect(restored.asset.id).toBe(mediaAsset?.id);
    expect(restored.version.label).toBe("Restored: Source");
    expect(restored.version.parentVersionId).toBe(session.versions[0].id);
    expect(restored.session.versions[0].id).toBe(restored.version.id);
    expect(restored.session.settings.lastPrompt).toBe("Iterate this frame with stronger ink texture.");
    expect(exported.downloadUrl).toBe(generated.asset?.url);
    expect(exported.fileName).toMatch(/^source-hero-frame-sharper-red-sun-[a-f0-9-]+\.png$/);
  });

  it("versions video sessions from uploaded references without mutating the director pipeline", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const user = {
      id: "video-session-user",
      email: "video-session@example.com",
      planTier: "dev" as const,
      dailyBudgetCents: 5000,
    };
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A modular video session with external references.",
        durationSeconds: 60,
      }),
      user,
    );
    const { mediaAsset: imageRef } = await createLibraryAssetForProject(job.projectId, user.id, {
      kind: "image",
      name: "Uploaded key frame",
      role: "reference",
      url: "https://example.com/key-frame.png",
      mimeType: "image/png",
      source: "upload",
      tags: ["uploaded", "reference"],
      metadata: { sourceKind: "user-upload" },
      pinToProject: true,
    });
    const { mediaAsset: videoRef } = await createLibraryAssetForProject(job.projectId, user.id, {
      kind: "video",
      name: "Imported motion reference",
      role: "reference",
      url: "https://example.com/motion-reference.mp4",
      mimeType: "video/mp4",
      source: "url",
      tags: ["imported", "reference"],
      metadata: { sourceKind: "remote-import" },
      pinToProject: true,
    });
    const session = await createMediaSession(job.projectId, {
      kind: "video",
      title: "Standalone clip lab",
      sourceAssetId: imageRef?.id,
      goal: "Create one slower Seedance clip from reference material.",
      settings: { durationSeconds: 8, resolution: "720p" },
    });
    const inputAssetIds = [imageRef?.id, videoRef?.id].filter((id): id is string => Boolean(id));
    const result = await createMediaSessionGeneration(job.projectId, session.id, {
      prompt: "Slow dolly through the same key frame with rain and restrained motion.",
      provider: "mock",
      controls: {
        seedanceMode: "reference-to-video",
        durationSeconds: 8,
        resolution: "720p",
        seedMode: "lock",
        seed: 1234,
      },
      inputAssetIds,
      idempotencyKey: "video-session-generation-key",
      label: "Slow reference dolly",
      execute: true,
    });
    const replay = await createMediaSessionGeneration(job.projectId, session.id, {
      prompt: "Slow dolly through the same key frame with rain and restrained motion.",
      provider: "mock",
      controls: {
        seedanceMode: "reference-to-video",
        durationSeconds: 8,
        resolution: "720p",
        seedMode: "lock",
        seed: 1234,
      },
      inputAssetIds,
      idempotencyKey: "video-session-generation-key",
      label: "Slow reference dolly",
      execute: true,
    });
    const library = await store.listProjectMedia(job.projectId);
    const unchangedJob = await store.getJob(job.id);

    expect(result.asset?.kind).toBe("video");
    expect(replay.generation.id).toBe(result.generation.id);
    expect(replay.version?.id).toBe(result.version?.id);
    expect(result.version?.label).toBe("Slow reference dolly");
    expect(result.session.settings.lastPrompt).toBe("Slow dolly through the same key frame with rain and restrained motion.");
    expect(result.session.settings.lastControls).toMatchObject({ seedanceMode: "reference-to-video", seed: 1234 });
    expect(result.generation.inputAssetIds).toEqual(inputAssetIds);
    expect(library.assets.some((asset) => asset.id === imageRef?.id)).toBe(true);
    expect(library.assets.some((asset) => asset.id === result.asset?.id)).toBe(true);
    expect(unchangedJob?.generatedShots).toHaveLength(0);
    expect(unchangedJob?.anchorAssets).toHaveLength(0);
    expect(unchangedJob?.musicTrack).toBeUndefined();
  });

  it("supports first-class ElevenLabs music sessions through the same version layer", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A cinematic audio motif with detailed section-aware dynamics.",
        durationSeconds: 75,
      }),
      {
        id: "music-session-user",
        email: "music-session@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );
    const session = await createMediaSession(job.projectId, {
      kind: "music",
      title: "Bridge motif",
      goal: "Build a darker bridge cue with cleaner drums and a future stem-separation note.",
      settings: { outputFormat: "mp3_44100_192", requestStems: true },
    });
    const result = await createMediaSessionGeneration(job.projectId, session.id, {
      prompt: "Dark cinematic bridge cue, cleaner drums, wide low end.",
      provider: "mock",
      controls: { outputFormat: "mp3_44100_192", requestStems: true, durationSeconds: 45 },
      inputAssetIds: [],
      label: "Bridge cue v1",
      execute: true,
    });

    expect(result.asset?.kind).toBe("music");
    expect(result.version?.label).toBe("Bridge cue v1");
    expect(result.session.settings.lastPrompt).toBe("Dark cinematic bridge cue, cleaner drums, wide low end.");
    expect(result.session.settings.lastControls).toMatchObject({ outputFormat: "mp3_44100_192", requestStems: true });
    expect(result.generation.metadata.plan).toBeDefined();
    expect(result.session.versions[0].assetId).toBe(result.asset?.id);
  });

  it("persists media-session messages in chronological order", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: "session-message-user",
      name: "Session message project",
    });
    const session = await createMediaSession(project.id, {
      settings: {},
      kind: "image",
      title: "Chat-backed image session",
      goal: "Iterate a cover frame through agent proposals.",
    });

    await store.createMediaSessionMessage({
      sessionId: session.id,
      role: "user",
      content: "Make this more stage-lit.",
    });
    await store.createMediaSessionMessage({
      sessionId: session.id,
      role: "agent",
      content: "I staged an image proposal.",
      proposal: {
        actionType: "media_generation",
        title: "Stage image version",
        rationale: "Creates a session version only.",
        costRisk: "Runs one image call after confirmation.",
        kind: "image",
        provider: "mock",
        prompt: "Stage-lit image plate.",
        controls: { quality: "high" },
        inputAssetIds: [],
      },
    });

    const messages = await store.listMediaSessionMessages(session.id);
    const fetchedSession = await store.getMediaSession(project.id, session.id);

    expect(messages.map((message) => message.role)).toEqual(["user", "agent"]);
    expect(messages[1].proposal?.actionType).toBe("media_generation");
    expect(fetchedSession?.messages).toHaveLength(2);
  });

  it("returns a persisted confirmable proposal from the session-agent endpoint", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: "session-agent-route-user",
      name: "Session Agent API",
    });
    const session = await createMediaSession(project.id, {
      settings: {},
      kind: "video",
      title: "Clip co-creation",
      goal: "Make standalone clip versions.",
    });

    const response = await postSessionAgentMessage(
      new Request("https://local.test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": "session-agent-route-user",
        },
        body: JSON.stringify({ message: "Create a slower Seedance clip version with live guitar energy." }),
      }),
      { params: Promise.resolve({ projectId: project.id, sessionId: session.id }) } as never,
    );
    const json = await response.json() as {
      proposal?: AgentActionProposal;
      messages?: Array<{ role: string; content: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.proposal?.actionType).toBe("media_generation");
    expect(json.proposal?.kind).toBe("video");
    expect(json.messages?.map((message) => message.role)).toEqual(["user", "agent"]);
  });

  it("routes standalone media creation through the project Cocoa Director endpoint", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: "project-agent-route-user",
      name: "Cocoa Director API",
    });

    const response = await postProjectAgentMessage(
      new Request("https://local.test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": "project-agent-route-user",
        },
        body: JSON.stringify({ message: "Create a 30-second song about rock and roll." }),
      }),
      { params: Promise.resolve({ projectId: project.id }) } as never,
    );
    const json = await response.json() as {
      proposal?: AgentActionProposal;
      messages?: Array<{ role: string; content: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.proposal?.actionType).toBe("media_generation");
    expect(json.proposal?.kind).toBe("music");
    expect(json.proposal?.controls.durationSeconds).toBe(30);
    expect(json.messages).toEqual([]);
  });

  it("keeps video-with-audio prompts on the Seedance video path", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: "project-agent-video-audio-user",
      name: "Cocoa Director Video Audio API",
    });

    const response = await postProjectAgentMessage(
      new Request("https://local.test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": "project-agent-video-audio-user",
        },
        body: JSON.stringify({
          message: "Create a video game stylized fight scene between futuristic ninjas, 10s, full audio with musical background.",
        }),
      }),
      { params: Promise.resolve({ projectId: project.id }) } as never,
    );
    const json = await response.json() as {
      proposal?: AgentActionProposal;
    };

    expect(response.status).toBe(200);
    expect(json.proposal?.actionType).toBe("media_generation");
    expect(json.proposal?.kind).toBe("video");
    expect(json.proposal?.controls).toMatchObject({
      durationSeconds: 10,
      generateAudio: true,
      seedanceMode: "text-to-video",
    });
  });

  it("confirms media-generation proposals through the existing session version flow", async () => {
    process.env.PROVIDER_MODE = "mock";
    const store = getStore();
    const project = await store.createProject({
      userId: "session-proposal-confirm-user",
      name: "Proposal confirmation project",
    });
    const session = await createMediaSession(project.id, {
      settings: {},
      kind: "music",
      title: "Guitar hook lab",
      goal: "Explore rock guitar hooks.",
    });
    const proposal: AgentActionProposal = {
      actionType: "media_generation",
      title: "Stage rock guitar hook",
      rationale: "Creates a new music session version.",
      costRisk: "Runs one music call after confirmation.",
      kind: "music",
      provider: "mock",
      prompt: "Rock guitar hook with live drums and bass.",
      controls: { outputFormat: "mp3_44100_192", respectSectionDurations: true },
      inputAssetIds: [],
      label: "Rock guitar hook",
    };

    const result = await createMediaSessionGeneration(project.id, session.id, {
      prompt: proposal.prompt ?? "",
      provider: proposal.provider,
      controls: proposal.controls,
      inputAssetIds: proposal.inputAssetIds,
      label: proposal.label,
      execute: true,
    });

    expect(result.version?.label).toBe("Rock guitar hook");
    expect(result.asset?.kind).toBe("music");
    expect(result.session.versions[0].prompt).toBe(proposal.prompt);
  });

  it("keeps project media reads scoped to the owning user", async () => {
    const store = getStore();
    const owner = {
      id: "project-media-owner",
      email: "owner@example.com",
      planTier: "dev" as const,
      dailyBudgetCents: 5000,
    };
    const project = await store.createProject({
      userId: owner.id,
      name: "Private media vault",
    });

    const allowed = await authorizeProjectRequest(
      new Request("https://local.test", { headers: { "x-user-id": owner.id } }),
      project.id,
    );
    const denied = await authorizeProjectRequest(
      new Request("https://local.test", { headers: { "x-user-id": "not-the-owner" } }),
      project.id,
    );

    expect(allowed.project?.id).toBe(project.id);
    expect(denied.response?.status).toBe(404);
  });

  it("keeps video jobs scoped to the owning user", async () => {
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A private video that should not leak by ID.",
        durationSeconds: 60,
      }),
      {
        id: "video-owner-user",
        email: "video-owner@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );

    const allowed = await authorizeVideoRequest(
      new Request("https://local.test", { headers: { "x-user-id": job.userId } }),
      job.id,
    );
    const denied = await authorizeVideoRequest(
      new Request("https://local.test", { headers: { "x-user-id": "not-video-owner" } }),
      job.id,
    );

    expect(allowed.job?.id).toBe(job.id);
    expect(denied.response?.status).toBe(404);
  });

  it("audits full-pipeline spend guards and replays idempotent video actions", async () => {
    delete process.env.PROVIDER_CALLS_ENABLED;
    const input = VideoCreateRequest.parse({
      prompt: "A controlled beta music-video run with spend guard audit.",
      durationSeconds: 60,
      autopilot: true,
    });
    const user = {
      id: "video-guard-user",
      email: "video-guard@example.com",
      planTier: "dev" as const,
      dailyBudgetCents: 5000,
    };
    const first = await assertVideoActionAllowed({
      action: "create_video_autopilot",
      estimatedCostCents: estimateCreateVideoCents(input),
      idempotencyKey: "video-guard-key",
      recordSubmitted: true,
      user,
    });
    const replay = await assertVideoActionAllowed({
      action: "create_video_autopilot",
      estimatedCostCents: estimateCreateVideoCents(input),
      idempotencyKey: "video-guard-key",
      recordSubmitted: true,
      user,
    });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.event?.metadata.source).toBe("video_action_guard");
  });

  it("soft-deletes library and media assets while archiving sessions", async () => {
    const store = getStore();
    const user = {
      id: "delete-assets-user",
      email: "delete-assets@example.com",
      planTier: "dev" as const,
      dailyBudgetCents: 5000,
    };
    const project = await store.createProject({ userId: user.id, name: "Lifecycle project" });
    const library = await store.createLibraryAsset({
      userId: user.id,
      kind: "image",
      name: "Temporary upload",
      role: "reference",
      url: "https://example.com/temp.png",
      mimeType: "image/png",
      source: "upload",
      tags: [],
      metadata: {},
    });
    const media = await store.createMediaAsset({
      projectId: project.id,
      kind: "image",
      role: "reference",
      url: "https://example.com/media.png",
      mimeType: "image/png",
      metadata: {},
    });
    const session = await createMediaSession(project.id, {
      settings: {},
      kind: "image",
      title: "Temporary session",
      sourceAssetId: media.id,
    });

    await store.deleteLibraryAsset(user.id, library.id);
    await store.deleteMediaAsset(project.id, media.id);
    await store.archiveMediaSession(project.id, session.id);

    expect(await store.getLibraryAsset(user.id, library.id)).toBeNull();
    expect(await store.getMediaAsset(project.id, media.id)).toBeNull();
    expect((await store.listMediaSessions(project.id)).some((item) => item.id === session.id)).toBe(false);
  });

  it("captures beta feedback with project and video context", async () => {
    const store = getStore();
    const job = await store.createJob(
      VideoCreateRequest.parse({
        prompt: "A beta feedback video context.",
        durationSeconds: 60,
      }),
      {
        id: "feedback-user",
        email: "feedback@example.com",
        planTier: "dev" as const,
        dailyBudgetCents: 5000,
      },
    );

    const feedback = await store.createBetaFeedback({
      userId: job.userId,
      projectId: job.projectId,
      videoJobId: job.id,
      kind: "issue",
      message: "The tester hit a confusing paused-provider state.",
      metadata: { browser: "unit-test" },
    });

    expect(feedback.status).toBe("open");
    expect(feedback.videoJobId).toBe(job.id);
    expect((await store.listBetaFeedback()).some((item) => item.id === feedback.id)).toBe(true);
  });

  it("blocks standalone generation when the beta spend guard is tripped", async () => {
    delete process.env.PROVIDER_CALLS_ENABLED;
    await expect(
      assertMediaGenerationAllowed(
        {
          id: "spend-guard-user",
          email: "spend-guard@example.com",
          planTier: "dev" as const,
          dailyBudgetCents: 1,
        },
        MediaGenerationCreateRequest.parse({
          kind: "image",
          provider: "mock",
          prompt: "Expensive image version.",
          controls: { quality: "high" },
          execute: true,
          idempotencyKey: "spend-guard-key",
        }),
      ),
    ).rejects.toBeInstanceOf(SpendGuardError);

    process.env.PROVIDER_CALLS_ENABLED = "false";
    await expect(
      assertMediaGenerationAllowed(
        {
          id: "paused-provider-user",
          email: "paused@example.com",
          planTier: "dev" as const,
          dailyBudgetCents: 5000,
        },
        MediaGenerationCreateRequest.parse({
          kind: "image",
          provider: "mock",
          prompt: "Paused image version.",
          controls: { quality: "low" },
          execute: true,
          idempotencyKey: "paused-provider-key",
        }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    delete process.env.PROVIDER_CALLS_ENABLED;
  });
});
