import { randomUUID } from "node:crypto";

import {
  CreativeBrief,
  MusicControls,
  MusicPlan,
  MusicTrack,
  BeatGrid,
  AnchorAsset,
  ShotPlan,
  GeneratedShot,
  RenderManifest,
  EditDirective,
  ArtifactVersion,
  BetaAccessRequest,
  BetaFeedback,
  BetaInviteCode,
  MediaAsset,
  MediaGeneration,
  ProviderAuditEvent,
  Project,
  LibraryAsset,
  LibraryCollection,
  ProjectAssetLink,
  MediaSession,
  MediaSessionMessage,
  MediaSessionVersion,
  ProductionSource,
  ProductionWorkflowRun,
  SourceFragment,
  type PhaseNumber,
  type ProviderCall,
  type VideoCreateRequest,
  type VideoJob,
  type VideoSeeds,
  type WorkflowPhase,
} from "@/lib/schemas";
import { cents, estimateInitialCost } from "@/lib/cost";
import { MUSIC_VIDEO_V1_PHASES } from "@/lib/music-workflow-profile";
import { workflowProfileFor } from "@/lib/production";
import { createTraceId, nowIso } from "@/lib/trace";
import type { UserContext } from "@/lib/server/auth";
import { ensureDatabaseSchema, getSql, hasDatabase, withTransaction } from "@/lib/server/db";
import { getProviderMode } from "@/lib/server/config";
import { databaseTimestamp } from "@/lib/server/timestamps";

export type JobPatch = Partial<
  Pick<
    VideoJob,
    | "status"
    | "currentPhase"
    | "prompt"
    | "durationSeconds"
    | "aspectRatio"
    | "actualCostCents"
    | "recoveryBudgetCents"
    | "recoverySpentCents"
    | "estimatedCostCents"
    | "contentType"
    | "qualityTier"
    | "workflowVersion"
    | "sourceBundle"
    | "digestMode"
    | "researchMode"
    | "presentationMode"
    | "visualStylePreset"
    | "visualPlan"
    | "editorialPlan"
    | "durationPlan"
    | "storyboard"
    | "approvals"
    | "timelineManifest"
    | "qaReport"
    | "workflowSteps"
    | "script"
    | "narrationAssetId"
    | "visualMode"
    | "seeds"
    | "cancellationRequested"
    | "error"
    | "creativeBrief"
    | "musicPlan"
    | "musicTrack"
    | "beatGrid"
    | "anchorAssets"
    | "shotPlan"
    | "generatedShots"
    | "renderManifest"
    | "finalVideoUrl"
    | "thumbnailUrl"
    | "promptTrace"
    | "editDirectives"
    | "artifactVersions"
  >
>;

type MediaGenerationInput = Omit<MediaGeneration, "id" | "createdAt" | "updatedAt"> & { id?: string };
type MediaGenerationPatch = Partial<
  Pick<
    MediaGeneration,
    | "status"
    | "model"
    | "prompt"
    | "controls"
    | "inputAssetIds"
    | "outputUrls"
    | "metadata"
    | "costCents"
    | "requestId"
    | "error"
  >
>;
type MediaAssetInput = Omit<MediaAsset, "id" | "createdAt" | "deletedAt"> & { id?: string };
type ProjectInput = Omit<Project, "id" | "createdAt"> & { id?: string };
type LibraryAssetInput = Omit<LibraryAsset, "id" | "createdAt" | "deletedAt"> & { id?: string };
type LibraryAssetPatch = Partial<Pick<LibraryAsset, "name" | "tags" | "metadata" | "favoriteAt">>;
type LibraryCollectionInput = Omit<LibraryCollection, "id" | "createdAt" | "updatedAt" | "archivedAt" | "assetIds"> & {
  id?: string;
  assetIds?: string[];
};
type LibraryCollectionPatch = Partial<Pick<LibraryCollection, "name" | "metadata">> & { archived?: boolean };
type ProjectAssetLinkInput = Omit<ProjectAssetLink, "id" | "createdAt"> & { id?: string };
type MediaSessionInput = Omit<MediaSession, "id" | "createdAt" | "updatedAt" | "status"> & {
  id?: string;
  status?: MediaSession["status"];
};
type MediaSessionPatch = Partial<
  Pick<MediaSession, "title" | "status" | "sourceAssetId" | "currentAssetId" | "goal" | "settings">
>;
type MediaSessionVersionInput = Omit<MediaSessionVersion, "id" | "createdAt"> & { id?: string };
type MediaSessionMessageInput = Omit<MediaSessionMessage, "id" | "createdAt"> & { id?: string };
type BetaAccessRequestInput = Omit<BetaAccessRequest, "id" | "createdAt" | "updatedAt" | "status"> & {
  id?: string;
  status?: BetaAccessRequest["status"];
};
type BetaAccessRequestPatch = Partial<Pick<BetaAccessRequest, "status" | "inviteCodeId">>;
type BetaInviteCodeInput = Omit<BetaInviteCode, "id" | "createdAt" | "updatedAt" | "consumedAt" | "consumedBy" | "revokedAt"> & {
  id?: string;
};
type ProviderAuditEventInput = Omit<ProviderAuditEvent, "id" | "createdAt"> & { id?: string };
type BetaFeedbackInput = Omit<BetaFeedback, "id" | "createdAt" | "updatedAt" | "status"> & {
  id?: string;
  status?: BetaFeedback["status"];
};
type BetaFeedbackPatch = Partial<Pick<BetaFeedback, "status">>;
type ProductionSourceInput = Omit<ProductionSource, "id" | "createdAt" | "updatedAt"> & { id?: string };
type ProductionSourcePatch = Partial<Pick<ProductionSource,
  "productionId" | "title" | "canonicalUrl" | "pageCount" | "publishedAt" | "retrievedAt" |
  "processingState" | "warnings" | "error" | "sha256" | "byteSize" | "blobUrl"
>>;
type SourceFragmentInput = Omit<SourceFragment, "id" | "createdAt"> & { id?: string };
type ProductionWorkflowRunInput = Omit<ProductionWorkflowRun, "id"> & { id?: string };
type ProductionWorkflowRunPatch = Partial<Pick<ProductionWorkflowRun,
  "state" | "recoveryToken" | "errorCode" | "error" | "metadata" | "heartbeatAt" | "completedAt"
>>;

export type MediaSessionWithDetails = MediaSession & {
  versions: MediaSessionVersion[];
  messages: MediaSessionMessage[];
};

export type VideoStore = {
  listProjects(userId: string): Promise<Project[]>;
  createProject(input: ProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project | null>;
  listBetaAccessRequests(status?: BetaAccessRequest["status"]): Promise<BetaAccessRequest[]>;
  createBetaAccessRequest(input: BetaAccessRequestInput): Promise<BetaAccessRequest>;
  updateBetaAccessRequest(id: string, patch: BetaAccessRequestPatch): Promise<BetaAccessRequest>;
  findApprovedBetaAccess(identity: { email?: string; phone?: string }): Promise<BetaAccessRequest | null>;
  findRecentBetaAccessRequestByIpHash(ipHash: string, sinceIso: string): Promise<BetaAccessRequest | null>;
  createBetaInviteCode(input: BetaInviteCodeInput): Promise<BetaInviteCode>;
  consumeBetaInviteCode(codeHash: string, consumedBy: string): Promise<BetaInviteCode | null>;
  revokeInviteCodesForAccessRequest(accessRequestId: string): Promise<void>;
  getActiveInviteCodeForAccessRequest(accessRequestId: string): Promise<BetaInviteCode | null>;
  createProviderAuditEvent(input: ProviderAuditEventInput): Promise<ProviderAuditEvent>;
  listProviderAuditEvents(limit?: number): Promise<ProviderAuditEvent[]>;
  createBetaFeedback(input: BetaFeedbackInput): Promise<BetaFeedback>;
  listBetaFeedback(limit?: number): Promise<BetaFeedback[]>;
  updateBetaFeedback(id: string, patch: BetaFeedbackPatch): Promise<BetaFeedback>;
  createJob(request: VideoCreateRequest, user: UserContext, projectId?: string): Promise<VideoJob>;
  getJob(videoId: string): Promise<VideoJob | null>;
  listProjectJobs(projectId: string): Promise<VideoJob[]>;
  updateJob(videoId: string, patch: JobPatch): Promise<VideoJob>;
  mutateJob(videoId: string, mutate: (job: VideoJob) => JobPatch): Promise<VideoJob>;
  updatePhase(videoId: string, phaseNumber: PhaseNumber, patch: Partial<WorkflowPhase>): Promise<VideoJob>;
  addProviderCall(call: Omit<ProviderCall, "id" | "createdAt">): Promise<VideoJob>;
  listProductionSources(projectId: string): Promise<ProductionSource[]>;
  getProductionSource(sourceId: string): Promise<ProductionSource | null>;
  createProductionSource(input: ProductionSourceInput): Promise<ProductionSource>;
  updateProductionSource(sourceId: string, patch: ProductionSourcePatch): Promise<ProductionSource>;
  deleteProductionSource(sourceId: string): Promise<ProductionSource | null>;
  replaceSourceFragments(sourceId: string, fragments: SourceFragmentInput[]): Promise<SourceFragment[]>;
  listSourceFragments(sourceId: string): Promise<SourceFragment[]>;
  listLibraryAssets(userId: string): Promise<LibraryAsset[]>;
  createLibraryAsset(input: LibraryAssetInput): Promise<LibraryAsset>;
  getLibraryAsset(userId: string, assetId: string): Promise<LibraryAsset | null>;
  updateLibraryAsset(userId: string, assetId: string, patch: LibraryAssetPatch): Promise<LibraryAsset | null>;
  deleteLibraryAsset(userId: string, assetId: string): Promise<LibraryAsset | null>;
  listLibraryCollections(userId: string): Promise<LibraryCollection[]>;
  getLibraryCollection(userId: string, collectionId: string): Promise<LibraryCollection | null>;
  createLibraryCollection(input: LibraryCollectionInput): Promise<LibraryCollection>;
  updateLibraryCollection(userId: string, collectionId: string, patch: LibraryCollectionPatch): Promise<LibraryCollection | null>;
  addLibraryAssetToCollection(userId: string, collectionId: string, assetId: string): Promise<LibraryCollection | null>;
  removeLibraryAssetFromCollection(userId: string, collectionId: string, assetId: string): Promise<LibraryCollection | null>;
  createProjectAssetLink(input: ProjectAssetLinkInput): Promise<ProjectAssetLink>;
  listProjectAssetLinks(projectId: string): Promise<ProjectAssetLink[]>;
  listProjectMedia(projectId: string): Promise<{ generations: MediaGeneration[]; assets: MediaAsset[] }>;
  listJobMedia(videoJobId: string): Promise<{ generations: MediaGeneration[]; assets: MediaAsset[] }>;
  getMediaGeneration(projectId: string, generationId: string): Promise<MediaGeneration | null>;
  createMediaGeneration(input: MediaGenerationInput): Promise<MediaGeneration>;
  updateMediaGeneration(generationId: string, patch: MediaGenerationPatch): Promise<MediaGeneration>;
  createMediaAsset(input: MediaAssetInput): Promise<MediaAsset>;
  getMediaAsset(projectId: string, assetId: string): Promise<MediaAsset | null>;
  deleteMediaAsset(projectId: string, assetId: string): Promise<MediaAsset | null>;
  createProductionWorkflowRun(input: ProductionWorkflowRunInput): Promise<ProductionWorkflowRun>;
  updateProductionWorkflowRun(runId: string, patch: ProductionWorkflowRunPatch): Promise<ProductionWorkflowRun>;
  listProductionWorkflowRuns(productionId: string): Promise<ProductionWorkflowRun[]>;
  reconcileJobActualCost(videoJobId: string): Promise<VideoJob>;
  listMediaSessions(projectId: string): Promise<MediaSessionWithDetails[]>;
  createMediaSession(input: MediaSessionInput): Promise<MediaSession>;
  getMediaSession(projectId: string, sessionId: string): Promise<MediaSessionWithDetails | null>;
  updateMediaSession(sessionId: string, patch: MediaSessionPatch): Promise<MediaSession>;
  archiveMediaSession(projectId: string, sessionId: string): Promise<MediaSession | null>;
  createMediaSessionVersion(input: MediaSessionVersionInput): Promise<MediaSessionVersion>;
  getMediaSessionVersion(sessionId: string, versionId: string): Promise<MediaSessionVersion | null>;
  createMediaSessionMessage(input: MediaSessionMessageInput): Promise<MediaSessionMessage>;
  listMediaSessionMessages(sessionId: string, limit?: number): Promise<MediaSessionMessage[]>;
};

const PHASES = MUSIC_VIDEO_V1_PHASES;

const globalForStore = globalThis as unknown as { __videoStore?: VideoStore };

export function getStore(): VideoStore {
  if (!globalForStore.__videoStore) {
    if (getProviderMode() === "live" && !hasDatabase() && process.env.NODE_ENV === "production") {
      throw new Error("Live provider mode requires DATABASE_URL so jobs are durable.");
    }
    globalForStore.__videoStore = hasDatabase() ? new PostgresStore() : new MemoryStore();
  }
  return globalForStore.__videoStore;
}

export function resetInMemoryStoreForDev() {
  const existing = globalForStore.__videoStore;
  if (existing && !(existing instanceof MemoryStore)) {
    return { reset: false, mode: "database" as const };
  }
  globalForStore.__videoStore = new MemoryStore();
  return { reset: true, mode: "memory" as const };
}

class MemoryStore implements VideoStore {
  private projects = new Map<string, Project>();
  private betaAccessRequests = new Map<string, BetaAccessRequest>();
  private betaFeedback = new Map<string, BetaFeedback>();
  private betaInviteCodes = new Map<string, BetaInviteCode>();
  private providerAuditEvents = new Map<string, ProviderAuditEvent>();
  private jobs = new Map<string, VideoJob>();
  private libraryAssets = new Map<string, LibraryAsset>();
  private libraryCollections = new Map<string, LibraryCollection>();
  private libraryCollectionAssets = new Map<string, Set<string>>();
  private projectAssetLinks = new Map<string, ProjectAssetLink>();
  private mediaGenerations = new Map<string, MediaGeneration>();
  private mediaAssets = new Map<string, MediaAsset>();
  private mediaSessions = new Map<string, MediaSession>();
  private mediaSessionVersions = new Map<string, MediaSessionVersion>();
  private mediaSessionMessages = new Map<string, MediaSessionMessage>();
  private productionSources = new Map<string, ProductionSource>();
  private sourceFragments = new Map<string, SourceFragment>();
  private productionWorkflowRuns = new Map<string, ProductionWorkflowRun>();

  async listProjects(userId: string) {
    return [...this.projects.values()]
      .filter((project) => project.userId === userId)
      .sort(descendingCreatedAt);
  }

  async createProject(input: ProjectInput) {
    const project: Project = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(projectId: string) {
    return this.projects.get(projectId) ?? null;
  }

  async listBetaAccessRequests(status?: BetaAccessRequest["status"]) {
    return [...this.betaAccessRequests.values()]
      .filter((request) => !status || request.status === status)
      .sort(descendingUpdatedAt);
  }

  async createBetaAccessRequest(input: BetaAccessRequestInput) {
    const existing = this.findBetaAccessRequest(input);
    const now = nowIso();
    if (existing) {
      const next = {
        ...existing,
        name: input.name ?? existing.name,
        note: input.note ?? existing.note,
        ipHash: input.ipHash ?? existing.ipHash,
        userAgent: input.userAgent ?? existing.userAgent,
        updatedAt: now,
      };
      this.betaAccessRequests.set(existing.id, next);
      return next;
    }
    const request: BetaAccessRequest = {
      ...input,
      id: input.id ?? randomUUID(),
      email: normalizeEmail(input.email),
      ipHash: input.ipHash,
      userAgent: input.userAgent,
      inviteCodeId: input.inviteCodeId,
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.betaAccessRequests.set(request.id, request);
    return request;
  }

  async updateBetaAccessRequest(id: string, patch: BetaAccessRequestPatch) {
    const request = this.betaAccessRequests.get(id);
    if (!request) throw new Error(`Beta access request not found: ${id}`);
    const next = { ...request, ...patch, updatedAt: nowIso() };
    this.betaAccessRequests.set(id, next);
    return next;
  }

  async findApprovedBetaAccess(identity: { email?: string; phone?: string }) {
    return this.findBetaAccessRequest(identity, "approved") ?? null;
  }

  async findRecentBetaAccessRequestByIpHash(ipHash: string, sinceIso: string) {
    const since = Date.parse(sinceIso);
    return [...this.betaAccessRequests.values()].find((request) => {
      return request.ipHash === ipHash && Date.parse(request.createdAt) >= since;
    }) ?? null;
  }

  async createBetaInviteCode(input: BetaInviteCodeInput) {
    const now = nowIso();
    const invite: BetaInviteCode = {
      ...input,
      id: input.id ?? randomUUID(),
      email: normalizeEmail(input.email),
      createdAt: now,
      updatedAt: now,
    };
    this.betaInviteCodes.set(invite.id, invite);
    return invite;
  }

  async consumeBetaInviteCode(codeHash: string, consumedBy: string) {
    const now = nowIso();
    const invite = [...this.betaInviteCodes.values()].find((candidate) => {
      return candidate.codeHash === codeHash &&
        !candidate.consumedAt &&
        !candidate.revokedAt &&
        Date.parse(candidate.expiresAt) > Date.now();
    });
    if (!invite) return null;
    const next = { ...invite, consumedAt: now, consumedBy, updatedAt: now };
    this.betaInviteCodes.set(invite.id, next);
    return next;
  }

  async revokeInviteCodesForAccessRequest(accessRequestId: string) {
    const now = nowIso();
    for (const invite of this.betaInviteCodes.values()) {
      if (invite.accessRequestId === accessRequestId && !invite.revokedAt && !invite.consumedAt) {
        this.betaInviteCodes.set(invite.id, { ...invite, revokedAt: now, updatedAt: now });
      }
    }
  }

  async getActiveInviteCodeForAccessRequest(accessRequestId: string) {
    return [...this.betaInviteCodes.values()]
      .filter((invite) =>
        invite.accessRequestId === accessRequestId &&
        !invite.consumedAt &&
        !invite.revokedAt &&
        Date.parse(invite.expiresAt) > Date.now(),
      )
      .sort(descendingCreatedAt)[0] ?? null;
  }

  async createProviderAuditEvent(input: ProviderAuditEventInput) {
    if (input.billingKey) {
      const existing = [...this.providerAuditEvents.values()].find((event) => event.billingKey === input.billingKey);
      if (existing) return existing;
    }
    const event: ProviderAuditEvent = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.providerAuditEvents.set(event.id, event);
    return event;
  }

  async listProviderAuditEvents(limit = 100) {
    return [...this.providerAuditEvents.values()]
      .sort(descendingCreatedAt)
      .slice(0, limit > 0 ? limit : undefined);
  }

  async createBetaFeedback(input: BetaFeedbackInput) {
    const now = nowIso();
    const feedback: BetaFeedback = {
      ...input,
      id: input.id ?? randomUUID(),
      status: input.status ?? "open",
      createdAt: now,
      updatedAt: now,
    };
    this.betaFeedback.set(feedback.id, feedback);
    return feedback;
  }

  async listBetaFeedback(limit = 100) {
    return [...this.betaFeedback.values()]
      .sort(descendingUpdatedAt)
      .slice(0, limit > 0 ? limit : undefined);
  }

  async updateBetaFeedback(id: string, patch: BetaFeedbackPatch) {
    const feedback = this.betaFeedback.get(id);
    if (!feedback) throw new Error(`Beta feedback not found: ${id}`);
    const next = { ...feedback, ...patch, updatedAt: nowIso() };
    this.betaFeedback.set(id, next);
    return next;
  }

  private findBetaAccessRequest(
    identity: { email?: string; phone?: string },
    status?: BetaAccessRequest["status"],
  ) {
    const email = normalizeEmail(identity.email);
    return [...this.betaAccessRequests.values()].find((request) => {
      if (status && request.status !== status) return false;
      return Boolean(
        (email && request.email?.toLowerCase() === email) ||
        (identity.phone && request.phone === identity.phone),
      );
    });
  }

  async createJob(request: VideoCreateRequest, user: UserContext, existingProjectId?: string) {
    const now = nowIso();
    const estimate = estimateInitialCost(request);
    const videoId = randomUUID();
    const existingProject = existingProjectId ? await this.getProject(existingProjectId) : null;
    if (existingProjectId && (!existingProject || existingProject.userId !== user.id)) {
      throw new Error("Project not found");
    }
    const project = existingProject ?? await this.createProject({ userId: user.id, name: "Cocoa Director" });
    const job: VideoJob = {
      id: videoId,
      projectId: project.id,
      userId: user.id,
      prompt: request.prompt,
      status: "pending",
      currentPhase: 1,
      estimatedCostCents: cents(estimate.totalUsd),
      actualCostCents: 0,
      recoveryBudgetCents: 0,
      recoverySpentCents: 0,
      aspectRatio: request.aspectRatio,
      contentType: "music_video",
      qualityTier: "standard",
      workflowVersion: "music-video-v1",
      visualMode: request.visualMode,
      durationSeconds: request.durationSeconds,
      traceId: createTraceId(),
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      musicControls: request.musicControls,
      seeds: request.seeds ?? { subjects: [], aesthetic: [] },
      anchorAssets: [],
      generatedShots: [],
      editDirectives: [],
      artifactVersions: [],
      approvals: [],
      phases: PHASES.map(({ phaseNumber, name }) => ({
        phaseNumber,
        name,
        state: "pending",
      })),
      providerCalls: [],
    };
    this.jobs.set(videoId, job);
    return job;
  }

  async getJob(videoId: string) {
    return this.jobs.get(videoId) ?? null;
  }

  async listProjectJobs(projectId: string) {
    return [...this.jobs.values()]
      .filter((job) => job.projectId === projectId)
      .sort(descendingUpdatedAt);
  }

  async updateJob(videoId: string, patch: JobPatch) {
    return this.mutateJob(videoId, () => patch);
  }

  async mutateJob(videoId: string, mutate: (job: VideoJob) => JobPatch) {
    const job = this.jobs.get(videoId);
    if (!job) throw new Error("Video job not found");
    const next = mergeJobPatch(job, mutate(structuredClone(job)));
    this.jobs.set(videoId, next);
    return next;
  }

  async updatePhase(videoId: string, phaseNumber: PhaseNumber, patch: Partial<WorkflowPhase>) {
    const job = this.jobs.get(videoId);
    if (!job) throw new Error("Video job not found");
    if (job.cancellationRequested || job.status === "cancelled") return job;
    const phases = job.phases.map((phase) =>
      phase.phaseNumber === phaseNumber ? { ...phase, ...patch } : phase,
    );
    const next = { ...job, phases, updatedAt: nowIso() };
    this.jobs.set(videoId, next);
    return next;
  }

  async addProviderCall(call: Omit<ProviderCall, "id" | "createdAt">) {
    const job = this.jobs.get(call.videoJobId);
    if (!job) throw new Error("Video job not found");
    const existing = job.providerCalls.find(
      (providerCall) => providerCall.idempotencyKey === call.idempotencyKey,
    );
    if (existing) return job;

    const providerCall: ProviderCall = {
      ...call,
      id: randomUUID(),
      createdAt: nowIso(),
    };
    const actualCostCents = job.actualCostCents + providerCall.costCents;
    const next = {
      ...job,
      actualCostCents,
      providerCalls: [...job.providerCalls, providerCall],
      updatedAt: nowIso(),
    };
    this.jobs.set(job.id, next);
    await this.createProviderAuditEvent({
      userId: job.userId,
      projectId: job.projectId,
      videoJobId: job.id,
      provider: providerCall.provider,
      model: providerCall.model,
      status: providerCall.status === "success" ? "success" : providerCall.status === "failed" ? "failed" : "submitted",
      estimatedCostCents: providerCall.costCents,
      actualCostCents: providerCall.status === "success" ? providerCall.costCents : 0,
      requestId: providerCall.requestId,
      idempotencyKey: providerCall.idempotencyKey,
      billingKey: providerCall.status === "success" ? `provider-call:${providerCall.idempotencyKey}` : undefined,
      error: providerCall.error,
      metadata: { phaseNumber: providerCall.phaseNumber, source: "pipeline_provider_call", ...providerCall.metadata },
    });
    return next;
  }

  async listLibraryAssets(userId: string) {
    return [...this.libraryAssets.values()]
      .filter((asset) => asset.userId === userId && !asset.deletedAt)
      .sort(descendingCreatedAt);
  }

  async createLibraryAsset(input: LibraryAssetInput) {
    const asset: LibraryAsset = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.libraryAssets.set(asset.id, asset);
    return asset;
  }

  async getLibraryAsset(userId: string, assetId: string) {
    const asset = this.libraryAssets.get(assetId);
    return asset?.userId === userId && !asset.deletedAt ? asset : null;
  }

  async updateLibraryAsset(userId: string, assetId: string, patch: LibraryAssetPatch) {
    const asset = await this.getLibraryAsset(userId, assetId);
    if (!asset) return null;
    const next: LibraryAsset = {
      ...asset,
      name: patch.name ?? asset.name,
      metadata: patch.metadata ?? asset.metadata,
      tags: patch.tags ?? asset.tags,
      favoriteAt: hasOwn(patch, "favoriteAt") ? patch.favoriteAt : asset.favoriteAt,
    };
    this.libraryAssets.set(asset.id, next);
    return next;
  }

  async deleteLibraryAsset(userId: string, assetId: string) {
    const asset = this.libraryAssets.get(assetId);
    if (!asset || asset.userId !== userId || asset.deletedAt) return null;
    const next = { ...asset, deletedAt: nowIso() };
    this.libraryAssets.set(asset.id, next);
    return next;
  }

  async listLibraryCollections(userId: string) {
    return [...this.libraryCollections.values()]
      .filter((collection) => collection.userId === userId && !collection.archivedAt)
      .map((collection) => this.hydrateLibraryCollection(collection))
      .sort(descendingCreatedAt);
  }

  async getLibraryCollection(userId: string, collectionId: string) {
    const collection = this.libraryCollections.get(collectionId);
    if (!collection || collection.userId !== userId || collection.archivedAt) return null;
    return this.hydrateLibraryCollection(collection);
  }

  async createLibraryCollection(input: LibraryCollectionInput) {
    const now = nowIso();
    const collection: LibraryCollection = {
      userId: input.userId,
      name: input.name,
      metadata: input.metadata,
      id: input.id ?? randomUUID(),
      assetIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.libraryCollections.set(collection.id, collection);
    this.libraryCollectionAssets.set(collection.id, new Set());
    for (const assetId of input.assetIds ?? []) {
      await this.addLibraryAssetToCollection(input.userId, collection.id, assetId);
    }
    return this.hydrateLibraryCollection(collection);
  }

  async updateLibraryCollection(userId: string, collectionId: string, patch: LibraryCollectionPatch) {
    const collection = this.libraryCollections.get(collectionId);
    if (!collection || collection.userId !== userId || collection.archivedAt) return null;
    const next: LibraryCollection = {
      ...collection,
      name: patch.name ?? collection.name,
      metadata: patch.metadata ?? collection.metadata,
      archivedAt: patch.archived ? nowIso() : collection.archivedAt,
      updatedAt: nowIso(),
    };
    this.libraryCollections.set(collection.id, next);
    return patch.archived ? null : this.hydrateLibraryCollection(next);
  }

  async addLibraryAssetToCollection(userId: string, collectionId: string, assetId: string) {
    const collection = await this.getLibraryCollection(userId, collectionId);
    const asset = await this.getLibraryAsset(userId, assetId);
    if (!collection || !asset) return null;
    const assetIds = this.libraryCollectionAssets.get(collection.id) ?? new Set<string>();
    assetIds.add(asset.id);
    this.libraryCollectionAssets.set(collection.id, assetIds);
    const stored = this.libraryCollections.get(collection.id);
    if (stored) this.libraryCollections.set(collection.id, { ...stored, updatedAt: nowIso() });
    return this.getLibraryCollection(userId, collectionId);
  }

  async removeLibraryAssetFromCollection(userId: string, collectionId: string, assetId: string) {
    const collection = await this.getLibraryCollection(userId, collectionId);
    if (!collection) return null;
    const assetIds = this.libraryCollectionAssets.get(collection.id) ?? new Set<string>();
    assetIds.delete(assetId);
    this.libraryCollectionAssets.set(collection.id, assetIds);
    const stored = this.libraryCollections.get(collection.id);
    if (stored) this.libraryCollections.set(collection.id, { ...stored, updatedAt: nowIso() });
    return this.getLibraryCollection(userId, collectionId);
  }

  async createProjectAssetLink(input: ProjectAssetLinkInput) {
    const existing = [...this.projectAssetLinks.values()].find(
      (link) => link.projectId === input.projectId && link.libraryAssetId === input.libraryAssetId,
    );
    if (existing) return existing;
    const link: ProjectAssetLink = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.projectAssetLinks.set(link.id, link);
    return link;
  }

  async listProjectAssetLinks(projectId: string) {
    return [...this.projectAssetLinks.values()]
      .filter((link) => link.projectId === projectId)
      .sort(descendingCreatedAt);
  }

  private hydrateLibraryCollection(collection: LibraryCollection): LibraryCollection {
    return {
      ...collection,
      assetIds: [...(this.libraryCollectionAssets.get(collection.id) ?? new Set<string>())],
    };
  }

  async listProjectMedia(projectId: string) {
    return {
      generations: [...this.mediaGenerations.values()]
        .filter((generation) => generation.projectId === projectId)
        .sort(descendingCreatedAt),
      assets: [...this.mediaAssets.values()]
        .filter((asset) => asset.projectId === projectId && !asset.deletedAt)
        .sort(descendingCreatedAt),
    };
  }

  async listJobMedia(videoJobId: string) {
    return {
      generations: [...this.mediaGenerations.values()]
        .filter((generation) => generation.videoJobId === videoJobId)
        .sort(descendingCreatedAt),
      assets: [...this.mediaAssets.values()]
        .filter((asset) => asset.videoJobId === videoJobId && !asset.deletedAt)
        .sort(descendingCreatedAt),
    };
  }

  async getMediaGeneration(projectId: string, generationId: string) {
    const generation = this.mediaGenerations.get(generationId);
    return generation?.projectId === projectId ? generation : null;
  }

  async createMediaGeneration(input: MediaGenerationInput) {
    const now = nowIso();
    const generation: MediaGeneration = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.mediaGenerations.set(generation.id, generation);
    return generation;
  }

  async updateMediaGeneration(generationId: string, patch: MediaGenerationPatch) {
    const generation = this.mediaGenerations.get(generationId);
    if (!generation) throw new Error(`Media generation not found: ${generationId}`);
    const next = { ...generation, ...patch, updatedAt: nowIso() };
    this.mediaGenerations.set(generationId, next);
    const costDelta = next.costCents - generation.costCents;
    if (costDelta !== 0 && next.videoJobId) {
      const job = this.jobs.get(next.videoJobId);
      if (job) this.jobs.set(job.id, { ...job, actualCostCents: Math.max(0, job.actualCostCents + costDelta), updatedAt: nowIso() });
    }
    return next;
  }

  async createMediaAsset(input: MediaAssetInput) {
    const asset: MediaAsset = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.mediaAssets.set(asset.id, asset);
    return asset;
  }

  async getMediaAsset(projectId: string, assetId: string) {
    const asset = this.mediaAssets.get(assetId);
    return asset?.projectId === projectId && !asset.deletedAt ? asset : null;
  }

  async deleteMediaAsset(projectId: string, assetId: string) {
    const asset = this.mediaAssets.get(assetId);
    if (!asset || asset.projectId !== projectId || asset.deletedAt) return null;
    const next = { ...asset, deletedAt: nowIso() };
    this.mediaAssets.set(asset.id, next);
    return next;
  }

  async createProductionWorkflowRun(input: ProductionWorkflowRunInput) {
    const existing = [...this.productionWorkflowRuns.values()].find((run) => run.runId === input.runId);
    if (existing) return existing;
    const run = ProductionWorkflowRun.parse({ ...input, id: input.id ?? randomUUID() });
    this.productionWorkflowRuns.set(run.id, run);
    return run;
  }

  async updateProductionWorkflowRun(runId: string, patch: ProductionWorkflowRunPatch) {
    const run = [...this.productionWorkflowRuns.values()].find((candidate) => candidate.runId === runId);
    if (!run) throw new Error(`Production workflow run not found: ${runId}`);
    const next = ProductionWorkflowRun.parse({ ...run, ...patch });
    this.productionWorkflowRuns.set(next.id, next);
    return next;
  }

  async listProductionWorkflowRuns(productionId: string) {
    return [...this.productionWorkflowRuns.values()]
      .filter((run) => run.productionId === productionId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async reconcileJobActualCost(videoJobId: string) {
    const job = await requireJob(this, videoJobId);
    const media = await this.listJobMedia(videoJobId);
    const existingAudits = [...this.providerAuditEvents.values()].filter((event) => event.videoJobId === videoJobId);
    for (const generation of media.generations.filter((item) => item.status === "success" && item.costCents > 0)) {
      if (existingAudits.some((event) => event.mediaGenerationId === generation.id && event.status === "success")) continue;
      await this.createProviderAuditEvent({
        userId: job.userId, projectId: job.projectId, videoJobId, mediaGenerationId: generation.id,
        provider: generation.provider, model: generation.model, status: "success",
        estimatedCostCents: generation.costCents, actualCostCents: generation.costCents,
        requestId: generation.requestId, billingKey: `media-generation:${generation.id}`,
        metadata: { source: "legacy_media_reconciliation" },
      });
    }
    for (const call of job.providerCalls.filter((item) => item.status === "success" && item.costCents > 0)) {
      if (existingAudits.some((event) => event.idempotencyKey === call.idempotencyKey && event.status === "success")) continue;
      await this.createProviderAuditEvent({
        userId: job.userId, projectId: job.projectId, videoJobId,
        provider: call.provider, model: call.model, status: "success",
        estimatedCostCents: call.costCents, actualCostCents: call.costCents,
        requestId: call.requestId, idempotencyKey: call.idempotencyKey,
        billingKey: `provider-call:${call.idempotencyKey}`,
        metadata: { source: "legacy_provider_call_reconciliation" },
      });
    }
    const actualCostCents = [...this.providerAuditEvents.values()]
      .filter((event) => event.videoJobId === videoJobId && event.status === "success")
      .reduce((sum, event) => sum + event.actualCostCents, 0);
    return this.updateJob(videoJobId, { actualCostCents });
  }

  async listMediaSessions(projectId: string) {
    return [...this.mediaSessions.values()]
      .filter((session) => session.projectId === projectId && session.status !== "archived")
      .sort(descendingUpdatedAt)
      .map((session) => ({
        ...session,
        versions: this.versionsForSession(session.id),
        messages: this.messagesForSession(session.id, 40),
      }));
  }

  async createMediaSession(input: MediaSessionInput) {
    const now = nowIso();
    const session: MediaSession = {
      ...input,
      id: input.id ?? randomUUID(),
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    this.mediaSessions.set(session.id, session);
    return session;
  }

  async getMediaSession(projectId: string, sessionId: string) {
    const session = this.mediaSessions.get(sessionId);
    if (!session || session.projectId !== projectId) return null;
    return {
      ...session,
      versions: this.versionsForSession(session.id),
      messages: this.messagesForSession(session.id, 80),
    };
  }

  async updateMediaSession(sessionId: string, patch: MediaSessionPatch) {
    const session = this.mediaSessions.get(sessionId);
    if (!session) throw new Error(`Media session not found: ${sessionId}`);
    const next = { ...session, ...patch, updatedAt: nowIso() };
    this.mediaSessions.set(sessionId, next);
    return next;
  }

  async archiveMediaSession(projectId: string, sessionId: string) {
    const session = this.mediaSessions.get(sessionId);
    if (!session || session.projectId !== projectId) return null;
    const next = { ...session, status: "archived" as const, updatedAt: nowIso() };
    this.mediaSessions.set(sessionId, next);
    return next;
  }

  async createMediaSessionVersion(input: MediaSessionVersionInput) {
    const version: MediaSessionVersion = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.mediaSessionVersions.set(version.id, version);
    return version;
  }

  async getMediaSessionVersion(sessionId: string, versionId: string) {
    const version = this.mediaSessionVersions.get(versionId);
    return version?.sessionId === sessionId ? version : null;
  }

  async createMediaSessionMessage(input: MediaSessionMessageInput) {
    const message: MediaSessionMessage = {
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: nowIso(),
    };
    this.mediaSessionMessages.set(message.id, message);
    return message;
  }

  async listMediaSessionMessages(sessionId: string, limit = 80) {
    return this.messagesForSession(sessionId, limit);
  }

  async listProductionSources(projectId: string) {
    return [...this.productionSources.values()]
      .filter((source) => source.projectId === projectId)
      .sort(descendingCreatedAt);
  }

  async getProductionSource(sourceId: string) {
    return this.productionSources.get(sourceId) ?? null;
  }

  async createProductionSource(input: ProductionSourceInput) {
    const now = nowIso();
    const source = ProductionSource.parse({
      ...input,
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
    });
    this.productionSources.set(source.id, source);
    return source;
  }

  async updateProductionSource(sourceId: string, patch: ProductionSourcePatch) {
    const source = this.productionSources.get(sourceId);
    if (!source) throw new Error(`Production source not found: ${sourceId}`);
    const next = ProductionSource.parse({ ...source, ...patch, updatedAt: nowIso() });
    this.productionSources.set(sourceId, next);
    return next;
  }

  async deleteProductionSource(sourceId: string) {
    const source = this.productionSources.get(sourceId);
    if (!source) return null;
    this.productionSources.delete(sourceId);
    for (const [id, fragment] of this.sourceFragments) {
      if (fragment.sourceId === sourceId) this.sourceFragments.delete(id);
    }
    return source;
  }

  async replaceSourceFragments(sourceId: string, inputs: SourceFragmentInput[]) {
    for (const [id, fragment] of this.sourceFragments) {
      if (fragment.sourceId === sourceId) this.sourceFragments.delete(id);
    }
    return inputs.map((input) => {
      const fragment = SourceFragment.parse({ ...input, id: input.id ?? randomUUID(), createdAt: nowIso() });
      this.sourceFragments.set(fragment.id, fragment);
      return fragment;
    });
  }

  async listSourceFragments(sourceId: string) {
    return [...this.sourceFragments.values()]
      .filter((fragment) => fragment.sourceId === sourceId)
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  private versionsForSession(sessionId: string) {
    return [...this.mediaSessionVersions.values()]
      .filter((version) => version.sessionId === sessionId)
      .sort(descendingCreatedAt);
  }

  private messagesForSession(sessionId: string, limit = 80) {
    const messages = [...this.mediaSessionMessages.values()]
      .filter((message) => message.sessionId === sessionId)
      .sort(ascendingCreatedAt);
    return limit > 0 ? messages.slice(Math.max(0, messages.length - limit)) : messages;
  }
}

class PostgresStore implements VideoStore {
  async listProjects(userId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from projects where user_id = ${userId} order by created_at desc`) as Array<Record<string, unknown>>;
    return rows.map(fromProjectRow);
  }

  async createProject(input: ProjectInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    await sql`insert into users (id, email, plan_tier, daily_budget_cents)
      values (${input.userId}, 'dev@local.test', 'dev', 5000)
      on conflict (id) do nothing`;
    const rows = (await sql`insert into projects (id, user_id, name)
      values (${id}, ${input.userId}, ${input.name})
      returning *`) as Array<Record<string, unknown>>;
    return fromProjectRow(rows[0]);
  }

  async getProject(projectId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from projects where id = ${projectId}`) as Array<Record<string, unknown>>;
    return rows[0] ? fromProjectRow(rows[0]) : null;
  }

  async listBetaAccessRequests(status?: BetaAccessRequest["status"]) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = status
      ? (await sql`select * from beta_access_requests where status = ${status} order by updated_at desc`) as Array<Record<string, unknown>>
      : (await sql`select * from beta_access_requests order by updated_at desc`) as Array<Record<string, unknown>>;
    return rows.map(fromBetaAccessRequestRow);
  }

  async createBetaAccessRequest(input: BetaAccessRequestInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const existing = await this.findBetaAccessRequest(input);
    if (existing) {
      const updated = (await sql`update beta_access_requests set
        name = coalesce(${input.name ?? null}, name),
        note = coalesce(${input.note ?? null}, note),
        ip_hash = coalesce(${input.ipHash ?? null}, ip_hash),
        user_agent = coalesce(${input.userAgent ?? null}, user_agent),
        updated_at = now()
        where id = ${existing.id}
        returning *`) as Array<Record<string, unknown>>;
      return fromBetaAccessRequestRow(updated[0]);
    }
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into beta_access_requests (
      id, name, email, phone, note, ip_hash, user_agent, invite_code_id, status
    ) values (
      ${id}, ${input.name ?? null}, ${normalizeEmail(input.email) ?? null}, ${input.phone ?? null},
      ${input.note ?? null}, ${input.ipHash ?? null}, ${input.userAgent ?? null},
      ${input.inviteCodeId ?? null}, ${input.status ?? "pending"}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromBetaAccessRequestRow(rows[0]);
  }

  async updateBetaAccessRequest(id: string, patch: BetaAccessRequestPatch) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`update beta_access_requests set
      status = coalesce(${patch.status ?? null}, status),
      invite_code_id = coalesce(${patch.inviteCodeId ?? null}, invite_code_id),
      updated_at = now()
      where id = ${id}
      returning *`) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new Error(`Beta access request not found: ${id}`);
    return fromBetaAccessRequestRow(rows[0]);
  }

  async findApprovedBetaAccess(identity: { email?: string; phone?: string }) {
    return this.findBetaAccessRequest(identity, "approved");
  }

  async findRecentBetaAccessRequestByIpHash(ipHash: string, sinceIso: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from beta_access_requests
      where ip_hash = ${ipHash} and created_at >= ${sinceIso}
      order by created_at desc
      limit 1`) as Array<Record<string, unknown>>;
    return rows[0] ? fromBetaAccessRequestRow(rows[0]) : null;
  }

  async createBetaInviteCode(input: BetaInviteCodeInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into beta_invite_codes (
      id, access_request_id, code_hash, email, phone, expires_at
    ) values (
      ${id}, ${input.accessRequestId ?? null}, ${input.codeHash}, ${normalizeEmail(input.email) ?? null},
      ${input.phone ?? null}, ${input.expiresAt}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromBetaInviteCodeRow(rows[0]);
  }

  async consumeBetaInviteCode(codeHash: string, consumedBy: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`update beta_invite_codes set
      consumed_at = now(),
      consumed_by = ${consumedBy},
      updated_at = now()
      where code_hash = ${codeHash}
        and consumed_at is null
        and revoked_at is null
        and expires_at > now()
      returning *`) as Array<Record<string, unknown>>;
    return rows[0] ? fromBetaInviteCodeRow(rows[0]) : null;
  }

  async revokeInviteCodesForAccessRequest(accessRequestId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    await sql`update beta_invite_codes set revoked_at = now(), updated_at = now()
      where access_request_id = ${accessRequestId}
        and consumed_at is null
        and revoked_at is null`;
  }

  async getActiveInviteCodeForAccessRequest(accessRequestId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from beta_invite_codes
      where access_request_id = ${accessRequestId}
        and consumed_at is null
        and revoked_at is null
        and expires_at > now()
      order by created_at desc
      limit 1`) as Array<Record<string, unknown>>;
    return rows[0] ? fromBetaInviteCodeRow(rows[0]) : null;
  }

  async createProviderAuditEvent(input: ProviderAuditEventInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into provider_audit_events (
      id, user_id, project_id, video_job_id, media_generation_id, media_session_id,
      provider, model, status, estimated_cost_cents, actual_cost_cents,
      daily_spent_cents, daily_budget_cents, global_spent_cents, global_budget_cents,
      request_id, idempotency_key, billing_key, error, metadata
    ) values (
      ${id}, ${input.userId}, ${input.projectId ?? null}, ${input.videoJobId ?? null},
      ${input.mediaGenerationId ?? null}, ${input.mediaSessionId ?? null},
      ${input.provider}, ${input.model}, ${input.status}, ${input.estimatedCostCents},
      ${input.actualCostCents}, ${input.dailySpentCents ?? null}, ${input.dailyBudgetCents ?? null},
      ${input.globalSpentCents ?? null}, ${input.globalBudgetCents ?? null}, ${input.requestId ?? null},
      ${input.idempotencyKey ?? null}, ${input.billingKey ?? null}, ${input.error ?? null}, ${JSON.stringify(input.metadata)}::jsonb
    ) on conflict do nothing returning *`) as Array<Record<string, unknown>>;
    if (rows[0]) return fromProviderAuditEventRow(rows[0]);
    if (input.billingKey) {
      const existing = (await sql`select * from provider_audit_events where billing_key = ${input.billingKey} limit 1`) as Array<Record<string, unknown>>;
      if (existing[0]) return fromProviderAuditEventRow(existing[0]);
    }
    throw new Error("Provider audit event could not be persisted.");
  }

  async listProviderAuditEvents(limit = 100) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from provider_audit_events
      order by created_at desc
      limit ${limit}`) as Array<Record<string, unknown>>;
    return rows.map(fromProviderAuditEventRow);
  }

  async createBetaFeedback(input: BetaFeedbackInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    await sql`insert into users (id, email, plan_tier, daily_budget_cents)
      values (${input.userId}, 'dev@local.test', 'dev', 5000)
      on conflict (id) do nothing`;
    const rows = (await sql`insert into beta_feedback (
      id, user_id, project_id, video_job_id, media_session_id, kind, message, status, metadata
    ) values (
      ${id}, ${input.userId}, ${input.projectId ?? null}, ${input.videoJobId ?? null},
      ${input.mediaSessionId ?? null}, ${input.kind}, ${input.message}, ${input.status ?? "open"},
      ${JSON.stringify(input.metadata)}::jsonb
    ) returning *`) as Array<Record<string, unknown>>;
    return fromBetaFeedbackRow(rows[0]);
  }

  async listBetaFeedback(limit = 100) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from beta_feedback
      order by updated_at desc
      limit ${limit}`) as Array<Record<string, unknown>>;
    return rows.map(fromBetaFeedbackRow);
  }

  async updateBetaFeedback(id: string, patch: BetaFeedbackPatch) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`update beta_feedback set
      status = coalesce(${patch.status ?? null}, status),
      updated_at = now()
      where id = ${id}
      returning *`) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new Error(`Beta feedback not found: ${id}`);
    return fromBetaFeedbackRow(rows[0]);
  }

  async createJob(request: VideoCreateRequest, user: UserContext, existingProjectId?: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const estimate = estimateInitialCost(request);
    const videoId = randomUUID();
    const projectId = existingProjectId ?? randomUUID();
    const traceId = createTraceId();
    const now = nowIso();
    const phases = PHASES.map(({ phaseNumber, name }) => ({
      phaseNumber,
      name,
      state: "pending" as const,
    }));

    await sql`insert into users (id, email, plan_tier, daily_budget_cents)
      values (${user.id}, ${user.email}, ${user.planTier}, ${user.dailyBudgetCents})
      on conflict (id) do update set email = excluded.email`;
    if (existingProjectId) {
      const projectRows = (await sql`select id from projects where id = ${projectId} and user_id = ${user.id}`) as Array<Record<string, unknown>>;
      if (!projectRows[0]) throw new Error("Project not found");
    } else {
      await sql`insert into projects (id, user_id, name)
        values (${projectId}, ${user.id}, 'Cocoa Director')`;
    }
    await sql`insert into video_jobs (
      id, project_id, user_id, status, current_phase, prompt, estimated_cost_cents,
      actual_cost_cents, recovery_budget_cents, recovery_spent_cents, aspect_ratio, visual_mode, duration_seconds, trace_id, cancellation_requested,
      music_controls, seeds
    ) values (
      ${videoId}, ${projectId}, ${user.id}, 'pending', 1, ${request.prompt},
      ${cents(estimate.totalUsd)}, 0, 0, 0, ${request.aspectRatio}, ${request.visualMode}, ${request.durationSeconds},
      ${traceId}, false,
      ${JSON.stringify(request.musicControls ?? null)}::jsonb,
      ${JSON.stringify(request.seeds ?? { subjects: [], aesthetic: [] })}::jsonb
    )`;

    for (const phase of phases) {
      await sql`insert into workflow_phases (id, video_job_id, phase_number, name, state)
        values (${randomUUID()}, ${videoId}, ${phase.phaseNumber}, ${phase.name}, ${phase.state})`;
    }

    const job: VideoJob = {
      id: videoId,
      projectId,
      userId: user.id,
      prompt: request.prompt,
      status: "pending",
      currentPhase: 1,
      estimatedCostCents: cents(estimate.totalUsd),
      actualCostCents: 0,
      recoveryBudgetCents: 0,
      recoverySpentCents: 0,
      aspectRatio: request.aspectRatio,
      contentType: "music_video",
      qualityTier: "standard",
      workflowVersion: "music-video-v1",
      visualMode: request.visualMode,
      durationSeconds: request.durationSeconds,
      traceId,
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      musicControls: request.musicControls,
      seeds: request.seeds ?? { subjects: [], aesthetic: [] },
      anchorAssets: [],
      generatedShots: [],
      editDirectives: [],
      artifactVersions: [],
      approvals: [],
      phases,
      providerCalls: [],
    };
    return job;
  }

  async getJob(videoId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from video_jobs where id = ${videoId}`) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;

    const phaseRows = (await sql`select * from workflow_phases where video_job_id = ${videoId} order by phase_number`) as Array<Record<string, unknown>>;
    const providerRows = (await sql`select * from provider_calls where video_job_id = ${videoId} order by created_at`) as Array<Record<string, unknown>>;
    const workflowStepRows = (await sql`select * from workflow_steps where video_job_id = ${videoId}`) as Array<Record<string, unknown>>;

    return fromDbRow(row, phaseRows, providerRows, workflowStepRows);
  }

  async listProjectJobs(projectId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select id from video_jobs where project_id = ${projectId} order by updated_at desc`) as Array<Record<string, unknown>>;
    const jobs = await Promise.all(rows.map((row) => this.getJob(String(row.id))));
    return jobs.filter((job): job is VideoJob => Boolean(job));
  }

  async updateJob(videoId: string, patch: JobPatch) {
    return this.mutateJob(videoId, () => patch);
  }

  async mutateJob(videoId: string, mutate: (job: VideoJob) => JobPatch) {
    await ensureDatabaseSchema();
    return withTransaction(async (sql) => {
      await sql`select id from video_jobs where id = ${videoId} for update`;
      const existing = await requireJob(this, videoId);
      const next = mergeJobPatch(existing, mutate(structuredClone(existing)));
      await sql`update video_jobs set
      status = ${next.status},
      current_phase = ${next.currentPhase},
      prompt = ${next.prompt},
      duration_seconds = ${next.durationSeconds},
      aspect_ratio = ${next.aspectRatio},
      actual_cost_cents = ${next.actualCostCents},
      recovery_budget_cents = ${next.recoveryBudgetCents},
      recovery_spent_cents = ${next.recoverySpentCents},
      estimated_cost_cents = ${next.estimatedCostCents},
      content_type = ${next.contentType ?? "music_video"},
      quality_tier = ${next.qualityTier ?? "standard"},
      workflow_version = ${next.workflowVersion ?? "music-video-v1"},
      source_bundle = ${JSON.stringify(next.sourceBundle ?? null)}::jsonb,
      digest_mode = ${next.digestMode ?? null},
      research_mode = ${next.researchMode ?? null},
      presentation_mode = ${next.presentationMode ?? null},
      visual_style_preset = ${next.visualStylePreset ?? "auto"},
      visual_plan = ${JSON.stringify(next.visualPlan ?? null)}::jsonb,
      editorial_plan = ${JSON.stringify(next.editorialPlan ?? null)}::jsonb,
      duration_plan = ${JSON.stringify(next.durationPlan ?? null)}::jsonb,
      storyboard = ${JSON.stringify(next.storyboard ?? null)}::jsonb,
      approvals = ${JSON.stringify(next.approvals ?? [])}::jsonb,
      timeline_manifest = ${JSON.stringify(next.timelineManifest ?? null)}::jsonb,
      qa_report = ${JSON.stringify(next.qaReport ?? null)}::jsonb,
      script = ${next.script ?? null},
      narration_asset_id = ${next.narrationAssetId ?? null},
      visual_mode = ${next.visualMode},
      seeds = ${JSON.stringify(next.seeds ?? { subjects: [], aesthetic: [] })}::jsonb,
      cancellation_requested = ${next.cancellationRequested},
      error = ${next.error ?? null},
      creative_brief = ${JSON.stringify(next.creativeBrief ?? null)}::jsonb,
      music_plan = ${JSON.stringify(next.musicPlan ?? null)}::jsonb,
      music_track = ${JSON.stringify(next.musicTrack ?? null)}::jsonb,
      beat_grid = ${JSON.stringify(next.beatGrid ?? null)}::jsonb,
      anchor_assets = ${JSON.stringify(next.anchorAssets)}::jsonb,
      shot_plan = ${JSON.stringify(next.shotPlan ?? null)}::jsonb,
      generated_shots = ${JSON.stringify(next.generatedShots)}::jsonb,
      render_manifest = ${JSON.stringify(next.renderManifest ?? null)}::jsonb,
      final_video_url = ${next.finalVideoUrl ?? null},
      thumbnail_url = ${next.thumbnailUrl ?? null},
      prompt_trace = ${JSON.stringify(next.promptTrace ?? null)}::jsonb,
      edit_directives = ${JSON.stringify(next.editDirectives)}::jsonb,
      artifact_versions = ${JSON.stringify(next.artifactVersions)}::jsonb,
      updated_at = now()
      where id = ${videoId}`;
      if (next.workflowSteps) {
        for (const step of next.workflowSteps) {
          const startedAt = step.startedAt ? databaseTimestamp(step.startedAt) : null;
          const completedAt = step.completedAt ? databaseTimestamp(step.completedAt) : null;
          await sql`insert into workflow_steps (
          id, video_job_id, step_id, name, state, depends_on, artifact_version_id,
          started_at, completed_at, error
        ) values (
          ${randomUUID()}, ${videoId}, ${step.id}, ${step.name}, ${step.state},
          ${JSON.stringify(step.dependsOn)}::jsonb, ${step.artifactVersionId ?? null},
          ${startedAt}, ${completedAt}, ${step.error ?? null}
        ) on conflict (video_job_id, step_id) do update set
          name = excluded.name,
          state = excluded.state,
          depends_on = excluded.depends_on,
          artifact_version_id = excluded.artifact_version_id,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          error = excluded.error`;
        }
      }
      return next;
    });
  }

  async updatePhase(videoId: string, phaseNumber: PhaseNumber, patch: Partial<WorkflowPhase>) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const shouldSetState = Object.prototype.hasOwnProperty.call(patch, "state");
    const shouldSetStartedAt = Object.prototype.hasOwnProperty.call(patch, "startedAt");
    const shouldSetCompletedAt = Object.prototype.hasOwnProperty.call(patch, "completedAt");
    const shouldSetArtifactUrl = Object.prototype.hasOwnProperty.call(patch, "artifactUrl");
    const shouldSetError = Object.prototype.hasOwnProperty.call(patch, "error");
    await sql`update workflow_phases set
      state = case when ${shouldSetState} then ${patch.state ?? null} else state end,
      started_at = case when ${shouldSetStartedAt} then ${patch.startedAt ? databaseTimestamp(patch.startedAt) : null} else started_at end,
      completed_at = case when ${shouldSetCompletedAt} then ${patch.completedAt ? databaseTimestamp(patch.completedAt) : null} else completed_at end,
      artifact_url = case when ${shouldSetArtifactUrl} then ${patch.artifactUrl ?? null} else artifact_url end,
      error = case when ${shouldSetError} then ${patch.error ?? null} else error end
      where video_job_id = ${videoId} and phase_number = ${phaseNumber}
      and exists (select 1 from video_jobs where id = ${videoId} and not cancellation_requested and status <> 'cancelled')`;
    const job = await this.getJob(videoId);
    if (!job) throw new Error(`Video job not found: ${videoId}`);
    return job;
  }

  async addProviderCall(call: Omit<ProviderCall, "id" | "createdAt">) {
    await ensureDatabaseSchema();
    return withTransaction(async (sql) => {
    const id = randomUUID();
    const inserted = (await sql`insert into provider_calls (
      id, video_job_id, phase_number, provider, model, request_id, idempotency_key,
      latency_ms, cost_cents, status, error, metadata
    ) values (
      ${id}, ${call.videoJobId}, ${call.phaseNumber}, ${call.provider}, ${call.model},
      ${call.requestId}, ${call.idempotencyKey}, ${call.latencyMs}, ${call.costCents},
      ${call.status}, ${call.error ?? null}, ${JSON.stringify(call.metadata ?? {})}::jsonb
    ) on conflict (video_job_id, idempotency_key) do nothing returning id`) as Array<Record<string, unknown>>;
    if (inserted.length > 0) {
      await sql`update video_jobs set actual_cost_cents = actual_cost_cents + ${call.costCents}, updated_at = now()
        where id = ${call.videoJobId}`;
    }
    const job = await this.getJob(call.videoJobId);
    if (!job) throw new Error(`Video job not found: ${call.videoJobId}`);
    if (inserted.length > 0) {
      await this.createProviderAuditEvent({
        userId: job.userId,
        projectId: job.projectId,
        videoJobId: job.id,
        provider: call.provider,
        model: call.model,
        status: call.status === "success" ? "success" : call.status === "failed" ? "failed" : "submitted",
        estimatedCostCents: call.costCents,
        actualCostCents: call.status === "success" ? call.costCents : 0,
        requestId: call.requestId,
        idempotencyKey: call.idempotencyKey,
        billingKey: call.status === "success" ? `provider-call:${call.idempotencyKey}` : undefined,
        error: call.error,
        metadata: { phaseNumber: call.phaseNumber, source: "pipeline_provider_call", ...call.metadata },
      });
    }
    return job;
    });
  }

  async listLibraryAssets(userId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from library_assets where user_id = ${userId} and deleted_at is null order by created_at desc`) as Array<Record<string, unknown>>;
    return rows.map(fromLibraryAssetRow);
  }

  async createLibraryAsset(input: LibraryAssetInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    await sql`insert into users (id, email, plan_tier, daily_budget_cents)
      values (${input.userId}, 'dev@local.test', 'dev', 5000)
      on conflict (id) do nothing`;
    const rows = (await sql`insert into library_assets (
      id, user_id, kind, name, role, url, mime_type, source, tags, metadata, favorite_at
    ) values (
      ${id}, ${input.userId}, ${input.kind}, ${input.name}, ${input.role}, ${input.url},
      ${input.mimeType}, ${input.source}, ${JSON.stringify(input.tags)}::jsonb,
      ${JSON.stringify(input.metadata)}::jsonb, ${input.favoriteAt ?? null}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromLibraryAssetRow(rows[0]);
  }

  async getLibraryAsset(userId: string, assetId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from library_assets where user_id = ${userId} and id = ${assetId} and deleted_at is null`) as Array<Record<string, unknown>>;
    return rows[0] ? fromLibraryAssetRow(rows[0]) : null;
  }

  async updateLibraryAsset(userId: string, assetId: string, patch: LibraryAssetPatch) {
    await ensureDatabaseSchema();
    const existing = await this.getLibraryAsset(userId, assetId);
    if (!existing) return null;
    const sql = getSql();
    const favoriteAt = hasOwn(patch, "favoriteAt") ? patch.favoriteAt ?? null : existing.favoriteAt ?? null;
    const rows = (await sql`update library_assets set
      name = ${patch.name ?? existing.name},
      tags = ${JSON.stringify(patch.tags ?? existing.tags)}::jsonb,
      metadata = ${JSON.stringify(patch.metadata ?? existing.metadata)}::jsonb,
      favorite_at = ${favoriteAt}
      where user_id = ${userId} and id = ${assetId} and deleted_at is null
      returning *`) as Array<Record<string, unknown>>;
    return rows[0] ? fromLibraryAssetRow(rows[0]) : null;
  }

  async deleteLibraryAsset(userId: string, assetId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`update library_assets set deleted_at = now()
      where user_id = ${userId} and id = ${assetId} and deleted_at is null
      returning *`) as Array<Record<string, unknown>>;
    return rows[0] ? fromLibraryAssetRow(rows[0]) : null;
  }

  async listLibraryCollections(userId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const collectionRows = (await sql`select * from library_collections
      where user_id = ${userId} and archived_at is null
      order by updated_at desc, created_at desc`) as Array<Record<string, unknown>>;
    const assetRows = (await sql`select collection_id, library_asset_id from library_collection_assets
      where collection_id in (
        select id from library_collections where user_id = ${userId} and archived_at is null
      )
      order by created_at desc`) as Array<Record<string, unknown>>;
    return hydrateLibraryCollectionRows(collectionRows, assetRows);
  }

  async getLibraryCollection(userId: string, collectionId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const collectionRows = (await sql`select * from library_collections
      where user_id = ${userId} and id = ${collectionId} and archived_at is null`) as Array<Record<string, unknown>>;
    if (!collectionRows[0]) return null;
    const assetRows = (await sql`select collection_id, library_asset_id from library_collection_assets
      where collection_id = ${collectionId}
      order by created_at desc`) as Array<Record<string, unknown>>;
    return hydrateLibraryCollectionRows(collectionRows, assetRows)[0] ?? null;
  }

  async createLibraryCollection(input: LibraryCollectionInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    await sql`insert into users (id, email, plan_tier, daily_budget_cents)
      values (${input.userId}, 'dev@local.test', 'dev', 5000)
      on conflict (id) do nothing`;
    const rows = (await sql`insert into library_collections (
      id, user_id, name, metadata
    ) values (
      ${id}, ${input.userId}, ${input.name}, ${JSON.stringify(input.metadata)}::jsonb
    ) returning *`) as Array<Record<string, unknown>>;
    for (const assetId of input.assetIds ?? []) {
      await this.addLibraryAssetToCollection(input.userId, id, assetId);
    }
    return (await this.getLibraryCollection(input.userId, id)) ?? fromLibraryCollectionRow(rows[0], []);
  }

  async updateLibraryCollection(userId: string, collectionId: string, patch: LibraryCollectionPatch) {
    await ensureDatabaseSchema();
    const existing = await this.getLibraryCollection(userId, collectionId);
    if (!existing) return null;
    const sql = getSql();
    const archivedAt = patch.archived ? nowIso() : existing.archivedAt ?? null;
    const rows = (await sql`update library_collections set
      name = ${patch.name ?? existing.name},
      metadata = ${JSON.stringify(patch.metadata ?? existing.metadata)}::jsonb,
      archived_at = ${archivedAt},
      updated_at = now()
      where user_id = ${userId} and id = ${collectionId} and archived_at is null
      returning *`) as Array<Record<string, unknown>>;
    if (!rows[0] || patch.archived) return null;
    return this.getLibraryCollection(userId, collectionId);
  }

  async addLibraryAssetToCollection(userId: string, collectionId: string, assetId: string) {
    await ensureDatabaseSchema();
    const [collection, asset] = await Promise.all([
      this.getLibraryCollection(userId, collectionId),
      this.getLibraryAsset(userId, assetId),
    ]);
    if (!collection || !asset) return null;
    const sql = getSql();
    await sql`insert into library_collection_assets (
      id, collection_id, library_asset_id
    ) values (
      ${randomUUID()}, ${collectionId}, ${assetId}
    ) on conflict (collection_id, library_asset_id) do nothing`;
    await sql`update library_collections set updated_at = now() where user_id = ${userId} and id = ${collectionId}`;
    return this.getLibraryCollection(userId, collectionId);
  }

  async removeLibraryAssetFromCollection(userId: string, collectionId: string, assetId: string) {
    await ensureDatabaseSchema();
    const collection = await this.getLibraryCollection(userId, collectionId);
    if (!collection) return null;
    const sql = getSql();
    await sql`delete from library_collection_assets where collection_id = ${collectionId} and library_asset_id = ${assetId}`;
    await sql`update library_collections set updated_at = now() where user_id = ${userId} and id = ${collectionId}`;
    return this.getLibraryCollection(userId, collectionId);
  }

  async createProjectAssetLink(input: ProjectAssetLinkInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const existing = (await sql`select * from project_asset_links
      where project_id = ${input.projectId} and library_asset_id = ${input.libraryAssetId}
      limit 1`) as Array<Record<string, unknown>>;
    if (existing[0]) return fromProjectAssetLinkRow(existing[0]);
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into project_asset_links (
      id, project_id, library_asset_id, media_asset_id
    ) values (
      ${id}, ${input.projectId}, ${input.libraryAssetId}, ${input.mediaAssetId}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromProjectAssetLinkRow(rows[0]);
  }

  async listProjectAssetLinks(projectId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from project_asset_links where project_id = ${projectId} order by created_at desc`) as Array<Record<string, unknown>>;
    return rows.map(fromProjectAssetLinkRow);
  }

  async listProjectMedia(projectId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const generationRows = (await sql`select * from media_generations where project_id = ${projectId} order by created_at desc`) as Array<Record<string, unknown>>;
    const assetRows = (await sql`select * from media_assets where project_id = ${projectId} and deleted_at is null order by created_at desc`) as Array<Record<string, unknown>>;
    return {
      generations: generationRows.map(fromMediaGenerationRow),
      assets: assetRows.map(fromMediaAssetRow),
    };
  }

  async listJobMedia(videoJobId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const generationRows = (await sql`select * from media_generations where video_job_id = ${videoJobId} order by created_at desc`) as Array<Record<string, unknown>>;
    const assetRows = (await sql`select * from media_assets where video_job_id = ${videoJobId} and deleted_at is null order by created_at desc`) as Array<Record<string, unknown>>;
    return {
      generations: generationRows.map(fromMediaGenerationRow),
      assets: assetRows.map(fromMediaAssetRow),
    };
  }

  async getMediaGeneration(projectId: string, generationId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from media_generations where project_id = ${projectId} and id = ${generationId}`) as Array<Record<string, unknown>>;
    return rows[0] ? fromMediaGenerationRow(rows[0]) : null;
  }

  async createMediaGeneration(input: MediaGenerationInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into media_generations (
      id, project_id, video_job_id, kind, provider, model, status, prompt, controls,
      input_asset_ids, output_urls, metadata, cost_cents, request_id, error
    ) values (
      ${id}, ${input.projectId}, ${input.videoJobId ?? null}, ${input.kind}, ${input.provider},
      ${input.model}, ${input.status}, ${input.prompt}, ${JSON.stringify(input.controls)}::jsonb,
      ${JSON.stringify(input.inputAssetIds)}::jsonb, ${JSON.stringify(input.outputUrls)}::jsonb,
      ${JSON.stringify(input.metadata)}::jsonb, ${input.costCents}, ${input.requestId ?? null},
      ${input.error ?? null}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromMediaGenerationRow(rows[0]);
  }

  async updateMediaGeneration(generationId: string, patch: MediaGenerationPatch) {
    await ensureDatabaseSchema();
    return withTransaction(async (sql) => {
    const rows = (await sql`select * from media_generations where id = ${generationId} for update`) as Array<Record<string, unknown>>;
    const existing = rows[0] ? fromMediaGenerationRow(rows[0]) : null;
    if (!existing) throw new Error(`Media generation not found: ${generationId}`);
    const next = { ...existing, ...patch, updatedAt: nowIso() };
    const updated = (await sql`update media_generations set
      status = ${next.status},
      model = ${next.model},
      prompt = ${next.prompt},
      controls = ${JSON.stringify(next.controls)}::jsonb,
      input_asset_ids = ${JSON.stringify(next.inputAssetIds)}::jsonb,
      output_urls = ${JSON.stringify(next.outputUrls)}::jsonb,
      metadata = ${JSON.stringify(next.metadata)}::jsonb,
      cost_cents = ${next.costCents},
      request_id = ${next.requestId ?? null},
      error = ${next.error ?? null},
      updated_at = now()
      where id = ${generationId}
      returning *`) as Array<Record<string, unknown>>;
    const costDelta = next.costCents - existing.costCents;
    if (costDelta !== 0 && next.videoJobId) {
      await sql`update video_jobs
        set actual_cost_cents = greatest(0, actual_cost_cents + ${costDelta}), updated_at = now()
        where id = ${next.videoJobId}`;
    }
    return fromMediaGenerationRow(updated[0]);
    });
  }

  async createMediaAsset(input: MediaAssetInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into media_assets (
      id, project_id, video_job_id, generation_id, kind, role, url, mime_type, metadata
    ) values (
      ${id}, ${input.projectId}, ${input.videoJobId ?? null}, ${input.generationId ?? null},
      ${input.kind}, ${input.role}, ${input.url}, ${input.mimeType}, ${JSON.stringify(input.metadata)}::jsonb
    ) returning *`) as Array<Record<string, unknown>>;
    return fromMediaAssetRow(rows[0]);
  }

  async getMediaAsset(projectId: string, assetId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from media_assets where project_id = ${projectId} and id = ${assetId} and deleted_at is null`) as Array<Record<string, unknown>>;
    return rows[0] ? fromMediaAssetRow(rows[0]) : null;
  }

  async deleteMediaAsset(projectId: string, assetId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`update media_assets set deleted_at = now()
      where project_id = ${projectId} and id = ${assetId} and deleted_at is null
      returning *`) as Array<Record<string, unknown>>;
    return rows[0] ? fromMediaAssetRow(rows[0]) : null;
  }

  async createProductionWorkflowRun(input: ProductionWorkflowRunInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into production_workflow_runs (
      id, production_id, run_id, kind, workflow_version, state, recovery_token,
      error_code, error, metadata, started_at, heartbeat_at, completed_at
    ) values (
      ${id}, ${input.productionId}, ${input.runId}, ${input.kind}, ${input.workflowVersion},
      ${input.state}, ${input.recoveryToken ?? null}, ${input.errorCode ?? null}, ${input.error ?? null},
      ${JSON.stringify(input.metadata)}::jsonb, ${databaseTimestamp(input.startedAt)},
      ${databaseTimestamp(input.heartbeatAt)}, ${input.completedAt ? databaseTimestamp(input.completedAt) : null}
    ) on conflict (run_id) do update set heartbeat_at = excluded.heartbeat_at returning *`) as Array<Record<string, unknown>>;
    return fromProductionWorkflowRunRow(rows[0]);
  }

  async updateProductionWorkflowRun(runId: string, patch: ProductionWorkflowRunPatch) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from production_workflow_runs where run_id = ${runId}`) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new Error(`Production workflow run not found: ${runId}`);
    const existing = fromProductionWorkflowRunRow(rows[0]);
    const next = { ...existing, ...patch };
    const updated = (await sql`update production_workflow_runs set
      state = ${next.state},
      recovery_token = ${next.recoveryToken ?? null},
      error_code = ${next.errorCode ?? null},
      error = ${next.error ?? null},
      metadata = ${JSON.stringify(next.metadata)}::jsonb,
      heartbeat_at = ${databaseTimestamp(next.heartbeatAt)},
      completed_at = ${next.completedAt ? databaseTimestamp(next.completedAt) : null}
      where run_id = ${runId} returning *`) as Array<Record<string, unknown>>;
    return fromProductionWorkflowRunRow(updated[0]);
  }

  async listProductionWorkflowRuns(productionId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from production_workflow_runs where production_id = ${productionId} order by started_at desc`) as Array<Record<string, unknown>>;
    return rows.map(fromProductionWorkflowRunRow);
  }

  async reconcileJobActualCost(videoJobId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const job = await requireJob(this, videoJobId);
    const mediaRows = (await sql`select * from media_generations where video_job_id = ${videoJobId} and status = 'success' and cost_cents > 0`) as Array<Record<string, unknown>>;
    const auditRows = (await sql`select * from provider_audit_events where video_job_id = ${videoJobId}`) as Array<Record<string, unknown>>;
    const audits = auditRows.map(fromProviderAuditEventRow);
    for (const row of mediaRows) {
      const generation = fromMediaGenerationRow(row);
      if (audits.some((event) => event.mediaGenerationId === generation.id && event.status === "success")) continue;
      await this.createProviderAuditEvent({
        userId: job.userId, projectId: job.projectId, videoJobId, mediaGenerationId: generation.id,
        provider: generation.provider, model: generation.model, status: "success",
        estimatedCostCents: generation.costCents, actualCostCents: generation.costCents,
        requestId: generation.requestId, billingKey: `media-generation:${generation.id}`,
        metadata: { source: "legacy_media_reconciliation" },
      });
    }
    for (const call of job.providerCalls.filter((item) => item.status === "success" && item.costCents > 0)) {
      if (audits.some((event) => event.idempotencyKey === call.idempotencyKey && event.status === "success")) continue;
      await this.createProviderAuditEvent({
        userId: job.userId, projectId: job.projectId, videoJobId,
        provider: call.provider, model: call.model, status: "success",
        estimatedCostCents: call.costCents, actualCostCents: call.costCents,
        requestId: call.requestId, idempotencyKey: call.idempotencyKey,
        billingKey: `provider-call:${call.idempotencyKey}`,
        metadata: { source: "legacy_provider_call_reconciliation" },
      });
    }
    await sql`update video_jobs set actual_cost_cents = coalesce((
      select sum(actual_cost_cents) from provider_audit_events
      where video_job_id = ${videoJobId} and status = 'success'
    ), 0), updated_at = now() where id = ${videoJobId}`;
    return requireJob(this, videoJobId);
  }

  async listMediaSessions(projectId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const sessionRows = (await sql`select * from media_sessions where project_id = ${projectId} and status <> 'archived' order by updated_at desc`) as Array<Record<string, unknown>>;
    const versionsBySession = new Map<string, MediaSessionVersion[]>();
    const messagesBySession = new Map<string, MediaSessionMessage[]>();
    const sessions = sessionRows.map(fromMediaSessionRow);
    for (const session of sessions) {
      const versionRows = (await sql`select * from media_session_versions where session_id = ${session.id} order by created_at desc`) as Array<Record<string, unknown>>;
      const messageRows = (await sql`select * from (
        select * from media_session_messages where session_id = ${session.id} order by created_at desc limit 40
      ) recent_messages order by created_at asc`) as Array<Record<string, unknown>>;
      versionsBySession.set(session.id, versionRows.map(fromMediaSessionVersionRow));
      messagesBySession.set(session.id, messageRows.map(fromMediaSessionMessageRow));
    }
    return sessions.map((session) => ({
      ...session,
      versions: versionsBySession.get(session.id) ?? [],
      messages: messagesBySession.get(session.id) ?? [],
    }));
  }

  async createMediaSession(input: MediaSessionInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into media_sessions (
      id, project_id, kind, title, status, source_asset_id, current_asset_id, goal, settings
    ) values (
      ${id}, ${input.projectId}, ${input.kind}, ${input.title}, ${input.status ?? "active"},
      ${input.sourceAssetId ?? null}, ${input.currentAssetId ?? null}, ${input.goal ?? null},
      ${JSON.stringify(input.settings)}::jsonb
    ) returning *`) as Array<Record<string, unknown>>;
    return fromMediaSessionRow(rows[0]);
  }

  async getMediaSession(projectId: string, sessionId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from media_sessions where project_id = ${projectId} and id = ${sessionId}`) as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const versionRows = (await sql`select * from media_session_versions where session_id = ${sessionId} order by created_at desc`) as Array<Record<string, unknown>>;
    const messageRows = (await sql`select * from (
      select * from media_session_messages where session_id = ${sessionId} order by created_at desc limit 80
    ) recent_messages order by created_at asc`) as Array<Record<string, unknown>>;
    return {
      ...fromMediaSessionRow(rows[0]),
      versions: versionRows.map(fromMediaSessionVersionRow),
      messages: messageRows.map(fromMediaSessionMessageRow),
    };
  }

  async updateMediaSession(sessionId: string, patch: MediaSessionPatch) {
    await ensureDatabaseSchema();
    return withTransaction(async (sql) => {
    const rows = (await sql`select * from media_sessions where id = ${sessionId} for update`) as Array<Record<string, unknown>>;
    const existing = rows[0] ? fromMediaSessionRow(rows[0]) : null;
    if (!existing) throw new Error(`Media session not found: ${sessionId}`);
    const next = { ...existing, ...patch, updatedAt: nowIso() };
    const updated = (await sql`update media_sessions set
      title = ${next.title},
      status = ${next.status},
      source_asset_id = ${next.sourceAssetId ?? null},
      current_asset_id = ${next.currentAssetId ?? null},
      goal = ${next.goal ?? null},
      settings = ${JSON.stringify(next.settings)}::jsonb,
      updated_at = now()
      where id = ${sessionId}
      returning *`) as Array<Record<string, unknown>>;
    return fromMediaSessionRow(updated[0]);
    });
  }

  async archiveMediaSession(projectId: string, sessionId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`update media_sessions set
      status = 'archived',
      updated_at = now()
      where project_id = ${projectId} and id = ${sessionId}
      returning *`) as Array<Record<string, unknown>>;
    return rows[0] ? fromMediaSessionRow(rows[0]) : null;
  }

  async createMediaSessionVersion(input: MediaSessionVersionInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into media_session_versions (
      id, session_id, asset_id, generation_id, label, prompt, controls, parent_version_id, notes
    ) values (
      ${id}, ${input.sessionId}, ${input.assetId}, ${input.generationId ?? null}, ${input.label},
      ${input.prompt ?? null}, ${JSON.stringify(input.controls)}::jsonb,
      ${input.parentVersionId ?? null}, ${input.notes ?? null}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromMediaSessionVersionRow(rows[0]);
  }

  async getMediaSessionVersion(sessionId: string, versionId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from media_session_versions where session_id = ${sessionId} and id = ${versionId}`) as Array<Record<string, unknown>>;
    return rows[0] ? fromMediaSessionVersionRow(rows[0]) : null;
  }

  async createMediaSessionMessage(input: MediaSessionMessageInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into media_session_messages (
      id, session_id, role, content, proposal, generation_id, version_id, action_id
    ) values (
      ${id}, ${input.sessionId}, ${input.role}, ${input.content},
      ${JSON.stringify(input.proposal ?? null)}::jsonb, ${input.generationId ?? null},
      ${input.versionId ?? null}, ${input.actionId ?? null}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromMediaSessionMessageRow(rows[0]);
  }

  async listMediaSessionMessages(sessionId: string, limit = 80) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from (
      select * from media_session_messages
      where session_id = ${sessionId}
      order by created_at desc
      limit ${limit}
    ) recent_messages order by created_at asc`) as Array<Record<string, unknown>>;
    return rows.map(fromMediaSessionMessageRow);
  }

  async listProductionSources(projectId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from production_sources where project_id = ${projectId} order by created_at desc`) as Array<Record<string, unknown>>;
    return rows.map(fromProductionSourceRow);
  }

  async getProductionSource(sourceId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from production_sources where id = ${sourceId}`) as Array<Record<string, unknown>>;
    return rows[0] ? fromProductionSourceRow(rows[0]) : null;
  }

  async createProductionSource(input: ProductionSourceInput) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const id = input.id ?? randomUUID();
    const rows = (await sql`insert into production_sources (
      id, project_id, production_id, user_id, kind, title, original_name, source_url,
      canonical_url, blob_url, mime_type, byte_size, sha256, page_count, published_at,
      retrieved_at, supplied_at, rights, processing_state, extraction_version, warnings, error
    ) values (
      ${id}, ${input.projectId}, ${input.productionId ?? null}, ${input.userId}, ${input.kind},
      ${input.title}, ${input.originalName ?? null}, ${input.url ?? null}, ${input.canonicalUrl ?? null},
      ${input.blobUrl ?? null}, ${input.mimeType ?? null}, ${input.byteSize ?? null}, ${input.sha256 ?? null},
      ${input.pageCount ?? null}, ${input.publishedAt ?? null}, ${input.retrievedAt ?? null},
      ${input.suppliedAt}, ${input.rights}, ${input.processingState}, ${input.extractionVersion},
      ${JSON.stringify(input.warnings)}::jsonb, ${input.error ?? null}
    ) returning *`) as Array<Record<string, unknown>>;
    return fromProductionSourceRow(rows[0]);
  }

  async updateProductionSource(sourceId: string, patch: ProductionSourcePatch) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from production_sources where id = ${sourceId}`) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new Error(`Production source not found: ${sourceId}`);
    const next = { ...fromProductionSourceRow(rows[0]), ...patch };
    const updated = (await sql`update production_sources set
      production_id = ${next.productionId ?? null},
      title = ${next.title},
      canonical_url = ${next.canonicalUrl ?? null},
      blob_url = ${next.blobUrl ?? null},
      byte_size = ${next.byteSize ?? null},
      sha256 = ${next.sha256 ?? null},
      page_count = ${next.pageCount ?? null},
      published_at = ${next.publishedAt ?? null},
      retrieved_at = ${next.retrievedAt ?? null},
      processing_state = ${next.processingState},
      warnings = ${JSON.stringify(next.warnings)}::jsonb,
      error = ${next.error ?? null},
      updated_at = now()
      where id = ${sourceId}
      returning *`) as Array<Record<string, unknown>>;
    return fromProductionSourceRow(updated[0]);
  }

  async deleteProductionSource(sourceId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`delete from production_sources where id = ${sourceId} returning *`) as Array<Record<string, unknown>>;
    return rows[0] ? fromProductionSourceRow(rows[0]) : null;
  }

  async replaceSourceFragments(sourceId: string, inputs: SourceFragmentInput[]) {
    await ensureDatabaseSchema();
    const sql = getSql();
    await sql`delete from source_fragments where source_id = ${sourceId}`;
    const fragments: SourceFragment[] = [];
    for (const input of inputs) {
      const id = input.id ?? randomUUID();
      const rows = (await sql`insert into source_fragments (
        id, source_id, ordinal, page_number, section, text_content, text_hash, extraction_method
      ) values (
        ${id}, ${sourceId}, ${input.ordinal}, ${input.pageNumber ?? null}, ${input.section ?? null},
        ${input.text}, ${input.textHash}, ${input.extractionMethod}
      ) returning *`) as Array<Record<string, unknown>>;
      fragments.push(fromSourceFragmentRow(rows[0]));
    }
    return fragments;
  }

  async listSourceFragments(sourceId: string) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const rows = (await sql`select * from source_fragments where source_id = ${sourceId} order by ordinal`) as Array<Record<string, unknown>>;
    return rows.map(fromSourceFragmentRow);
  }

  private async findBetaAccessRequest(
    identity: { email?: string; phone?: string },
    status?: BetaAccessRequest["status"],
  ) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const email = normalizeEmail(identity.email);
    const phone = identity.phone;
    if (!email && !phone) return null;
    const rows = await findBetaAccessRows(sql, { email, phone, status });
    return rows[0] ? fromBetaAccessRequestRow(rows[0]) : null;
  }
}

async function findBetaAccessRows(
  sql: ReturnType<typeof getSql>,
  input: { email?: string; phone?: string; status?: BetaAccessRequest["status"] },
) {
  const { email, phone, status } = input;
  if (email && phone && status) {
    return (await sql`select * from beta_access_requests
      where status = ${status} and (lower(email) = ${email} or phone = ${phone})
      limit 1`) as Array<Record<string, unknown>>;
  }
  if (email && phone) {
    return (await sql`select * from beta_access_requests
      where lower(email) = ${email} or phone = ${phone}
      limit 1`) as Array<Record<string, unknown>>;
  }
  if (email && status) {
    return (await sql`select * from beta_access_requests
      where status = ${status} and lower(email) = ${email}
      limit 1`) as Array<Record<string, unknown>>;
  }
  if (email) {
    return (await sql`select * from beta_access_requests
      where lower(email) = ${email}
      limit 1`) as Array<Record<string, unknown>>;
  }
  if (phone && status) {
    return (await sql`select * from beta_access_requests
      where status = ${status} and phone = ${phone}
      limit 1`) as Array<Record<string, unknown>>;
  }
  return (await sql`select * from beta_access_requests
    where phone = ${phone}
    limit 1`) as Array<Record<string, unknown>>;
}

async function requireJob(storeImpl: VideoStore, videoId: string) {
  const job = await storeImpl.getJob(videoId);
  if (!job) {
    throw new Error(`Video job not found: ${videoId}`);
  }
  return job;
}

function fromDbRow(
  row: Record<string, unknown>,
  phases: Array<Record<string, unknown>>,
  providerCalls: Array<Record<string, unknown>>,
  workflowSteps: Array<Record<string, unknown>>,
): VideoJob {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    userId: String(row.user_id),
    prompt: String(row.prompt),
    status: row.status as VideoJob["status"],
    currentPhase: Number(row.current_phase),
    estimatedCostCents: Number(row.estimated_cost_cents),
    actualCostCents: Number(row.actual_cost_cents),
    recoveryBudgetCents: Number(row.recovery_budget_cents ?? 0),
    recoverySpentCents: Number(row.recovery_spent_cents ?? 0),
    aspectRatio: row.aspect_ratio as VideoJob["aspectRatio"],
    contentType: (row.content_type as VideoJob["contentType"]) ?? "music_video",
    qualityTier: (row.quality_tier as VideoJob["qualityTier"]) ?? "standard",
    workflowVersion: row.workflow_version ? String(row.workflow_version) : "music-video-v1",
    sourceBundle: parseJson<VideoJob["sourceBundle"]>(row.source_bundle),
    digestMode: row.digest_mode as VideoJob["digestMode"],
    researchMode: row.research_mode as VideoJob["researchMode"],
    presentationMode: row.presentation_mode as VideoJob["presentationMode"],
    visualStylePreset: (row.visual_style_preset as VideoJob["visualStylePreset"]) ?? "auto",
    visualPlan: parseJson<VideoJob["visualPlan"]>(row.visual_plan),
    editorialPlan: parseJson<VideoJob["editorialPlan"]>(row.editorial_plan),
    durationPlan: parseJson<VideoJob["durationPlan"]>(row.duration_plan),
    storyboard: parseJson<VideoJob["storyboard"]>(row.storyboard),
    approvals: parseJson<VideoJob["approvals"]>(row.approvals) ?? [],
    timelineManifest: parseJson<VideoJob["timelineManifest"]>(row.timeline_manifest),
    qaReport: parseJson<VideoJob["qaReport"]>(row.qa_report),
    script: row.script ? String(row.script) : undefined,
    narrationAssetId: row.narration_asset_id ? String(row.narration_asset_id) : undefined,
    visualMode: (row.visual_mode as VideoJob["visualMode"]) ?? "conceptual",
    durationSeconds: Number(row.duration_seconds),
    traceId: String(row.trace_id),
    cancellationRequested: Boolean(row.cancellation_requested),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
    error: row.error ? String(row.error) : undefined,
    musicControls: parseJson<MusicControls>(row.music_controls),
    seeds: parseJson<VideoSeeds>(row.seeds) ?? { subjects: [], aesthetic: [] },
    creativeBrief: parseJson<CreativeBrief>(row.creative_brief),
    musicPlan: parseJson<MusicPlan>(row.music_plan),
    musicTrack: parseJson<MusicTrack>(row.music_track),
    beatGrid: parseJson<BeatGrid>(row.beat_grid),
    anchorAssets: parseJson<AnchorAsset[]>(row.anchor_assets) ?? [],
    shotPlan: parseJson<ShotPlan>(row.shot_plan),
    generatedShots: parseJson<GeneratedShot[]>(row.generated_shots) ?? [],
    renderManifest: parseJson<RenderManifest>(row.render_manifest),
    finalVideoUrl: row.final_video_url ? String(row.final_video_url) : undefined,
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : undefined,
    promptTrace: parseJson<VideoJob["promptTrace"]>(row.prompt_trace),
    editDirectives: parseJson<EditDirective[]>(row.edit_directives) ?? [],
    artifactVersions: parseJson<ArtifactVersion[]>(row.artifact_versions) ?? [],
    workflowSteps: orderWorkflowSteps((row.content_type as VideoJob["contentType"]) ?? "music_video", workflowSteps.map((step) => ({
      id: String(step.step_id),
      name: String(step.name),
      state: step.state as NonNullable<VideoJob["workflowSteps"]>[number]["state"],
      dependsOn: parseJson<string[]>(step.depends_on) ?? [],
      artifactVersionId: step.artifact_version_id ? String(step.artifact_version_id) : undefined,
      startedAt: step.started_at ? databaseTimestamp(step.started_at) : undefined,
      completedAt: step.completed_at ? databaseTimestamp(step.completed_at) : undefined,
      error: step.error ? String(step.error) : undefined,
    }))),
    phases: phases.map((phase) => ({
      phaseNumber: Number(phase.phase_number) as PhaseNumber,
      name: String(phase.name),
      state: phase.state as VideoJob["status"],
      startedAt: phase.started_at ? databaseTimestamp(phase.started_at) : undefined,
      completedAt: phase.completed_at ? databaseTimestamp(phase.completed_at) : undefined,
      artifactUrl: phase.artifact_url ? String(phase.artifact_url) : undefined,
      error: phase.error ? String(phase.error) : undefined,
    })),
    providerCalls: providerCalls.map((call) => ({
      id: String(call.id),
      videoJobId: String(call.video_job_id),
      phaseNumber: Number(call.phase_number) as PhaseNumber,
      provider: String(call.provider),
      model: String(call.model),
      requestId: String(call.request_id),
      idempotencyKey: String(call.idempotency_key),
      latencyMs: Number(call.latency_ms),
      costCents: Number(call.cost_cents),
      status: call.status as ProviderCall["status"],
      error: call.error ? String(call.error) : undefined,
      metadata: parseJson<Record<string, unknown>>(call.metadata) ?? {},
      createdAt: databaseTimestamp(call.created_at),
    })),
  };
}

function parseJson<T>(value: unknown): T | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function orderWorkflowSteps(contentType: NonNullable<VideoJob["contentType"]>, steps: NonNullable<VideoJob["workflowSteps"]>) {
  const positions = new Map(workflowProfileFor(contentType).steps.map((step, index) => [step.id, index]));
  return [...steps].sort((left, right) => {
    const leftPosition = positions.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightPosition = positions.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftPosition - rightPosition || left.name.localeCompare(right.name);
  });
}

function hasOwn<T extends object>(value: T, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fromProjectRow(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    createdAt: String(row.created_at),
  };
}

function fromProductionSourceRow(row: Record<string, unknown>): ProductionSource {
  return ProductionSource.parse({
    id: String(row.id),
    projectId: String(row.project_id),
    productionId: row.production_id ? String(row.production_id) : undefined,
    userId: String(row.user_id),
    kind: row.kind,
    title: String(row.title),
    originalName: row.original_name ? String(row.original_name) : undefined,
    url: row.source_url ? String(row.source_url) : undefined,
    canonicalUrl: row.canonical_url ? String(row.canonical_url) : undefined,
    blobUrl: row.blob_url ? String(row.blob_url) : undefined,
    mimeType: row.mime_type ? String(row.mime_type) : undefined,
    byteSize: row.byte_size === null || row.byte_size === undefined ? undefined : Number(row.byte_size),
    sha256: row.sha256 ? String(row.sha256) : undefined,
    pageCount: row.page_count === null || row.page_count === undefined ? undefined : Number(row.page_count),
    publishedAt: row.published_at ? databaseTimestamp(row.published_at) : undefined,
    retrievedAt: row.retrieved_at ? databaseTimestamp(row.retrieved_at) : undefined,
    suppliedAt: databaseTimestamp(row.supplied_at),
    rights: row.rights,
    processingState: row.processing_state,
    extractionVersion: String(row.extraction_version),
    warnings: parseJson<string[]>(row.warnings) ?? [],
    error: row.error ? String(row.error) : undefined,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  });
}

function fromSourceFragmentRow(row: Record<string, unknown>): SourceFragment {
  return SourceFragment.parse({
    id: String(row.id),
    sourceId: String(row.source_id),
    ordinal: Number(row.ordinal),
    pageNumber: row.page_number === null || row.page_number === undefined ? undefined : Number(row.page_number),
    section: row.section ? String(row.section) : undefined,
    text: String(row.text_content),
    textHash: String(row.text_hash),
    extractionMethod: row.extraction_method,
    createdAt: databaseTimestamp(row.created_at),
  });
}

function fromBetaAccessRequestRow(row: Record<string, unknown>): BetaAccessRequest {
  return {
    id: String(row.id),
    name: row.name ? String(row.name) : undefined,
    email: row.email ? String(row.email) : undefined,
    phone: row.phone ? String(row.phone) : undefined,
    note: row.note ? String(row.note) : undefined,
    ipHash: row.ip_hash ? String(row.ip_hash) : undefined,
    userAgent: row.user_agent ? String(row.user_agent) : undefined,
    inviteCodeId: row.invite_code_id ? String(row.invite_code_id) : undefined,
    status: row.status as BetaAccessRequest["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromBetaInviteCodeRow(row: Record<string, unknown>): BetaInviteCode {
  return {
    id: String(row.id),
    accessRequestId: row.access_request_id ? String(row.access_request_id) : undefined,
    codeHash: String(row.code_hash),
    email: row.email ? String(row.email) : undefined,
    phone: row.phone ? String(row.phone) : undefined,
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at ? String(row.consumed_at) : undefined,
    consumedBy: row.consumed_by ? String(row.consumed_by) : undefined,
    revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromProviderAuditEventRow(row: Record<string, unknown>): ProviderAuditEvent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    videoJobId: row.video_job_id ? String(row.video_job_id) : undefined,
    mediaGenerationId: row.media_generation_id ? String(row.media_generation_id) : undefined,
    mediaSessionId: row.media_session_id ? String(row.media_session_id) : undefined,
    provider: String(row.provider),
    model: String(row.model),
    status: row.status as ProviderAuditEvent["status"],
    estimatedCostCents: Number(row.estimated_cost_cents),
    actualCostCents: Number(row.actual_cost_cents),
    dailySpentCents: row.daily_spent_cents === null || row.daily_spent_cents === undefined
      ? undefined
      : Number(row.daily_spent_cents),
    dailyBudgetCents: row.daily_budget_cents === null || row.daily_budget_cents === undefined
      ? undefined
      : Number(row.daily_budget_cents),
    globalSpentCents: row.global_spent_cents === null || row.global_spent_cents === undefined
      ? undefined
      : Number(row.global_spent_cents),
    globalBudgetCents: row.global_budget_cents === null || row.global_budget_cents === undefined
      ? undefined
      : Number(row.global_budget_cents),
    requestId: row.request_id ? String(row.request_id) : undefined,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
    billingKey: row.billing_key ? String(row.billing_key) : undefined,
    error: row.error ? String(row.error) : undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    createdAt: String(row.created_at),
  };
}

function fromProductionWorkflowRunRow(row: Record<string, unknown>): ProductionWorkflowRun {
  return ProductionWorkflowRun.parse({
    id: String(row.id),
    productionId: String(row.production_id),
    runId: String(row.run_id),
    kind: row.kind,
    workflowVersion: String(row.workflow_version),
    state: row.state,
    recoveryToken: row.recovery_token ? String(row.recovery_token) : undefined,
    errorCode: row.error_code ? String(row.error_code) : undefined,
    error: row.error ? String(row.error) : undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    startedAt: databaseTimestamp(row.started_at),
    heartbeatAt: databaseTimestamp(row.heartbeat_at),
    completedAt: row.completed_at ? databaseTimestamp(row.completed_at) : undefined,
  });
}

function fromBetaFeedbackRow(row: Record<string, unknown>): BetaFeedback {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    videoJobId: row.video_job_id ? String(row.video_job_id) : undefined,
    mediaSessionId: row.media_session_id ? String(row.media_session_id) : undefined,
    kind: row.kind as BetaFeedback["kind"],
    message: String(row.message),
    status: row.status as BetaFeedback["status"],
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromLibraryAssetRow(row: Record<string, unknown>): LibraryAsset {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind as LibraryAsset["kind"],
    name: String(row.name),
    role: String(row.role),
    url: String(row.url),
    mimeType: String(row.mime_type),
    source: row.source as LibraryAsset["source"],
    tags: parseJson<string[]>(row.tags) ?? [],
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    favoriteAt: row.favorite_at ? String(row.favorite_at) : undefined,
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
  };
}

function hydrateLibraryCollectionRows(
  collectionRows: Array<Record<string, unknown>>,
  assetRows: Array<Record<string, unknown>>,
) {
  const assetIdsByCollection = new Map<string, string[]>();
  for (const row of assetRows) {
    const collectionId = String(row.collection_id);
    const assetIds = assetIdsByCollection.get(collectionId) ?? [];
    assetIds.push(String(row.library_asset_id));
    assetIdsByCollection.set(collectionId, assetIds);
  }
  return collectionRows.map((row) => fromLibraryCollectionRow(row, assetIdsByCollection.get(String(row.id)) ?? []));
}

function fromLibraryCollectionRow(row: Record<string, unknown>, assetIds: string[]): LibraryCollection {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    assetIds,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at ? String(row.archived_at) : undefined,
  };
}

function fromProjectAssetLinkRow(row: Record<string, unknown>): ProjectAssetLink {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    libraryAssetId: String(row.library_asset_id),
    mediaAssetId: String(row.media_asset_id),
    createdAt: String(row.created_at),
  };
}

function fromMediaGenerationRow(row: Record<string, unknown>): MediaGeneration {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    videoJobId: row.video_job_id ? String(row.video_job_id) : undefined,
    kind: row.kind as MediaGeneration["kind"],
    provider: row.provider as MediaGeneration["provider"],
    model: String(row.model),
    status: row.status as MediaGeneration["status"],
    prompt: String(row.prompt),
    controls: parseJson<Record<string, unknown>>(row.controls) ?? {},
    inputAssetIds: parseJson<string[]>(row.input_asset_ids) ?? [],
    outputUrls: parseJson<Record<string, string>>(row.output_urls) ?? {},
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    costCents: Number(row.cost_cents),
    requestId: row.request_id ? String(row.request_id) : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromMediaAssetRow(row: Record<string, unknown>): MediaAsset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    videoJobId: row.video_job_id ? String(row.video_job_id) : undefined,
    generationId: row.generation_id ? String(row.generation_id) : undefined,
    kind: row.kind as MediaAsset["kind"],
    role: String(row.role),
    url: String(row.url),
    mimeType: String(row.mime_type),
    metadata: parseJson<Record<string, unknown>>(row.metadata) ?? {},
    createdAt: String(row.created_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : undefined,
  };
}

function fromMediaSessionRow(row: Record<string, unknown>): MediaSession {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: row.kind as MediaSession["kind"],
    title: String(row.title),
    status: row.status as MediaSession["status"],
    sourceAssetId: row.source_asset_id ? String(row.source_asset_id) : undefined,
    currentAssetId: row.current_asset_id ? String(row.current_asset_id) : undefined,
    goal: row.goal ? String(row.goal) : undefined,
    settings: parseJson<Record<string, unknown>>(row.settings) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function fromMediaSessionVersionRow(row: Record<string, unknown>): MediaSessionVersion {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    assetId: String(row.asset_id),
    generationId: row.generation_id ? String(row.generation_id) : undefined,
    label: String(row.label),
    prompt: row.prompt ? String(row.prompt) : undefined,
    controls: parseJson<Record<string, unknown>>(row.controls) ?? {},
    parentVersionId: row.parent_version_id ? String(row.parent_version_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
  };
}

function fromMediaSessionMessageRow(row: Record<string, unknown>): MediaSessionMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: row.role as MediaSessionMessage["role"],
    content: String(row.content),
    proposal: parseJson<MediaSessionMessage["proposal"]>(row.proposal),
    generationId: row.generation_id ? String(row.generation_id) : undefined,
    versionId: row.version_id ? String(row.version_id) : undefined,
    actionId: row.action_id ? String(row.action_id) : undefined,
    createdAt: String(row.created_at),
  };
}

function ascendingCreatedAt<T extends { createdAt: string }>(left: T, right: T) {
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

function descendingCreatedAt<T extends { createdAt: string }>(left: T, right: T) {
  return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
}

function descendingUpdatedAt<T extends { updatedAt: string }>(left: T, right: T) {
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
}

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() || undefined;
}

function mergeJobPatch(job: VideoJob, patch: JobPatch): VideoJob {
  if (job.cancellationRequested || job.status === "cancelled") {
    return { ...job, status: "cancelled", cancellationRequested: true,
      actualCostCents: Math.max(job.actualCostCents, patch.actualCostCents ?? 0), updatedAt: nowIso() };
  }
  const artifactVersions = patch.artifactVersions
    ? [...new Map([...job.artifactVersions, ...patch.artifactVersions].map((version) => [version.id, version])).values()]
    : job.artifactVersions;
  return { ...job, ...patch, artifactVersions,
    ...(patch.cancellationRequested || patch.status === "cancelled" ? { status: "cancelled" as const, cancellationRequested: true } : {}),
    updatedAt: nowIso() };
}
