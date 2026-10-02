"use client";

import { upload } from "@vercel/blob/client";
import Image from "next/image";
import {
  AlertTriangle,
  Aperture,
  Archive,
  Ban,
  Bot,
  Box,
  ChevronRight,
  Clapperboard,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Film,
  Folder,
  Gauge,
  History,
  Image as ImageIcon,
  Link as LinkIcon,
  Library,
  LockKeyhole,
  Loader2,
  Maximize2,
  Menu,
  Minimize2,
  Moon,
  MoreVertical,
  Music2,
  Palette,
  Pause,
  PlayCircle,
  Plus,
  Radio,
  RefreshCcw,
  Search,
  Save,
  Send,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Tag,
  Upload,
  UserRound,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import { FormEvent, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MusicConsole, MusicStudioCard, MusicStudioDrawer } from "@/components/music-studio";
import { CreateSectionTabs, ProductionWorkbench, type CreateSectionId } from "@/components/creative-console-shell";
import { SeedDrawer, SeedTile, YouAnchorCard } from "@/components/seed-studio";
import { useTheme } from "@/hooks/useTheme";
import { DEFAULT_MUSIC_CONTROLS } from "@/lib/music-controls";
import { estimateInitialCost } from "@/lib/cost";
import {
  aestheticSeedFrom,
  buildSeedsPayload,
  libraryRoleForSeed,
  youPhotosFrom,
  type AestheticSeedRole,
  type SeedRole,
} from "@/lib/seeds-payload";
import { PROVIDER_CAPABILITIES } from "@/lib/provider-capabilities";
import { detectBriefDurationSeconds } from "@/lib/editorial-timing";
import { clearResolvedBackgroundError } from "@/lib/ui-errors";
import type {
  AgentActionProposal,
  AspectRatio,
  AnchorAsset,
  ContentType,
  DigestMode,
  EditorScope,
  GeneratedShot,
  MediaAsset,
  MediaGeneration,
  MediaGenerationCreateRequest,
  MediaGenerationInjectRequest,
  MediaKind,
  MediaProvider,
  MediaSession,
  MediaSessionMessage,
  MediaSessionVersion,
  MusicControls,
  MusicPlan,
  PhaseNumber,
  PromptTrace,
  ProductionProgressSnapshot,
  ProductionSource,
  QAReport,
  QualityTier,
  ResearchMode,
  LibraryAsset,
  LibraryCollection,
  MediaSessionKind,
  Project,
  ProviderControls,
  RegenerateStrategy,
  RenderAgentProposal,
  Shot,
  VideoJob,
  VisualBeat,
  VisualBeatKind,
  VisualMode,
  VisualStylePreset,
  WorkflowPhase,
} from "@/lib/schemas";

type ApiJob = {
  videoId: string;
  currentPhase: number;
  state: string;
  estimatedCostUsd: number;
  actualCostUsd: number;
  error?: string;
  job: VideoJob;
};

type EditorMode = "preview" | "anchors" | "shots" | "music" | "versions";
type EditorContext = {
  mode: EditorMode;
  shotIndex?: number;
  pendingAction?: EditorPendingAction;
  startFullscreen?: boolean;
};
type PreviewSelection =
  | { kind: "auto" }
  | { kind: "anchor"; role: AnchorAsset["role"] }
  | { kind: "shot"; shotIndex: number }
  | { kind: "final" }
  | { kind: "thumbnail" };
type PreviewMedia = {
  kind: "video" | "image" | "idle";
  key: string;
  title: string;
  detail: string;
  src?: string;
  poster?: string;
  alt: string;
  icon: ReactNode;
};

type WorkspaceId = "agent" | "create" | "projects" | "library" | "assets" | "shots" | "music" | "settings";

type MediaLibraryState = {
  projectId: string;
  generations: MediaGeneration[];
  assets: MediaAsset[];
};

type MediaSessionWithVersions = MediaSession & { versions: MediaSessionVersion[]; messages: MediaSessionMessage[] };
type LibraryVaultFilter = "all" | MediaKind | "generated" | "uploaded" | "project" | "favorites" | "finished";
type LibraryVaultItem = {
  asset: LibraryAsset;
  mediaAsset?: MediaAsset;
  generation?: MediaGeneration;
  isProjectLinked: boolean;
  collectionIds: string[];
  prompt?: string;
  provider?: string;
  model?: string;
  durationSeconds?: number;
  dimensions?: string;
  thumbnailUrl?: string;
  sourceProjectName?: string;
  lastUsedAt?: string;
};

type EditorPendingAction = {
  kind: "regenerate-phase" | "regenerate-shot" | "restore-version";
  label: string;
  phase?: PhaseNumber;
  shotIndex?: number;
  versionId?: string;
  scope?: EditorScope;
};

type ActionMenuItem = {
  label: string;
  detail?: string;
  icon?: ReactNode;
  href?: string;
  download?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
};
type ActionMenuPlacement = "down" | "up";
type DirectorChatMessage = { role: "agent" | "user"; text: string };
type DirectorOutput = {
  id: string;
  kind: MediaKind;
  status: MediaGeneration["status"];
  provider: MediaProvider;
  label: string;
  prompt: string;
  url?: string;
  downloadUrl?: string;
  fileName?: string;
  mimeType?: string;
  queueStatus?: string;
  requestId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

const phases = [
  "Treatment",
  "Composition",
  "Music",
  "Beat grid",
  "Anchors",
  "Shot plan",
  "Shots",
  "QA",
  "Render",
];

const phaseCardLabels = ["Treat", "Comp", "Music", "Beat Grid", "Anchor", "Shot Plan", "Shots", "QA", "Render"];

const DEFAULT_PROMPT =
  "Describe the genre, instruments, mood, visual world, and any specific imagery you want.";

const ACTIVE_PRODUCTION_STORAGE_KEY = "cocoa.activeProduction.v1";

const FORMAT_OPTIONS: Array<{
  id: ContentType;
  label: string;
  detail: string;
  icon: LucideIcon;
  defaultDuration: number;
}> = [
  { id: "music_video", label: "Music video", detail: "Beat-driven cinema", icon: Music2, defaultDuration: 90 },
  { id: "explainer", label: "Explainer", detail: "Source-first teaching", icon: FileText, defaultDuration: 60 },
  { id: "news_digest", label: "News digest", detail: "Claim-linked information", icon: Radio, defaultDuration: 180 },
  { id: "product_social", label: "Product / social", detail: "Brand-ready variants", icon: Sparkles, defaultDuration: 30 },
  { id: "custom", label: "Custom", detail: "Composable workflow", icon: Clapperboard, defaultDuration: 60 },
];

const STYLE_PRESETS = [
  {
    id: "auto",
    label: "Auto",
    detail: "AI decides",
    directive: "",
  },
  {
    id: "guided",
    label: "Guided",
    detail: "Add direction",
    directive:
      "prioritize a clear authored visual signature, practical cinematic lighting, and concrete visual vocabulary derived from the user's prompt",
  },
  {
    id: "image",
    label: "Reference",
    detail: "Image guide",
    directive:
      "make the anchor assets read like premium gpt-image-2 production plates with layered foreground, midground, background, material detail, and reusable prompt-derived details",
  },
  {
    id: "shots",
    label: "Shot list",
    detail: "Optical rhythm",
    directive:
      "shape the video around precise camera language, internal cuts, lens texture, and beat-synced motion cues drawn from the prompt's concrete visual vocabulary",
  },
] as const;

const EDITORIAL_VISUAL_PRESETS: Array<{ id: VisualStylePreset; label: string; detail: string }> = [
  { id: "auto", label: "Director Auto", detail: "Adapts the visual mix scene by scene" },
  { id: "prestige_documentary", label: "Prestige documentary", detail: "Measured cinema, tactile evidence, elegant data" },
  { id: "broadcast_energy", label: "Broadcast energy", detail: "Fast, dimensional, high-clarity newsroom motion" },
  { id: "cinematic_social", label: "Cinematic social", detail: "Bold color, kinetic framing, mobile-safe graphics" },
];

const VISUAL_BEAT_LABELS: Record<VisualBeatKind, string> = {
  documentary_source: "Documentary source",
  document_excerpt: "Document excerpt",
  data_visualization: "Data visualization",
  editorial_image: "Editorial illustration",
  cinematic_broll: "Cinematic B-roll",
  synthetic_reenactment: "AI reenactment",
  composite: "Cinema + information",
};

type StylePresetId = (typeof STYLE_PRESETS)[number]["id"];

const NAV_ITEMS: Array<{ id: WorkspaceId; label: string; icon: LucideIcon }> = [
  { id: "agent", label: "Media Lab", icon: Bot },
  { id: "create", label: "Create", icon: Sparkles },
  { id: "projects", label: "Projects", icon: Folder },
  { id: "library", label: "Library", icon: Library },
  { id: "assets", label: "Assets", icon: Box },
  { id: "shots", label: "Shots", icon: Clapperboard },
  { id: "music", label: "Music", icon: Music2 },
  { id: "settings", label: "Settings", icon: Settings },
];

type StudioCapabilities = {
  newsWebResearch: boolean;
  productionProgressV2: boolean;
};

export function StudioDashboard({
  authRequired = false,
  demoMode = false,
  capabilities = { newsWebResearch: false, productionProgressV2: true },
}: {
  authRequired?: boolean;
  demoMode?: boolean;
  capabilities?: StudioCapabilities;
}) {
  const createInFlightRef = useRef(false);
  const pendingCreateKeyRef = useRef<{ signature: string; key: string } | null>(null);
  const sessionGenerationInFlightRef = useRef(false);
  const pendingSessionKeyRef = useRef<{ signature: string; key: string } | null>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>("create");
  const [activeCreateSection, setActiveCreateSection] = useState<CreateSectionId>("brief");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [contentType, setContentType] = useState<ContentType>("music_video");
  const [qualityTier, setQualityTier] = useState<QualityTier>("standard");
  const [visualStylePreset, setVisualStylePreset] = useState<VisualStylePreset>("auto");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [sourceText, setSourceText] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [productionSources, setProductionSources] = useState<ProductionSource[]>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [digestMode, setDigestMode] = useState<DigestMode>("auto");
  const [researchMode, setResearchMode] = useState<ResearchMode>("supplied_only");
  const [draftScript, setDraftScript] = useState("");
  const [durationSeconds, setDurationSeconds] = useState(90);
  const [visualMode, setVisualMode] = useState<VisualMode>("conceptual");
  const [stylePreset, setStylePreset] = useState<StylePresetId>("auto");
  const [styleIntensity, setStyleIntensity] = useState(42);
  const [musicControls, setMusicControls] = useState<MusicControls>(DEFAULT_MUSIC_CONTROLS);
  const [musicStudioOpen, setMusicStudioOpen] = useState(false);
  const [seedDrawer, setSeedDrawer] = useState<SeedRole | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const seedAutoFlipRef = useRef(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [job, setJob] = useState<ApiJob | null>(null);
  const [productionProgress, setProductionProgress] = useState<ProductionProgressSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorContext | null>(null);
  const [previewSelection, setPreviewSelection] = useState<PreviewSelection>({ kind: "auto" });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectJobs, setProjectJobs] = useState<VideoJob[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [libraryAssets, setLibraryAssets] = useState<LibraryAsset[]>([]);
  const [libraryCollections, setLibraryCollections] = useState<LibraryCollection[]>([]);
  const [mediaSessions, setMediaSessions] = useState<MediaSessionWithVersions[]>([]);
  const [mediaLibrary, setMediaLibrary] = useState<MediaLibraryState | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(() => new Set());
  const sourceSelectionContextRef = useRef<string | null>(null);
  const hydratedJobIdRef = useRef<string | null>(null);
  const [directorOpen, setDirectorOpen] = useState(false);
  const [directorInput, setDirectorInput] = useState("");
  const [directorMessages, setDirectorMessages] = useState<DirectorChatMessage[]>([
    {
      role: "agent",
      text: "Ask me to create an image, generate a clip, compose music, save a pipeline note, regenerate a phase, or inject selected media. I will stage the action for confirmation before anything billable or mutating runs.",
    },
  ]);
  const [directorProposal, setDirectorProposal] = useState<AgentActionProposal | null>(null);
  const [directorOutputs, setDirectorOutputs] = useState<DirectorOutput[]>([]);
  const hasSnapshotRef = useRef(false);
  const backgroundRefreshErrorRef = useRef<string | null>(null);
  const hasMediaLibrarySnapshot = Boolean(mediaLibrary);
  const pollingContentType = job?.job.contentType ?? "music_video";
  const selectedProductionSources = useMemo(
    () => productionSources.filter((source) => selectedSourceIds.has(source.id)),
    [productionSources, selectedSourceIds],
  );
  const sourceProcessingActive = selectedProductionSources.some(
    (source) => source.processingState === "pending" || source.processingState === "processing",
  );
  const hasUnreadySources = selectedProductionSources.some(
    (source) => source.processingState !== "ready" && source.processingState !== "warning",
  );
  const briefDurationHintSeconds = useMemo(
    () => contentType === "music_video" ? undefined : detectBriefDurationSeconds(prompt),
    [contentType, prompt],
  );
  const hasDurationConflict = briefDurationHintSeconds !== undefined && briefDurationHintSeconds !== durationSeconds;

  const applySourceSnapshot = useCallback((projectId: string, sources: ProductionSource[]) => {
    setProductionSources(sources);
    setSelectedSourceIds((current) => {
      const editingCurrentFormat = job?.job.contentType === contentType;
      const contextId = `${projectId}:${editingCurrentFormat ? job?.job.id : "draft"}:${contentType}`;
      const available = new Set(sources.map((source) => source.id));
      if (sourceSelectionContextRef.current !== contextId) {
        sourceSelectionContextRef.current = contextId;
        const attached = editingCurrentFormat
          ? new Set(job?.job.sourceBundle?.inputs.flatMap((source) => source.sourceRecordId ? [source.sourceRecordId] : []) ?? [])
          : new Set<string>();
        const defaults = attached.size > 0
          ? sources.filter((source) => attached.has(source.id))
          : sources.filter((source) => !source.productionId);
        return new Set(defaults.map((source) => source.id));
      }
      return new Set([...current].filter((sourceId) => available.has(sourceId)));
    });
  }, [contentType, job?.job.contentType, job?.job.id, job?.job.sourceBundle?.inputs]);

  useEffect(() => {
    if (!capabilities.newsWebResearch && researchMode === "corroborate") {
      setResearchMode("supplied_only");
    }
  }, [capabilities.newsWebResearch, researchMode]);

  useEffect(() => {
    if (contentType === "music_video" && activeCreateSection === "sources") {
      setActiveCreateSection("brief");
    }
  }, [activeCreateSection, contentType]);

  useEffect(() => {
    hasSnapshotRef.current =
      Boolean(job) || projects.length > 0 || hasMediaLibrarySnapshot || libraryAssets.length > 0;
  }, [hasMediaLibrarySnapshot, job, libraryAssets.length, projects.length]);

  // Seed assets ("put yourself in the video") derived from the library. The character "you"
  // photos and per-slot aesthetic references are just tagged library images.
  const youPhotos = useMemo(() => youPhotosFrom(libraryAssets), [libraryAssets]);
  const seedByRole = useMemo(
    () => ({
      style: aestheticSeedFrom(libraryAssets, "style"),
      environment: aestheticSeedFrom(libraryAssets, "environment"),
      palette: aestheticSeedFrom(libraryAssets, "palette"),
    }),
    [libraryAssets],
  );

  useEffect(() => {
    try {
      if (window.localStorage.getItem("cocoa.seedConsent.v1") === "1") setConsentAccepted(true);
    } catch {
      // localStorage unavailable (private mode) — consent simply re-asks per session.
    }
  }, []);

  const acceptConsent = useCallback((next: boolean) => {
    setConsentAccepted(next);
    try {
      if (next) window.localStorage.setItem("cocoa.seedConsent.v1", "1");
      else window.localStorage.removeItem("cocoa.seedConsent.v1");
    } catch {
      // ignore persistence failure; the in-memory flag still gates this session
    }
  }, []);

  // Adding yourself implies you should appear on screen — flip to performer mode once.
  useEffect(() => {
    if (youPhotos.length > 0 && !seedAutoFlipRef.current && visualMode === "conceptual") {
      seedAutoFlipRef.current = true;
      setVisualMode("visible_performer");
    }
  }, [youPhotos.length, visualMode]);

  const clearBackgroundRefreshError = useCallback(() => {
    const resolvedError = backgroundRefreshErrorRef.current;
    backgroundRefreshErrorRef.current = null;
    setError((current) => clearResolvedBackgroundError(current, resolvedError));
  }, []);

  const handleBackgroundRefreshError = useCallback((refreshError: unknown, fallback: string) => {
    const message = errorMessage(refreshError, fallback);
    if (hasSnapshotRef.current && isRecoverableFetchError(refreshError, message)) {
      console.warn(`${fallback}: ${message}`);
      return;
    }
    backgroundRefreshErrorRef.current = message;
    setError(message);
  }, []);

  const fetchJob = useCallback(async (targetVideoId: string) => {
    const response = await fetch(`/api/videos/${targetVideoId}`);
    const json = await readApiJson<ApiJob & { error?: string }>(response);
    if (!response.ok) {
      throw new Error(json.error ?? `Status refresh failed (${response.status})`);
    }
    clearBackgroundRefreshError();
    return json as ApiJob;
  }, [clearBackgroundRefreshError]);

  useEffect(() => {
    const restore = () => {
      try {
        const queryId = new URL(window.location.href).searchParams.get("production");
        const storedId = window.localStorage.getItem(ACTIVE_PRODUCTION_STORAGE_KEY);
        const candidate = queryId ?? storedId;
        if (candidate && isProductionId(candidate)) setVideoId(candidate);
      } catch {
        // URL/local storage may be unavailable in hardened browser modes. The server-side
        // project list remains the recovery path in those environments.
      }
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (videoId) {
        window.localStorage.setItem(ACTIVE_PRODUCTION_STORAGE_KEY, videoId);
        url.searchParams.set("production", videoId);
      } else {
        window.localStorage.removeItem(ACTIVE_PRODUCTION_STORAGE_KEY);
        url.searchParams.delete("production");
      }
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // The in-memory selection still works for this session.
    }
  }, [videoId]);

  const refreshProjects = useCallback(async () => {
    const response = await fetch("/api/projects");
    const json = await readApiJson<{ projects?: Project[]; error?: string }>(response);
    if (!response.ok) throw new Error(json.error ?? "Project refresh failed");
    setProjects(json.projects ?? []);
    setActiveProjectId((current) => current ?? json.projects?.[0]?.id ?? null);
    clearBackgroundRefreshError();
    return json.projects ?? [];
  }, [clearBackgroundRefreshError]);

  const refreshProjectData = useCallback(async (projectId: string) => {
    const response = await fetch(`/api/projects/${projectId}`);
    const json = await readApiJson<{
      project?: Project;
      jobs?: VideoJob[];
      media?: { generations: MediaGeneration[]; assets: MediaAsset[] };
      sessions?: MediaSessionWithVersions[];
      libraryAssets?: LibraryAsset[];
      libraryCollections?: LibraryCollection[];
      error?: string;
    }>(response);
    if (!response.ok || !json.project) throw new Error(json.error ?? "Project data refresh failed");
    setProjects((current) => upsertById(current, json.project!));
    setProjectJobs(json.jobs ?? []);
    setActiveProjectId(json.project.id);
    setMediaLibrary({ projectId, generations: json.media?.generations ?? [], assets: json.media?.assets ?? [] });
    setMediaSessions(json.sessions ?? []);
    setLibraryAssets(json.libraryAssets ?? []);
    setLibraryCollections(json.libraryCollections ?? []);
    clearBackgroundRefreshError();
    return json;
  }, [clearBackgroundRefreshError]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshProjects().catch((projectError) => {
        handleBackgroundRefreshError(projectError, "Project refresh failed");
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [handleBackgroundRefreshError, refreshProjects]);

  const jobIsTerminal = job?.job.id === videoId && (job.state === "complete" || job.state === "cancelled");
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const json = await fetchJob(videoId);
        if (!cancelled) setJob(json);
      } catch (pollError) {
        if (!cancelled) {
          handleBackgroundRefreshError(pollError, "Status refresh failed");
        }
      }
    };
    void load();
    if (jobIsTerminal) return () => { cancelled = true; };
    const interval = window.setInterval(load, pollingContentType === "music_video" ? 2500 : 10000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fetchJob, handleBackgroundRefreshError, jobIsTerminal, pollingContentType, videoId]);

  useEffect(() => {
    if (!videoId || pollingContentType === "music_video" || !capabilities.productionProgressV2) {
      setProductionProgress(null);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let previousArtifactVersionCount = productionProgress?.artifactVersionCount;
    const load = async () => {
      try {
        const response = await fetch(`/api/productions/${videoId}/progress`, { cache: "no-store" });
        const snapshot = await readApiJson<ProductionProgressSnapshot & { error?: string }>(response);
        if (!response.ok) throw new Error(snapshot.error ?? "Production progress refresh failed");
        if (cancelled) return;
        setProductionProgress(snapshot);
        if (previousArtifactVersionCount !== undefined && snapshot.artifactVersionCount !== previousArtifactVersionCount) {
          setJob(await fetchJob(videoId));
        }
        previousArtifactVersionCount = snapshot.artifactVersionCount;
        if (!["complete", "failed", "cancelled"].includes(snapshot.state)) {
          timer = window.setTimeout(load, snapshot.state === "awaiting_user" || snapshot.state === "needs_attention" ? 10000 : 2000);
        }
      } catch (progressError) {
        if (!cancelled) {
          handleBackgroundRefreshError(progressError, "Production progress refresh failed");
          timer = window.setTimeout(load, 10000);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  // Progress polling intentionally keys to the production, not each snapshot update.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities.productionProgressV2, fetchJob, handleBackgroundRefreshError, pollingContentType, videoId]);

  useEffect(() => {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return;

    let cancelled = false;
    const loadProject = async () => {
      try {
        await refreshProjectData(projectId);
      } catch (projectError) {
        if (!cancelled) {
          handleBackgroundRefreshError(projectError, "Project refresh failed");
        }
      }
    };

    void loadProject();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, handleBackgroundRefreshError, job?.job.projectId, refreshProjectData]);

  useEffect(() => {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) { setProductionSources([]); return; }
    let cancelled = false;
    void fetch(`/api/projects/${projectId}/sources`)
      .then((response) => readApiJson<{ sources?: ProductionSource[]; error?: string }>(response).then((json) => ({ response, json })))
      .then(({ response, json }) => {
        if (!response.ok) throw new Error(json.error ?? "Source refresh failed");
        if (!cancelled) applySourceSnapshot(projectId, json.sources ?? []);
      })
      .catch((sourceError) => { if (!cancelled) handleBackgroundRefreshError(sourceError, "Source refresh failed"); });
    return () => { cancelled = true; };
  }, [activeProjectId, applySourceSnapshot, handleBackgroundRefreshError, job?.job.projectId]);

  useEffect(() => {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId || !sourceProcessingActive) return;
    let cancelled = false;
    const refreshSources = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/sources`);
        const json = await readApiJson<{ sources?: ProductionSource[]; error?: string }>(response);
        if (!response.ok) throw new Error(json.error ?? "Source refresh failed");
        if (!cancelled) applySourceSnapshot(projectId, json.sources ?? []);
      } catch (sourceError) {
        if (!cancelled) handleBackgroundRefreshError(sourceError, "Source refresh failed");
      }
    };
    const interval = window.setInterval(() => void refreshSources(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeProjectId, applySourceSnapshot, handleBackgroundRefreshError, job?.job.projectId, sourceProcessingActive]);

  useEffect(() => {
    setDraftScript(job?.job.script ?? "");
  }, [job?.job.id, job?.job.script]);

  useEffect(() => {
    const restored = job?.job;
    if (!restored || hydratedJobIdRef.current === restored.id) return;
    hydratedJobIdRef.current = restored.id;
    if (restored.contentType) setContentType(restored.contentType);
    setPrompt(restored.prompt);
    setDurationSeconds(restored.durationSeconds);
    setAspectRatio(restored.aspectRatio);
    if (restored.qualityTier) setQualityTier(restored.qualityTier);
    if (restored.visualStylePreset) setVisualStylePreset(restored.visualStylePreset);
    if (restored.digestMode) setDigestMode(restored.digestMode);
    if (restored.researchMode) setResearchMode(restored.researchMode);
    setActiveProjectId(restored.projectId);
  }, [job?.job]);

  useEffect(() => {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId || !job?.job.finalVideoUrl) return;
    void refreshProjectData(projectId).catch((projectError) => {
      handleBackgroundRefreshError(projectError, "Project render vault refresh failed");
    });
  }, [activeProjectId, handleBackgroundRefreshError, job?.job.finalVideoUrl, job?.job.projectId, refreshProjectData]);

  useEffect(() => {
    const projectId = job?.job.projectId ?? activeProjectId;
    const hasQueuedMedia = mediaLibrary?.generations.some((generation) =>
      generation.status === "queued" || generation.status === "running",
    );
    if (!projectId || !hasQueuedMedia) return;
    const interval = window.setInterval(() => {
      void refreshProjectData(projectId).catch((projectError) => {
        handleBackgroundRefreshError(projectError, "Project media refresh failed");
      });
    }, 5000);
    return () => window.clearInterval(interval);
  }, [activeProjectId, handleBackgroundRefreshError, job?.job.projectId, mediaLibrary?.generations, refreshProjectData]);

  useEffect(() => {
    if (!mediaLibrary) return;
    setDirectorOutputs((outputs) => {
      if (outputs.length === 0) return outputs;
      let changed = false;
      const nextOutputs = outputs.map((output) => {
        const generation = mediaLibrary.generations.find((candidate) => candidate.id === output.id);
        if (!generation) return output;
        const asset = primaryAssetForMediaGeneration(mediaLibrary.assets, generation);
        const nextOutput = directorOutputFromGeneration(generation, asset, output.label);
        if (directorOutputsMatch(output, nextOutput)) return output;
        changed = true;
        return nextOutput;
      });
      return changed ? nextOutputs : outputs;
    });
  }, [mediaLibrary]);

  const canAdvance = job?.state === "awaiting_user" && (currentContentType(job?.job) === "music_video");
  const nextActionLabel = useMemo(() => nextLabel(job?.job), [job]);
  const currentPhase = currentJobPhase(job?.job);
  const currentStep = currentWorkflowStep(job?.job);
  const visibleError = error ?? job?.error ?? currentStep?.error ?? currentPhase?.error ?? null;
  const selectedStyle = useMemo(
    () => STYLE_PRESETS.find((item) => item.id === stylePreset) ?? STYLE_PRESETS[0],
    [stylePreset],
  );
  const directorPrompt = useMemo(
    () => composeDirectorPrompt(prompt, selectedStyle, styleIntensity),
    [prompt, selectedStyle, styleIntensity],
  );

  const durationRange = durationRangeFor(contentType);

  const selectContentType = useCallback((nextContentType: ContentType) => {
    const option = FORMAT_OPTIONS.find((item) => item.id === nextContentType);
    setContentType(nextContentType);
    setDurationSeconds(option?.defaultDuration ?? 60);
    setAspectRatio(nextContentType === "music_video" || nextContentType === "product_social" ? "9:16" : "16:9");
  }, []);

  const createVideo = useCallback(async (autopilot: boolean) => {
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setBusy(true);
    setError(null);
    const signature = JSON.stringify([autopilot, contentType, activeProjectId, directorPrompt, durationSeconds, briefDurationHintSeconds, aspectRatio, visualMode, musicControls, qualityTier, digestMode, researchMode, selectedProductionSources.map((source) => source.id), sourceText, sourceTitle, visualStylePreset, libraryAssets.filter((asset) => asset.tags.includes("seed")).map((asset) => [asset.id, asset.url, asset.role, asset.tags])]);
    if (pendingCreateKeyRef.current?.signature !== signature) pendingCreateKeyRef.current = { signature, key: createClientIdempotencyKey() };
    const idempotencyKey = pendingCreateKeyRef.current.key;
    // Only send musicControls when the user actually touched the panel, so a default-auto run
    // produces a byte-identical request to before this feature existed.
    const musicControlsActive =
      (Boolean(musicControls.genre) && musicControls.genre !== "auto") ||
      musicControls.vocals !== "auto" ||
      musicControls.tempo !== "auto" ||
      Boolean(musicControls.bpm) ||
      musicControls.intensity !== "auto";
    // Seeds ride along only when the user actually added some, so a seed-free run is
    // byte-identical to before this feature existed.
    const seeds = buildSeedsPayload(libraryAssets, new Date().toISOString());
    try {
      const isMusicVideo = contentType === "music_video";
      let productionProjectId = activeProjectId;
      let attachedSources = [...selectedProductionSources];
      if (!isMusicVideo) {
        if (!productionProjectId) {
          const projectResponse = await fetch("/api/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: `${FORMAT_OPTIONS.find((option) => option.id === contentType)?.label ?? "Cocoa Director"} project` }),
          });
          const projectJson = await readApiJson<{ project?: Project; error?: string }>(projectResponse);
          if (!projectResponse.ok || !projectJson.project) throw new Error(projectJson.error ?? "Project creation failed");
          productionProjectId = projectJson.project.id;
          setProjects((current) => upsertById(current, projectJson.project!));
          setActiveProjectId(productionProjectId);
        }
        if (!productionProjectId) throw new Error("Create or select a project before adding sources.");
        if (sourceText.trim()) {
          const sourceResponse = await fetch(`/api/projects/${productionProjectId}/sources`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sources: [{ kind: "text", title: sourceTitle.trim() || "Pasted source", text: sourceText.trim() }] }),
          });
          const sourceJson = await readApiJson<{ sources?: ProductionSource[]; error?: string }>(sourceResponse);
          if (!sourceResponse.ok) throw new Error(sourceJson.error ?? "Text source could not be added");
          attachedSources = mergeSources(attachedSources, sourceJson.sources ?? []);
          setProductionSources(attachedSources);
          setSourceText("");
          setSourceTitle("");
        }
        if (attachedSources.length === 0) throw new Error("Add at least one text, URL, or PDF source.");
        const unreadySource = attachedSources.find(
          (source) => source.processingState !== "ready" && source.processingState !== "warning",
        );
        if (unreadySource) {
          throw new Error(
            unreadySource.processingState === "failed"
              ? `Resolve or remove the failed source: ${unreadySource.title}`
              : `Source processing is still underway: ${unreadySource.title}`,
          );
        }
      }
      const endpoint = isMusicVideo ? "/api/videos" : "/api/productions";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(isMusicVideo
          ? {
              prompt: directorPrompt,
              durationSeconds,
              aspectRatio,
              visualMode,
              autopilot,
              idempotencyKey,
              ...(musicControlsActive ? { musicControls } : {}),
              ...(seeds ? { seeds } : {}),
            }
          : {
              contentType,
              projectId: productionProjectId,
              brief: prompt.trim() || "Create a clear, visually engaging production from the supplied source material.",
              sourceBundle: { inputs: [], claims: [] },
              sourceRecordIds: attachedSources.map((source) => source.id),
              digestMode,
              researchMode,
              presentationMode: "faceless",
              targetDurationSeconds: durationSeconds,
              briefDurationHintSeconds,
              aspectRatio,
              language: "en",
              qualityTier,
              visualStylePreset,
              autopilot,
              idempotencyKey,
            }),
      });
      const json = await readApiJson<{ videoId?: string; productionId?: string; error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Create failed");
      const createdId = json.productionId ?? json.videoId;
      if (!createdId) throw new Error("Create response did not include a production ID");
      pendingCreateKeyRef.current = null;
      setVideoId(createdId);
      const nextJob = await fetchJob(createdId);
      setJob(nextJob);
      setActiveProjectId(nextJob.job.projectId);
      void refreshProjectData(nextJob.job.projectId).catch((projectError) => {
        handleBackgroundRefreshError(projectError, "Project refresh failed");
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Create failed");
    } finally {
      createInFlightRef.current = false;
      setBusy(false);
    }
  }, [activeProjectId, aspectRatio, briefDurationHintSeconds, contentType, digestMode, directorPrompt, durationSeconds, fetchJob, handleBackgroundRefreshError, libraryAssets, musicControls, prompt, qualityTier, refreshProjectData, researchMode, selectedProductionSources, sourceText, sourceTitle, visualMode, visualStylePreset]);

  async function addTextSource() {
    if (!sourceText.trim()) return;
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return;
    await createSources(projectId, [{ kind: "text", title: sourceTitle.trim() || "Pasted source", text: sourceText.trim() }]);
    setSourceText("");
    setSourceTitle("");
  }

  async function addUrlSources() {
    const urls = sourceUrls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    if (urls.length === 0) return;
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return;
    await createSources(projectId, urls.map((url) => ({ kind: "url" as const, url })));
    setSourceUrls("");
  }

  async function createSources(projectId: string, sources: Array<{ kind: "text"; title: string; text: string } | { kind: "url"; url: string }>) {
    setSourceBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/sources`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sources }) });
      const json = await readApiJson<{ sources?: ProductionSource[]; error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Sources could not be added");
      const added = json.sources ?? [];
      setProductionSources((current) => mergeSources(current, added));
      setSelectedSourceIds((current) => new Set([...current, ...added.map((source) => source.id)]));
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : "Sources could not be added");
    } finally {
      setSourceBusy(false);
    }
  }

  async function uploadPdfSources(files: File[]) {
    if (!files.length) return;
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return;
    setSourceBusy(true);
    setError(null);
    try {
      const readinessResponse = await fetch(`/api/projects/${projectId}/sources/upload`);
      const readiness = await readApiJson<{ clientUpload?: boolean; error?: string }>(readinessResponse);
      if (!readinessResponse.ok) throw new Error(readiness.error ?? "PDF upload readiness failed");
      if (readiness.clientUpload) {
        const uploadedUrls: string[] = [];
        for (const file of Array.from(files)) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, "-");
          const blob = await upload(`news-sources/${projectId}/${createClientIdempotencyKey()}-${safeName}`, file, {
            access: "private",
            handleUploadUrl: `/api/projects/${projectId}/sources/upload`,
            clientPayload: JSON.stringify({ projectId, originalName: file.name }),
            multipart: file.size > 5 * 1024 * 1024,
          });
          uploadedUrls.push(blob.url);
        }
        let refreshed: ProductionSource[] = [];
        for (let attempt = 0; attempt < 30; attempt++) {
          const refreshResponse = await fetch(`/api/projects/${projectId}/sources`);
          const refreshJson = await readApiJson<{ sources?: ProductionSource[]; error?: string }>(refreshResponse);
          if (!refreshResponse.ok) throw new Error(refreshJson.error ?? "Source refresh failed");
          refreshed = refreshJson.sources ?? [];
          if (uploadedUrls.every((url) => refreshed.some((source) => source.blobUrl === url))) break;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const existingIds = new Set(productionSources.map((source) => source.id));
        setProductionSources(refreshed);
        setSelectedSourceIds((current) => new Set([...current, ...refreshed.filter((source) => !existingIds.has(source.id)).map((source) => source.id)]));
        if (!uploadedUrls.every((url) => refreshed.some((source) => source.blobUrl === url))) throw new Error("The PDF was uploaded, but registration is still pending. Reopen this project in a moment to refresh its sources.");
      } else {
        const formData = new FormData();
        for (const file of Array.from(files)) formData.append("files", file);
        const response = await fetch(`/api/projects/${projectId}/sources/upload`, { method: "POST", body: formData });
        const json = await readApiJson<{ sources?: ProductionSource[]; error?: string }>(response);
        if (!response.ok) throw new Error(json.error ?? "PDF upload failed");
        const added = json.sources ?? [];
        setProductionSources((current) => mergeSources(current, added));
        setSelectedSourceIds((current) => new Set([...current, ...added.map((source) => source.id)]));
      }
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : "PDF upload failed");
    } finally {
      setSourceBusy(false);
    }
  }

  async function removeSource(sourceId: string) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return;
    const response = await fetch(`/api/projects/${projectId}/sources/${sourceId}`, { method: "DELETE" });
    const json = await readApiJson<{ error?: string }>(response);
    if (!response.ok) { setError(json.error ?? "Source removal failed"); return; }
    setProductionSources((current) => current.filter((source) => source.id !== sourceId));
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      next.delete(sourceId);
      return next;
    });
  }

  async function retrySource(sourceId: string) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return;
    setSourceBusy(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/sources/${sourceId}/retry`, { method: "POST" });
      const json = await readApiJson<{ source?: ProductionSource; error?: string }>(response);
      if (!response.ok || !json.source) throw new Error(json.error ?? "Source retry failed");
      setProductionSources((current) => mergeSources(current, [json.source!]));
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : "Source retry failed");
    } finally {
      setSourceBusy(false);
    }
  }

  async function saveNewsScript() {
    if (!videoId || !draftScript.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/productions/${videoId}/draft`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ script: draftScript.trim() }) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Script update failed");
      setJob(await fetchJob(videoId));
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : "Script update failed");
    } finally { setBusy(false); }
  }

  async function approveNews(gate: "script" | "storyboard") {
    if (!videoId || !job) return;
    const artifactVersionId = job.job.workflowSteps?.find((step) => step.id === gate)?.artifactVersionId;
    if (!artifactVersionId) { setError(`The current ${gate} does not have a reviewable version.`); return; }
    setBusy(true);
    try {
      const idempotencyKey = createClientIdempotencyKey();
      const response = await fetch(`/api/productions/${videoId}/approvals`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ gate, artifactVersionId, confirmSpend: gate === "storyboard", idempotencyKey }) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? `${gate} approval failed`);
      setJob(await fetchJob(videoId));
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : `${gate} approval failed`);
    } finally { setBusy(false); }
  }

  async function excludeClaim(claimId: string) {
    if (!videoId || !job?.job.sourceBundle) return;
    const claims = job.job.sourceBundle.claims.map((claim) => claim.id === claimId ? { ...claim, editorialStatus: "excluded" as const } : claim);
    setBusy(true);
    try {
      const response = await fetch(`/api/productions/${videoId}/draft`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claims }) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Claim update failed");
      setJob(await fetchJob(videoId));
    } catch (claimError) { setError(claimError instanceof Error ? claimError.message : "Claim update failed"); }
    finally { setBusy(false); }
  }

  async function editClaimText(claimId: string, text: string) {
    if (!videoId || !job?.job.sourceBundle || !text.trim()) return;
    const current = job.job.sourceBundle.claims.find((claim) => claim.id === claimId);
    if (!current || current.text === text.trim()) return;
    const claims = job.job.sourceBundle.claims.map((claim) => claim.id === claimId ? { ...claim, text: text.trim(), status: "unverified" as const, confidence: 0 } : claim);
    setBusy(true);
    try {
      const response = await fetch(`/api/productions/${videoId}/draft`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claims }) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Claim update failed");
      setJob(await fetchJob(videoId));
    } catch (claimError) { setError(claimError instanceof Error ? claimError.message : "Claim update failed"); }
    finally { setBusy(false); }
  }

  async function setClaimStatus(claimId: string, status: "unverified" | "supported" | "contested" | "rejected") {
    if (!videoId || !job?.job.sourceBundle) return;
    const claims = job.job.sourceBundle.claims.map((claim) => claim.id === claimId ? { ...claim, status, confidence: status === "supported" ? Math.max(claim.confidence, 0.75) : claim.confidence } : claim);
    setBusy(true);
    try {
      const response = await fetch(`/api/productions/${videoId}/draft`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claims }) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Claim status update failed");
      setJob(await fetchJob(videoId));
    } catch (claimError) { setError(claimError instanceof Error ? claimError.message : "Claim status update failed"); }
    finally { setBusy(false); }
  }

  async function regenerateNewsEditorial() {
    if (!videoId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/productions/${videoId}/regenerate-editorial`, { method: "POST" });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Editorial regeneration failed");
      setJob(await fetchJob(videoId));
    } catch (regenerationError) {
      setError(regenerationError instanceof Error ? regenerationError.message : "Editorial regeneration failed");
    } finally { setBusy(false); }
  }

  async function fitEditorialToDuration() {
    if (!videoId || !job) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/productions/${videoId}/fit-editorial`, { method: "POST" });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "The script could not be fitted to the selected duration");
      setJob(await fetchJob(videoId));
    } catch (fitError) {
      setError(fitError instanceof Error ? fitError.message : "The script could not be fitted to the selected duration");
    } finally {
      setBusy(false);
    }
  }

  async function editStoryboardScene(sceneId: string, patch: { visual?: string; visualKind?: "graphic" | "document" | "image" | "video" | "presenter" }) {
    if (!videoId || !job?.job.storyboard) return;
    const storyboard = { ...job.job.storyboard, scenes: job.job.storyboard.scenes.map((scene) => scene.id === sceneId ? { ...scene, ...patch } : scene) };
    setBusy(true);
    try {
      const response = await fetch(`/api/productions/${videoId}/draft`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storyboard }) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Storyboard update failed");
      setJob(await fetchJob(videoId));
    } catch (storyboardError) { setError(storyboardError instanceof Error ? storyboardError.message : "Storyboard update failed"); }
    finally { setBusy(false); }
  }

  async function editVisualBeat(beatId: string, patch: Partial<Pick<VisualBeat, "kind" | "intent" | "generationPrompt" | "motionDirection" | "locked">>) {
    if (!videoId) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/productions/${videoId}/visual-beats/${beatId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Visual beat update failed");
      setJob(await fetchJob(videoId));
    } catch (beatError) { setError(beatError instanceof Error ? beatError.message : "Visual beat update failed"); }
    finally { setBusy(false); }
  }

  async function regenerateVisualBeat(beatId: string) {
    if (!videoId) return;
    await mutate(`/api/productions/${videoId}/visual-beats/${beatId}`, { action: "regenerate" });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createVideo(false);
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter" || busy) return;
      event.preventDefault();
      void createVideo(!event.shiftKey);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, createVideo]);

  async function mutate(path: string, body: unknown = {}) {
    if (!videoId) return;
    setBusy(true);
    setError(null);
    const idempotencyKey = createClientIdempotencyKey();
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(
          body && typeof body === "object" && !Array.isArray(body)
            ? { ...body, idempotencyKey }
            : body,
        ),
      });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Mutation failed");
      setJob(await fetchJob(videoId));
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Mutation failed");
    } finally {
      setBusy(false);
    }
  }

  async function resumeEditorialRecovery() {
    if (!videoId || !productionProgress) return;
    if ((productionProgress.visualQuality?.duplicateGroupCount ?? 0) > 0) {
      const message = `Cocoa found ${productionProgress.visualQuality?.duplicateGroupCount} generation-output collision group${productionProgress.visualQuality?.duplicateGroupCount === 1 ? "" : "s"}. Salvage distinct provider results into immutable paths and build a revised V3 storyboard now? This recovery makes no new provider calls and preserves the existing final as a prior version.`;
      if (!window.confirm(message)) return;
      await mutate(`/api/productions/${videoId}/recovery`, { action: "salvage_visuals", beatIds: [], confirmSpend: false });
      return;
    }
    const qualityRecovery = productionProgress.visualQuality?.state === "failed"
      || productionProgress.visualQuality?.state === "needs_review";
    if (qualityRecovery && (productionProgress.visualQuality?.autoPolishAttempts ?? 0) > 0) {
      const message = "Re-check the corrected timing and recovered visuals now? This validation is non-billable and will not launch another image or video generation.";
      if (!window.confirm(message)) return;
      await mutate(`/api/productions/${videoId}/recovery`, {
        action: "resume",
        beatIds: [],
        confirmSpend: false,
      });
      const response = await fetch(`/api/productions/${videoId}/progress`, { cache: "no-store" });
      if (response.ok) setProductionProgress(await response.json() as ProductionProgressSnapshot);
      return;
    }
    const failedUnits = productionProgress.units.filter((unit) => unit.state === "needs_attention" || unit.state === "failed");
    const failedBeatIds = [...new Set([
      ...failedUnits.map((unit) => unit.id.replace(/^(image|video):/, "")).filter((id) => id.includes("beat")),
      ...(productionProgress.visualQuality?.rejectedBeatIds ?? []),
    ])];
    const estimatedIncrementalCents = failedBeatIds.reduce((sum, beatId) => (
      sum + (currentJob?.visualPlan?.beats.find((beat) => beat.id === beatId)?.costEstimateCents ?? 0)
    ), 0);
    if (failedBeatIds.length === 0) {
      setError(qualityRecovery
        ? "Visual rough-cut QA has not identified any beats that require recovery."
        : "No failed cinematic beats require recovery.");
      return;
    }
    const recoveryCostMessage = estimatedIncrementalCents === 0
      ? "No new provider spend is required."
      : `The estimated incremental cost is $${(estimatedIncrementalCents / 100).toFixed(2)}.`;
    const message = `${qualityRecovery ? "Apply visual-quality corrections" : "Resume with identity-safe replacements"} for ${failedBeatIds.length} flagged beat${failedBeatIds.length === 1 ? "" : "s"}? ${recoveryCostMessage} All successful assets and approvals will be retained.`;
    if (!window.confirm(message)) return;
    await mutate(`/api/productions/${videoId}/recovery`, {
      action: qualityRecovery ? "retry_failed_beats" : "safe_retry",
      beatIds: failedBeatIds,
      confirmSpend: true,
    });
    const response = await fetch(`/api/productions/${videoId}/progress`, { cache: "no-store" });
    if (response.ok) setProductionProgress(await response.json() as ProductionProgressSnapshot);
  }

  async function resumeEditorialDelivery() {
    if (!videoId) return;
    await mutate(`/api/productions/${videoId}/recovery`, {
      action: "resume",
      beatIds: [],
      confirmSpend: false,
    });
    const response = await fetch(`/api/productions/${videoId}/progress`, { cache: "no-store" });
    if (response.ok) setProductionProgress(await response.json() as ProductionProgressSnapshot);
  }

  async function addEditDirective(input: {
    scope: EditorScope;
    phase?: PhaseNumber;
    targetId?: string;
    text: string;
    strategy?: RegenerateStrategy;
    providerControls?: ProviderControls;
  }) {
    if (!videoId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/videos/${videoId}/edit-directives`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = await readApiJson<{ error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Edit directive failed");
      setJob(await fetchJob(videoId));
    } catch (directiveError) {
      setError(directiveError instanceof Error ? directiveError.message : "Edit directive failed");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateWithDirection(
    phase: PhaseNumber,
    target: { scope: EditorScope; phase?: PhaseNumber; targetId?: string },
    directiveText?: string,
    strategy?: RegenerateStrategy,
    providerControls?: ProviderControls,
  ) {
    if (!videoId) return;
    await mutate(`/api/videos/${videoId}/regenerate`, {
      phase,
      directiveText: directiveText?.trim() || undefined,
      strategy,
      providerControls,
      target,
    });
  }

  async function regenerateShotWithDirection(
    shotIndex: number,
    directiveText?: string,
    strategy?: RegenerateStrategy,
    providerControls?: ProviderControls,
  ) {
    if (!videoId) return;
    await mutate(`/api/videos/${videoId}/shots/${shotIndex}/regenerate`, {
      directiveText: directiveText?.trim() || undefined,
      strategy,
      providerControls,
      target: { scope: "shots", phase: 7, targetId: String(shotIndex) },
    });
  }

  async function restoreVersion(versionId: string) {
    if (!videoId) return;
    await mutate(`/api/videos/${videoId}/versions/${versionId}/restore`);
  }

  async function createMediaGenerationResult(input: MediaGenerationCreateRequest) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    const idempotencyKey = createClientIdempotencyKey();
    try {
      const response = await fetch(`/api/projects/${projectId}/media/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ ...input, idempotencyKey }),
      });
      const json = await readApiJson<{
        generation?: MediaGeneration;
        assets?: MediaAsset[];
        library?: MediaLibraryState;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        error?: string;
      }>(response);
      if (!response.ok || !json.generation) throw new Error(json.error ?? "Media generation failed");
      if (json.library) setMediaLibrary({ projectId, generations: json.library.generations, assets: json.library.assets });
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      return { generation: json.generation, assets: json.assets ?? [] };
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : "Media generation failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function createMediaGeneration(input: MediaGenerationCreateRequest) {
    const result = await createMediaGenerationResult(input);
    return result?.generation ?? null;
  }

  async function injectMediaGeneration(generationId: string, input: MediaGenerationInjectRequest) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId || !videoId) return;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/media/generations/${generationId}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = await readApiJson<{
        job?: VideoJob;
        library?: MediaLibraryState;
        error?: string;
      }>(response);
      if (!response.ok || !json.job) throw new Error(json.error ?? "Media injection failed");
      if (json.library) setMediaLibrary({ projectId, generations: json.library.generations, assets: json.library.assets });
      setJob(await fetchJob(videoId));
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : "Media injection failed");
    } finally {
      setMediaBusy(false);
    }
  }

  async function sendCocoaDirectorMessage(
    message: string,
    input: { sessionId?: string; selectedAssetIds?: string[]; shotIndex?: number } = {},
  ) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) throw new Error("Start a project before using Cocoa Director.");
    const response = await fetch(`/api/projects/${projectId}/agent/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoJobId: videoId ?? undefined,
        sessionId: input.sessionId,
        message,
        workspace: activeWorkspace,
        selectedAssetIds: input.selectedAssetIds ?? [],
        shotIndex: input.shotIndex,
      }),
    });
    const json = await readApiJson<{
      reply?: string;
      proposal?: AgentActionProposal;
      messages?: MediaSessionMessage[];
      error?: string;
    }>(response);
    if (!response.ok) throw new Error(json.error ?? "Cocoa Director failed");
    if (input.sessionId && json.messages) {
      setMediaSessions((current) =>
        current.map((session) => (
          session.id === input.sessionId
            ? { ...session, messages: json.messages ?? session.messages }
            : session
        )),
      );
    }
    return json;
  }

  async function sendAgentMessage(message: string, input: { selectedAssetIds?: string[]; shotIndex?: number } = {}) {
    const json = await sendCocoaDirectorMessage(message, input);
    return {
      reply: json.reply,
      proposal: renderProposalFromAgentProposal(json.proposal),
    };
  }

  async function sendSessionAgentMessage(sessionId: string, message: string) {
    return sendCocoaDirectorMessage(message, { sessionId });
  }

  async function sendDirectorChat() {
    if (!directorInput.trim() || busy || mediaBusy) return;
    const message = directorInput.trim();
    setDirectorInput("");
    setDirectorMessages((messages) => [...messages, { role: "user", text: message }]);
    try {
      const response = await sendCocoaDirectorMessage(message);
      if (response.reply) {
        setDirectorMessages((messages) => [...messages, { role: "agent", text: response.reply! }]);
      }
      setDirectorProposal(response.proposal ?? null);
    } catch (directorError) {
      setDirectorMessages((messages) => [
        ...messages,
        { role: "agent", text: directorError instanceof Error ? directorError.message : "Cocoa Director could not respond." },
      ]);
      setDirectorInput(message);
    }
  }

  async function confirmDirectorProposal() {
    if (!directorProposal) return;
    try {
      const completionMessage = await executeAgentProposal(directorProposal);
      setDirectorMessages((messages) => [
        ...messages,
        { role: "agent", text: completionMessage },
      ]);
      setDirectorProposal(null);
    } catch (directorError) {
      setDirectorMessages((messages) => [
        ...messages,
        { role: "agent", text: directorError instanceof Error ? directorError.message : "Cocoa Director could not complete that action." },
      ]);
    }
  }

  async function executeAgentProposal(proposal: AgentActionProposal) {
    if (proposal.actionType === "media_generation") {
      if (!proposal.kind || !proposal.prompt) throw new Error("This media proposal is missing a media type or prompt.");
      const inputAssetIds = proposal.inputAssetIds ?? [];
      const result = await createMediaGenerationResult({
        kind: proposal.kind,
        provider: proposal.provider ?? providerForMediaKind(proposal.kind),
        prompt: proposal.prompt,
        controls: normalizedDirectorMediaControls(proposal.kind, proposal.controls, inputAssetIds.length > 0, proposal.prompt),
        inputAssetIds,
        videoJobId: currentJob?.id,
        execute: true,
        label: proposal.label ?? proposal.title,
      });
      if (!result) throw new Error("Media generation did not complete.");
      setDirectorOutputs((outputs) => [
        directorOutputFromGeneration(result.generation, result.assets[0], proposal.title),
        ...outputs,
      ]);
      const generation = result.generation;
      if (generation.kind === "video" && (generation.status === "queued" || generation.status === "running")) {
        return `${proposal.title} is ${generation.status} with Seedance. I will keep checking for completion and update the output card when the clip is ready.`;
      }
      if (generation.status === "failed") {
        return `${proposal.title} failed: ${generation.error ?? "The provider did not return a usable output."}`;
      }
      return `${proposal.title} ${generation.status}. It is now tracked in the project media library.`;
    }

    if (proposal.actionType === "pipeline_directive") {
      await addEditDirective({
        scope: proposal.scope ?? "phase",
        phase: proposal.phase,
        targetId: proposal.targetId,
        text: proposal.directiveText ?? proposal.prompt ?? proposal.rationale,
        strategy: proposal.strategy,
        providerControls: proposal.providerControls,
      });
      return `${proposal.title} saved as a pipeline instruction.`;
    }

    if (proposal.actionType === "pipeline_regeneration") {
      const phase = (proposal.phase ?? currentJob?.currentPhase ?? 1) as PhaseNumber;
      await regenerateWithDirection(
        phase,
        {
          scope: proposal.scope ?? "phase",
          phase,
          targetId: proposal.targetId,
        },
        proposal.directiveText ?? proposal.prompt,
        proposal.strategy,
        proposal.providerControls,
      );
      return `${proposal.title} started through the pipeline regeneration path.`;
    }

    if (proposal.actionType === "media_injection") {
      if (!proposal.generationId || !currentJob) throw new Error("This injection proposal needs an active pipeline and generation.");
      await injectMediaGeneration(proposal.generationId, {
        videoJobId: currentJob.id,
        action: proposal.injectionAction ?? "use_in_render_manifest",
        role: proposal.role,
        shotIndex: proposal.shotIndex,
        note: proposal.directiveText ?? proposal.rationale,
      });
      return `${proposal.title} applied to the active pipeline.`;
    }

    return `${proposal.title} completed.`;
  }

  async function createProject(name?: string) {
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name?.trim() || "Cocoa Director Project" }),
      });
      const json = await readApiJson<{ project?: Project; error?: string }>(response);
      if (!response.ok || !json.project) throw new Error(json.error ?? "Project creation failed");
      setProjects((current) => upsertById(current, json.project!));
      setActiveProjectId(json.project.id);
      await refreshProjectData(json.project.id);
      return json.project;
    } catch (projectError) {
      setError(projectError instanceof Error ? projectError.message : "Project creation failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function createSession(input: {
    kind: MediaSessionKind;
    title?: string;
    goal?: string;
    sourceAssetId?: string;
    settings?: Record<string, unknown>;
  }) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/media-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = await readApiJson<{
        session?: MediaSessionWithVersions;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok || !json.session) throw new Error(json.error ?? "Media session creation failed");
      setMediaSessions(json.sessions ?? upsertById(mediaSessions, json.session));
      setActiveWorkspace("agent");
      return json.session;
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "Media session creation failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function generateSessionVersion(sessionId: string, input: {
    prompt: string;
    provider?: MediaProvider;
    controls?: Record<string, unknown>;
    inputAssetIds?: string[];
    label?: string;
  }) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId || sessionGenerationInFlightRef.current) return null;
    sessionGenerationInFlightRef.current = true;
    setMediaBusy(true);
    setError(null);
    const signature = JSON.stringify({ projectId, sessionId, input });
    if (pendingSessionKeyRef.current?.signature !== signature) pendingSessionKeyRef.current = { signature, key: createClientIdempotencyKey() };
    const idempotencyKey = pendingSessionKeyRef.current.key;
    try {
      const response = await fetch(`/api/projects/${projectId}/media-sessions/${sessionId}/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          ...input,
          execute: true,
          idempotencyKey,
          provider: input.provider,
          controls: input.controls ?? {},
          inputAssetIds: input.inputAssetIds ?? [],
        }),
      });
      const json = await readApiJson<{
        session?: MediaSessionWithVersions;
        generation?: MediaGeneration;
        sessions?: MediaSessionWithVersions[];
        media?: MediaLibraryState;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        error?: string;
      }>(response);
      if (!response.ok || !json.session) throw new Error(json.error ?? "Session generation failed");
      if (json.generation?.status === "failed") throw new Error(json.generation.error ?? "Generation failed. Review its details before staging another request.");
      pendingSessionKeyRef.current = null;
      setMediaSessions(json.sessions ?? upsertById(mediaSessions, json.session));
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      return json.session;
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "Session generation failed");
      return null;
    } finally {
      sessionGenerationInFlightRef.current = false;
      setMediaBusy(false);
    }
  }

  async function restoreSessionVersion(sessionId: string, versionId: string) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/media-sessions/${sessionId}/versions/${versionId}/restore`, {
        method: "POST",
      });
      const json = await readApiJson<{ sessions?: MediaSessionWithVersions[]; error?: string }>(response);
      if (!response.ok) throw new Error(json.error ?? "Version restore failed");
      if (json.sessions) setMediaSessions(json.sessions);
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Version restore failed");
    } finally {
      setMediaBusy(false);
    }
  }

  async function exportSessionVersion(sessionId: string, versionId?: string) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/media-sessions/${sessionId}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      const json = await readApiJson<{ downloadUrl?: string; fileName?: string; error?: string }>(response);
      if (!response.ok || !json.downloadUrl) throw new Error(json.error ?? "Version export failed");
      triggerBrowserDownload(json.downloadUrl, json.fileName);
      return json.downloadUrl;
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Version export failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function importLibraryAsset(input: {
    kind: MediaKind;
    url: string;
    name?: string;
    role?: string;
    tags?: string[];
  }) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, pinToProject: true }),
      });
      const json = await readApiJson<{
        libraryAsset?: LibraryAsset;
        mediaAsset?: MediaAsset;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        error?: string;
      }>(response);
      if (!response.ok || !json.libraryAsset) throw new Error(json.error ?? "Library import failed");
      setLibraryAssets(json.libraryAssets ?? upsertById(libraryAssets, json.libraryAsset));
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      return json.libraryAsset;
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Library import failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  // Upload a project file via Vercel Blob client-upload, falling back to a direct server
  // upload when there's no Blob token (local dev) — see /library/upload-direct.
  async function uploadProjectFile(
    projectId: string,
    file: File,
    payload: { kind: MediaKind; name: string; role: string; tags: string[] },
  ) {
    try {
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: `/api/projects/${projectId}/library/upload`,
        clientPayload: JSON.stringify({ projectId, ...payload }),
        multipart: file.size > 5 * 1024 * 1024,
      });
      // Blob completion is asynchronous. Keep the upload pending until the signed
      // callback registers the asset, otherwise the first refresh shows an empty vault.
      for (let attempt = 0; attempt < 30; attempt++) {
        const project = await refreshProjectData(projectId);
        if (project.libraryAssets?.some((asset) => asset.url === blob.url)) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("The file was uploaded, but registration is still pending. Reopen this project in a moment to refresh the library.");
    } catch (error) {
      // No Blob token (local dev) → the client token can't be minted. Fall back to a direct
      // server upload that writes to /dev-blob/. Production has a token, so this never runs.
      if (!/client token/i.test(error instanceof Error ? error.message : "")) throw error;
      const form = new FormData();
      form.set("file", file);
      form.set("kind", payload.kind);
      form.set("name", payload.name);
      form.set("role", payload.role);
      form.set("tags", JSON.stringify(payload.tags));
      const res = await fetch(`/api/projects/${projectId}/library/upload-direct`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error || "Upload failed");
      }
    }
  }

  async function uploadLibraryAsset(file: File, kind: MediaKind, role = "reference") {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      await uploadProjectFile(projectId, file, { kind, name: file.name, role, tags: ["uploaded"] });
      await refreshProjectData(projectId);
      return true;
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Upload failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  // Upload reference image(s) for a seed slot. They're tagged so the youPhotos/seedByRole
  // memos pick them up and buildSeedsPayload threads their URLs into the create request.
  async function uploadSeedImage(files: File[], role: SeedRole) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return;
    setSeedBusy(true);
    setSeedError(null);
    try {
      for (const file of files) {
        await uploadProjectFile(projectId, file, {
          kind: "image",
          name: file.name,
          role: libraryRoleForSeed(role),
          tags: ["seed", role === "you" ? "you" : "aesthetic"],
        });
      }
      await refreshProjectData(projectId);
    } catch (uploadError) {
      setSeedError(uploadError instanceof Error ? uploadError.message : "Upload failed");
    } finally {
      setSeedBusy(false);
    }
  }

  async function removeSeedImage(assetId: string) {
    setSeedError(null);
    await archiveLibraryAsset(assetId);
  }

  async function pinLibraryAsset(assetId: string) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/${assetId}/pin`, {
        method: "POST",
      });
      const json = await readApiJson<{
        mediaAsset?: MediaAsset;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok || !json.mediaAsset) throw new Error(json.error ?? "Library asset could not be used");
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
      return json.mediaAsset;
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : "Library asset could not be used");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function archiveLibraryAsset(assetId: string) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/${assetId}`, {
        method: "DELETE",
      });
      const json = await readApiJson<{
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok) throw new Error(json.error ?? "Library asset archive failed");
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "Library asset archive failed");
    } finally {
      setMediaBusy(false);
    }
  }

  async function updateLibraryAsset(assetId: string, input: { name?: string; tags?: string[]; favorite?: boolean; metadata?: Record<string, unknown> }) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/${assetId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = await readApiJson<{
        libraryAsset?: LibraryAsset;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok || !json.libraryAsset) throw new Error(json.error ?? "Library asset update failed");
      setLibraryAssets(json.libraryAssets ?? upsertById(libraryAssets, json.libraryAsset));
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
      return json.libraryAsset;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Library asset update failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function createLibraryCollection(name: string, assetIds: string[] = []) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, assetIds }),
      });
      const json = await readApiJson<{
        collection?: LibraryCollection;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok || !json.collection) throw new Error(json.error ?? "Reference pack creation failed");
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      setLibraryCollections(json.libraryCollections ?? upsertById(libraryCollections, json.collection));
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
      return json.collection;
    } catch (collectionError) {
      setError(collectionError instanceof Error ? collectionError.message : "Reference pack creation failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function updateLibraryCollection(collectionId: string, input: { name?: string; archived?: boolean; metadata?: Record<string, unknown> }) {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/collections/${collectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = await readApiJson<{
        collection?: LibraryCollection | null;
        archivedCollectionId?: string;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok) throw new Error(json.error ?? "Reference pack update failed");
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
      return json.collection ?? null;
    } catch (collectionError) {
      setError(collectionError instanceof Error ? collectionError.message : "Reference pack update failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function setLibraryCollectionAsset(collectionId: string, assetId: string, action: "add" | "remove") {
    const projectId = job?.job.projectId ?? activeProjectId;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/collections/${collectionId}/assets/${assetId}`, {
        method: action === "add" ? "POST" : "DELETE",
      });
      const json = await readApiJson<{
        collection?: LibraryCollection;
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok || !json.collection) throw new Error(json.error ?? "Reference pack asset update failed");
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
      return json.collection;
    } catch (collectionError) {
      setError(collectionError instanceof Error ? collectionError.message : "Reference pack asset update failed");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  async function pinLibraryCollection(collectionId: string) {
    const projectId = job?.job.projectId ?? activeProjectId ?? (await createProject())?.id;
    if (!projectId) return null;
    setMediaBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/library/collections/${collectionId}/pin`, {
        method: "POST",
      });
      const json = await readApiJson<{
        mediaAssets?: MediaAsset[];
        libraryAssets?: LibraryAsset[];
        libraryCollections?: LibraryCollection[];
        media?: MediaLibraryState;
        sessions?: MediaSessionWithVersions[];
        error?: string;
      }>(response);
      if (!response.ok) throw new Error(json.error ?? "Reference pack could not be used");
      if (json.libraryAssets) setLibraryAssets(json.libraryAssets);
      if (json.libraryCollections) setLibraryCollections(json.libraryCollections);
      if (json.media) setMediaLibrary({ projectId, generations: json.media.generations, assets: json.media.assets });
      if (json.sessions) setMediaSessions(json.sessions);
      return json.mediaAssets ?? [];
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : "Reference pack could not be used");
      return null;
    } finally {
      setMediaBusy(false);
    }
  }

  function askDirectorWithLibraryAsset(asset: LibraryAsset) {
    const prompt = stringFromMetadata(asset.metadata.prompt);
    const tags = asset.tags.length > 0 ? ` Tags: ${asset.tags.join(", ")}.` : "";
    const sourcePrompt = prompt ? ` Original prompt: ${prompt}.` : "";
    setDirectorInput(`Use the ${asset.kind} library asset "${asset.name}" as reference. URL: ${asset.url}.${tags}${sourcePrompt} Create `);
    setDirectorOpen(true);
  }

  async function resetStudio() {
    setVideoId(null);
    setJob(null);
    setProductionProgress(null);
    setSelectedSourceIds(new Set());
    sourceSelectionContextRef.current = null;
    hydratedJobIdRef.current = null;
    setError(null);
    setBusy(false);
    setPrompt(DEFAULT_PROMPT);
    setContentType("music_video");
    setQualityTier("standard");
    setAspectRatio("9:16");
    setSourceText("");
    setDurationSeconds(90);
    setVisualMode("conceptual");
    setStylePreset("auto");
    setStyleIntensity(42);
    setEditor(null);
    setPreviewSelection({ kind: "auto" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  }

  const currentJob = job?.job;
  const currentProjectId = currentJob?.projectId ?? activeProjectId;
  const activeProject = projects.find((project) => project.id === currentProjectId) ?? projects[0] ?? null;
  const editorialCoverage = currentJob && (currentJob.contentType === "news_digest" || currentJob.contentType === "explainer")
    ? editorialNarrationSeconds(currentJob) / Math.max(1, currentJob.durationSeconds)
    : undefined;
  const editorialFitNeeded = editorialCoverage !== undefined && (editorialCoverage < 0.75 || editorialCoverage > 0.92);
  const progress = jobProgressPercent(currentJob);
  const shotTotal = currentJob?.shotPlan?.shots.length ?? 0;
  const shotDone = currentJob?.generatedShots.length ?? 0;

  useEffect(() => {
    setPreviewSelection((selection) => (
      isPreviewSelectionAvailable(currentJob, selection) ? selection : { kind: "auto" }
    ));
  }, [currentJob]);

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="studio-ambient" aria-hidden />
      <div className="relative z-10 flex min-h-screen">
        <StudioSidebar activeWorkspace={activeWorkspace} onSelect={setActiveWorkspace} />
        <div className="flex min-w-0 flex-1 flex-col">
          {demoMode ? <div role="status" className="demo-banner">Demo mode · Synthetic media and simulated costs · No paid AI calls · Local projects reset when the server restarts</div> : null}
          <header className="studio-topbar border-b border-line/80 bg-background/82 backdrop-blur-xl">
            <div className="topbar-brand flex min-w-[220px] items-center gap-3">
              <div className="brand-mark">
                <Clapperboard className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <div className="truncate text-lg font-semibold leading-6">Cocoa Director</div>
                <div className="truncate text-xs font-medium uppercase tracking-[0.18em] text-muted">AI production studio</div>
              </div>
            </div>
            <TopPipeline current={job?.currentPhase ?? 0} currentJob={currentJob} progress={productionProgress ?? undefined} />
            <div className="topbar-metrics">
              <Metric label={productionProgress ? "Max authorized" : "Est. total"} value={productionProgress ? `$${(productionProgress.costs.maximumAuthorizedCents / 100).toFixed(2)}` : job ? `$${job.estimatedCostUsd.toFixed(2)}` : contentType === "music_video" ? `$${estimateInitialCost({ durationSeconds, aspectRatio }).totalUsd.toFixed(2)}` : "After planning"} />
              <Metric label={demoMode ? "Simulated spend" : "Spent"} value={productionProgress ? `$${(productionProgress.costs.actualCents / 100).toFixed(2)}` : job ? `$${job.actualCostUsd.toFixed(2)}` : "$0.00"} />
              <button
                type="button"
                className="icon-command h-11 px-4"
                disabled={busy}
                onClick={() => setDirectorOpen(true)}
                title="Ask Cocoa Director"
              >
                <Bot className="h-4 w-4" aria-hidden />
                <span>Director</span>
              </button>
              {job ? (
                <button
                  type="button"
                  className="icon-command h-11 px-4"
                  disabled={busy}
                  onClick={resetStudio}
                  title="Start a new video"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  <span>New</span>
                </button>
              ) : null}
              {authRequired ? (
                <button
                  type="button"
                  className="icon-command h-11 px-4"
                  disabled={busy}
                  onClick={logout}
                  title="End studio session"
                >
                  <LockKeyhole className="h-4 w-4" aria-hidden />
                  <span>Logout</span>
                </button>
              ) : null}
            </div>
          </header>

          <div className="grid gap-0 xl:flex-1 xl:grid-rows-[minmax(0,1fr)_auto]">
            {activeWorkspace === "create" ? (
              <>
            <section className="studio-main-grid min-h-0">
              <form onSubmit={submit} className="studio-panel create-panel min-h-0">
                <div className="panel-heading">
                  <div>
                    <h2>Create</h2>
                    <p>Director prompt</p>
                  </div>
                  <button type="button" className="ghost-command" onClick={() => setPrompt("")} title="Clear prompt">
                    <RefreshCcw className="h-4 w-4" aria-hidden />
                    <span>Clear</span>
                  </button>
                </div>

                <CreateSectionTabs
                  active={activeCreateSection}
                  onChange={setActiveCreateSection}
                  includeSources={contentType !== "music_video"}
                  sourceCount={productionSources.length}
                  reviewReady={Boolean(job)}
                />

                <div
                  className={`create-section-panel ${activeCreateSection === "brief" ? "is-active" : ""}`}
                  id="create-panel-brief"
                  role="tabpanel"
                  aria-labelledby="create-tab-brief"
                  hidden={activeCreateSection !== "brief"}
                >
                <div className="control-block">
                  <div className="field-label">Production format</div>
                  <div className="grid grid-cols-2 gap-2 2xl:grid-cols-3">
                    {FORMAT_OPTIONS.map((option) => {
                      const FormatIcon = option.icon;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => selectContentType(option.id)}
                          className={`mode-tile ${contentType === option.id ? "is-selected" : ""}`}
                          aria-pressed={contentType === option.id}
                        >
                          <FormatIcon className="h-5 w-5" aria-hidden />
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.detail}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="field-label" htmlFor="prompt">
                  {contentType === "music_video" ? "Prompt / concept" : "Production brief"}
                </label>
                <div className="prompt-shell">
                  <textarea
                    id="prompt"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    className="prompt-textarea"
                    maxLength={1200}
                  />
                  <div className="prompt-count">{directorPrompt.length} / 1500</div>
                </div>
                <button type="button" className="section-next-command" onClick={() => setActiveCreateSection(contentType === "music_video" ? "direction" : "sources")}>
                  Continue to {contentType === "music_video" ? "direction" : "sources"}
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
                </div>

                {contentType !== "music_video" && activeCreateSection === "sources" ? (
                  <div className="create-section-panel is-active" id="create-panel-sources" role="tabpanel" aria-labelledby="create-tab-sources">
                  <div className="control-block">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <div className="field-label">Add sources</div>
                        <div className="text-xs text-muted">Mix pasted text, public URLs, and private PDFs in one production.</div>
                      </div>
                      <label className="secondary-command h-9 cursor-pointer px-3">
                        <Upload className="h-4 w-4" aria-hidden />
                        <span>{sourceBusy ? "Processing…" : "Upload PDFs"}</span>
                        <input className="sr-only" type="file" accept="application/pdf,.pdf" multiple disabled={sourceBusy} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.currentTarget.value = ""; void uploadPdfSources(files); }} />
                      </label>
                    </div>
                    <input
                      value={sourceTitle}
                      onChange={(event) => setSourceTitle(event.target.value)}
                      className="toolbar-select mb-2 w-full"
                      maxLength={200}
                      placeholder="Text source title (optional)"
                    />
                    <textarea
                      id="source-text"
                      value={sourceText}
                      onChange={(event) => setSourceText(event.target.value)}
                      className="prompt-textarea min-h-28"
                      maxLength={200_000}
                      placeholder="Paste article text, notes, a transcript, or an approved brief…"
                    />
                    <button type="button" className="secondary-command mt-2 h-9 w-full" disabled={sourceBusy || !sourceText.trim()} onClick={() => void addTextSource()}>
                      <Plus className="h-4 w-4" aria-hidden /> Add text source
                    </button>
                    <textarea
                      value={sourceUrls}
                      onChange={(event) => setSourceUrls(event.target.value)}
                      className="prompt-textarea mt-3 min-h-20"
                      maxLength={20_000}
                      placeholder="Paste one or more public URLs, one per line…"
                    />
                    <button type="button" className="secondary-command mt-2 h-9 w-full" disabled={sourceBusy || !sourceUrls.trim()} onClick={() => void addUrlSources()}>
                      <LinkIcon className="h-4 w-4" aria-hidden /> Add URL sources
                    </button>
                    <div className="source-selection-summary" aria-live="polite">
                      <div><strong>{selectedProductionSources.length}</strong><span>selected</span></div>
                      <div><strong>{productionSources.length}</strong><span>available</span></div>
                      <p>{productionSources.length > 0 ? "Manage every source in the Sources workbench below." : "Add text, URLs, or private PDFs to ground this production."}</p>
                    </div>
                    <div className="mt-3 text-xs leading-5 text-muted">
                      PDFs are private and OCR runs only on pages without meaningful native text. Paid narration and visuals remain locked behind script and storyboard approval.
                    </div>
                  </div>
                  <button type="button" className="section-next-command" onClick={() => setActiveCreateSection("direction")}>
                    Continue to direction <ChevronRight className="h-4 w-4" aria-hidden />
                  </button>
                  </div>
                ) : null}

                <div
                  className={`create-section-panel ${activeCreateSection === "direction" ? "is-active" : ""}`}
                  id="create-panel-direction"
                  role="tabpanel"
                  aria-labelledby="create-tab-direction"
                  hidden={activeCreateSection !== "direction"}
                >
                {contentType === "news_digest" || contentType === "explainer" ? (
                  <div className="control-block">
                    <label className="field-label" htmlFor="visual-style-preset">Cinematic direction</label>
                    <select
                      id="visual-style-preset"
                      value={visualStylePreset}
                      onChange={(event) => setVisualStylePreset(event.target.value as VisualStylePreset)}
                      className="toolbar-select w-full"
                    >
                      {EDITORIAL_VISUAL_PRESETS.map((preset) => (
                        <option key={preset.id} value={preset.id}>{preset.label} · {preset.detail}</option>
                      ))}
                    </select>
                    <div className="mt-2 text-[11px] leading-4 text-muted">
                      Draft uses animated graphics and key art. Standard targets 45–60% cinematic coverage; Premium targets 60–75%.
                    </div>
                  </div>
                ) : null}

                {contentType === "news_digest" ? (
                  <div className="control-block grid gap-3">
                    <div>
                      <label className="field-label" htmlFor="digest-mode">Digest structure</label>
                      <select id="digest-mode" value={digestMode} onChange={(event) => setDigestMode(event.target.value as DigestMode)} className="toolbar-select w-full">
                        <option value="auto">Auto · choose coherent synthesis or roundup</option>
                        <option value="single_topic">Single topic · one connected story</option>
                        <option value="roundup">Roundup · several distinct stories</option>
                      </select>
                    </div>
                    <div>
                      <label className="field-label" htmlFor="research-mode">Research</label>
                      <select id="research-mode" value={researchMode} onChange={(event) => setResearchMode(event.target.value as ResearchMode)} className="toolbar-select w-full">
                        <option value="supplied_only">Supplied sources only</option>
                        <option value="corroborate" disabled={!capabilities.newsWebResearch}>Corroborate on the web</option>
                      </select>
                      {!capabilities.newsWebResearch ? (
                        <p className="mt-2 text-xs leading-5 text-muted">
                          Web corroboration is disabled for this deployment. Supplied URLs, PDFs, and text still work normally.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="control-block">
                  <div className="flex items-center justify-between gap-3">
                    <label className="field-label" htmlFor="duration">
                      Duration
                    </label>
                    <output className="font-mono text-sm text-foreground">{formatSeconds(durationSeconds)}</output>
                  </div>
                  <div className="range-row">
                    <span>{formatSeconds(durationRange.min)}</span>
                    <input
                      id="duration"
                      type="range"
                      min={durationRange.min}
                      max={durationRange.max}
                      value={durationSeconds}
                      onChange={(event) => setDurationSeconds(Number(event.target.value))}
                      className="cinema-range"
                    />
                    <span>{formatSeconds(durationRange.max)}</span>
                  </div>
                  {hasDurationConflict ? (
                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-amber-400/35 bg-amber-400/8 p-3 text-xs text-amber-100" role="status">
                      <span>Brief says {formatSeconds(briefDurationHintSeconds)}; selected duration is {formatSeconds(durationSeconds)}. The control will be used.</span>
                      <button type="button" className="shrink-0 rounded border border-amber-300/40 px-2 py-1 font-medium hover:bg-amber-300/10" onClick={() => setDurationSeconds(briefDurationHintSeconds)}>Use brief duration</button>
                    </div>
                  ) : null}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <label className="spec-pill border-accent bg-accent/12 text-accent">
                    <Film className="h-4 w-4" aria-hidden />
                    <select
                      value={aspectRatio}
                      onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}
                      className="bg-transparent text-xs font-medium outline-none"
                      aria-label="Aspect ratio"
                    >
                      <option value="9:16">9:16</option>
                      <option value="16:9">16:9</option>
                      <option value="1:1">1:1</option>
                    </select>
                  </label>
                  <Pill icon={<Aperture className="h-4 w-4" />} label={qualityTier === "premium" ? "Premium" : qualityTier === "draft" ? "Draft" : "Standard"} />
                  <Pill icon={contentType === "music_video" ? <Music2 className="h-4 w-4" /> : <FileText className="h-4 w-4" />} label={FORMAT_OPTIONS.find((item) => item.id === contentType)?.label ?? "Video"} />
                </div>

                {contentType !== "music_video" ? (
                  <div className="control-block">
                    <label className="field-label" htmlFor="quality-tier">Quality tier</label>
                    <select
                      id="quality-tier"
                      value={qualityTier}
                      onChange={(event) => setQualityTier(event.target.value as QualityTier)}
                      className="toolbar-select w-full"
                    >
                      <option value="draft">Draft · proxies and economical routing</option>
                      <option value="standard">Standard · balanced quality and cost</option>
                      <option value="premium">Premium · best measured routing</option>
                    </select>
                  </div>
                ) : null}

                {contentType === "music_video" ? <div className="control-block">
                  <div className="field-label">Visual mode</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setVisualMode("conceptual")}
                      className={`mode-tile ${visualMode === "conceptual" ? "is-selected" : ""}`}
                    >
                        <Sparkles className="h-5 w-5" aria-hidden />
                      <span>
                        <strong>Conceptual first</strong>
                        <small>World and rhythm led</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setVisualMode("visible_performer")}
                      className={`mode-tile ${visualMode === "visible_performer" ? "is-selected" : ""}`}
                    >
                      <UserRound className="h-5 w-5" aria-hidden />
                      <span>
                        <strong>Show performer</strong>
                        <small>Adult performer early</small>
                      </span>
                    </button>
                  </div>
                </div> : null}

                {contentType === "music_video" ? <div className="control-block">
                  <div className="field-label">User style intervention</div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
                    {STYLE_PRESETS.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        onClick={() => setStylePreset(item.id)}
                        className={`style-chip ${stylePreset === item.id ? "is-selected" : ""}`}
                      >
                        <Palette className="h-4 w-4" aria-hidden />
                        <span>{item.label}</span>
                        <small>{item.detail}</small>
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="min-w-24 text-xs font-medium text-muted">Intervention</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={styleIntensity}
                      onChange={(event) => setStyleIntensity(Number(event.target.value))}
                      className="cinema-range"
                      aria-label="Style intervention strength"
                    />
                    <output className="w-10 text-right font-mono text-xs text-foreground">{styleIntensity}%</output>
                  </div>
                </div> : null}

                {contentType === "music_video" ? <MusicStudioCard
                  value={musicControls}
                  onChange={setMusicControls}
                  onOpenFull={() => setMusicStudioOpen(true)}
                /> : null}
                <button type="button" className="section-next-command" onClick={() => setActiveCreateSection("review")}>
                  Continue to review <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
                </div>

                <div
                  className={`create-section-panel ${activeCreateSection === "review" ? "is-active" : ""}`}
                  id="create-panel-review"
                  role="tabpanel"
                  aria-labelledby="create-tab-review"
                  hidden={activeCreateSection !== "review"}
                >
                <div className="action-grid">
                  <button
                    type="button"
                    disabled={busy || (contentType !== "music_video" && hasUnreadySources)}
                    onClick={() => createVideo(true)}
                    className="primary-command"
                    aria-keyshortcuts="Control+Enter Meta+Enter"
                    title={contentType !== "music_video" && hasUnreadySources ? "Wait for source processing or resolve failed sources" : "Command or Control plus Enter"}
                  >
                    <Sparkles className="h-4 w-4" aria-hidden />
                    {busy
                      ? "Starting..."
                      : contentType === "music_video"
                        ? "Make Video"
                        : sourceProcessingActive
                          ? "Processing sources..."
                          : hasUnreadySources
                            ? "Resolve sources"
                            : "Create Draft"}
                    <span>{contentType === "music_video" ? `$${estimateInitialCost({ durationSeconds, aspectRatio }).totalUsd.toFixed(2)} est.` : job ? `$${job.estimatedCostUsd.toFixed(2)} est.` : "Estimate after planning"}</span>
                  </button>
                  <button
                    type="submit"
                    disabled={busy || (contentType !== "music_video" && hasUnreadySources)}
                    className="secondary-command"
                    aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
                    title={contentType !== "music_video" && hasUnreadySources ? "Wait for source processing or resolve failed sources" : "Command or Control plus Shift plus Enter"}
                  >
                    <Send className="h-4 w-4" aria-hidden />
                    {busy
                      ? "Staging..."
                      : contentType === "music_video"
                        ? "Stage"
                        : sourceProcessingActive
                          ? "Processing..."
                          : hasUnreadySources
                            ? "Resolve sources"
                            : "Create for Review"}
                  </button>
                </div>

                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <button
                    type="button"
                    disabled={!canAdvance || busy}
                    onClick={() => mutate(`/api/videos/${videoId}/advance`)}
                    className="secondary-command"
                  >
                    <ChevronRight className="h-4 w-4" aria-hidden />
                    {nextActionLabel}
                  </button>
                  <button
                    type="button"
                    disabled={!videoId || busy || jobIsTerminal}
                    onClick={() => mutate(`/api/videos/${videoId}/cancel`)}
                    className="danger-command h-11 w-11"
                    aria-label="Cancel"
                    title="Cancel"
                  >
                    <Ban className="h-4 w-4" aria-hidden />
                  </button>
                </div>

                {visibleError ? <ErrorDetail>{visibleError}</ErrorDetail> : null}
                {job?.job.contentType === "news_digest" && visibleError?.includes("Sources changed") ? (
                  <button type="button" className="primary-command w-full" disabled={busy} onClick={() => void regenerateNewsEditorial()}>
                    <RefreshCcw className="h-4 w-4" /> Regenerate cited draft
                  </button>
                ) : null}

                {(job?.job.contentType === "news_digest" || job?.job.contentType === "explainer") && job.job.script ? (
                  <div className="control-block space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="field-label">Cited script approval</div>
                        <div className="text-xs text-muted">Approve the exact saved version after reviewing its claims and evidence.</div>
                      </div>
                      <span className="font-mono text-xs text-accent">{job.job.approvals?.some((item) => item.gate === "script" && item.artifactVersionId === job.job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId) ? "approved" : "review"}</span>
                    </div>
                    <textarea value={draftScript} onChange={(event) => setDraftScript(event.target.value)} className="prompt-textarea min-h-48" maxLength={50_000} />
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" className="secondary-command" disabled={busy || draftScript.trim() === job.job.script} onClick={() => void saveNewsScript()}><Save className="h-4 w-4" /> Save version</button>
                      {editorialFitNeeded ? (
                        <button type="button" className="primary-command" disabled={busy} onClick={() => void fitEditorialToDuration()}>
                          <Sparkles className="h-4 w-4" /> {editorialCoverage !== undefined && editorialCoverage > 0.92 ? "Condense to" : "Fit to"} {formatSeconds(job.job.durationSeconds)}
                        </button>
                      ) : (
                        <button type="button" className="primary-command" disabled={busy} onClick={() => void approveNews("script")}><CheckCircle2 className="h-4 w-4" /> Approve script</button>
                      )}
                    </div>
                    <div className="rounded-lg border border-border bg-black/10 p-3 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted">Predicted narration</span>
                        <span className="font-mono text-foreground">{formatSeconds(Math.ceil(editorialNarrationSeconds(job.job)))} / {formatSeconds(job.job.durationSeconds)}</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, editorialNarrationSeconds(job.job) / job.job.durationSeconds * 100)}%` }} />
                      </div>
                      <div className="mt-2 text-[10px] leading-4 text-muted">Includes the voice-specific pause and transition reserve. Material overruns must return to script review.</div>
                      <div className={`mt-1 font-mono text-[10px] ${editorialNarrationSeconds(job.job) / job.job.durationSeconds >= 0.75 && editorialNarrationSeconds(job.job) / job.job.durationSeconds <= 0.92 ? "text-accent" : "text-amber-300"}`}>
                        {Math.round(editorialNarrationSeconds(job.job) / job.job.durationSeconds * 100)}% predicted spoken coverage · required 75–92%
                      </div>
                      {editorialFitNeeded ? (
                        <div className="mt-2 text-[11px] leading-4 text-foreground">
                          Director can revise this draft from the attached evidence, preserve its citations, and create a new exact version for your review.
                        </div>
                      ) : null}
                    </div>
                    {job.job.contentType === "news_digest" ? <div className="claim-review-grid">
                      {(job.job.sourceBundle?.claims ?? []).map((claim) => (
                        <div key={claim.id} className={`rounded-lg border p-3 ${claim.status === "supported" ? "border-accent/25 bg-accent/5" : "border-red-500/30 bg-red-500/5"}`}>
                          <div className="flex items-start justify-between gap-2">
                            <textarea defaultValue={claim.text} onBlur={(event) => void editClaimText(claim.id, event.currentTarget.value)} className="min-h-16 flex-1 resize-y bg-transparent text-xs leading-5 text-foreground outline-none" aria-label={`Edit claim ${claim.id}`} />
                            <button type="button" className="text-xs text-muted hover:text-red-300" onClick={() => void excludeClaim(claim.id)}>Exclude</button>
                          </div>
                          <div className="mt-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wide text-muted">
                            <select value={claim.status} onChange={(event) => void setClaimStatus(claim.id, event.target.value as "unverified" | "supported" | "contested" | "rejected")} className="rounded border border-border bg-transparent px-1 py-0.5 text-[10px] text-foreground">
                              <option value="unverified">unverified</option><option value="supported">supported</option><option value="contested">contested</option><option value="rejected">rejected</option>
                            </select>
                            <span>{Math.round(claim.confidence * 100)}% · {claim.asOf ? `as of ${formatSourceDate(claim.asOf)}` : "no date"}</span>
                          </div>
                          <div className="mt-2 space-y-1">
                            {claim.evidenceRefs.map((evidence) => (
                              <a key={`${claim.id}-${evidence.sourceId}-${evidence.fragmentId ?? evidence.pageNumber ?? "e"}`} href={evidence.sourceUrl ?? `/api/projects/${job.job.projectId}/sources/${evidence.sourceId}/download${evidence.pageNumber ? `#page=${evidence.pageNumber}` : ""}`} target="_blank" rel="noreferrer" className="block text-[11px] leading-4 text-accent hover:underline">
                                {evidence.pageNumber ? `Page ${evidence.pageNumber}` : evidence.section ?? safeDomain(evidence.sourceUrl)} · {evidence.excerpt.slice(0, 160)}{evidence.excerpt.length > 160 ? "…" : ""}
                              </a>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div> : null}
                    {job.job.approvals?.some((item) => item.gate === "script" && item.artifactVersionId === job.job.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId) ? (
                      <div className="space-y-2 border-t border-border pt-3">
                        <div className="flex items-end justify-between gap-3">
                          <div>
                            <div className="field-label">Hybrid cinematic storyboard</div>
                            <div className="text-[11px] text-muted">Beat-level footage, evidence, data, overlays, and persistent disclosures.</div>
                          </div>
                          {job.job.visualPlan ? <span className="font-mono text-[10px] text-accent">{Math.round(job.job.visualPlan.metrics.cinematicCoverage * 100)}% cinema · {job.job.visualPlan.metrics.cinematicBeatCount} clips</span> : null}
                        </div>
                        {job.job.visualPlan ? (
                          <div className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-black/10 p-3 font-mono text-[10px] text-muted">
                            <span>{job.job.visualPlan.resolvedPreset.replaceAll("_", " ")}</span>
                            <span className="text-right">${(job.job.visualPlan.metrics.estimatedCostCents / 100).toFixed(2)} visual calls</span>
                            <span>{job.job.visualPlan.metrics.evidenceBeatCount} evidence/data beats</span>
                            <span className="text-right">{Math.round(job.job.visualPlan.metrics.staticCoverage * 100)}% deliberate holds</span>
                            <span>{job.job.visualPlan.chapters.length} directed chapters</span>
                            <span className="text-right">V{job.job.visualPlan.version} direction</span>
                            {job.job.visualPlan.qualityReport ? <>
                              <span className={job.job.visualPlan.qualityReport.passed ? "text-accent" : "text-danger"}>{Math.round(job.job.visualPlan.qualityReport.uniqueAssetRatio * 100)}% unique assets</span>
                              <span className={`text-right ${job.job.visualPlan.qualityReport.passed ? "text-accent" : "text-danger"}`}>{job.job.visualPlan.qualityReport.state.replaceAll("_", " ")}</span>
                            </> : null}
                            {job.job.visualPlan.timingPlan ? <>
                              <span>{Math.round(job.job.visualPlan.timingPlan.coverage.spokenCoverage * 100)}% measured speech</span>
                              <span className="text-right">{job.job.visualPlan.timingPlan.pauses.length} explicit pauses · max {(Math.max(0, ...job.job.visualPlan.timingPlan.pauses.map((pause) => pause.durationMs)) / 1_000).toFixed(1)}s</span>
                            </> : null}
                          </div>
                        ) : null}
                        <div className="storyboard-scene-grid">
                          {job.job.storyboard?.scenes.map((scene) => (
                            <div key={scene.id} className="rounded-lg border border-border p-3 text-xs">
                              <div className="font-medium text-foreground">{scene.title}</div>
                              <textarea defaultValue={scene.visual} onBlur={(event) => { if (event.currentTarget.value.trim() !== scene.visual) void editStoryboardScene(scene.id, { visual: event.currentTarget.value.trim() }); }} className="mt-1 min-h-12 w-full resize-y bg-transparent text-muted outline-none" aria-label={`Edit visual direction for ${scene.title}`} />
                              <div className="storyboard-beat-grid" aria-label={`${scene.title} visual beats`}>
                                {(scene.beats ?? []).map((beat) => (
                                  <div key={beat.id} className={`storyboard-beat-card rounded-md border p-2 ${beat.kind === "synthetic_reenactment" ? "border-amber-400/40 bg-amber-400/5" : "border-border bg-black/15"}`}>
                                    <div className="flex items-center justify-between gap-2">
                                      <select value={beat.kind} disabled={beat.locked || busy} onChange={(event) => void editVisualBeat(beat.id, { kind: event.target.value as VisualBeatKind })} className="min-w-0 flex-1 rounded border border-border bg-panel px-1 py-1 text-[10px] text-foreground">
                                        {Object.entries(VISUAL_BEAT_LABELS).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
                                      </select>
                                      <button type="button" title={beat.locked ? "Unlock beat" : "Lock beat"} aria-label={beat.locked ? `Unlock ${beat.id}` : `Lock ${beat.id}`} disabled={busy} className={beat.locked ? "text-accent" : "text-muted"} onClick={() => void editVisualBeat(beat.id, { locked: !beat.locked })}><LockKeyhole className="h-3.5 w-3.5" /></button>
                                    </div>
                                    <div className="mt-1 font-mono text-[9px] text-muted">{formatSeconds(beat.startMs / 1_000)}–{formatSeconds(beat.endMs / 1_000)} · {beat.providerRoute.video ?? beat.providerRoute.image ?? "deterministic"}</div>
                                    <div className="mt-1 font-mono text-[9px] leading-4 text-accent/90">{beat.chapterId?.replace("chapter-", "ch ") ?? "chapter"} · {beat.sequencePattern?.replaceAll("_", " ") ?? "editorial sequence"}</div>
                                    {beat.shotSpec ? <div className="mt-1 rounded border border-border/70 bg-black/20 p-1.5 text-[9px] leading-4 text-muted">
                                      <div>{beat.shotSpec.size.replaceAll("_", " ")} · {beat.shotSpec.angle.replaceAll("_", " ")} · {beat.shotSpec.cameraMovement.replaceAll("_", " ")}</div>
                                      <div>{beat.shotSpec.transition.replaceAll("_", " ")} · {beat.shotSpec.narrativeFunction}</div>
                                    </div> : null}
                                    {beat.graphicSpec ? <div className="mt-1 rounded border border-sky-400/20 bg-sky-400/5 px-1.5 py-1 font-mono text-[9px] text-sky-200">{beat.graphicSpec.family.replaceAll("_", " ")} · {"values" in beat.graphicSpec ? `${beat.graphicSpec.values.length} cited value${beat.graphicSpec.values.length === 1 ? "" : "s"}` : "evidence payload"} · {beat.graphicSpec.overlayPlacement}</div> : null}
                                    {beat.sourceVisual ? <div className="mt-1 rounded border border-accent/25 bg-accent/5 p-1.5 text-[9px] leading-4 text-muted">
                                      <div className="font-mono text-accent">{beat.sourceVisual.kind.replaceAll("_", " ")} · {beat.sourceVisual.locator}</div>
                                      <div className="line-clamp-3">“{beat.sourceVisual.excerpt}”</div>
                                      <div className="flex items-center justify-between gap-2 font-mono text-[8px]"><span>hash {beat.sourceVisual.excerptHash.slice(0, 12)} · {beat.fullScreen ? `${((beat.endMs - beat.startMs) / 1_000).toFixed(1)}s full-screen` : "layered"}</span>{beat.sourceVisual.sourceUrl ? <a href={beat.sourceVisual.sourceUrl} target="_blank" rel="noreferrer" className="shrink-0 text-accent underline underline-offset-2">Open source</a> : null}</div>
                                    </div> : null}
                                    {beat.motionCues.length > 0 ? <div className="mt-1 font-mono text-[8px] text-muted">motion: {beat.motionCues.map((cue) => `${cue.kind}@${(cue.atMs / 1_000).toFixed(1)}s`).join(" · ")}</div> : null}
                                    {(() => {
                                      const asset = beat.assets.find((candidate) => candidate.status === "ready" && candidate.kind === "video" && candidate.url) ?? beat.assets.find((candidate) => candidate.status === "ready" && candidate.url);
                                      if (!asset?.url) return null;
                                      return asset.kind === "video"
                                        ? <video className="mt-2 aspect-video w-full rounded border border-border object-cover" src={asset.url} controls preload="metadata" />
                                        : <Image className="mt-2 aspect-video w-full rounded border border-border object-cover" src={asset.url} alt={`${scene.title} visual proxy`} width={480} height={270} unoptimized />;
                                    })()}
                                    {job.job.visualPlan?.qualityReport?.rejectedBeatIds.includes(beat.id) ? <div className="mt-1 rounded border border-danger/30 bg-danger/10 px-1.5 py-1 font-mono text-[9px] text-danger">Flagged by visual rough-cut QA</div> : null}
                                    <textarea defaultValue={beat.intent} disabled={beat.locked || busy} onBlur={(event) => { if (event.currentTarget.value.trim() !== beat.intent) void editVisualBeat(beat.id, { intent: event.currentTarget.value.trim() }); }} className="mt-1 min-h-14 w-full resize-y bg-transparent text-[10px] leading-4 text-muted outline-none" aria-label={`Edit intent for ${beat.id}`} />
                                    {beat.generationPrompt ? <details className="mt-1 text-[9px] text-muted">
                                      <summary className="cursor-pointer text-accent">Generation prompt &amp; motion</summary>
                                      <textarea defaultValue={beat.generationPrompt} disabled={beat.locked || busy} onBlur={(event) => { if (event.currentTarget.value.trim() !== beat.generationPrompt) void editVisualBeat(beat.id, { generationPrompt: event.currentTarget.value.trim() }); }} className="mt-1 min-h-24 w-full resize-y rounded border border-border bg-black/15 p-1.5 text-[9px] leading-4 outline-none" aria-label={`Edit generation prompt for ${beat.id}`} />
                                      <textarea defaultValue={beat.motionDirection} disabled={beat.locked || busy} onBlur={(event) => { if (event.currentTarget.value.trim() !== beat.motionDirection) void editVisualBeat(beat.id, { motionDirection: event.currentTarget.value.trim() }); }} className="mt-1 min-h-14 w-full resize-y rounded border border-border bg-black/15 p-1.5 text-[9px] leading-4 outline-none" aria-label={`Edit motion direction for ${beat.id}`} />
                                      <div className="mt-1 font-mono">fallback: {beat.providerRoute.fallback} · ${(beat.costEstimateCents / 100).toFixed(2)}</div>
                                    </details> : null}
                                    {beat.disclosure.required ? <div className="mt-1 rounded bg-amber-300/10 px-1.5 py-1 font-mono text-[9px] text-amber-200">AI-GENERATED REENACTMENT · persistent</div> : null}
                                    {beat.assets.some((asset) => asset.status === "ready") ? <button type="button" disabled={busy || beat.locked} onClick={() => void regenerateVisualBeat(beat.id)} className="mt-2 flex items-center gap-1 text-[10px] text-accent disabled:opacity-40"><RefreshCcw className="h-3 w-3" /> Regenerate</button> : null}
                                  </div>
                                ))}
                              </div>
                              <div className="mt-2 font-mono text-[10px] text-accent">{scene.citationLabels.length} source labels · {(scene.beats ?? []).length} visual beats</div>
                            </div>
                          ))}
                        </div>
                        <button type="button" className="primary-command w-full" disabled={busy} onClick={() => void approveNews("storyboard")}><Sparkles className="h-4 w-4" /> Approve storyboard &amp; generate</button>
                        <div className="text-[11px] leading-4 text-muted">This confirms the displayed image/video calls and spend for narration, score, cinematic assets, graphics, validation, and the final render. Failed cinematic beats return for review rather than silently becoming static cards.</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                </div>
              </form>

              <section className="stage-column min-h-0">
                <PreviewPanel
                  job={currentJob}
                  progress={productionProgress ?? undefined}
                  previewSelection={previewSelection}
                  onPreviewSelect={setPreviewSelection}
                  onOpenEditor={setEditor}
                />
              </section>

              <aside className="studio-panel inspector-panel min-h-0">
                <div className="panel-heading">
                  <div>
                    <h2>Run status</h2>
                    <p>{currentJob ? workflowStepPosition(currentJob) : "Idle"}</p>
                  </div>
                  <StateBadge state={currentJob?.status ?? "pending"} label={currentJob?.status ?? "idle"} compact />
                </div>
                <div className="status-hero">
                  <div>
                    <span>{productionProgress?.activeStageLabel ?? currentStep?.name ?? currentPhase?.name ?? phases[(currentJob?.currentPhase ?? 1) - 1] ?? "Ready"}</span>
                    <strong>{productionProgress ? progressHealthLabel(productionProgress.state) : currentJob ? statusSummary(currentJob, currentPhase).title : "Ready for direction"}</strong>
                  </div>
                  {productionProgress ? <ProgressHealthIcon state={productionProgress.state} /> : <ProgressRing value={progress} />}
                </div>
                {!productionProgress ? <div className="run-progress"><div style={{ width: `${progress}%` }} /></div> : null}
                <CompactRunSummary apiJob={job} progress={productionProgress ?? undefined} />

                <div className="run-summary-grid">
                  <div><span>Spent</span><strong>{productionProgress ? `$${(productionProgress.costs.actualCents / 100).toFixed(2)}` : job ? `$${job.actualCostUsd.toFixed(2)}` : "$0.00"}</strong></div>
                  <div><span>Shots</span><strong>{shotTotal ? `${shotDone}/${shotTotal}` : "Pending"}</strong></div>
                  <div><span>Format</span><strong>{formatContentType(currentContentType(currentJob))}</strong></div>
                  <div><span>Mode</span><strong>{currentContentType(currentJob) === "music_video" ? (visualMode === "conceptual" ? "Conceptual" : "Performer") : currentJob?.qualityTier ?? qualityTier}</strong></div>
                </div>

                {currentJob?.status === "failed" ? (
                  <div className="grid gap-2">
                    {currentJob.currentPhase >= 7 && /image_urls|reference|likeness|private/i.test(currentJob.error ?? "") ? (
                      <button
                        type="button"
                        disabled={!videoId || busy}
                        onClick={() => mutate(`/api/videos/${videoId}/regenerate`, { phase: 5 })}
                        className="secondary-command"
                      >
                        <RefreshCcw className="h-4 w-4" aria-hidden />
                        Regenerate anchors
                      </button>
                    ) : null}
                    {productionProgress && currentContentType(currentJob) !== "music_video" ? (
                      <button
                        type="button"
                        disabled={!videoId || busy}
                        onClick={() => void resumeEditorialDelivery()}
                        className="secondary-command"
                      >
                        <RefreshCcw className="h-4 w-4" aria-hidden />
                        Resume from {productionProgress.activeStageLabel}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!videoId || busy}
                        onClick={() => mutate(`/api/videos/${videoId}/regenerate`, { phase: currentJob.currentPhase })}
                        className="secondary-command"
                      >
                        <RefreshCcw className="h-4 w-4" aria-hidden />
                        Retry current phase
                      </button>
                    )}
                  </div>
                ) : null}

                <div className="run-info">
                  <InfoRow label="Workflow" value={currentJob?.workflowVersion ?? "music-video-v1"} />
                  <InfoRow label="Trace" value={currentJob ? currentJob.traceId.slice(0, 10) : "not started"} />
                </div>
              </aside>
            </section>

            <ProductionWorkbench
              items={[
                {
                  id: "pipeline",
                  label: "Pipeline",
                  badge: currentJob ? `${currentJob.currentPhase}/9` : undefined,
                  content: <PhaseTimeline current={job?.currentPhase ?? 0} currentJob={currentJob} progress={productionProgress ?? undefined} />,
                },
                {
                  id: "sources",
                  label: "Sources",
                  badge: productionSources.length || undefined,
                  disabled: contentType === "music_video" && productionSources.length === 0,
                  content: <SourcesPanel sources={productionSources} selectedSourceIds={selectedSourceIds} onSelectionChange={setSelectedSourceIds} onRetry={retrySource} onRemove={removeSource} />,
                },
                {
                  id: "anchors",
                  label: "Anchors",
                  badge: currentJob?.anchorAssets.length || undefined,
                  content: <AssetsPanel job={currentJob} assets={currentJob?.anchorAssets ?? []} youPhotos={youPhotos} seedByRole={seedByRole} onOpenSeedDrawer={setSeedDrawer} previewSelection={previewSelection} onPreviewSelect={setPreviewSelection} onOpenEditor={setEditor} />,
                },
                {
                  id: "shots",
                  label: "Shots",
                  badge: currentJob?.generatedShots.length || undefined,
                  content: <ShotsPanel job={currentJob} shots={currentJob?.generatedShots ?? []} previewSelection={previewSelection} onPreviewSelect={setPreviewSelection} onRegenerate={(index) => setEditor({ mode: "shots", shotIndex: index, pendingAction: { kind: "regenerate-shot", label: `Regenerate shot ${index + 1}`, shotIndex: index, phase: 7, scope: "shots" } })} onOpenEditor={setEditor} />,
                },
                {
                  id: "music",
                  label: "Music",
                  badge: currentJob?.musicPlan ? "Ready" : undefined,
                  content: <MusicPanel job={currentJob} musicPlan={currentJob?.musicPlan} onOpenEditor={setEditor} />,
                },
                {
                  id: "diagnostics",
                  label: "Diagnostics",
                  badge: currentJob?.status === "failed" || currentJob?.qaReport?.passed === false ? "Review" : undefined,
                  content: (
                    <div className="diagnostics-grid">
                      <JobStatusCard apiJob={job} busy={busy} progress={productionProgress ?? undefined} onRecovery={() => void resumeEditorialRecovery()} />
                      <CostPanel job={currentJob} progress={productionProgress ?? undefined} />
                      {currentJob?.qaReport ? <QualitySummary report={currentJob.qaReport} /> : <div className="telemetry-panel"><div className="telemetry-row text-sm text-muted">Quality results will appear after the QA stage.</div></div>}
                      <PromptTracePanel trace={currentJob?.promptTrace} />
                    </div>
                  ),
                },
              ]}
            />
              </>
            ) : (
              <StudioWorkspace
                activeWorkspace={activeWorkspace}
                activeProject={activeProject}
                projects={projects}
                projectJobs={projectJobs}
                libraryAssets={libraryAssets}
                libraryCollections={libraryCollections}
                mediaLibrary={currentProjectId && mediaLibrary?.projectId === currentProjectId ? mediaLibrary : mediaLibrary}
                mediaSessions={mediaSessions}
                currentJob={currentJob}
                busy={busy || mediaBusy}
                visibleError={visibleError}
                onSelectWorkspace={setActiveWorkspace}
                onCreateProject={createProject}
                onSelectProject={(projectId) => {
                  setActiveProjectId(projectId);
                  void refreshProjectData(projectId).catch((projectError) => {
                    handleBackgroundRefreshError(projectError, "Project refresh failed");
                  });
                }}
                onOpenProduction={(productionId) => {
                  setVideoId(productionId);
                  setActiveWorkspace("create");
                }}
                onCreateSession={createSession}
                onGenerateSession={generateSessionVersion}
                onRestoreSessionVersion={restoreSessionVersion}
                onExportSessionVersion={exportSessionVersion}
                onImportLibraryAsset={importLibraryAsset}
                onUploadLibraryAsset={uploadLibraryAsset}
                onPinLibraryAsset={pinLibraryAsset}
                onArchiveLibraryAsset={archiveLibraryAsset}
                onUpdateLibraryAsset={updateLibraryAsset}
                onCreateLibraryCollection={createLibraryCollection}
                onUpdateLibraryCollection={updateLibraryCollection}
                onSetLibraryCollectionAsset={setLibraryCollectionAsset}
                onPinLibraryCollection={pinLibraryCollection}
                onAskDirectorWithLibraryAsset={askDirectorWithLibraryAsset}
                onOpenEditor={setEditor}
                onSendSessionAgentMessage={sendSessionAgentMessage}
                onAddDirective={addEditDirective}
                onRegeneratePhase={regenerateWithDirection}
                onInjectMediaGeneration={injectMediaGeneration}
              />
            )}
          </div>
          <SystemDock job={currentJob} />
        </div>
      </div>
      {directorOpen ? (
        <CocoaDirectorDrawer
          activeProject={activeProject}
          activeWorkspace={activeWorkspace}
          currentJob={currentJob}
          busy={busy || mediaBusy}
          input={directorInput}
          messages={directorMessages}
          outputs={directorOutputs}
          proposal={directorProposal}
          onInputChange={setDirectorInput}
          onSend={sendDirectorChat}
          onConfirmProposal={confirmDirectorProposal}
          onCancelProposal={() => setDirectorProposal(null)}
          onClose={() => setDirectorOpen(false)}
        />
      ) : null}
      {editor ? (
        <RenderAgentDrawer
          key={`${editor.mode}-${editor.shotIndex ?? "all"}-${editor.pendingAction?.kind ?? "inspect"}-${editor.pendingAction?.label ?? ""}`}
          job={currentJob}
          context={editor}
          busy={busy || mediaBusy}
          mediaLibrary={mediaLibrary}
          onClose={() => setEditor(null)}
          onOpenContext={setEditor}
          onAddDirective={addEditDirective}
          onRegeneratePhase={regenerateWithDirection}
          onRegenerateShot={regenerateShotWithDirection}
          onRestoreVersion={restoreVersion}
          onCreateMediaGeneration={createMediaGeneration}
          onInjectMediaGeneration={injectMediaGeneration}
          onSendAgentMessage={sendAgentMessage}
        />
      ) : null}
      {musicStudioOpen ? (
        <MusicStudioDrawer
          value={musicControls}
          onChange={setMusicControls}
          onClose={() => setMusicStudioOpen(false)}
        />
      ) : null}
      {seedDrawer ? (
        <SeedDrawer
          role={seedDrawer}
          photos={
            seedDrawer === "you"
              ? youPhotos
              : ([seedByRole[seedDrawer]].filter(Boolean) as LibraryAsset[])
          }
          consentAccepted={consentAccepted}
          busy={seedBusy}
          error={seedError}
          onConsentChange={acceptConsent}
          onUpload={(files) => uploadSeedImage(files, seedDrawer)}
          onRemove={removeSeedImage}
          onClose={() => setSeedDrawer(null)}
        />
      ) : null}
    </main>
  );
}

async function readApiJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    const fallback = text.includes("<!DOCTYPE")
      ? `Server returned an HTML error page (${response.status}). Check the Vercel function logs.`
      : text.slice(0, 280);
    return { error: fallback } as T;
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

const RECOVERABLE_FETCH_MESSAGE_RE = /^(?:failed to fetch|load failed|networkerror|network request failed|fetch failed)$/i;

function isRecoverableFetchMessage(message: string | null) {
  if (!message) return false;
  return RECOVERABLE_FETCH_MESSAGE_RE.test(message.trim());
}

function isRecoverableFetchError(error: unknown, message: string | null) {
  if (error instanceof TypeError) return true;
  return isRecoverableFetchMessage(message);
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return items.some((current) => current.id === item.id)
    ? items.map((current) => (current.id === item.id ? item : current))
    : [item, ...items];
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className="nav-button"
      onClick={toggle}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
      <span>{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}

function StudioSidebar({
  activeWorkspace,
  onSelect,
}: {
  activeWorkspace: WorkspaceId;
  onSelect: (workspace: WorkspaceId) => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <>
      <button
        type="button"
        className="mobile-nav-trigger"
        aria-label={mobileOpen ? "Close studio navigation" : "Open studio navigation"}
        aria-expanded={mobileOpen}
        aria-controls="studio-navigation"
        onClick={() => setMobileOpen((open) => !open)}
      >
        {mobileOpen ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
      </button>
      {mobileOpen ? <button type="button" className="mobile-nav-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} /> : null}
      <aside id="studio-navigation" className={`studio-sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="brand-mark sidebar-brand-mark">
          <Clapperboard className="h-5 w-5" aria-hidden />
        </div>
        <nav className="studio-navigation" aria-label="Studio">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`nav-button ${activeWorkspace === id ? "is-active" : ""}`}
              title={label}
              aria-current={activeWorkspace === id ? "page" : undefined}
              onClick={() => {
                onSelect(id);
                setMobileOpen(false);
              }}
            >
              <Icon className="h-4 w-4" aria-hidden />
              <span>{label}</span>
            </button>
          ))}
          <ThemeToggle />
        </nav>
        <div className="director-avatar" aria-label="Director profile">
          <span>D</span>
        </div>
      </aside>
    </>
  );
}

function StudioWorkspace({
  activeWorkspace,
  activeProject,
  projects,
  projectJobs,
  libraryAssets,
  libraryCollections,
  mediaLibrary,
  mediaSessions,
  currentJob,
  busy,
  visibleError,
  onSelectWorkspace,
  onCreateProject,
  onSelectProject,
  onOpenProduction,
  onCreateSession,
  onGenerateSession,
  onRestoreSessionVersion,
  onExportSessionVersion,
  onImportLibraryAsset,
  onUploadLibraryAsset,
  onPinLibraryAsset,
  onArchiveLibraryAsset,
  onUpdateLibraryAsset,
  onCreateLibraryCollection,
  onUpdateLibraryCollection,
  onSetLibraryCollectionAsset,
  onPinLibraryCollection,
  onAskDirectorWithLibraryAsset,
  onOpenEditor,
  onSendSessionAgentMessage,
  onAddDirective,
  onRegeneratePhase,
  onInjectMediaGeneration,
}: {
  activeWorkspace: WorkspaceId;
  activeProject: Project | null;
  projects: Project[];
  projectJobs: VideoJob[];
  libraryAssets: LibraryAsset[];
  libraryCollections: LibraryCollection[];
  mediaLibrary: MediaLibraryState | null;
  mediaSessions: MediaSessionWithVersions[];
  currentJob?: VideoJob;
  busy: boolean;
  visibleError: string | null;
  onSelectWorkspace: (workspace: WorkspaceId) => void;
  onCreateProject: (name?: string) => Promise<Project | null>;
  onSelectProject: (projectId: string) => void;
  onOpenProduction: (productionId: string) => void;
  onCreateSession: (input: {
    kind: MediaSessionKind;
    title?: string;
    goal?: string;
    sourceAssetId?: string;
    settings?: Record<string, unknown>;
  }) => Promise<MediaSessionWithVersions | null>;
  onGenerateSession: (
    sessionId: string,
    input: {
      prompt: string;
      provider?: MediaProvider;
      controls?: Record<string, unknown>;
      inputAssetIds?: string[];
      label?: string;
    },
  ) => Promise<MediaSessionWithVersions | null>;
  onRestoreSessionVersion: (sessionId: string, versionId: string) => Promise<void>;
  onExportSessionVersion: (sessionId: string, versionId?: string) => Promise<string | null>;
  onImportLibraryAsset: (input: {
    kind: MediaKind;
    url: string;
    name?: string;
    role?: string;
    tags?: string[];
  }) => Promise<LibraryAsset | null>;
  onUploadLibraryAsset: (file: File, kind: MediaKind, role?: string) => Promise<boolean | null>;
  onPinLibraryAsset: (assetId: string) => Promise<MediaAsset | null>;
  onArchiveLibraryAsset: (assetId: string) => Promise<void>;
  onUpdateLibraryAsset: (assetId: string, input: { name?: string; tags?: string[]; favorite?: boolean; metadata?: Record<string, unknown> }) => Promise<LibraryAsset | null>;
  onCreateLibraryCollection: (name: string, assetIds?: string[]) => Promise<LibraryCollection | null>;
  onUpdateLibraryCollection: (collectionId: string, input: { name?: string; archived?: boolean; metadata?: Record<string, unknown> }) => Promise<LibraryCollection | null>;
  onSetLibraryCollectionAsset: (collectionId: string, assetId: string, action: "add" | "remove") => Promise<LibraryCollection | null>;
  onPinLibraryCollection: (collectionId: string) => Promise<MediaAsset[] | null>;
  onAskDirectorWithLibraryAsset: (asset: LibraryAsset) => void;
  onOpenEditor: (context: EditorContext) => void;
  onSendSessionAgentMessage: (
    sessionId: string,
    message: string,
  ) => Promise<{ reply?: string; proposal?: AgentActionProposal; messages?: MediaSessionMessage[] }>;
  onAddDirective: (input: {
    scope: EditorScope;
    phase?: PhaseNumber;
    targetId?: string;
    text: string;
    strategy?: RegenerateStrategy;
    providerControls?: ProviderControls;
  }) => Promise<void>;
  onRegeneratePhase: (
    phase: PhaseNumber,
    target: { scope: EditorScope; phase?: PhaseNumber; targetId?: string },
    directiveText?: string,
    strategy?: RegenerateStrategy,
    providerControls?: ProviderControls,
  ) => Promise<void>;
  onInjectMediaGeneration: (generationId: string, input: MediaGenerationInjectRequest) => Promise<void>;
}) {
  const preferredKind = workspacePreferredSessionKind(activeWorkspace);
  const visibleSessions = preferredKind
    ? mediaSessions.filter((session) => session.kind === preferredKind)
    : mediaSessions;
  const [projectName, setProjectName] = useState("Cocoa Director Project");
  const [selectedKind, setSelectedKind] = useState<MediaSessionKind>(preferredKind ?? "image");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(visibleSessions[0]?.id ?? null);
  const [sessionPrompt, setSessionPrompt] = useState("");
  const [sessionPromptSessionId, setSessionPromptSessionId] = useState<string | null>(null);
  const [sessionControlDraft, setSessionControlDraft] = useState<{
    sessionId: string | null; controls: Record<string, unknown>;
  } | null>(null);
  const [pendingSessionGeneration, setPendingSessionGeneration] = useState<{
    sessionId: string;
    kind: MediaSessionKind;
    prompt: string;
    provider: MediaProvider;
    controls: Record<string, unknown>;
    inputAssetIds: string[];
    label: string;
  } | null>(null);
  const [sessionAgentInput, setSessionAgentInput] = useState("");
  const [sessionAgentBusy, setSessionAgentBusy] = useState(false);
  const [pendingAgentProposal, setPendingAgentProposal] = useState<{
    sessionId: string;
    proposal: AgentActionProposal;
  } | null>(null);
  const [dismissedProposalMessageId, setDismissedProposalMessageId] = useState<string | null>(null);
  const [importKind, setImportKind] = useState<MediaKind>("image");
  const [importUrl, setImportUrl] = useState("");
  const [importName, setImportName] = useState("");
  const [uploadKind, setUploadKind] = useState<MediaKind>("image");
  const [libraryFilter, setLibraryFilter] = useState<LibraryVaultFilter>("all");
  const [librarySearch, setLibrarySearch] = useState("");
  const [selectedLibraryAssetId, setSelectedLibraryAssetId] = useState<string | null>(null);
  const [selectedLibraryCollectionId, setSelectedLibraryCollectionId] = useState<string | null>(null);

  const activeProjectVaultId = activeProject?.id ?? "";
  const assets = useMemo(() => mediaLibrary?.assets ?? [], [mediaLibrary?.assets]);
  const generations = useMemo(() => mediaLibrary?.generations ?? [], [mediaLibrary?.generations]);
  const libraryVaultItems = useMemo(
    () => createLibraryVaultItems(libraryAssets, libraryCollections, assets, generations, activeProjectVaultId),
    [activeProjectVaultId, assets, generations, libraryAssets, libraryCollections],
  );
  const selectedLibraryCollection =
    libraryCollections.find((collection) => collection.id === selectedLibraryCollectionId) ??
    null;
  const selectedLibraryItem =
    libraryVaultItems.find((item) => item.asset.id === selectedLibraryAssetId) ??
    libraryVaultItems[0] ??
    null;
  const selectedSession =
    mediaSessions.find((session) => session.id === selectedSessionId) ??
    visibleSessions[0] ??
    mediaSessions[0] ??
    null;
  const sessionControls = sessionControlDraft?.sessionId === (selectedSession?.id ?? null)
    ? sessionControlDraft.controls
    : selectedSession ? sessionControlsForSession(selectedSession, currentJob) : sessionDefaultControls(selectedKind, currentJob);
  function setSessionControls(controls: Record<string, unknown>, sessionId = selectedSession?.id ?? null) {
    setSessionControlDraft({ sessionId, controls });
  }
  const selectedAsset = selectedSession?.currentAssetId
    ? assets.find((asset) => asset.id === selectedSession.currentAssetId)
    : undefined;
  const sourceAsset = selectedSession?.sourceAssetId
    ? assets.find((asset) => asset.id === selectedSession.sourceAssetId)
    : undefined;
  const sessionReferenceAssets = ([selectedAsset, sourceAsset].filter(Boolean) as MediaAsset[])
    .filter((asset, index, list) => list.findIndex((candidate) => candidate.id === asset.id) === index);
  const selectedSessionVersion = selectedSession ? currentMediaSessionVersion(selectedSession) : undefined;
  const sessionGeneration = selectedSession ? generations
    .filter((generation) => generation.metadata.mediaSessionId === selectedSession.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] : undefined;
  const sessionGenerationPending = sessionGeneration?.status === "queued" || sessionGeneration?.status === "running";
  const sessionKind = selectedSession?.kind ?? selectedKind;
  const displayKind = selectedSession?.kind ?? preferredKind ?? selectedKind;
  const selectedSessionPersistedPrompt = selectedSession
    ? sessionPromptForSession(selectedSession, currentJob)
    : sessionDefaultPrompt(displayKind, currentJob);
  const displayedSessionPrompt = selectedSession?.id === sessionPromptSessionId
    ? sessionPrompt
    : selectedSessionPersistedPrompt;
  const effectiveSessionPrompt =
    displayedSessionPrompt || selectedSessionPersistedPrompt;
  const canGenerateSession = Boolean(selectedSession && sessionKindToMediaKind(sessionKind) && effectiveSessionPrompt.trim());
  const latestProposalMessage = selectedSession?.messages
    ?.slice()
    .reverse()
    .find((message) => message.proposal && !(message.proposal.actionType === "media_generation" && selectedSession?.versions.some((version) => version.prompt === message.proposal?.prompt && version.createdAt >= message.createdAt)));
  const activeAgentProposal = selectedSession && pendingAgentProposal?.sessionId === selectedSession.id
    ? pendingAgentProposal.proposal
    : latestProposalMessage?.id !== dismissedProposalMessageId
      ? latestProposalMessage?.proposal ?? null
      : null;

  async function startSession(kind: MediaSessionKind, sourceAssetId?: string) {
    setSelectedKind(kind);
    const session = await onCreateSession({
      kind,
      sourceAssetId,
      goal: sessionDefaultPrompt(kind, currentJob),
      settings: sessionDefaultControls(kind, currentJob),
    });
    if (session) {
      setSelectedSessionId(session.id);
      setSessionPrompt(sessionPromptForSession(session, currentJob));
      setSessionPromptSessionId(session.id);
      setSessionControls(sessionControlsForSession(session, currentJob), session.id);
      setPendingAgentProposal(null);
      setDismissedProposalMessageId(null);
      setSessionAgentInput("");
    }
  }

  function stageGenerateVersion() {
    if (!selectedSession || sessionGenerationPending) return;
    const mediaKind = sessionKindToMediaKind(selectedSession.kind);
    if (!mediaKind) return;
    setPendingSessionGeneration({
      sessionId: selectedSession.id,
      kind: selectedSession.kind,
      prompt: effectiveSessionPrompt,
      provider: providerForMediaKind(mediaKind),
      controls: sessionControls,
      inputAssetIds: [selectedSession.currentAssetId, selectedSession.sourceAssetId].filter(Boolean) as string[],
      label: `${selectedSession.kind} iteration`,
    });
  }

  async function confirmGenerateVersion() {
    if (!pendingSessionGeneration) return;
    const session = await onGenerateSession(pendingSessionGeneration.sessionId, {
      prompt: pendingSessionGeneration.prompt,
      provider: pendingSessionGeneration.provider,
      controls: pendingSessionGeneration.controls,
      inputAssetIds: pendingSessionGeneration.inputAssetIds,
      label: pendingSessionGeneration.label,
    });
    if (session) {
      setSelectedSessionId(session.id);
      setSessionPrompt(pendingSessionGeneration.prompt);
      setSessionPromptSessionId(session.id);
      setSessionControls(sessionControlsForSession(session, currentJob), session.id);
    }
    setPendingSessionGeneration(null);
  }

  async function sendSessionAgent() {
    if (!selectedSession || !sessionAgentInput.trim() || sessionAgentBusy || busy) return;
    const message = sessionAgentInput.trim();
    setSessionAgentInput("");
    setSessionAgentBusy(true);
    try {
      const response = await onSendSessionAgentMessage(selectedSession.id, message);
      if (response.proposal) {
        setPendingAgentProposal({ sessionId: selectedSession.id, proposal: response.proposal });
        setDismissedProposalMessageId(null);
        if (response.proposal.actionType === "media_generation" && response.proposal.controls) {
          setSessionControls(response.proposal.controls);
        }
        if (response.proposal.prompt) {
          setSessionPrompt(response.proposal.prompt);
          setSessionPromptSessionId(selectedSession.id);
        }
      }
    } catch {
      setSessionAgentInput(message);
    } finally {
      setSessionAgentBusy(false);
    }
  }

  async function confirmAgentProposal() {
    const proposal = selectedSession && pendingAgentProposal?.sessionId === selectedSession.id
      ? pendingAgentProposal.proposal
      : null;
    if (!selectedSession || !proposal) return;
    if (proposal.actionType === "media_generation") {
      const kind = proposal.kind ?? sessionKindToMediaKind(selectedSession.kind);
      if (!kind || !proposal.prompt) return;
      const session = await onGenerateSession(selectedSession.id, {
        prompt: proposal.prompt,
        provider: proposal.provider ?? providerForMediaKind(kind),
        controls: proposal.controls,
        inputAssetIds: proposal.inputAssetIds.length > 0
          ? proposal.inputAssetIds
          : [selectedSession.currentAssetId, selectedSession.sourceAssetId].filter(Boolean) as string[],
        label: proposal.label ?? `${kind} Cocoa Director version`,
      });
      if (session) {
        setSelectedSessionId(session.id);
        setSessionPrompt(proposal.prompt);
        setSessionPromptSessionId(session.id);
        setSessionControls(sessionControlsForSession(session, currentJob), session.id);
      }
      setPendingAgentProposal(null);
      setDismissedProposalMessageId(latestProposalMessage?.id ?? null);
      return;
    }

    if (proposal.actionType === "pipeline_directive") {
      await onAddDirective({
        scope: proposal.scope ?? "phase",
        phase: proposal.phase,
        targetId: proposal.targetId,
        text: proposal.directiveText ?? proposal.prompt ?? proposal.rationale,
        strategy: proposal.strategy,
        providerControls: proposal.providerControls,
      });
      setPendingAgentProposal(null);
      setDismissedProposalMessageId(null);
      return;
    }

    if (proposal.actionType === "pipeline_regeneration") {
      const phase = (proposal.phase ?? currentJob?.currentPhase ?? 1) as PhaseNumber;
      await onRegeneratePhase(
        phase,
        {
          scope: proposal.scope ?? "phase",
          phase,
          targetId: proposal.targetId,
        },
        proposal.directiveText ?? proposal.prompt,
        proposal.strategy,
        proposal.providerControls,
      );
      setPendingAgentProposal(null);
      setDismissedProposalMessageId(null);
      return;
    }

    if (proposal.actionType === "media_injection" && proposal.generationId && currentJob) {
      await onInjectMediaGeneration(proposal.generationId, {
        videoJobId: currentJob.id,
        action: proposal.injectionAction ?? "use_in_render_manifest",
        role: proposal.role,
        shotIndex: proposal.shotIndex,
        note: proposal.directiveText ?? proposal.rationale,
      });
      setPendingAgentProposal(null);
      setDismissedProposalMessageId(null);
    }
  }

  async function importUrlAsset() {
    if (!importUrl.trim()) return;
    const asset = await onImportLibraryAsset({
      kind: importKind,
      url: importUrl.trim(),
      name: importName.trim() || undefined,
      role: importKind === "music" ? "music_reference" : "reference",
      tags: ["imported"],
    });
    if (asset) {
      setImportUrl("");
      setImportName("");
    }
  }

  async function uploadFile(file?: File | null) {
    if (!file) return;
    await onUploadLibraryAsset(file, uploadKind, uploadKind === "music" ? "music_reference" : "reference");
  }

  async function pinVaultAsset(asset: LibraryAsset) {
    const existing = projectMediaAssetForLibraryAsset(asset, assets);
    return existing ?? onPinLibraryAsset(asset.id);
  }

  async function startSessionFromVault(asset: LibraryAsset) {
    const mediaAsset = await pinVaultAsset(asset);
    if (!mediaAsset) return;
    const kind = asset.kind === "render" ? "video" : asset.kind;
    await startSession(kind as MediaSessionKind, mediaAsset.id);
  }

  async function archiveVaultAsset(asset: LibraryAsset) {
    await onArchiveLibraryAsset(asset.id);
    setSelectedLibraryAssetId((current) => (current === asset.id ? null : current));
  }

  function copyVaultAssetUrl(asset: LibraryAsset) {
    void navigator.clipboard?.writeText(asset.url).catch(() => undefined);
  }

  async function updateVaultAsset(asset: LibraryAsset, input: { name?: string; tags?: string[]; favorite?: boolean; metadata?: Record<string, unknown> }) {
    const updated = await onUpdateLibraryAsset(asset.id, input);
    if (updated) setSelectedLibraryAssetId(updated.id);
    return updated;
  }

  async function createVaultCollection(name: string, assetIds: string[] = []) {
    const collection = await onCreateLibraryCollection(name, assetIds);
    if (collection) setSelectedLibraryCollectionId(collection.id);
    return collection;
  }

  async function updateVaultCollection(collectionId: string, input: { name?: string; archived?: boolean; metadata?: Record<string, unknown> }) {
    const collection = await onUpdateLibraryCollection(collectionId, input);
    if (input.archived) {
      setSelectedLibraryCollectionId((current) => (current === collectionId ? null : current));
    } else if (collection) {
      setSelectedLibraryCollectionId(collection.id);
    }
    return collection;
  }

  async function setVaultCollectionAsset(collectionId: string, assetId: string, action: "add" | "remove") {
    const collection = await onSetLibraryCollectionAsset(collectionId, assetId, action);
    if (collection) setSelectedLibraryCollectionId(collection.id);
    return collection;
  }

  async function pinVaultCollection(collectionId: string) {
    const mediaAssets = await onPinLibraryCollection(collectionId);
    if (mediaAssets?.[0]) {
      const libraryAssetId = stringFromMetadata(mediaAssets[0].metadata.libraryAssetId);
      setSelectedLibraryAssetId(libraryAssetId ?? null);
    }
    return mediaAssets;
  }

  if (!activeProject) {
    return (
      <section className="workspace-shell">
        <div className="workspace-empty">
          <Bot className="h-8 w-8" aria-hidden />
          <div>
            <span>Media Lab</span>
            <h2>Start with a project, then work at any scale.</h2>
            <p>Create one image, iterate one Seedance clip, compose one ElevenLabs track, or promote chosen assets into the full director pipeline when the idea is ready.</p>
          </div>
          <div className="workspace-create-project">
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} aria-label="Project name" />
            <button type="button" className="primary-command" disabled={busy} onClick={() => onCreateProject(projectName)}>
              <Plus className="h-4 w-4" aria-hidden />
              Create project
            </button>
          </div>
          {visibleError ? <ErrorDetail>{visibleError}</ErrorDetail> : null}
        </div>
      </section>
    );
  }

  return (
    <section className="workspace-shell">
      <div className="workspace-header">
        <div>
          <span>{workspaceEyebrow(activeWorkspace)}</span>
          <h2>{workspaceTitle(activeWorkspace)}</h2>
          <p>{workspaceDescription(activeWorkspace)}</p>
        </div>
        <div className="workspace-header-actions">
          <select
            className="workspace-project-select"
            value={activeProject.id}
            onChange={(event) => onSelectProject(event.target.value)}
            aria-label="Active project"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button type="button" className="secondary-command" disabled={busy} onClick={() => onOpenEditor({ mode: "preview", startFullscreen: true })}>
            <Maximize2 className="h-4 w-4" aria-hidden />
            Open Pipeline
          </button>
        </div>
      </div>

      {visibleError ? <ErrorDetail>{visibleError}</ErrorDetail> : null}

      {activeWorkspace === "settings" ? (
        <div className="workspace-grid is-projects">
          <section className="workspace-card">
            <div className="workspace-card-heading">
              <h3>Your studio</h3>
              <p>Cocoa Director is an unsupported open-source release. Your projects, keys, provider accounts, and deployment belong to you. Fork the repository to customize or maintain your copy.</p>
            </div>
            <a href="https://github.com/keef75/cocoa-director" target="_blank" rel="noreferrer" className="secondary-command">Setup and source code</a>
          </section>
          <section className="workspace-card">
            <div className="workspace-card-heading">
              <h3>Provider controls</h3>
              <p>Live calls require your access code and explicit provider enablement. Global spending limits apply to every account, including the owner. Configure keys and limits on your own server.</p>
            </div>
            <div className="session-meta-row">
              <StateBadge state="awaiting_user" label="owner access" compact />
              <StateBadge state="awaiting_user" label="spend audit" compact />
              <StateBadge state="awaiting_user" label="asset export" compact />
            </div>
          </section>
        </div>
      ) : null}

      {activeWorkspace === "settings" ? null : activeWorkspace === "library" ? (
        <LibraryVault
          activeProject={activeProject}
          items={libraryVaultItems}
          collections={libraryCollections}
          selectedCollection={selectedLibraryCollection}
          selectedItem={selectedLibraryItem}
          filter={libraryFilter}
          search={librarySearch}
          importKind={importKind}
          importUrl={importUrl}
          importName={importName}
          uploadKind={uploadKind}
          busy={busy}
          onFilterChange={setLibraryFilter}
          onSearchChange={setLibrarySearch}
          onSelectAsset={(asset) => setSelectedLibraryAssetId(asset.id)}
          onSelectCollection={(collectionId) => setSelectedLibraryCollectionId(collectionId)}
          onImportKindChange={setImportKind}
          onImportUrlChange={setImportUrl}
          onImportNameChange={setImportName}
          onUploadKindChange={setUploadKind}
          onImport={importUrlAsset}
          onUpload={uploadFile}
          onUseReference={(asset) => void pinVaultAsset(asset)}
          onStartSession={(asset) => void startSessionFromVault(asset)}
          onAskDirector={onAskDirectorWithLibraryAsset}
          onUpdateAsset={(asset, input) => void updateVaultAsset(asset, input)}
          onCreateCollection={(name, assetIds) => void createVaultCollection(name, assetIds)}
          onUpdateCollection={(collectionId, input) => void updateVaultCollection(collectionId, input)}
          onSetCollectionAsset={(collectionId, assetId, action) => void setVaultCollectionAsset(collectionId, assetId, action)}
          onUseCollection={(collectionId) => void pinVaultCollection(collectionId)}
          onArchive={(asset) => void archiveVaultAsset(asset)}
          onCopyUrl={copyVaultAssetUrl}
        />
      ) : activeWorkspace === "projects" ? (
        <div className="workspace-grid is-projects">
          <section className="workspace-card">
            <div className="workspace-card-heading">
              <h3>Projects</h3>
              <p>Project-first work does not require a video job.</p>
            </div>
            <div className="workspace-project-list">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={project.id === activeProject.id ? "is-active" : ""}
                  onClick={() => onSelectProject(project.id)}
                >
                  <Folder className="h-4 w-4" aria-hidden />
                  <span>{project.name}</span>
                  <small>{formatClock(project.createdAt)}</small>
                </button>
              ))}
            </div>
          </section>
          <section className="workspace-card">
            <div className="workspace-card-heading">
              <h3>Productions</h3>
              <p>Running and review jobs remain durable when you leave this screen.</p>
            </div>
            <div className="workspace-project-list">
              {projectJobs.length > 0 ? projectJobs.map((production) => (
                <button key={production.id} type="button" onClick={() => onOpenProduction(production.id)}>
                  <Clapperboard className="h-4 w-4" aria-hidden />
                  <span>{formatContentType(production.contentType ?? "music_video")} · {production.prompt.slice(0, 54)}</span>
                  <small>{production.status.replaceAll("_", " ")} · {formatClock(production.updatedAt)}</small>
                </button>
              )) : (
                <p className="editor-muted">No productions in this project yet.</p>
              )}
            </div>
          </section>
          <section className="workspace-card">
            <div className="workspace-card-heading">
              <h3>New project</h3>
              <p>Start a clean vault for uploaded and generated media.</p>
            </div>
            <div className="workspace-create-project">
              <input value={projectName} onChange={(event) => setProjectName(event.target.value)} aria-label="Project name" />
              <button type="button" className="primary-command" disabled={busy} onClick={() => onCreateProject(projectName)}>
                <Plus className="h-4 w-4" aria-hidden />
                Create project
              </button>
            </div>
          </section>
        </div>
      ) : (
        <>
          <section className="workspace-command-strip">
            {(["image", "video", "music"] as MediaSessionKind[]).map((kind) => (
              <button key={kind} type="button" className={displayKind === kind ? "is-active" : ""} disabled={busy} onClick={() => startSession(kind)}>
                {sessionKindIcon(kind)}
                <span>{sessionKindLabel(kind)}</span>
                <small>{sessionKindDetail(kind)}</small>
              </button>
            ))}
            <button
              type="button"
              className={`workspace-command-wide ${displayKind === "render" ? "is-active" : ""}`}
              onClick={() => {
                if (currentJob) {
                  void startSession("render");
                  return;
                }
                onSelectWorkspace("create");
              }}
            >
              <Clapperboard className="h-5 w-5" aria-hidden />
              <span>Director pipeline</span>
              <small>{currentJob ? "Chat through directives, regeneration, and media injection." : "Start or select a director pipeline run first."}</small>
            </button>
          </section>

          <div className="workspace-grid">
            <section className="workspace-card workspace-agent-card">
              <div className="workspace-card-heading">
                <h3>Session canvas</h3>
                <p>{selectedSession ? selectedSession.title : "Create or select a session to begin iterating."}</p>
              </div>
              {selectedSession ? (
                <>
                  <div className="session-hero">
                    <SessionAssetPreview asset={selectedAsset ?? sourceAsset} kind={selectedSession.kind} />
                    <div>
                      <span>{selectedSession.kind} session</span>
                      <h4>{selectedSession.title}</h4>
                      <p>{selectedSessionVersion?.prompt ?? selectedSession.goal ?? "Generate versioned replacements with provider-aware controls, then export or promote the chosen result."}</p>
                      <div className="session-meta-row">
                        <StateBadge state={selectedSession.status === "complete" ? "complete" : "awaiting_user"} label={selectedSession.status} compact />
                        <span>{selectedSession.versions.length} version{selectedSession.versions.length === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                  </div>
                  <SessionAgentChat
                    session={selectedSession}
                    currentJob={currentJob}
                    messages={selectedSession.messages ?? []}
                    input={sessionAgentInput}
                    busy={busy || sessionAgentBusy}
                    proposal={activeAgentProposal}
                    referenceAssets={sessionReferenceAssets}
                    onInputChange={setSessionAgentInput}
                    onSend={sendSessionAgent}
                    onConfirmProposal={confirmAgentProposal}
                    onCancelProposal={() => {
                      setPendingAgentProposal(null);
                      setDismissedProposalMessageId(latestProposalMessage?.id ?? null);
                    }}
                  />
                  {sessionGeneration && sessionGeneration.status !== "success" ? (
                    <p role={sessionGeneration.status === "failed" ? "alert" : "status"} aria-live="polite">
                      {sessionGeneration.status === "failed"
                        ? `Generation failed: ${sessionGeneration.error ?? "The provider did not return usable media."} Review the controls and stage a new request to retry.`
                        : "Your video is queued with the provider. This session will update when it finishes; you can leave and return safely."}
                    </p>
                  ) : null}
                  <MediaProviderControlsEditor
                    kind={sessionKindToMediaKind(selectedSession.kind) ?? "image"}
                    controls={sessionControls}
                    job={currentJob}
                    onChange={setSessionControls}
                  />
                  <div className="editor-command-actions">
                    <button type="button" className="secondary-command" disabled={busy || sessionGenerationPending || !canGenerateSession} onClick={stageGenerateVersion}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                      Stage from controls
                    </button>
                    <button type="button" className="secondary-command" disabled={busy || selectedSession.versions.length === 0} onClick={() => onExportSessionVersion(selectedSession.id)}>
                      <Download className="h-4 w-4" aria-hidden />
                      Export current
                    </button>
                  </div>
                  {pendingSessionGeneration ? (
                    <div className="session-confirm-card">
                      <div>
                        <strong>Confirm {pendingSessionGeneration.kind} generation</strong>
                        <p>{sessionGenerationRisk(pendingSessionGeneration.kind)} This creates a new session version and does not alter the director pipeline.</p>
                      </div>
                      <dl>
                        <div>
                          <dt>Provider</dt>
                          <dd>{providerLabelForMediaKind(sessionKindToMediaKind(pendingSessionGeneration.kind) ?? "image")}</dd>
                        </div>
                        <div>
                          <dt>Inputs</dt>
                          <dd>{pendingSessionGeneration.inputAssetIds.length || "No"} selected</dd>
                        </div>
                        <div>
                          <dt>Controls</dt>
                          <dd>{compactJson(pendingSessionGeneration.controls)}</dd>
                        </div>
                      </dl>
                      <div className="editor-command-actions">
                        <button type="button" className="ghost-command" disabled={busy} onClick={() => setPendingSessionGeneration(null)}>
                          Cancel
                        </button>
                        <button type="button" className="primary-command" disabled={busy} onClick={confirmGenerateVersion}>
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                          Confirm generate
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <SessionVersionCarousel
                    session={selectedSession}
                    assets={assets}
                    generations={mediaLibrary?.generations ?? []}
                    busy={busy}
                    onRestore={async (version) => {
                      await onRestoreSessionVersion(selectedSession.id, version.id);
                      setSessionPrompt(version.prompt ?? sessionPromptForSession(selectedSession, currentJob));
                      setSessionPromptSessionId(selectedSession.id);
                      setSessionControls(
                        Object.keys(version.controls).length > 0
                          ? publicSessionControls(version.controls)
                          : sessionDefaultControls(selectedSession.kind, currentJob),
                      );
                    }}
                    onExport={(version) => onExportSessionVersion(selectedSession.id, version.id)}
                  />
                </>
              ) : (
                <div className="workspace-empty-inline">
                  <Sparkles className="h-5 w-5" aria-hidden />
                  <span>Start an image, video, or music session from the strip above.</span>
                </div>
              )}
            </section>

            <section className="workspace-card">
              <div className="workspace-card-heading">
                <h3>Sessions</h3>
                <p>{visibleSessions.length} focused work unit{visibleSessions.length === 1 ? "" : "s"}</p>
              </div>
              <div className="session-list">
                {visibleSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={selectedSession?.id === session.id ? "is-active" : ""}
                    onClick={() => {
                      setSelectedSessionId(session.id);
                      setSelectedKind(session.kind);
                      setSessionPrompt(sessionPromptForSession(session, currentJob));
                      setSessionPromptSessionId(session.id);
                      setSessionControls(sessionControlsForSession(session, currentJob), session.id);
                      setPendingAgentProposal(null);
                      setDismissedProposalMessageId(null);
                      setSessionAgentInput("");
                    }}
                  >
                    {sessionKindIcon(session.kind)}
                    <span>{session.title}</span>
                    <small>{session.versions.length} versions · {formatClock(session.updatedAt)}</small>
                  </button>
                ))}
                {visibleSessions.length === 0 ? <p className="editor-muted">No sessions in this workspace yet.</p> : null}
              </div>
            </section>

            <section className="workspace-card">
              <div className="workspace-card-heading">
                <h3>Library</h3>
                <p>Upload or import media as source/reference material, then start a versioned session from any asset.</p>
              </div>
              <div className="library-tools">
                <div className="library-tool-row">
                  <select value={importKind} onChange={(event) => setImportKind(event.target.value as MediaKind)} aria-label="Import kind">
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                    <option value="music">Music</option>
                    <option value="render">Render</option>
                  </select>
                  <input value={importUrl} onChange={(event) => setImportUrl(event.target.value)} placeholder="Paste media URL" aria-label="Media URL" />
                </div>
                <div className="library-tool-row">
                  <input value={importName} onChange={(event) => setImportName(event.target.value)} placeholder="Optional name" aria-label="Import name" />
                  <button type="button" className="secondary-command" disabled={busy || !importUrl.trim()} onClick={importUrlAsset}>
                    <LinkIcon className="h-4 w-4" aria-hidden />
                    Import
                  </button>
                </div>
                <div className="library-tool-row">
                  <select value={uploadKind} onChange={(event) => setUploadKind(event.target.value as MediaKind)} aria-label="Upload kind">
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                    <option value="music">Music</option>
                  </select>
                  <label className="upload-button">
                    <Upload className="h-4 w-4" aria-hidden />
                    <span>Upload file</span>
                    <input type="file" accept="image/*,video/*,audio/*" onChange={(event) => uploadFile(event.target.files?.[0])} />
                  </label>
                </div>
              </div>
              <div className="library-asset-grid">
                {libraryAssets.slice(0, 12).map((asset) => (
                  <div key={asset.id} className="library-asset-card">
                    <LibraryAssetPreview asset={asset} />
                    <div>
                      <strong>{asset.name}</strong>
                      <span>{asset.kind} · {asset.source}</span>
                    </div>
                    {asset.kind === "image" || asset.kind === "video" || asset.kind === "music" ? (
                      <button
                        type="button"
                        className="ghost-command"
                        disabled={busy}
                        onClick={() => {
                          void startSessionFromVault(asset);
                        }}
                      >
                        Start session
                      </button>
                    ) : null}
                  </div>
                ))}
                {libraryAssets.length === 0 ? <p className="editor-muted">Imported and uploaded media will appear here.</p> : null}
              </div>
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function LibraryVault({
  activeProject,
  items,
  collections,
  selectedCollection,
  selectedItem,
  filter,
  search,
  importKind,
  importUrl,
  importName,
  uploadKind,
  busy,
  onFilterChange,
  onSearchChange,
  onSelectAsset,
  onSelectCollection,
  onImportKindChange,
  onImportUrlChange,
  onImportNameChange,
  onUploadKindChange,
  onImport,
  onUpload,
  onUseReference,
  onStartSession,
  onAskDirector,
  onUpdateAsset,
  onCreateCollection,
  onUpdateCollection,
  onSetCollectionAsset,
  onUseCollection,
  onArchive,
  onCopyUrl,
}: {
  activeProject: Project;
  items: LibraryVaultItem[];
  collections: LibraryCollection[];
  selectedCollection: LibraryCollection | null;
  selectedItem: LibraryVaultItem | null;
  filter: LibraryVaultFilter;
  search: string;
  importKind: MediaKind;
  importUrl: string;
  importName: string;
  uploadKind: MediaKind;
  busy: boolean;
  onFilterChange: (filter: LibraryVaultFilter) => void;
  onSearchChange: (value: string) => void;
  onSelectAsset: (asset: LibraryAsset) => void;
  onSelectCollection: (collectionId: string | null) => void;
  onImportKindChange: (kind: MediaKind) => void;
  onImportUrlChange: (value: string) => void;
  onImportNameChange: (value: string) => void;
  onUploadKindChange: (kind: MediaKind) => void;
  onImport: () => Promise<void>;
  onUpload: (file?: File | null) => Promise<void>;
  onUseReference: (asset: LibraryAsset) => void;
  onStartSession: (asset: LibraryAsset) => void;
  onAskDirector: (asset: LibraryAsset) => void;
  onUpdateAsset: (asset: LibraryAsset, input: { name?: string; tags?: string[]; favorite?: boolean; metadata?: Record<string, unknown> }) => void;
  onCreateCollection: (name: string, assetIds: string[]) => void;
  onUpdateCollection: (collectionId: string, input: { name?: string; archived?: boolean; metadata?: Record<string, unknown> }) => void;
  onSetCollectionAsset: (collectionId: string, assetId: string, action: "add" | "remove") => void;
  onUseCollection: (collectionId: string) => void;
  onArchive: (asset: LibraryAsset) => void;
  onCopyUrl: (asset: LibraryAsset) => void;
}) {
  const filteredItems = useMemo(() => filterLibraryVaultItems(items, filter, search), [filter, items, search]);
  const activeItem = selectedItem && filteredItems.some((item) => item.asset.id === selectedItem.asset.id)
    ? selectedItem
    : filteredItems[0] ?? selectedItem;
  const [newCollectionName, setNewCollectionName] = useState("");

  const renderItems = items.filter((item) => item.asset.kind === "render" || item.asset.source === "render");
  const generatedItems = items.filter((item) => item.asset.source === "generation");
  const uploadedItems = items.filter((item) => item.asset.source === "upload" || item.asset.source === "url");
  const imageItems = items.filter((item) => item.asset.kind === "image");
  const videoItems = items.filter((item) => item.asset.kind === "video");
  const musicItems = items.filter((item) => item.asset.kind === "music");
  const projectItems = items.filter((item) => item.isProjectLinked);
  const favoriteItems = items.filter((item) => item.asset.favoriteAt);
  const recentItems = [...items].sort((left, right) => new Date(right.asset.createdAt).getTime() - new Date(left.asset.createdAt).getTime()).slice(0, 16);
  const collectionItems = selectedCollection
    ? items.filter((item) => selectedCollection.assetIds.includes(item.asset.id))
    : [];
  const stats = [
    { label: "All", value: items.length },
    { label: "Finished", value: renderItems.length },
    { label: "Images", value: imageItems.length },
    { label: "Videos", value: videoItems.length },
    { label: "Music", value: musicItems.length },
    { label: "Generated", value: generatedItems.length },
    { label: "Favorites", value: favoriteItems.length },
    { label: "Packs", value: collections.length },
    { label: "This project", value: projectItems.length },
  ];

  return (
    <div className="library-vault-shell">
      <section className="library-vault-featured" aria-label="Featured Vault">
        <button type="button" onClick={() => { onFilterChange("all"); onSelectCollection(null); }}>
          <History className="h-4 w-4" aria-hidden />
          <span>Recent</span>
          <strong>{recentItems.length}</strong>
        </button>
        <button type="button" onClick={() => { onFilterChange("favorites"); onSelectCollection(null); }}>
          <Star className="h-4 w-4" aria-hidden />
          <span>Favorites</span>
          <strong>{favoriteItems.length}</strong>
        </button>
        <button type="button" onClick={() => { onFilterChange("project"); onSelectCollection(null); }}>
          <LinkIcon className="h-4 w-4" aria-hidden />
          <span>This Project</span>
          <strong>{projectItems.length}</strong>
        </button>
        <button type="button" onClick={() => { onFilterChange("finished"); onSelectCollection(null); }}>
          <Film className="h-4 w-4" aria-hidden />
          <span>Finished</span>
          <strong>{renderItems.length}</strong>
        </button>
        <button type="button" onClick={() => collections[0] ? onSelectCollection(collections[0].id) : undefined}>
          <Folder className="h-4 w-4" aria-hidden />
          <span>Collections</span>
          <strong>{collections.length}</strong>
        </button>
      </section>

      <section className="library-vault-stage">
        <div className="library-vault-viewer">
          {activeItem ? <LibraryVaultHero item={activeItem} /> : <LibraryVaultEmpty />}
        </div>
        <aside className="library-vault-detail">
          <div>
            <span className="library-vault-kicker">{activeItem ? `${activeItem.asset.kind} · ${activeItem.asset.source}` : "Vault"}</span>
            <h3>{activeItem?.asset.name ?? "No assets yet"}</h3>
            <p>{activeItem?.prompt ?? "Generate or upload media and it will appear here as reusable Cocoa Director source material."}</p>
          </div>
          {activeItem ? (
            <>
              <LibraryVaultAssetCuration
                key={activeItem.asset.id}
                item={activeItem}
                collections={collections}
                busy={busy}
                onUpdateAsset={onUpdateAsset}
                onCreateCollection={onCreateCollection}
                onSetCollectionAsset={onSetCollectionAsset}
              />
              <div className="library-vault-meta-grid">
                <InfoRow label="Provider" value={activeItem.provider ?? activeItem.asset.source} />
                <InfoRow label="Created" value={formatClock(activeItem.asset.createdAt)} />
                <InfoRow label="Project" value={activeItem.sourceProjectName ?? activeProject.name} />
                <InfoRow label="Duration" value={activeItem.durationSeconds ? `${activeItem.durationSeconds}s` : "n/a"} />
                <InfoRow label="Format" value={activeItem.asset.mimeType} />
                <InfoRow label="Linked" value={activeItem.isProjectLinked ? "yes" : "not yet"} />
              </div>
              <div className="library-vault-action-grid">
                <button type="button" className="primary-command" disabled={busy} onClick={() => onUseReference(activeItem.asset)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Use as reference
                </button>
                <button type="button" className="secondary-command" disabled={busy} onClick={() => onStartSession(activeItem.asset)}>
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Start session
                </button>
                <button type="button" className="secondary-command" disabled={busy} onClick={() => onAskDirector(activeItem.asset)}>
                  <Bot className="h-4 w-4" aria-hidden />
                  Ask Director
                </button>
                <a className="ghost-command" href={libraryAssetDownloadUrl(activeProject.id, activeItem.asset.id)} download={libraryAssetDownloadFileName(activeItem.asset)}>
                  <Download className="h-4 w-4" aria-hidden />
                  Download
                </a>
                <a className="ghost-command" href={activeItem.asset.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open
                </a>
                <button type="button" className="ghost-command" onClick={() => onCopyUrl(activeItem.asset)}>
                  <Copy className="h-4 w-4" aria-hidden />
                  Copy URL
                </button>
                <button type="button" className="ghost-command danger-soft" disabled={busy} onClick={() => onArchive(activeItem.asset)}>
                  <Archive className="h-4 w-4" aria-hidden />
                  Archive
                </button>
              </div>
            </>
          ) : null}
        </aside>
      </section>

      <section className="library-vault-controls">
        <div className="library-vault-stats">
          {stats.map((stat) => (
            <div key={stat.label}>
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>
        <div className="library-vault-search">
          <Search className="h-4 w-4" aria-hidden />
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Search prompt, tag, project, provider" aria-label="Search library assets" />
        </div>
        <div className="library-vault-filters" role="tablist" aria-label="Library filters">
          {libraryVaultFilters.map((item) => (
            <button key={item.id} type="button" className={filter === item.id ? "is-active" : ""} onClick={() => onFilterChange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </section>

      <section className="library-vault-collections" aria-label="Reference packs">
        <div className="library-vault-reel-heading">
          <h3>Reference packs</h3>
          <span>{collections.length}</span>
        </div>
        <div className="library-vault-collection-rail">
          <button type="button" className={!selectedCollection ? "is-active" : ""} onClick={() => onSelectCollection(null)}>
            All vault
          </button>
          {collections.map((collection) => (
            <button key={collection.id} type="button" className={selectedCollection?.id === collection.id ? "is-active" : ""} onClick={() => onSelectCollection(collection.id)}>
              <Folder className="h-4 w-4" aria-hidden />
              <span>{collection.name}</span>
              <small>{collection.assetIds.length}</small>
            </button>
          ))}
          <div className="library-vault-collection-create">
            <input value={newCollectionName} onChange={(event) => setNewCollectionName(event.target.value)} placeholder="New reference pack" aria-label="New reference pack" />
            <button
              type="button"
              className="secondary-command"
              disabled={busy || !newCollectionName.trim()}
              onClick={() => {
                onCreateCollection(newCollectionName.trim(), []);
                setNewCollectionName("");
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Create pack
            </button>
          </div>
        </div>
        {selectedCollection ? (
          <div className="library-vault-pack-actions">
            <span>{selectedCollection.name} · {collectionItems.length} asset{collectionItems.length === 1 ? "" : "s"}</span>
            <button type="button" className="primary-command" disabled={busy || collectionItems.length === 0} onClick={() => onUseCollection(selectedCollection.id)}>
              <Plus className="h-4 w-4" aria-hidden />
              Use pack as references
            </button>
            <button type="button" className="ghost-command danger-soft" disabled={busy} onClick={() => onUpdateCollection(selectedCollection.id, { archived: true })}>
              <Archive className="h-4 w-4" aria-hidden />
              Archive pack
            </button>
          </div>
        ) : null}
      </section>

      <div className="library-vault-lower">
        <section className="library-vault-reels">
          {selectedCollection ? (
            <LibraryVaultReel title={`${selectedCollection.name} pack`} items={collectionItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          ) : null}
          <LibraryVaultReel title="Finished music videos" items={renderItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Recent vault" items={recentItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Favorites" items={favoriteItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Browse vault" items={filteredItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Recent generations" items={generatedItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Image references" items={imageItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Video clips" items={videoItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Music and audio" items={musicItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
          <LibraryVaultReel title="Uploaded references" items={uploadedItems} activeId={activeItem?.asset.id} onSelectAsset={onSelectAsset} />
        </section>

        <section className="library-vault-ingest">
          <div className="workspace-card-heading">
            <h3>Add to vault</h3>
            <p>Import links or upload files; generated Cocoa Director outputs are saved automatically.</p>
          </div>
          <div className="library-tools">
            <div className="library-tool-row">
              <select value={importKind} onChange={(event) => onImportKindChange(event.target.value as MediaKind)} aria-label="Import kind">
                <option value="image">Image</option>
                <option value="video">Video</option>
                <option value="music">Music</option>
                <option value="render">Render</option>
              </select>
              <input value={importUrl} onChange={(event) => onImportUrlChange(event.target.value)} placeholder="Paste media URL" aria-label="Media URL" />
            </div>
            <div className="library-tool-row">
              <input value={importName} onChange={(event) => onImportNameChange(event.target.value)} placeholder="Optional name" aria-label="Import name" />
              <button type="button" className="secondary-command" disabled={busy || !importUrl.trim()} onClick={() => void onImport()}>
                <LinkIcon className="h-4 w-4" aria-hidden />
                Import
              </button>
            </div>
            <div className="library-tool-row">
              <select value={uploadKind} onChange={(event) => onUploadKindChange(event.target.value as MediaKind)} aria-label="Upload kind">
                <option value="image">Image</option>
                <option value="video">Video</option>
                <option value="music">Music</option>
              </select>
              <label className="upload-button">
                <Upload className="h-4 w-4" aria-hidden />
                <span>Upload file</span>
                <input type="file" accept="image/*,video/*,audio/*" onChange={(event) => void onUpload(event.target.files?.[0])} />
              </label>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function LibraryVaultAssetCuration({
  item,
  collections,
  busy,
  onUpdateAsset,
  onCreateCollection,
  onSetCollectionAsset,
}: {
  item: LibraryVaultItem;
  collections: LibraryCollection[];
  busy: boolean;
  onUpdateAsset: (asset: LibraryAsset, input: { name?: string; tags?: string[]; favorite?: boolean; metadata?: Record<string, unknown> }) => void;
  onCreateCollection: (name: string, assetIds: string[]) => void;
  onSetCollectionAsset: (collectionId: string, assetId: string, action: "add" | "remove") => void;
}) {
  const [nameDraft, setNameDraft] = useState(item.asset.name);
  const [tagDraft, setTagDraft] = useState(item.asset.tags.join(", "));
  const [quickPackName, setQuickPackName] = useState("");
  const parsedTags = parseTagDraft(tagDraft);

  return (
    <>
      <div className="library-vault-title-edit">
        <label>
          Name
          <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} aria-label="Library asset name" />
        </label>
        <label>
          Tags
          <input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} aria-label="Library asset tags" placeholder="cosmic, reference, chorus" />
        </label>
        <div className="library-vault-tag-row">
          {item.asset.tags.length > 0 ? item.asset.tags.map((tag) => <span key={tag}>{tag}</span>) : <span>No tags yet</span>}
        </div>
        <div className="editor-command-actions">
          <button
            type="button"
            className="secondary-command"
            disabled={busy || !nameDraft.trim()}
            onClick={() => onUpdateAsset(item.asset, { name: nameDraft.trim(), tags: parsedTags })}
          >
            <Tag className="h-4 w-4" aria-hidden />
            Save details
          </button>
          <button
            type="button"
            className={`ghost-command ${item.asset.favoriteAt ? "is-favorite" : ""}`}
            disabled={busy}
            onClick={() => onUpdateAsset(item.asset, { favorite: !item.asset.favoriteAt })}
          >
            <Star className="h-4 w-4" aria-hidden />
            {item.asset.favoriteAt ? "Favorited" : "Favorite"}
          </button>
        </div>
      </div>
      <div className="library-vault-collection-membership">
        <strong>Reference packs</strong>
        <div>
          {collections.map((collection) => {
            const included = item.collectionIds.includes(collection.id);
            return (
              <button
                key={collection.id}
                type="button"
                className={included ? "is-active" : ""}
                disabled={busy}
                onClick={() => onSetCollectionAsset(collection.id, item.asset.id, included ? "remove" : "add")}
              >
                {collection.name}
              </button>
            );
          })}
          {collections.length === 0 ? <span>No packs yet</span> : null}
        </div>
        <div className="library-vault-pack-create">
          <input value={quickPackName} onChange={(event) => setQuickPackName(event.target.value)} placeholder="New pack with this asset" aria-label="New reference pack name" />
          <button
            type="button"
            className="ghost-command"
            disabled={busy || !quickPackName.trim()}
            onClick={() => {
              onCreateCollection(quickPackName.trim(), [item.asset.id]);
              setQuickPackName("");
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create
          </button>
        </div>
      </div>
    </>
  );
}

function LibraryVaultHero({ item }: { item: LibraryVaultItem }) {
  if (item.asset.kind === "image") {
    return (
      <div className="library-vault-hero-media">
        {/* eslint-disable-next-line @next/next/no-img-element -- Vault assets include arbitrary user/provider URLs. */}
        <img src={item.asset.url} alt={item.asset.name} />
      </div>
    );
  }
  if (item.asset.kind === "video" || item.asset.kind === "render") {
    return (
      <div className="library-vault-hero-media">
        <video src={item.asset.url} poster={item.thumbnailUrl} controls playsInline preload="metadata" />
      </div>
    );
  }
  if (item.asset.kind === "music") {
    return (
      <div className="library-vault-hero-audio">
        <Music2 className="h-8 w-8" aria-hidden />
        <div className="library-vault-waveform" aria-hidden>
          {[0.18, 0.72, 0.42, 0.9, 0.56, 0.78, 0.34, 0.64, 0.48, 0.86, 0.3, 0.7].map((scale, index) => (
            <span key={`${item.asset.id}-hero-${index}`} style={{ transform: `scaleY(${scale})` }} />
          ))}
        </div>
        <audio src={item.asset.url} controls />
      </div>
    );
  }
  return (
    <div className="library-vault-empty-preview">
      {mediaKindIcon(item.asset.kind)}
      <span>{item.asset.kind}</span>
    </div>
  );
}

function LibraryVaultEmpty() {
  return (
    <div className="library-vault-empty-preview">
      <Library className="h-8 w-8" aria-hidden />
      <span>Generate, import, or upload assets to fill the vault.</span>
    </div>
  );
}

function LibraryVaultReel({
  title,
  items,
  activeId,
  onSelectAsset,
}: {
  title: string;
  items: LibraryVaultItem[];
  activeId?: string;
  onSelectAsset: (asset: LibraryAsset) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="library-vault-reel">
      <div className="library-vault-reel-heading">
        <h3>{title}</h3>
        <span>{items.length}</span>
      </div>
      <div className="library-vault-thumb-track">
        {items.map((item) => (
          <button
            key={item.asset.id}
            type="button"
            className={`library-vault-thumb ${activeId === item.asset.id ? "is-active" : ""}`}
            onClick={() => onSelectAsset(item.asset)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const target = event.key === "ArrowRight"
                ? event.currentTarget.nextElementSibling
                : event.currentTarget.previousElementSibling;
              if (target instanceof HTMLElement) target.focus();
            }}
          >
            <LibraryVaultThumb item={item} />
            <span>{item.asset.name}</span>
            <small>{item.asset.kind} · {item.asset.source}</small>
            {item.asset.tags.length > 0 ? (
              <div className="library-vault-card-tags">
                {item.asset.tags.slice(0, 3).map((tag) => <em key={tag}>{tag}</em>)}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function LibraryVaultThumb({ item }: { item: LibraryVaultItem }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playPreview = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => undefined);
  };
  const stopPreview = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
  };
  const favoriteMark = item.asset.favoriteAt ? <Star className="library-vault-favorite-mark" aria-label="Favorite" /> : null;
  if (item.asset.kind === "image") {
    return (
      <div className="library-vault-thumb-media">
        {/* eslint-disable-next-line @next/next/no-img-element -- Vault thumbnails include arbitrary user/provider URLs. */}
        <img src={item.thumbnailUrl ?? item.asset.url} alt="" />
        {favoriteMark}
      </div>
    );
  }
  if (item.asset.kind === "video" || item.asset.kind === "render") {
    return (
      <div className="library-vault-thumb-media" onMouseEnter={playPreview} onMouseLeave={stopPreview}>
        <video ref={videoRef} src={item.asset.url} muted playsInline preload="metadata" loop />
        <PlayCircle className="library-vault-thumb-overlay" aria-hidden />
        {favoriteMark}
      </div>
    );
  }
  if (item.asset.kind === "music") {
    return (
      <div className="library-vault-thumb-media is-audio">
        <Music2 className="h-5 w-5" aria-hidden />
        <div className="library-vault-mini-wave" aria-hidden>
          {[0.38, 0.82, 0.56, 0.92, 0.64, 0.74].map((scale, index) => (
            <span key={`${item.asset.id}-thumb-${index}`} style={{ transform: `scaleY(${scale})` }} />
          ))}
        </div>
        {favoriteMark}
      </div>
    );
  }
  return <div className="library-vault-thumb-media">{mediaKindIcon(item.asset.kind)}{favoriteMark}</div>;
}

function SessionAgentChat({
  session,
  currentJob,
  messages,
  input,
  busy,
  proposal,
  referenceAssets,
  onInputChange,
  onSend,
  onConfirmProposal,
  onCancelProposal,
}: {
  session: MediaSessionWithVersions;
  currentJob?: VideoJob;
  messages: MediaSessionMessage[];
  input: string;
  busy: boolean;
  proposal: AgentActionProposal | null;
  referenceAssets: MediaAsset[];
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  onConfirmProposal: () => Promise<void>;
  onCancelProposal: () => void;
}) {
  const visibleMessages = messages.length > 0
    ? messages
    : [{
        id: `${session.id}-intro`,
        sessionId: session.id,
        role: "agent" as const,
        content: currentJob
          ? "I can stage session versions, pipeline directives, regeneration, or media injection proposals for this run."
          : "I can stage and create session versions here. Pipeline actions unlock when a director run is selected.",
        createdAt: session.createdAt,
      }];

  return (
    <div className="session-agent-chat">
      <div className="session-agent-head">
        <div>
          <strong>Cocoa Director</strong>
          <span>{messages.length} saved turn{messages.length === 1 ? "" : "s"}</span>
        </div>
        <StateBadge state={currentJob ? currentJob.status : "pending"} label={currentJob ? "pipeline linked" : "session only"} compact />
      </div>
      {referenceAssets.length > 0 ? (
        <div className="session-reference-chips" aria-label="Selected references">
          {referenceAssets.map((asset) => (
            <span key={asset.id}>
              {mediaKindIcon(asset.kind)}
              {asset.role}
            </span>
          ))}
        </div>
      ) : null}
      <div className="agent-message-list session-agent-messages">
        {visibleMessages.map((message) => (
          <div key={message.id} className={`agent-message ${message.role === "user" ? "is-user" : ""}`}>
            <span>{message.role === "user" ? "You" : "Cocoa Director"}</span>
            <p>{message.content}</p>
          </div>
        ))}
      </div>
      <div className="agent-input-row">
        <textarea
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void onSend();
            }
          }}
          maxLength={2000}
          placeholder="Ask for a version, pipeline note, regeneration, injection, or media creation."
          aria-label="Cocoa Director session message"
        />
        <button type="button" className="primary-command" disabled={busy || !input.trim()} onClick={() => void onSend()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
          Send
        </button>
      </div>
      {proposal ? (
        <div className="session-proposal-card">
          <div>
            <span>{proposalActionLabel(proposal)}</span>
            <strong>{proposal.title}</strong>
            <p>{proposal.rationale}</p>
          </div>
          <dl>
            <div>
              <dt>Risk</dt>
              <dd>{proposal.costRisk}</dd>
            </div>
            {proposal.kind ? (
              <div>
                <dt>Media</dt>
                <dd>{proposal.kind} · {proposal.provider ?? providerForMediaKind(proposal.kind)}</dd>
              </div>
            ) : null}
            {proposal.scope || proposal.phase ? (
              <div>
                <dt>Target</dt>
                <dd>{proposal.scope ?? "phase"}{proposal.phase ? ` · phase ${proposal.phase}` : ""}</dd>
              </div>
            ) : null}
          </dl>
          <div className="editor-command-actions">
            <button type="button" className="ghost-command" disabled={busy} onClick={onCancelProposal}>
              Cancel
            </button>
            <button type="button" className="primary-command" disabled={busy} onClick={() => void onConfirmProposal()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
              Confirm
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SessionVersionCarousel({
  session,
  assets,
  generations,
  busy,
  onRestore,
  onExport,
}: {
  session: MediaSessionWithVersions;
  assets: MediaAsset[];
  generations: MediaGeneration[];
  busy: boolean;
  onRestore: (version: MediaSessionVersion) => Promise<void>;
  onExport: (version: MediaSessionVersion) => Promise<string | null>;
}) {
  return (
    <section className="session-version-shelf" aria-label="Session versions">
      <div className="session-version-shelf-head">
        <div>
          <h4>Versions</h4>
          <span>{session.versions.length} saved output{session.versions.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      {session.versions.length > 0 ? (
        <div className="session-version-carousel">
          {session.versions.map((version) => {
            const asset = assets.find((candidate) => candidate.id === version.assetId);
            const generation = version.generationId
              ? generations.find((candidate) => candidate.id === version.generationId)
              : undefined;
            return (
              <article key={version.id} className={`session-version-slide ${session.currentAssetId === version.assetId ? "is-current" : ""}`}>
                <MediaAssetPreview asset={asset} fallbackKind={sessionKindToMediaKind(session.kind) ?? "image"} />
                <div>
                  <strong>{version.label}</strong>
                  <span>{generation ? `${generation.provider} · ${generation.status}` : "source asset"} · {formatClock(version.createdAt)}</span>
                  <p>{version.prompt ?? "Source version"}</p>
                </div>
                <div className="session-version-actions">
                  <button type="button" className="ghost-command" disabled={busy} onClick={() => void onRestore(version)}>
                    <History className="h-4 w-4" aria-hidden />
                    Restore
                  </button>
                  <button type="button" className="ghost-command" disabled={busy} onClick={() => void onExport(version)}>
                    <Download className="h-4 w-4" aria-hidden />
                    Export
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="workspace-empty-inline">
          <History className="h-5 w-5" aria-hidden />
          <span>Confirmed outputs will appear in this carousel.</span>
        </div>
      )}
    </section>
  );
}

function CocoaDirectorDrawer({
  activeProject,
  activeWorkspace,
  currentJob,
  busy,
  input,
  messages,
  outputs,
  proposal,
  onInputChange,
  onSend,
  onConfirmProposal,
  onCancelProposal,
  onClose,
}: {
  activeProject: Project | null;
  activeWorkspace: WorkspaceId;
  currentJob?: VideoJob;
  busy: boolean;
  input: string;
  messages: DirectorChatMessage[];
  outputs: DirectorOutput[];
  proposal: AgentActionProposal | null;
  onInputChange: (value: string) => void;
  onSend: () => Promise<void>;
  onConfirmProposal: () => Promise<void>;
  onCancelProposal: () => void;
  onClose: () => void;
}) {
  return (
    <div className="editor-backdrop is-director" role="presentation">
      <aside className="editor-drawer cocoa-director-drawer" aria-label="Cocoa Director command surface">
        <div className="editor-header">
          <div>
            <span>Unified assistant</span>
            <h2>Cocoa Director</h2>
          </div>
          <button type="button" className="icon-only" onClick={onClose} aria-label="Close Cocoa Director">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <section className="editor-section director-context-panel">
          <div className="editor-section-header">
            <div>
              <h3>Current context</h3>
              <p>{activeProject ? activeProject.name : "A project will be created when you confirm media generation."}</p>
            </div>
            <StateBadge state={currentJob?.status ?? "pending"} label={currentJob ? `phase ${currentJob.currentPhase}` : "media lab"} compact />
          </div>
          <div className="director-context-chips">
            <span>{workspaceTitle(activeWorkspace)}</span>
            <span>{currentJob ? "Pipeline linked" : "Standalone assets"}</span>
            {currentJob?.finalVideoUrl ? <span>Render ready</span> : null}
          </div>
        </section>

        <section className="render-agent-panel agent-chat-panel">
          <div className="editor-section-header">
            <div>
              <h3>Ask Cocoa Director</h3>
              <p>Create images, clips, music, or direct pipeline edits from one conversation.</p>
            </div>
          </div>
          <div className="agent-message-list director-message-list">
            {messages.slice(-8).map((message, index) => (
              <div key={`${message.role}-${index}`} className={`agent-message is-${message.role}`}>
                <span>{message.role === "user" ? "You" : "Cocoa Director"}</span>
                <p>{message.text}</p>
              </div>
            ))}
          </div>
          <div className="agent-input-row">
            <textarea
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void onSend();
                }
              }}
              maxLength={2000}
              placeholder="Create an image of a surfer, make a video of an amusement park, compose a 30-second rock song, or regenerate shot 03."
              aria-label="Cocoa Director message"
            />
            <button type="button" className="primary-command" disabled={busy || !input.trim()} onClick={() => void onSend()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
              Ask
            </button>
          </div>
        </section>

        {outputs.length > 0 ? (
          <section className="editor-section director-output-panel">
            <div className="editor-section-header">
              <div>
                <h3>Created outputs</h3>
                <p>Generated media from this conversation is ready to inspect or reuse.</p>
              </div>
            </div>
            <div className="director-output-grid">
              {outputs.slice(0, 6).map((output) => (
                <DirectorOutputCard key={output.id} output={output} />
              ))}
            </div>
          </section>
        ) : null}

        {proposal ? (
          <section className="session-proposal-card director-proposal-card">
            <div>
              <span>{proposalActionLabel(proposal)}</span>
              <strong>{proposal.title}</strong>
              <p>{proposal.rationale}</p>
            </div>
            <dl>
              <div>
                <dt>Risk</dt>
                <dd>{proposal.costRisk}</dd>
              </div>
              {proposal.kind ? (
                <div>
                  <dt>Scope</dt>
                  <dd>{proposal.kind} · {proposal.provider ?? providerForMediaKind(proposal.kind)}</dd>
                </div>
              ) : null}
              {proposal.scope || proposal.phase ? (
                <div>
                  <dt>Target</dt>
                  <dd>{proposal.scope ?? "phase"}{proposal.phase ? ` · phase ${proposal.phase}` : ""}</dd>
                </div>
              ) : null}
            </dl>
            <div className="editor-command-actions">
              <button type="button" className="ghost-command" disabled={busy} onClick={onCancelProposal}>
                Dismiss
              </button>
              <button type="button" className="primary-command" disabled={busy} onClick={() => void onConfirmProposal()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                Confirm
              </button>
            </div>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

function DirectorOutputCard({ output }: { output: DirectorOutput }) {
  const isWaiting = output.status === "queued" || output.status === "running";
  const statusDetail = directorOutputStatusDetail(output);
  return (
    <article className="director-output-card">
      <div className="director-output-preview">
        {output.kind === "image" && output.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- Generated assets use provider/blob URLs.
          <img src={output.url} alt={output.label} />
        ) : output.kind === "video" && output.url ? (
          <video src={output.url} controls playsInline preload="metadata" />
        ) : output.kind === "music" && output.url ? (
          <div className="director-output-audio">
            <Music2 className="h-5 w-5" aria-hidden />
            <audio src={output.url} controls />
          </div>
        ) : (
          <div className="director-output-empty">
            {isWaiting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : output.status === "failed" ? <AlertTriangle className="h-4 w-4" aria-hidden /> : mediaKindIcon(output.kind)}
            <span>{output.status}</span>
          </div>
        )}
      </div>
      <div className="director-output-meta">
        <div>
          <strong>{output.label}</strong>
          <span>{output.kind} · {output.status}{output.queueStatus ? ` · ${output.queueStatus}` : ""}</span>
        </div>
        <p>{output.prompt}</p>
        {statusDetail ? <small className="director-output-status">{statusDetail}</small> : null}
        <div className="director-output-actions">
          {output.url ? (
            <a className="director-output-action" href={output.url} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Open output
            </a>
          ) : null}
          {output.downloadUrl ? (
            <a className="director-output-action is-download" href={output.downloadUrl} download={output.fileName}>
              <Download className="h-3.5 w-3.5" aria-hidden />
              Download
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function TopPipeline({ current, currentJob, progress }: { current: number; currentJob?: VideoJob; progress?: ProductionProgressSnapshot }) {
  const records = progress ? progressRecords(progress) : pipelineRecords(currentJob);
  const activeIndex = Math.max(0, records.findIndex((record, index) => (
    record.state === "running" || record.state === "awaiting_user" || record.state === "failed" || current === index + 1
  )));
  const activeRecord = records[activeIndex] ?? records[0];
  return (
    <div className="top-pipeline" aria-label="Pipeline">
      <div className="pipeline-summary">
        <span>{currentJob ? `Phase ${activeIndex + 1} of ${records.length}` : "Production pipeline"}</span>
        <strong>{currentJob ? activeRecord?.name ?? "Preparing" : "Ready for direction"}</strong>
        <small>{currentJob ? stateLabel(activeRecord?.state ?? currentJob.status) : "Configure a brief to begin"}</small>
      </div>
      <div className="pipeline-segments" aria-hidden>
        {records.map((record, index) => {
          const done = record.state === "complete" || currentJob?.status === "complete";
          const active = index === activeIndex && Boolean(currentJob);
          return <span key={record.id} className={`${done ? "is-done" : ""} ${active ? "is-active" : ""}`} title={`${record.name}: ${stateLabel(record.state)}`} />;
        })}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-tile">
      <div>{label}</div>
      <strong>{value}</strong>
    </div>
  );
}

function Pill({ active, icon, label }: { active?: boolean; icon: ReactNode; label: string }) {
  return (
    <div
      className={`spec-pill ${
        active ? "border-accent bg-accent/12 text-accent" : "border-line bg-panel-2/80 text-muted"
      }`}
    >
      {icon}
      {label}
    </div>
  );
}

function ErrorDetail({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return (
    <div
      className={`max-h-48 overflow-auto rounded-md border border-danger/30 bg-danger/10 p-3 break-words text-danger ${
        compact ? "text-xs leading-5" : "text-sm leading-6"
      }`}
    >
      {children}
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress-ring"
      style={{ "--progress": `${clamped * 3.6}deg` } as CSSProperties}
      aria-label={`${Math.round(clamped)} percent complete`}
    >
      <span>{Math.round(clamped)}%</span>
    </div>
  );
}

function ProgressHealthIcon({ state }: { state: ProductionProgressSnapshot["state"] }) {
  if (state === "complete") return <CheckCircle2 className="h-12 w-12 text-accent" aria-label="Complete" />;
  if (state === "failed" || state === "needs_attention") return <AlertTriangle className="h-12 w-12 text-danger" aria-label={progressHealthLabel(state)} />;
  if (state === "possibly_stalled") return <Clock3 className="h-12 w-12 text-amber-300" aria-label="Possibly stalled" />;
  return <Loader2 className="h-12 w-12 animate-spin text-accent" aria-label={progressHealthLabel(state)} />;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SystemDock({ job }: { job?: VideoJob }) {
  return (
    <footer className="system-dock border-t border-line/80 bg-panel/60 backdrop-blur-xl">
      <div>
        <Radio className="h-4 w-4 text-accent" aria-hidden />
        <span>System</span>
        <strong>{job?.status === "failed" ? "needs attention" : "operational"}</strong>
      </div>
      <div>
        <Gauge className="h-4 w-4 text-accent-2" aria-hidden />
        <span>Queue</span>
        <strong>{job ? `phase ${job.currentPhase}` : "clear"}</strong>
      </div>
      <div>
        <SlidersHorizontal className="h-4 w-4 text-warm" aria-hidden />
        <span>Director</span>
        <strong>{job?.visualMode === "visible_performer" ? "performer" : "conceptual"}</strong>
      </div>
    </footer>
  );
}

function Waveform({ muted = false }: { muted?: boolean }) {
  return (
    <div className={`waveform ${muted ? "is-muted" : ""}`} aria-hidden>
      {Array.from({ length: 34 }, (_, index) => (
        <span key={index} style={{ height: `${24 + ((index * 17) % 44)}%` }} />
      ))}
    </div>
  );
}

function JobStatusCard({
  apiJob,
  busy,
  progress,
  onRecovery,
}: {
  apiJob: ApiJob | null;
  busy: boolean;
  progress?: ProductionProgressSnapshot;
  onRecovery?: () => void;
}) {
  if (!apiJob) {
    return (
      <div className="status-card text-sm text-muted">
        <div className="flex items-center gap-2 font-medium text-foreground">
          {busy ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Clock3 className="h-4 w-4 text-muted" />}
          {busy ? "Starting a new job" : "Ready for a new request"}
        </div>
        <p className="mt-2 leading-5">
          Stage creates the treatment gate. Make Video hands the whole run to the director workflow.
        </p>
      </div>
    );
  }

  const job = apiJob.job;
  const phase = currentJobPhase(job);
  const summary = statusSummary(job, phase);
  const remaining = estimatedRemaining(job);
  const failedCall = latestFailedProviderCall(job);

  if (progress) {
    const activeUnits = progress.units.filter((unit) => unit.state === "running" || unit.state === "queued");
    const failedUnits = progress.units.filter((unit) => unit.state === "failed" || unit.state === "needs_attention");
    const unitGroups = [
      { label: "Images", units: progress.units.filter((unit) => unit.kind === "image") },
      { label: "Cinematic clips", units: progress.units.filter((unit) => unit.kind === "video") },
      { label: "Narration", units: progress.units.filter((unit) => unit.kind === "speech") },
      { label: "Score", units: progress.units.filter((unit) => unit.kind === "music") },
    ].filter((group) => group.units.length > 0);
    const visualQualityState = progress.visualQuality?.state;
    const visualQualityNeedsAttention = visualQualityState === "failed" || visualQualityState === "needs_review";
    const visualQualityActive = visualQualityState === "running";
    const visualQualityPassed = visualQualityState === "passed";
    const visualQualityRecoveryAvailable = visualQualityNeedsAttention
      && ((progress.visualQuality?.rejectedAssetCount ?? 0) > 0 || (progress.visualQuality?.duplicateGroupCount ?? 0) > 0);
    const cinematicUnits = progress.units.filter((unit) => unit.kind === "video");
    const cinematicReady = cinematicUnits.filter((unit) => unit.state === "ready").length;
    const visualQualityStatus = visualQualityState === "not_started"
      ? `Waiting for cinematic assets (${cinematicReady}/${cinematicUnits.length} ready)`
      : visualQualityActive ? "Analyzing the completed visual rough cut"
        : visualQualityPassed ? "Passed"
          : visualQualityNeedsAttention ? "Review required" : undefined;
    return (
      <div className="status-card text-sm" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-foreground">
            {statusIcon(progressStatusForIcon(progress.state))}
            <span>{progressHealthLabel(progress.state)}</span>
          </div>
          <span className="rounded border border-line bg-background px-2 py-1 font-mono text-[11px] text-muted">{progress.activeStageLabel ?? "Production"}</span>
        </div>
        <p className="mt-2 leading-5 text-muted">{progress.activeDetail ?? "Waiting for the next persisted work unit."}</p>
        <div className="mt-3 grid gap-2">
          {unitGroups.map((group) => {
            const ready = group.units.filter((unit) => unit.state === "ready").length;
            const attention = group.units.filter((unit) => unit.state === "failed" || unit.state === "needs_attention").length;
            const allNotStarted = group.units.every((unit) => unit.state === "not_started");
            return <div key={group.label} className="flex items-center justify-between gap-3 rounded border border-line bg-background/60 px-3 py-2">
              <span className="text-muted">{group.label}</span>
              <strong className={attention > 0 ? "font-mono text-danger" : "font-mono text-accent"}>{allNotStarted ? `0/${group.units.length} not started` : `${ready}/${group.units.length} ready${attention > 0 ? ` · ${attention} need recovery` : ""}`}</strong>
            </div>
          })}
          {unitGroups.length === 0 && progress.activeDetail ? <div className="rounded border border-line bg-background/60 px-3 py-2 text-muted">{progress.activeDetail}</div> : null}
        </div>
        {progress.visualQuality ? <div className={`mt-3 rounded border p-3 ${visualQualityPassed
          ? "border-accent/30 bg-accent/5"
          : visualQualityNeedsAttention ? "border-danger/40 bg-danger/10"
            : visualQualityActive ? "border-sky-400/30 bg-sky-400/5"
              : "border-line bg-background/60"}`}>
          <div className="flex items-center justify-between gap-3">
            <strong className={visualQualityPassed
              ? "text-accent"
              : visualQualityNeedsAttention ? "text-danger"
                : visualQualityActive ? "text-sky-300" : "text-foreground"}>Audiovisual rough-cut QA · {progress.visualQuality.state.replaceAll("_", " ")}</strong>
            <span className="font-mono text-xs text-muted">{progress.visualQuality.uniqueAssetRatio === undefined
              ? visualQualityStatus
              : `${Math.round(progress.visualQuality.uniqueAssetRatio * 100)}% unique`}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px] text-muted">
            <span>{visualQualityState === "not_started" ? `${progress.visualQuality.retainedAssetCount} visual assets ready` : `${progress.visualQuality.retainedAssetCount} retained`}</span>
            <span className="text-right">{visualQualityState === "not_started" ? "QA pending" : `${progress.visualQuality.rejectedAssetCount} rejected`}</span>
            <span>{visualQualityState === "not_started" ? "Duplicate scan pending" : `${progress.visualQuality.duplicateGroupCount} duplicate groups`}</span>
            <span className="text-right">{visualQualityState === "not_started" ? "Polish not evaluated" : `polish ${progress.visualQuality.autoPolishAttempts}/1`}</span>
            {progress.visualQuality.semanticScore !== undefined ? <span>semantic {progress.visualQuality.semanticScore.toFixed(2)}</span> : null}
            {progress.visualQuality.cinematicCoverage !== undefined ? <span className="text-right">{Math.round(progress.visualQuality.cinematicCoverage * 100)}% cinema</span> : null}
            {progress.visualQuality.spokenCoverage !== undefined ? <span>{Math.round(progress.visualQuality.spokenCoverage * 100)}% measured speech</span> : null}
            {progress.visualQuality.longestUnapprovedGapMs !== undefined ? <span className="text-right">max voice gap {(progress.visualQuality.longestUnapprovedGapMs / 1_000).toFixed(1)}s</span> : null}
            {progress.visualQuality.authenticSourceVisualCount !== undefined ? <span>{progress.visualQuality.authenticSourceVisualCount} authentic source visuals</span> : null}
            {progress.visualQuality.maximumInformationStasisMs !== undefined ? <span className="text-right">max info stasis {(progress.visualQuality.maximumInformationStasisMs / 1_000).toFixed(1)}s</span> : null}
          </div>
          {visualQualityNeedsAttention && progress.visualQuality.findings.length > 0 ? <div className="mt-3 space-y-2">
            {progress.visualQuality.findings.slice(0, 3).map((finding) => <div key={`${finding.code}:${finding.beatIds.join(",")}`} className="rounded border border-danger/30 bg-background/50 px-2.5 py-2 text-xs leading-5 text-muted">
              <div className="font-medium text-danger">{finding.message}</div>
              {finding.beatIds.length > 0 ? <div className="mt-1 font-mono text-[10px]">{finding.beatIds.length} flagged beat{finding.beatIds.length === 1 ? "" : "s"}</div> : null}
            </div>)}
          </div> : null}
          {visualQualityRecoveryAvailable && onRecovery ? <button type="button" className="secondary-command mt-3 w-full" disabled={busy} onClick={onRecovery}><RefreshCcw className="h-4 w-4" /> {progress.visualQuality.duplicateGroupCount > 0 ? "Salvage collided visuals" : "Review and recover flagged beats"}</button> : null}
        </div> : null}
        {activeUnits.slice(0, 4).map((unit) => (
          <div key={unit.id} className="mt-2 rounded border border-line bg-background/60 p-2 text-xs text-muted">
            <div className="flex justify-between gap-2"><span>{unit.label}</span><span className="font-mono text-accent">{unit.state}</span></div>
            {unit.provider ? <div className="mt-1 font-mono">{unit.provider} · {unit.model ?? "default"}{unit.requestId ? ` · ${unit.requestId.slice(0, 12)}` : ""}</div> : null}
          </div>
        ))}
        {failedUnits.length > 0 && !progress.visualQuality ? (
          <div className="mt-3 rounded border border-danger/40 bg-danger/10 p-3">
            <strong className="text-danger">{failedUnits.length} work unit{failedUnits.length === 1 ? "" : "s"} need recovery</strong>
            <p className="mt-1 text-xs leading-5 text-muted">Successful assets remain locked. Recovery replaces only the failed cinematic beats with identity-safe alternatives.</p>
            {onRecovery ? <button type="button" className="secondary-command mt-3 w-full" disabled={busy} onClick={onRecovery}><RefreshCcw className="h-4 w-4" /> Resume with safe recovery</button> : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px] text-muted">
          <span className="rounded border border-line bg-background px-2 py-1">last confirmed {formatRelativeActivity(progress.lastActivityAt)}</span>
          <span className="rounded border border-line bg-background px-2 py-1">job {job.id.slice(0, 8)}</span>
          <span className="rounded border border-line bg-background px-2 py-1">{progress.workflowVersion}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="status-card text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium text-foreground">
          {statusIcon(job.status)}
          <span>{summary.title}</span>
        </div>
        <StateBadge state={job.status} />
      </div>
      <p className="mt-2 leading-5 text-muted">{summary.detail}</p>
      {job.status === "failed" && failedCall?.error ? (
          <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-semibold text-danger">Latest failed provider call</span>
              <span className="font-mono text-muted">{failedCall.provider} {failedCall.requestId.slice(0, 12)}</span>
            </div>
            <ErrorDetail compact>{failedCall.error}</ErrorDetail>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px] text-muted">
        <span className="rounded border border-line bg-background px-2 py-1">job {job.id.slice(0, 8)}</span>
        <span className="rounded border border-line bg-background px-2 py-1">
          phase {job.currentPhase}/9
        </span>
        {remaining ? (
          <span className="rounded border border-line bg-background px-2 py-1 text-accent">
            eta {remaining}
          </span>
        ) : null}
        {latestActiveProviderCall(job) ? (
          <span className="rounded border border-line bg-background px-2 py-1">
            fal {latestActiveProviderCall(job)?.requestId.slice(0, 12)}
          </span>
        ) : null}
        {failedCall ? (
          <span className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-danger">
            failed {failedCall.requestId.slice(0, 12)}
          </span>
        ) : null}
        <span className="rounded border border-line bg-background px-2 py-1">trace {job.traceId.slice(0, 10)}</span>
      </div>
    </div>
  );
}

function PhaseTimeline({ current, currentJob, progress }: { current: number; currentJob?: VideoJob; progress?: ProductionProgressSnapshot }) {
  const records = progress ? progressRecords(progress) : pipelineRecords(currentJob);
  return (
    <div className="studio-panel timeline-panel">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Pipeline detail</h2>
        <StateBadge state={currentJob?.status ?? "pending"} label={currentJob?.status ?? "idle"} />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
        {records.map((record, index) => {
          const phaseNumber = index + 1;
          const phaseCardLabel = currentJob?.workflowSteps ? record.name : phaseCardLabels[index] ?? record.name;
          const state = record.state;
          const active = currentJob?.workflowSteps
            ? state === "running" || state === "awaiting_user"
            : current === phaseNumber;
          const done = state === "complete" || (currentJob?.status === "complete" && phaseNumber <= records.length);
          const failed = state === "failed";
          const running = state === "running";
          return (
            <div
              key={record.id}
              className={`phase-card ${
                failed
                  ? "is-failed"
                  : running
                    ? "is-running"
                    : active
                      ? "is-active"
                      : done
                        ? "is-done"
                        : ""
              }`}
              role="group"
              aria-label={`Step ${phaseNumber}: ${record.name}, ${stateLabel(state)}`}
              title={`Step ${phaseNumber}: ${record.name}`}
            >
              <div className="min-w-0">
                <div className="font-mono text-xs text-muted">{String(phaseNumber).padStart(2, "0")}</div>
                <div className="phase-card-label mt-1 text-sm font-medium leading-5 text-foreground" aria-label={record.name}>
                  {phaseCardLabel}
                </div>
              </div>
              <div className="mt-2.5 flex min-w-0 flex-col gap-1.5">
                <TimelineStateBadge state={state} />
                {record.completedAt ? (
                  <span className="font-mono text-[11px] text-muted">{formatClock(record.completedAt)}</span>
                ) : null}
                {record.error ? <span className="line-clamp-2 text-[11px] text-danger">{record.error}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ActionMenu({
  label,
  items,
  placement = "down",
}: {
  label: string;
  items: ActionMenuItem[];
  placement?: ActionMenuPlacement;
}) {
  const [open, setOpen] = useState(false);

  function select(item: ActionMenuItem) {
    if (item.disabled) return;
    item.onSelect?.();
    setOpen(false);
  }

  return (
    <div className="action-menu">
      <button
        type="button"
        className="icon-only"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreVertical className="h-4 w-4" aria-hidden />
      </button>
      {open ? (
        <div className={`action-menu-popover ${placement === "up" ? "is-up" : ""}`} role="menu" aria-label={label}>
          {items.map((item) =>
            item.href ? (
              <a
                key={item.label}
                className={`action-menu-item ${item.danger ? "is-danger" : ""} ${item.disabled ? "is-disabled" : ""}`}
                href={item.disabled ? undefined : item.href}
                target={item.download ? undefined : "_blank"}
                rel={item.download ? undefined : "noreferrer"}
                download={item.download}
                aria-disabled={item.disabled}
                role="menuitem"
                onClick={(event) => {
                  if (item.disabled) {
                    event.preventDefault();
                    return;
                  }
                  setOpen(false);
                }}
              >
                {item.icon}
                <span>
                  <strong>{item.label}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </span>
              </a>
            ) : (
              <button
                key={item.label}
                type="button"
                className={`action-menu-item ${item.danger ? "is-danger" : ""}`}
                disabled={item.disabled}
                role="menuitem"
                onClick={() => select(item)}
              >
                {item.icon}
                <span>
                  <strong>{item.label}</strong>
                  {item.detail ? <small>{item.detail}</small> : null}
                </span>
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

function previewMediaForJob(
  job: VideoJob | undefined,
  selection: PreviewSelection,
  output: ReturnType<typeof outputSummary>,
): PreviewMedia {
  if (job) {
    const selectedMedia = previewMediaForSelection(job, selection);
    if (selectedMedia) return selectedMedia;

    if (job.finalVideoUrl) {
      return {
        kind: "video",
        key: `final-${job.finalVideoUrl}`,
        title: "Final render",
        detail: "Mastered MP4 from the current render manifest.",
        src: job.finalVideoUrl,
        poster: job.thumbnailUrl,
        alt: "Final music video render",
        icon: <PlayCircle className="h-4 w-4 text-accent" aria-hidden />,
      };
    }

    const firstShot = job.generatedShots[0];
    if (firstShot?.videoUrl) return previewMediaForShot(firstShot);

    if (job.thumbnailUrl) {
      return {
        kind: "image",
        key: `thumbnail-${job.thumbnailUrl}`,
        title: "Thumbnail",
        detail: "Generated thumbnail for the current render state.",
        src: job.thumbnailUrl,
        alt: "Generated thumbnail",
        icon: <ImageIcon className="h-4 w-4 text-accent" aria-hidden />,
      };
    }

    const firstAnchor = job.anchorAssets[0];
    if (firstAnchor?.url) return previewMediaForAnchor(firstAnchor);
  }

  return {
    kind: "idle",
    key: "idle",
    title: output.title,
    detail: output.detail,
    alt: "Cinematic Cocoa Director preview frame",
    icon: output.icon,
  };
}

function previewMediaForSelection(job: VideoJob, selection: PreviewSelection): PreviewMedia | null {
  if (selection.kind === "auto") return null;

  if (selection.kind === "final") {
    return job.finalVideoUrl
      ? {
          kind: "video",
          key: `final-${job.finalVideoUrl}`,
          title: "Final render",
          detail: "Mastered MP4 from the current render manifest.",
          src: job.finalVideoUrl,
          poster: job.thumbnailUrl,
          alt: "Final music video render",
          icon: <PlayCircle className="h-4 w-4 text-accent" aria-hidden />,
        }
      : null;
  }

  if (selection.kind === "thumbnail") {
    return job.thumbnailUrl
      ? {
          kind: "image",
          key: `thumbnail-${job.thumbnailUrl}`,
          title: "Thumbnail",
          detail: "Generated thumbnail for the current render state.",
          src: job.thumbnailUrl,
          alt: "Generated thumbnail",
          icon: <ImageIcon className="h-4 w-4 text-accent" aria-hidden />,
        }
      : null;
  }

  if (selection.kind === "anchor") {
    const anchor = job.anchorAssets.find((asset) => asset.role === selection.role);
    return anchor ? previewMediaForAnchor(anchor) : null;
  }

  const shot = job.generatedShots.find((asset) => asset.shotIndex === selection.shotIndex);
  return shot ? previewMediaForShot(shot) : null;
}

function previewMediaForAnchor(anchor: AnchorAsset): PreviewMedia {
  const label = formatAnchorRole(anchor.role);
  return {
    kind: "image",
    key: `anchor-${anchor.role}-${anchor.url}`,
    title: `Anchor: ${label}`,
    detail: `${label} reference from the anchor asset set.`,
    src: anchor.url,
    alt: `${label} anchor`,
    icon: <ImageIcon className="h-4 w-4 text-accent" aria-hidden />,
  };
}

function previewMediaForShot(shot: GeneratedShot): PreviewMedia {
  return {
    kind: "video",
    key: `shot-${shot.shotIndex}-${shot.videoUrl}`,
    title: `Shot ${formatShotNumber(shot.shotIndex)}`,
    detail: `${shot.durationSeconds.toFixed(1)}s generated clip · seed ${shot.seed}`,
    src: shot.videoUrl,
    alt: `Shot ${shot.shotIndex + 1} generated video`,
    icon: <Clapperboard className="h-4 w-4 text-accent" aria-hidden />,
  };
}

function isPreviewSelectionAvailable(job: VideoJob | undefined, selection: PreviewSelection) {
  if (selection.kind === "auto") return true;
  if (!job) return false;
  if (selection.kind === "final") return Boolean(job.finalVideoUrl);
  if (selection.kind === "thumbnail") return Boolean(job.thumbnailUrl);
  if (selection.kind === "anchor") return job.anchorAssets.some((asset) => asset.role === selection.role);
  return job.generatedShots.some((shot) => shot.shotIndex === selection.shotIndex);
}

function formatAnchorRole(role: AnchorAsset["role"]) {
  return role.replace(/_/g, " ");
}

function formatShotNumber(shotIndex: number) {
  return String(shotIndex + 1).padStart(2, "0");
}

function PreviewPanel({
  job,
  progress,
  previewSelection,
  onPreviewSelect,
  onOpenEditor,
}: {
  job?: VideoJob;
  progress?: ProductionProgressSnapshot;
  previewSelection: PreviewSelection;
  onPreviewSelect: (selection: PreviewSelection) => void;
  onOpenEditor: (context: EditorContext) => void;
}) {
  const output = outputSummary(job);
  const previewMedia = previewMediaForJob(job, previewSelection, output);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(false);
  const hasPlayableVideo = previewMedia.kind === "video" && Boolean(previewMedia.src);
  const togglePreviewPlay = () => {
    const element = previewVideoRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };
  const togglePreviewMute = () => {
    const element = previewVideoRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setPreviewMuted(element.muted);
  };
  const menuItems: ActionMenuItem[] = [
    {
      label: "Preview final render",
      detail: "Show the mastered MP4 in the main viewer",
      icon: <PlayCircle className="h-4 w-4" aria-hidden />,
      disabled: !job?.finalVideoUrl,
      onSelect: () => onPreviewSelect({ kind: "final" }),
    },
    {
      label: "Preview thumbnail",
      detail: "Show the rendered thumbnail frame",
      icon: <ImageIcon className="h-4 w-4" aria-hidden />,
      disabled: !job?.thumbnailUrl,
      onSelect: () => onPreviewSelect({ kind: "thumbnail" }),
    },
    {
      label: "Open render editor",
      detail: "Inspect final URL, preview state, and manifest",
      icon: <Film className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "preview" }),
    },
    {
      label: "Regenerate render",
      detail: "Re-render from the current manifest",
      icon: <RefreshCcw className="h-4 w-4" aria-hidden />,
      disabled: !job?.renderManifest,
      onSelect: () =>
        onOpenEditor({
          mode: "preview",
          pendingAction: {
            kind: "regenerate-phase",
            label: "Regenerate render",
            phase: 9,
            scope: "render",
          },
        }),
    },
    {
      label: "View manifest",
      detail: "Open render JSON",
      icon: <FileText className="h-4 w-4" aria-hidden />,
      href: job?.renderManifest ? `/api/videos/${job.id}/manifest` : undefined,
      disabled: !job?.renderManifest,
    },
    {
      label: "Download MP4",
      detail: "Save the mastered video",
      icon: <Download className="h-4 w-4" aria-hidden />,
      href: job?.finalVideoUrl ? `/api/videos/${job.id}/download` : undefined,
      download: true,
      disabled: !job?.finalVideoUrl,
    },
    {
      label: "Version history",
      detail: "Compare and restore prior artifacts",
      icon: <History className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "versions" }),
    },
  ];

  return (
    <div className="studio-panel preview-panel">
      <div className="preview-toolbar">
        <div>
          <h2>Preview ({job?.aspectRatio ?? "9:16"})</h2>
          <span>{previewMedia.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`preview-auto-button ${previewSelection.kind === "auto" ? "is-active" : ""}`}
            aria-pressed={previewSelection.kind === "auto"}
            onClick={() => onPreviewSelect({ kind: "auto" })}
          >
            Auto
          </button>
          <span className="toolbar-select">720p</span>
          <ActionMenu label="Preview options" items={menuItems} />
        </div>
      </div>
      <div className="preview-stage" style={{ aspectRatio: (job?.aspectRatio ?? "9:16").replace(":", " / ") }}>
        {previewMedia.kind === "video" && previewMedia.src ? (
          <video
            ref={previewVideoRef}
            key={previewMedia.key}
            src={previewMedia.src}
            poster={previewMedia.poster}
            controls
            playsInline
            muted={previewMuted}
            onPlay={() => setPreviewPlaying(true)}
            onPause={() => setPreviewPlaying(false)}
            onEnded={() => setPreviewPlaying(false)}
            className="h-full w-full object-contain"
          />
        ) : previewMedia.kind === "image" && previewMedia.src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={previewMedia.key} src={previewMedia.src} alt={previewMedia.alt} className="h-full w-full object-contain" />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/cocoa-preview.png" alt="Cinematic Cocoa Director preview frame" className="h-full w-full object-contain" />
            <div className="preview-idle-overlay">
              <div className="preview-pulse">{previewMedia.icon}</div>
              <span>{previewMedia.title}</span>
              <p>{previewMedia.detail}</p>
            </div>
          </>
        )}
      </div>
      <div className="transport">
        <button
          type="button"
          className="icon-only"
          aria-label={previewPlaying ? "Pause preview" : "Play preview"}
          onClick={togglePreviewPlay}
          disabled={!hasPlayableVideo}
        >
          {previewPlaying ? <Pause className="h-5 w-5" aria-hidden /> : <PlayCircle className="h-5 w-5" aria-hidden />}
        </button>
        <button
          type="button"
          className="icon-only"
          aria-label={previewMuted ? "Unmute preview" : "Mute preview"}
          onClick={togglePreviewMute}
          disabled={!hasPlayableVideo}
        >
          {previewMuted ? <VolumeX className="h-4 w-4" aria-hidden /> : <Volume2 className="h-4 w-4" aria-hidden />}
        </button>
        <div className="transport-track">
          <div style={{ width: `${progress && !job?.finalVideoUrl ? 0 : jobProgressPercent(job)}%` }} />
        </div>
        <span>{progress && !job?.finalVideoUrl ? "--:--" : job ? formatSeconds(Math.round((job.durationSeconds * jobProgressPercent(job)) / 100)) : "0:00"}</span>
        <span>/</span>
        <span>{formatSeconds(job?.durationSeconds ?? 90)}</span>
      </div>
      {job?.musicTrack?.url ? (
        <audio controls src={job.musicTrack.url} className="mt-3 w-full" />
      ) : null}
      {job ? (
        <div className="mt-3 rounded-md border border-line bg-panel-2/70 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            {previewMedia.icon}
            {previewMedia.title}
          </div>
          <p className="mt-1 text-sm leading-5 text-muted">{previewMedia.detail}</p>
        </div>
      ) : null}
      {job?.finalVideoUrl ? <DownloadPanel job={job} /> : null}
    </div>
  );
}

function DownloadPanel({ job }: { job: VideoJob }) {
  return (
    <div className="mt-3 rounded-md border border-accent/35 bg-accent/10 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">Ready for export</div>
          <p className="mt-1 text-xs leading-5 text-muted">Download the mastered MP4 directly from this project.</p>
        </div>
        <a
          href={`/api/videos/${job.id}/download`}
          download
          className="primary-command h-10 shrink-0 px-4"
        >
          <Download className="h-4 w-4" aria-hidden />
          Download MP4
        </a>
      </div>
    </div>
  );
}

function CompactRunSummary({ apiJob, progress }: { apiJob: ApiJob | null; progress?: ProductionProgressSnapshot }) {
  if (!apiJob) {
    return (
      <div className="compact-run-summary" aria-live="polite">
        <Clock3 className="h-4 w-4 text-muted" aria-hidden />
        <div><strong>Ready for a new request</strong><p>Set the brief, direction, and review options to begin.</p></div>
      </div>
    );
  }

  const job = apiJob.job;
  const summary = statusSummary(job, currentJobPhase(job));
  const remaining = estimatedRemaining(job);
  const completedUnits = progress?.units.filter((unit) => unit.state === "ready").length ?? 0;
  const totalUnits = progress?.units.length ?? 0;

  return (
    <div className="compact-run-summary" aria-live="polite">
      <div className="compact-run-summary-icon">{statusIcon(progress ? progressStatusForIcon(progress.state) : job.status)}</div>
      <div className="min-w-0">
        <strong>{progress ? progressHealthLabel(progress.state) : summary.title}</strong>
        <p>{progress?.activeDetail ?? summary.detail}</p>
        <div className="compact-run-meta">
          {remaining ? <span>ETA {remaining}</span> : null}
          {totalUnits > 0 ? <span>{completedUnits}/{totalUnits} units ready</span> : null}
          <span>Phase {job.currentPhase}/9</span>
        </div>
      </div>
    </div>
  );
}

function SourcesPanel({
  sources,
  selectedSourceIds,
  onSelectionChange,
  onRetry,
  onRemove,
}: {
  sources: ProductionSource[];
  selectedSourceIds: Set<string>;
  onSelectionChange: (value: Set<string>) => void;
  onRetry: (sourceId: string) => void | Promise<void>;
  onRemove: (sourceId: string) => void | Promise<void>;
}) {
  if (sources.length === 0) {
    return (
      <div className="workbench-empty-state">
        <FileText className="h-6 w-6 text-accent" aria-hidden />
        <div><strong>No sources added yet</strong><p>Add pasted text, public URLs, or private PDFs from the Sources creation section.</p></div>
      </div>
    );
  }

  return (
    <div className="source-workbench">
      <div className="source-workbench-summary">
        <div><strong>{selectedSourceIds.size}</strong><span>selected for this draft</span></div>
        <button type="button" className="ghost-command" disabled={selectedSourceIds.size === 0} onClick={() => onSelectionChange(new Set())}>Clear selection</button>
      </div>
      <div className="source-card-grid">
        {sources.map((source) => {
          const selected = selectedSourceIds.has(source.id);
          return (
            <article key={source.id} className={`source-workbench-card ${selected ? "is-selected" : ""}`}>
              <label>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => {
                    const next = new Set(selectedSourceIds);
                    if (event.target.checked) next.add(source.id); else next.delete(source.id);
                    onSelectionChange(next);
                  }}
                  aria-label={`Include ${source.title} in this draft`}
                />
                <span className="source-kind-icon">{source.kind === "document" ? <FileText className="h-4 w-4" /> : source.kind === "url" ? <LinkIcon className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</span>
                <span className="min-w-0"><strong>{source.title}</strong><small>{source.kind === "document" ? `${source.pageCount ?? "…"} pages · ${formatBytes(source.byteSize)}` : source.kind === "url" ? safeDomain(source.canonicalUrl ?? source.url) : `${source.byteSize ?? 0} bytes`}</small></span>
              </label>
              <div className={`source-processing-state is-${source.processingState}`}>
                <span>{source.processingState}{source.error ? ` · ${source.error}` : source.warnings[0] ? ` · ${source.warnings[0]}` : ""}</span>
                <div>
                  {(source.processingState === "failed" || source.processingState === "warning") ? <button type="button" className="icon-only" onClick={() => void onRetry(source.id)} title="Retry extraction" aria-label={`Retry ${source.title}`}><RefreshCcw className="h-3.5 w-3.5" /></button> : null}
                  <button type="button" className="icon-only" onClick={() => void onRemove(source.id)} title="Remove source" aria-label={`Remove ${source.title}`}><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CostPanel({ job, progress }: { job?: VideoJob; progress?: ProductionProgressSnapshot }) {
  const phase = currentJobPhase(job);
  const shotTotal = job?.shotPlan?.shots.length ?? 0;
  const shotDone = job?.generatedShots.length ?? 0;
  return (
    <div className="telemetry-panel">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        <Gauge className="h-4 w-4" aria-hidden />
        Cost & provider
      </div>
      <div className="flex flex-col gap-2">
        {progress ? (
          <div className="telemetry-row grid gap-2 text-xs">
            <div className="flex justify-between gap-3"><span className="text-muted">Base estimate</span><strong className="font-mono text-foreground">${(progress.costs.estimatedBaseCents / 100).toFixed(2)}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-muted">Recovery reserve</span><strong className="font-mono text-foreground">${(progress.costs.recoveryReserveCents / 100).toFixed(2)}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-muted">Actual provider spend</span><strong className="font-mono text-accent">${(progress.costs.actualCents / 100).toFixed(2)}</strong></div>
            <div className="flex justify-between gap-3"><span className="text-muted">Reserve remaining</span><strong className="font-mono text-foreground">${(progress.costs.remainingRecoveryCents / 100).toFixed(2)}</strong></div>
          </div>
        ) : null}
        {!progress && phase ? (
          <div className="telemetry-row">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">Current phase</span>
              <StateBadge state={phase.state} compact />
            </div>
            <div className="mt-2 text-xs leading-5 text-muted">
              {phase.name}
              {phase.startedAt ? ` started ${formatClock(phase.startedAt)}` : " is queued"}
              {phase.completedAt ? ` and finished ${formatClock(phase.completedAt)}` : ""}.
            </div>
            {phase.error ? <ErrorDetail compact>{phase.error}</ErrorDetail> : null}
          </div>
        ) : null}
        {shotTotal > 0 && (job?.currentPhase ?? 0) >= 7 ? (
          <div className="telemetry-row">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">Shot progress</span>
              <span className="font-mono text-accent">
                {shotDone}/{shotTotal}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-background">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${Math.round((shotDone / shotTotal) * 100)}%` }}
              />
            </div>
            {job ? (
              <div className="mt-2 text-xs leading-5 text-muted">
                {shotDone < shotTotal
                  ? `${shotTotal - shotDone} shot block${shotTotal - shotDone === 1 ? "" : "s"} left before QA and render. Rough ETA ${estimatedRemaining(job) ?? "calculating"}.`
                  : "All shot blocks are ready; QA and render are next."}
              </div>
            ) : null}
          </div>
        ) : null}
        {(job?.providerCalls ?? []).slice(-8).map((call) => (
          <div key={call.id} className="telemetry-row">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate font-medium text-foreground">{call.provider}</span>
              <div className="flex shrink-0 items-center gap-2">
                <StateBadge state={providerCallState(call.status)} label={call.status} compact />
                <span className="font-mono text-accent">${(call.costCents / 100).toFixed(2)}</span>
              </div>
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted">{call.requestId}</div>
            {typeof call.metadata?.routingReason === "string" ? (
              <div className="mt-2 text-xs leading-5 text-muted">{call.metadata.routingReason}</div>
            ) : null}
            {call.error ? <div className="mt-2 line-clamp-3 break-words text-xs text-danger">{call.error}</div> : null}
          </div>
        ))}
        {job?.providerCalls.length === 0 || !job ? (
          <div className="telemetry-row text-sm leading-5 text-muted">
            No billable provider calls have completed yet. Early treatment, routing, and queued workflow steps can still be moving before this list fills in.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QualitySummary({ report }: { report: QAReport }) {
  const blocking = report.findings.filter((finding) => finding.severity === "error");
  const warnings = report.findings.filter((finding) => finding.severity === "warning");
  return (
    <div className="telemetry-panel">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          Quality gate
        </div>
        <StateBadge state={report.passed ? "complete" : "failed"} label={report.passed ? "passed" : "blocked"} compact />
      </div>
      <p className="text-xs leading-5 text-muted">
        {blocking.length} blocking · {warnings.length} warning · {report.findings.length} total findings
      </p>
      {report.findings.slice(0, 3).map((finding) => (
        <div key={finding.id} className="mt-2 rounded border border-line bg-background/60 px-2 py-1.5 text-xs leading-5 text-muted">
          <span className={finding.severity === "error" ? "text-danger" : "text-foreground"}>{finding.code}</span>
          {` · ${finding.message}`}
        </div>
      ))}
    </div>
  );
}

function PromptTracePanel({ trace }: { trace?: PromptTrace }) {
  const contract = trace?.styleContract;
  const audits = trace?.anchorAudits ?? [];
  const excluded = audits.filter((audit) => !audit.reuseEligible);
  return (
    <div className="telemetry-panel">
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        <FileText className="h-4 w-4" aria-hidden />
        Style trace
      </div>
      {contract ? (
        <div className="flex flex-col gap-2">
          <div className="telemetry-row">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-foreground">{contract.musicIntent.primaryGenre}</span>
              <span className="font-mono text-xs text-accent">{contract.source}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted">{contract.visualIntent.primaryStyle}</p>
            {contract.userMotifs.length > 0 ? (
              <p className="mt-2 text-xs leading-5 text-muted">Motifs: {contract.userMotifs.join(", ")}</p>
            ) : (
              <p className="mt-2 text-xs leading-5 text-muted">No recurring motif layer; continuity comes from palette, materials, setting, camera, and rhythm.</p>
            )}
          </div>
          <div className="telemetry-row">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Positive vocabulary</div>
            <p className="mt-1 text-xs leading-5 text-muted">{contract.visualIntent.positiveVocabulary.slice(0, 6).join(", ") || "pending"}</p>
          </div>
          {contract.conflicts.length > 0 ? (
            <div className="telemetry-row">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">Conflicts</div>
              <p className="mt-1 text-xs leading-5 text-muted">{contract.conflicts.join(" ")}</p>
            </div>
          ) : null}
          {audits.length > 0 ? (
            <div className="telemetry-row">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium text-foreground">Anchor audit</span>
                <span className={`font-mono text-xs ${excluded.length ? "text-danger" : "text-accent"}`}>
                  {excluded.length}/{audits.length} excluded
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted">
                {audits.map((audit) => `${audit.role} ${Math.round(audit.styleAlignment * 100)}%`).join(" · ")}
              </p>
            </div>
          ) : null}
          {trace?.promptSummaries ? (
            <details className="telemetry-row">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-muted">Prompt excerpts</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-line bg-background p-2 text-[11px] leading-4 text-muted">
                {Object.entries(trace.promptSummaries).map(([key, value]) => `${key}: ${value}`).join("\n\n")}
              </pre>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="telemetry-row text-sm leading-5 text-muted">
          Style parsing has not run for this job yet. Legacy jobs may not include trace metadata.
        </div>
      )}
    </div>
  );
}

function AssetsPanel({
  job,
  assets,
  youPhotos,
  seedByRole,
  onOpenSeedDrawer,
  previewSelection,
  onPreviewSelect,
  onOpenEditor,
}: {
  job?: VideoJob;
  assets: AnchorAsset[];
  youPhotos: LibraryAsset[];
  seedByRole: Record<AestheticSeedRole, LibraryAsset | undefined>;
  onOpenSeedDrawer: (role: SeedRole) => void;
  previewSelection: PreviewSelection;
  onPreviewSelect: (selection: PreviewSelection) => void;
  onOpenEditor: (context: EditorContext) => void;
}) {
  const menuItems: ActionMenuItem[] = [
    {
      label: "Open anchor editor",
      detail: "Inspect prompts, images, and style notes",
      icon: <ImageIcon className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "anchors" }),
    },
    {
      label: "Regenerate anchors",
      detail: "Replaces anchor images and downstream references",
      icon: <RefreshCcw className="h-4 w-4" aria-hidden />,
      disabled: !job?.creativeBrief,
      onSelect: () =>
        onOpenEditor({
          mode: "anchors",
          pendingAction: {
            kind: "regenerate-phase",
            label: "Regenerate anchors",
            phase: 5,
            scope: "anchors",
          },
        }),
    },
    {
      label: "View anchor JSON",
      detail: "Open stored anchor artifacts",
      icon: <FileText className="h-4 w-4" aria-hidden />,
      href: assets.length > 0 && job ? `/api/videos/${job.id}/artifacts/anchors` : undefined,
      disabled: assets.length === 0 || !job,
    },
    {
      label: "Version history",
      detail: "Restore earlier anchor sets",
      icon: <History className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "versions" }),
    },
  ];

  return (
    <div className="bottom-panel anchors-panel">
      <div className="bottom-heading">
        <span>
          <ImageIcon className="h-4 w-4" aria-hidden />
          Anchors ({assets.length})
          {youPhotos.length > 0 ? " · You ✓" : ""}
        </span>
        <ActionMenu label="Anchor options" items={menuItems} placement="up" />
      </div>
      <div className="anchor-strip">
        <YouAnchorCard photos={youPhotos} onOpen={() => onOpenSeedDrawer("you")} />
        {assets.map((asset) => {
          const selected = previewSelection.kind === "anchor" && previewSelection.role === asset.role;
          return (
            <button
              key={asset.role}
              type="button"
              className={`anchor-thumb ${selected ? "is-selected" : ""}`}
              aria-pressed={selected}
              onClick={() => onPreviewSelect({ kind: "anchor", role: asset.role })}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={asset.url} alt={`${asset.role} anchor`} className="aspect-[9/16] w-full object-cover" />
              <div>{asset.role}</div>
            </button>
          );
        })}
        {assets.length === 0 ? (
          <>
            {(["style", "environment", "palette"] as const).map((role) => (
              <SeedTile
                key={role}
                role={role}
                label={role.charAt(0).toUpperCase() + role.slice(1)}
                seed={seedByRole[role]}
                onOpen={() => onOpenSeedDrawer(role)}
              />
            ))}
            <div className="anchor-thumb is-empty">
              <span>T</span>
              <div>Title</div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ShotsPanel({
  job,
  shots,
  previewSelection,
  onPreviewSelect,
  onRegenerate,
  onOpenEditor,
}: {
  job?: VideoJob;
  shots: GeneratedShot[];
  previewSelection: PreviewSelection;
  onPreviewSelect: (selection: PreviewSelection) => void;
  onRegenerate: (index: number) => void;
  onOpenEditor: (context: EditorContext) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(8);
  const firstShotIndex = shots[0]?.shotIndex ?? job?.shotPlan?.shots[0]?.shotIndex;
  const menuItems: ActionMenuItem[] = [
    {
      label: "Open shot editor",
      detail: "Inspect prompts, seeds, QA, and media",
      icon: <Clapperboard className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "shots", shotIndex: firstShotIndex }),
    },
    {
      label: "Regenerate shot set",
      detail: "Replaces generated shots and downstream QA/render",
      icon: <RefreshCcw className="h-4 w-4" aria-hidden />,
      disabled: !job?.shotPlan,
      onSelect: () =>
        onOpenEditor({
          mode: "shots",
          pendingAction: {
            kind: "regenerate-phase",
            label: "Regenerate all shots",
            phase: 7,
            scope: "shots",
          },
        }),
    },
    {
      label: "View shot plan",
      detail: "Open planned shot prompts",
      icon: <FileText className="h-4 w-4" aria-hidden />,
      href: job?.shotPlan ? `/api/videos/${job.id}/artifacts/shot-plan` : undefined,
      disabled: !job?.shotPlan,
    },
    {
      label: "View generated shots",
      detail: "Open rendered shot list",
      icon: <Film className="h-4 w-4" aria-hidden />,
      href: shots.length > 0 && job ? `/api/videos/${job.id}/artifacts/shots` : undefined,
      disabled: shots.length === 0 || !job,
    },
    {
      label: "Version history",
      detail: "Restore prior shot artifacts",
      icon: <History className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "versions" }),
    },
  ];

  return (
    <div className="bottom-panel shots-panel">
      <div className="bottom-heading">
        <span>
          <Clapperboard className="h-4 w-4" aria-hidden />
          Shots ({shots.length})
        </span>
        <ActionMenu label="Shot options" items={menuItems} placement="up" />
      </div>
      <div className="shot-table">
        {shots.slice(0, visibleCount).map((shot) => {
          const selected = previewSelection.kind === "shot" && previewSelection.shotIndex === shot.shotIndex;
          return (
            <div key={shot.shotIndex} className={`shot-row ${selected ? "is-selected" : ""}`}>
              <button
                type="button"
                className="shot-row-preview"
                aria-pressed={selected}
                onClick={() => onPreviewSelect({ kind: "shot", shotIndex: shot.shotIndex })}
              >
                <span className="font-mono text-xs text-muted">{formatShotNumber(shot.shotIndex)}</span>
                <div className="shot-miniature has-video">
                  <video src={shot.videoUrl} muted playsInline preload="metadata" aria-label={`Shot ${shot.shotIndex + 1} video preview`} />
                  <Clapperboard className="shot-miniature-icon h-3.5 w-3.5" aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">Shot {shot.shotIndex + 1}</div>
                  <div className="truncate text-xs text-muted">seed {shot.seed}</div>
                </div>
                <span className="font-mono text-xs text-muted">{shot.durationSeconds.toFixed(1)}s</span>
                <span className="font-mono text-xs text-accent">qa {shot.qaScore?.toFixed(2) ?? "-"}</span>
                <span className="font-mono text-xs text-muted">{shot.attempts}x</span>
              </button>
              <div className="shot-row-actions">
                <ActionMenu
                  label={`Shot ${shot.shotIndex + 1} options`}
                  placement="up"
                  items={[
                    {
                      label: "Open in editor",
                      detail: "Inspect this shot's prompt and result",
                      icon: <Clapperboard className="h-4 w-4" aria-hidden />,
                      onSelect: () => onOpenEditor({ mode: "shots", shotIndex: shot.shotIndex }),
                    },
                    {
                      label: "Regenerate shot",
                      detail: "Snapshots this shot before replacing it",
                      icon: <RefreshCcw className="h-4 w-4" aria-hidden />,
                      onSelect: () => onRegenerate(shot.shotIndex),
                    },
                    {
                      label: "Open shot video",
                      detail: "View current rendered clip",
                      icon: <ExternalLink className="h-4 w-4" aria-hidden />,
                      href: shot.videoUrl,
                    },
                  ]}
                />
              </div>
            </div>
          );
        })}
        {shots.length === 0
          ? Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="shot-row is-empty">
                <div className="shot-row-preview is-placeholder">
                  <span className="font-mono text-xs text-muted">{formatShotNumber(index)}</span>
                  <div className="shot-miniature" />
                  <div className="min-w-0">
                    <div className="h-2 w-36 rounded-full bg-line/70" />
                    <div className="mt-2 h-2 w-20 rounded-full bg-line/40" />
                  </div>
                  <span className="font-mono text-xs text-muted">--</span>
                  <span className="font-mono text-xs text-muted">qa --</span>
                  <span className="font-mono text-xs text-muted">--</span>
                </div>
                <span />
              </div>
            ))
          : null}
      </div>
      {shots.length > visibleCount ? (
        <button type="button" className="show-more-command" onClick={() => setVisibleCount((count) => count + 8)}>
          Show {Math.min(8, shots.length - visibleCount)} more shots
          <span>{visibleCount} of {shots.length}</span>
        </button>
      ) : null}
    </div>
  );
}

function MusicPanel({
  job,
  musicPlan,
  onOpenEditor,
}: {
  job?: VideoJob;
  musicPlan?: MusicPlan;
  onOpenEditor: (context: EditorContext) => void;
}) {
  const musicAudioRef = useRef<HTMLAudioElement>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const musicTrackUrl = job?.musicTrack?.url;
  const toggleMusic = () => {
    const element = musicAudioRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };
  const menuItems: ActionMenuItem[] = [
    {
      label: "Open music editor",
      detail: "Inspect composition, track, beat grid, sections",
      icon: <Music2 className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "music" }),
    },
    {
      label: "Regenerate music system",
      detail: "Rebuilds composition, audio, beat grid, and downstream timing",
      icon: <RefreshCcw className="h-4 w-4" aria-hidden />,
      disabled: !job?.creativeBrief,
      onSelect: () =>
        onOpenEditor({
          mode: "music",
          pendingAction: {
            kind: "regenerate-phase",
            label: "Regenerate music system",
            phase: 2,
            scope: "music",
          },
        }),
    },
    {
      label: "View music plan",
      detail: "Open composition JSON",
      icon: <FileText className="h-4 w-4" aria-hidden />,
      href: job?.musicPlan ? `/api/videos/${job.id}/artifacts/music-plan` : undefined,
      disabled: !job?.musicPlan,
    },
    {
      label: "View beat grid",
      detail: "Open timing grid JSON",
      icon: <SlidersHorizontal className="h-4 w-4" aria-hidden />,
      href: job?.beatGrid ? `/api/videos/${job.id}/artifacts/beat-grid` : undefined,
      disabled: !job?.beatGrid,
    },
    {
      label: "Version history",
      detail: "Restore prior music artifacts",
      icon: <History className="h-4 w-4" aria-hidden />,
      onSelect: () => onOpenEditor({ mode: "versions" }),
    },
  ];

  return (
    <div className="bottom-panel music-panel">
      <div className="bottom-heading">
        <span>
          <Music2 className="h-4 w-4" aria-hidden />
          Music & beat grid
        </span>
        <div className="flex items-center gap-2">
          <span className="toolbar-select">Grid</span>
          <ActionMenu label="Music options" items={menuItems} placement="up" />
        </div>
      </div>
      <div className="music-card">
        {musicPlan ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="icon-only"
                  aria-label={musicPlaying ? "Pause music" : "Preview music"}
                  onClick={toggleMusic}
                  disabled={!musicTrackUrl}
                >
                  {musicPlaying ? <Pause className="h-4 w-4" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />}
                </button>
                <div>
                  <div className="text-sm font-medium text-foreground">Composition plan</div>
                  <div className="text-xs text-muted">
                    {musicPlan.bpm} BPM · {musicPlan.key} · {musicPlan.voiceFamily ?? "vocal"}
                  </div>
                </div>
              </div>
              <StateBadge state="complete" compact />
            </div>
            <Waveform />
            {musicTrackUrl ? (
              <audio
                ref={musicAudioRef}
                src={musicTrackUrl}
                onPlay={() => setMusicPlaying(true)}
                onPause={() => setMusicPlaying(false)}
                onEnded={() => setMusicPlaying(false)}
                className="hidden"
              />
            ) : null}
          </>
        ) : null}
        {!musicPlan ? (
          <>
            <div className="flex items-center gap-2">
              <button type="button" className="icon-only" aria-label="Music preview" disabled>
                <Pause className="h-4 w-4" aria-hidden />
              </button>
              <div>
                <div className="text-sm font-medium text-foreground">Composition pending</div>
                <div className="text-xs text-muted">Beat grid will land after music render</div>
              </div>
            </div>
            <Waveform muted />
          </>
        ) : null}
      </div>
      <div className="section-map">
        {musicPlan?.sections.map((section) => (
          <div key={section.id} className="section-chip">
            <div className="section-chip-header">
              <span className="section-chip-title" title={section.id}>
                {section.id}
              </span>
              <span className="section-chip-duration">{section.durationSeconds}s</span>
            </div>
            <div className="mt-1 line-clamp-2 text-xs text-muted">{section.instrumentation}</div>
          </div>
        ))}
        {!musicPlan
          ? ["Intro", "Verse", "Pre", "Chorus", "Bridge"].map((label) => (
              <div key={label} className="section-chip is-empty">
                <span>{label}</span>
              </div>
            ))
          : null}
      </div>
    </div>
  );
}

function RenderAgentDrawer({
  job,
  context,
  busy,
  mediaLibrary,
  onClose,
  onOpenContext,
  onAddDirective,
  onRegeneratePhase,
  onRegenerateShot,
  onRestoreVersion,
  onCreateMediaGeneration,
  onInjectMediaGeneration,
  onSendAgentMessage,
}: {
  job?: VideoJob;
  context: EditorContext;
  busy: boolean;
  mediaLibrary: MediaLibraryState | null;
  onClose: () => void;
  onOpenContext: (context: EditorContext) => void;
  onAddDirective: (input: {
    scope: EditorScope;
    phase?: PhaseNumber;
    targetId?: string;
    text: string;
    strategy?: RegenerateStrategy;
    providerControls?: ProviderControls;
  }) => Promise<void>;
  onRegeneratePhase: (
    phase: PhaseNumber,
    target: { scope: EditorScope; phase?: PhaseNumber; targetId?: string },
    directiveText?: string,
    strategy?: RegenerateStrategy,
    providerControls?: ProviderControls,
  ) => Promise<void>;
  onRegenerateShot: (
    shotIndex: number,
    directiveText?: string,
    strategy?: RegenerateStrategy,
    providerControls?: ProviderControls,
  ) => Promise<void>;
  onRestoreVersion: (versionId: string) => Promise<void>;
  onCreateMediaGeneration: (input: MediaGenerationCreateRequest) => Promise<MediaGeneration | null>;
  onInjectMediaGeneration: (generationId: string, input: MediaGenerationInjectRequest) => Promise<void>;
  onSendAgentMessage: (message: string, input?: { selectedAssetIds?: string[]; shotIndex?: number }) => Promise<{ reply?: string; proposal?: RenderAgentProposal }>;
}) {
  const initialShotIndex = context.shotIndex ?? job?.generatedShots[0]?.shotIndex ?? job?.shotPlan?.shots[0]?.shotIndex;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<EditorPendingAction | null>(context.pendingAction ?? null);
  const [selectedShotIndex, setSelectedShotIndex] = useState<number | undefined>(initialShotIndex);
  const [copied, setCopied] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(context.startFullscreen));
  const [mediaDraft, setMediaDraft] = useState<{
    kind: MediaKind;
    prompt: string;
    controls: Record<string, unknown>;
  }>(() => ({
    kind: "image",
    prompt: job?.prompt ?? DEFAULT_PROMPT,
    controls: defaultMediaControls("image", job),
  }));
  const [pendingMedia, setPendingMedia] = useState<MediaGenerationCreateRequest | null>(null);
  const [selectedInputAssetIds, setSelectedInputAssetIds] = useState<string[]>([]);
  const [agentInput, setAgentInput] = useState("");
  const [agentMessages, setAgentMessages] = useState<Array<{ role: "agent" | "user"; text: string }>>([
    {
      role: "agent",
      text: "I can draft image, Seedance, music, or render commands here. Provider calls wait for your confirmation.",
    },
  ]);
  const [agentProposal, setAgentProposal] = useState<RenderAgentProposal | null>(null);

  const target = editorTargetForMode(context.mode, selectedShotIndex);
  const artifact = editorArtifact(job, context.mode, selectedShotIndex);
  const relatedDirectives = (job?.editDirectives ?? []).filter((directive) =>
    context.mode === "versions" ? true : directiveMatchesTarget(directive, target),
  );
  const relatedVersions = (job?.artifactVersions ?? [])
    .filter((version) => context.mode === "versions" || versionMatchesTarget(version, target))
    .slice()
    .reverse();
  const canEdit = Boolean(job && context.mode !== "versions");
  const phaseAction = defaultPhaseAction(context.mode);
  const availableInputAssetIds = useMemo(
    () => new Set((mediaLibrary?.assets ?? []).map((asset) => asset.id)),
    [mediaLibrary?.assets],
  );
  const selectedShot = selectedShotIndex !== undefined
    ? job?.shotPlan?.shots.find((shot) => shot.shotIndex === selectedShotIndex)
    : undefined;
  const generatedShot = selectedShotIndex !== undefined
    ? job?.generatedShots.find((shot) => shot.shotIndex === selectedShotIndex)
    : undefined;
  const providerDraftKey = `${context.mode}:${job?.id ?? "empty"}:${selectedShotIndex ?? "all"}`;
  const [providerDraft, setProviderDraft] = useState<{
    key: string;
    strategy: RegenerateStrategy;
    controls: ProviderControls;
  }>(() => ({
    key: providerDraftKey,
    strategy: defaultStrategyForMode(context.mode),
    controls: defaultProviderControlsForMode(context.mode, selectedShot, job),
  }));
  const activeProviderDraft = providerDraft.key === providerDraftKey
    ? providerDraft
    : {
        key: providerDraftKey,
        strategy: defaultStrategyForMode(context.mode),
        controls: defaultProviderControlsForMode(context.mode, selectedShot, job),
      };
  const strategy = activeProviderDraft.strategy;
  const providerControls = activeProviderDraft.controls;
  const setStrategy = (nextStrategy: RegenerateStrategy) =>
    setProviderDraft({ ...activeProviderDraft, strategy: nextStrategy });
  const setProviderControls = (nextControls: ProviderControls) =>
    setProviderDraft({ ...activeProviderDraft, controls: nextControls });
  const setMediaKind = (kind: MediaKind) =>
    setMediaDraft((current) => ({
      kind,
      prompt: current.prompt,
      controls: defaultMediaControls(kind, job),
    }));
  const setMediaControls = (controls: Record<string, unknown>) =>
    setMediaDraft((current) => ({ ...current, controls }));

  useEffect(() => {
    setSelectedInputAssetIds((current) => current.filter((assetId) => availableInputAssetIds.has(assetId)));
  }, [availableInputAssetIds]);

  async function saveDirective() {
    if (!canEdit || !draft.trim()) return;
    await onAddDirective({
      ...target,
      text: draft.trim(),
      strategy,
      providerControls,
    });
    setDraft("");
  }

  async function confirmPending() {
    if (!pending) return;
    if (pending.kind === "restore-version" && pending.versionId) {
      await onRestoreVersion(pending.versionId);
      setPending(null);
      return;
    }

    if (pending.kind === "regenerate-shot" && pending.shotIndex !== undefined) {
      await onRegenerateShot(pending.shotIndex, draft, strategy, providerControls);
      setDraft("");
      setPending(null);
      return;
    }

    if (pending.kind === "regenerate-phase" && pending.phase && pending.scope) {
      await onRegeneratePhase(
        pending.phase,
        {
          scope: pending.scope,
          phase: pending.phase,
          targetId: pending.shotIndex !== undefined ? String(pending.shotIndex) : undefined,
        },
        draft,
        strategy,
        providerControls,
      );
      setDraft("");
      setPending(null);
    }
  }

  async function confirmPendingMedia() {
    if (!pendingMedia) return;
    const generation = await onCreateMediaGeneration(pendingMedia);
    if (generation) {
      setAgentMessages((messages) => [
        ...messages,
        { role: "agent", text: `${generation.kind} generation ${generation.status}. It is now in the project media library.` },
      ]);
    }
    setPendingMedia(null);
  }

  function stageMediaGeneration(input?: Partial<MediaGenerationCreateRequest>) {
    if (!job) return;
    const inputAssetIds = input?.inputAssetIds ?? selectedInputAssetIds;
    const request: MediaGenerationCreateRequest = {
      kind: input?.kind ?? mediaDraft.kind,
      provider: input?.provider ?? providerForMediaKind(input?.kind ?? mediaDraft.kind),
      prompt: input?.prompt ?? mediaDraft.prompt,
      controls: input?.controls ?? mediaDraft.controls,
      inputAssetIds,
      videoJobId: job.id,
      execute: true,
      label: input?.label,
    };
    setPendingMedia(request);
  }

  async function sendAgent() {
    if (!agentInput.trim() || busy) return;
    const message = agentInput.trim();
    setAgentInput("");
    setAgentMessages((messages) => [...messages, { role: "user", text: message }]);
    try {
      const response = await onSendAgentMessage(message, {
        selectedAssetIds: selectedInputAssetIds,
        shotIndex: selectedShotIndex,
      });
      if (response.reply) {
        setAgentMessages((messages) => [...messages, { role: "agent", text: response.reply! }]);
      }
      if (response.proposal) {
        setAgentProposal(response.proposal);
        setMediaDraft({
          kind: response.proposal.kind,
          prompt: response.proposal.prompt,
          controls: response.proposal.controls,
        });
      }
    } catch (agentError) {
      setAgentMessages((messages) => [
        ...messages,
        { role: "agent", text: agentError instanceof Error ? agentError.message : "Cocoa Director could not respond." },
      ]);
    }
  }

  async function injectGeneration(generation: MediaGeneration, action: MediaGenerationInjectRequest["action"]) {
    if (!job) return;
    await onInjectMediaGeneration(generation.id, {
      videoJobId: job.id,
      action,
      role: mediaRoleForInjection(action),
      shotIndex: actionRequiresShot(action) ? selectedShotIndex ?? 0 : undefined,
    });
  }

  function toggleInputAsset(assetId: string) {
    setSelectedInputAssetIds((current) =>
      current.includes(assetId) ? current.filter((currentId) => currentId !== assetId) : [...current, assetId],
    );
  }

  async function copyUrl(label: string, url: string) {
    try {
      await navigator.clipboard?.writeText(url);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className={`editor-backdrop ${isFullscreen ? "is-fullscreen" : ""}`} role="presentation">
      <aside className={`editor-drawer ${isFullscreen ? "is-fullscreen" : ""}`} aria-label="Pipeline editor drawer">
        <div className="editor-header">
          <div>
            <span>{editorModeEyebrow(context.mode)}</span>
            <h2>{editorModeTitle(context.mode)}</h2>
          </div>
          <div className="editor-header-actions">
            <button
              type="button"
              className="icon-only"
              onClick={() => setIsFullscreen((current) => !current)}
              aria-label={isFullscreen ? "Exit full screen Pipeline Editor" : "Open full screen Pipeline Editor"}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
            </button>
            <button type="button" className="icon-only" onClick={onClose} aria-label="Close editor">
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="editor-tabs" role="tablist" aria-label="Editor contexts">
          {(["preview", "anchors", "shots", "music", "versions"] as EditorMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={context.mode === mode ? "is-active" : ""}
              onClick={() => onOpenContext({ mode, shotIndex: mode === "shots" ? selectedShotIndex : undefined })}
            >
              {mode === "preview" ? "Render" : mode}
            </button>
          ))}
        </div>

        <RenderAgentConsole
          job={job}
          busy={busy}
          isFullscreen={isFullscreen}
          mediaLibrary={mediaLibrary}
          mediaDraft={mediaDraft}
          selectedInputAssetIds={selectedInputAssetIds}
          agentInput={agentInput}
          agentMessages={agentMessages}
          agentProposal={agentProposal}
          selectedShotIndex={selectedShotIndex}
          onAgentInputChange={setAgentInput}
          onSendAgent={sendAgent}
          onMediaKindChange={setMediaKind}
          onMediaPromptChange={(promptValue) => setMediaDraft((current) => ({ ...current, prompt: promptValue }))}
          onMediaControlsChange={setMediaControls}
          onToggleInputAsset={toggleInputAsset}
          onClearInputAssets={() => setSelectedInputAssetIds([])}
          onStageMediaGeneration={stageMediaGeneration}
          onInjectGeneration={injectGeneration}
        />

        {pendingMedia ? (
          <section className="editor-confirm render-agent-confirm">
            <div className="editor-section-header">
              <div>
                <h3>Confirm {pendingMedia.kind} generation</h3>
                <p>{mediaBlastRadius(pendingMedia.kind)} Provider spend happens only after this confirmation.</p>
              </div>
              <AlertTriangle className="h-4 w-4 text-warm" aria-hidden />
            </div>
            <dl>
              <div>
                <dt>Provider</dt>
                <dd>{providerLabelForMediaKind(pendingMedia.kind)}</dd>
              </div>
              <div>
                <dt>Prompt</dt>
                <dd>{pendingMedia.prompt}</dd>
              </div>
              <div>
                <dt>Controls</dt>
                <dd>{compactJson(pendingMedia.controls)}</dd>
              </div>
              <div>
                <dt>Inputs</dt>
                <dd>{pendingMedia.inputAssetIds.length > 0 ? `${pendingMedia.inputAssetIds.length} selected asset${pendingMedia.inputAssetIds.length === 1 ? "" : "s"}` : "No project media inputs"}</dd>
              </div>
            </dl>
            <div className="editor-command-actions">
              <button type="button" className="ghost-command" disabled={busy} onClick={() => setPendingMedia(null)}>
                Cancel
              </button>
              <button type="button" className="primary-command" disabled={busy} onClick={confirmPendingMedia}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                Generate
              </button>
            </div>
          </section>
        ) : null}

        {!job ? (
          <div className="editor-empty">
            <Film className="h-5 w-5" aria-hidden />
            <span>Start a run to unlock project media generation and artifact injection.</span>
          </div>
        ) : (
          <>
            {context.mode === "shots" ? (
              <div className="editor-shot-strip" aria-label="Shot selector">
                {(job.shotPlan?.shots ?? job.generatedShots).map((shot) => {
                  const shotIndex = "shotIndex" in shot ? shot.shotIndex : 0;
                  return (
                    <button
                      key={shotIndex}
                      type="button"
                      className={selectedShotIndex === shotIndex ? "is-active" : ""}
                      onClick={() => setSelectedShotIndex(shotIndex)}
                    >
                      {String(shotIndex + 1).padStart(2, "0")}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {context.mode !== "versions" ? (
              <section className="editor-command">
                <div className="editor-section-header">
                  <div>
                    <h3>Edit instruction</h3>
                    <p>{editInstructionHint(context.mode, selectedShotIndex)}</p>
                  </div>
                  <StateBadge state={job.status} label={job.status} compact />
                </div>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={1200}
                  placeholder="Example: make the anchors more graphic, monochrome, and less photoreal."
                  aria-label="Edit instruction"
                />
                <RegenerateStrategyControl mode={context.mode} value={strategy} onChange={setStrategy} />
                <ProviderControlsEditor
                  mode={context.mode}
                  controls={providerControls}
                  selectedShot={selectedShot}
                  job={job}
                  onChange={setProviderControls}
                />
                <div className="editor-command-actions">
                  <button type="button" className="secondary-command" disabled={!draft.trim() || busy} onClick={saveDirective}>
                    <FileText className="h-4 w-4" aria-hidden />
                    Save instruction
                  </button>
                  {context.mode === "shots" && selectedShotIndex !== undefined ? (
                    <button
                      type="button"
                      className="secondary-command"
                      disabled={busy || (!selectedShot && !generatedShot)}
                      onClick={() =>
                        setPending({
                          kind: "regenerate-shot",
                          label: `Regenerate shot ${selectedShotIndex + 1}`,
                          shotIndex: selectedShotIndex,
                          phase: 7,
                          scope: "shots",
                        })
                      }
                    >
                      <RefreshCcw className="h-4 w-4" aria-hidden />
                      Regenerate shot
                    </button>
                  ) : null}
                  {phaseAction ? (
                    <button
                      type="button"
                      className="primary-command"
                      disabled={busy}
                      onClick={() => setPending(phaseAction)}
                    >
                      <Sparkles className="h-4 w-4" aria-hidden />
                      {phaseAction.label}
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {pending ? (
              <section className="editor-confirm">
                <div className="editor-section-header">
                  <div>
                    <h3>{pending.label}</h3>
                    <p>{pendingSummary(pending)}</p>
                  </div>
                  <AlertTriangle className="h-4 w-4 text-warm" aria-hidden />
                </div>
                <dl>
                  <div>
                    <dt>Blast radius</dt>
                    <dd>{blastRadius(pending)}</dd>
                  </div>
                  <div>
                    <dt>Cost risk</dt>
                    <dd>{costRisk(pending)}</dd>
                  </div>
                  <div>
                    <dt>Versioning</dt>
                    <dd>Current artifact is snapshotted before replacement.</dd>
                  </div>
                </dl>
                <div className="editor-command-actions">
                  <button type="button" className="ghost-command" disabled={busy} onClick={() => setPending(null)}>
                    Cancel
                  </button>
                  <button type="button" className="primary-command" disabled={busy} onClick={confirmPending}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCcw className="h-4 w-4" aria-hidden />}
                    Confirm
                  </button>
                </div>
              </section>
            ) : null}

            <section className="editor-section">
              <div className="editor-section-header">
                <div>
                  <h3>{artifact.label}</h3>
                  <p>{artifact.detail}</p>
                </div>
                {artifact.urls.length > 0 ? <span className="toolbar-select">{artifact.urls.length} URLs</span> : null}
              </div>
              {artifact.urls.length > 0 ? (
                <div className="editor-url-list">
                  {artifact.urls.map((url) => (
                    <div key={`${url.label}-${url.href}`}>
                      <span>{url.label}</span>
                      <button type="button" className="icon-only" onClick={() => copyUrl(url.label, url.href)} aria-label={`Copy ${url.label} URL`}>
                        <Copy className="h-4 w-4" aria-hidden />
                      </button>
                      <a className="icon-only" href={url.href} target="_blank" rel="noreferrer" aria-label={`Open ${url.label}`}>
                        <ExternalLink className="h-4 w-4" aria-hidden />
                      </a>
                    </div>
                  ))}
                  {copied ? <small>{copied} copied</small> : null}
                </div>
              ) : null}
              <pre className="editor-json">{safeJson(artifact.payload)}</pre>
            </section>

            <section className="editor-section">
              <div className="editor-section-header">
                <div>
                  <h3>Active instructions</h3>
                  <p>{relatedDirectives.length} scoped note{relatedDirectives.length === 1 ? "" : "s"}</p>
                </div>
              </div>
              <div className="editor-list">
                {relatedDirectives.slice(-5).reverse().map((directive) => (
                  <div key={directive.id} className="editor-list-row">
                    <div>
                      <strong>{directive.scope}</strong>
                      <p>{directive.text}</p>
                    </div>
                    <span>{directive.appliedAt ? "applied" : directive.status}</span>
                  </div>
                ))}
                {relatedDirectives.length === 0 ? <p className="editor-muted">No edit instructions saved for this scope yet.</p> : null}
              </div>
            </section>

            <section className="editor-section">
              <div className="editor-section-header">
                <div>
                  <h3>Versions</h3>
                  <p>{relatedVersions.length} retained artifact snapshot{relatedVersions.length === 1 ? "" : "s"}</p>
                </div>
              </div>
              <div className="editor-list">
                {relatedVersions.map((version) => (
                  <div key={version.id} className="editor-list-row">
                    <div>
                      <strong>{version.label}</strong>
                      <p>{version.scope}{version.targetId ? ` · target ${version.targetId}` : ""} · {formatClock(version.createdAt)}</p>
                    </div>
                    <button
                      type="button"
                      className="ghost-command"
                      disabled={busy}
                      onClick={() =>
                        setPending({
                          kind: "restore-version",
                          label: `Restore ${version.label}`,
                          versionId: version.id,
                          scope: version.scope,
                          phase: version.phase,
                        })
                      }
                    >
                      <History className="h-4 w-4" aria-hidden />
                      Restore
                    </button>
                  </div>
                ))}
                {relatedVersions.length === 0 ? <p className="editor-muted">Snapshots appear here before regenerate or restore actions.</p> : null}
              </div>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function RenderAgentConsole({
  job,
  busy,
  isFullscreen,
  mediaLibrary,
  mediaDraft,
  selectedInputAssetIds,
  agentInput,
  agentMessages,
  agentProposal,
  selectedShotIndex,
  onAgentInputChange,
  onSendAgent,
  onMediaKindChange,
  onMediaPromptChange,
  onMediaControlsChange,
  onToggleInputAsset,
  onClearInputAssets,
  onStageMediaGeneration,
  onInjectGeneration,
}: {
  job?: VideoJob;
  busy: boolean;
  isFullscreen: boolean;
  mediaLibrary: MediaLibraryState | null;
  mediaDraft: { kind: MediaKind; prompt: string; controls: Record<string, unknown> };
  selectedInputAssetIds: string[];
  agentInput: string;
  agentMessages: Array<{ role: "agent" | "user"; text: string }>;
  agentProposal: RenderAgentProposal | null;
  selectedShotIndex?: number;
  onAgentInputChange: (value: string) => void;
  onSendAgent: () => Promise<void>;
  onMediaKindChange: (kind: MediaKind) => void;
  onMediaPromptChange: (value: string) => void;
  onMediaControlsChange: (value: Record<string, unknown>) => void;
  onToggleInputAsset: (assetId: string) => void;
  onClearInputAssets: () => void;
  onStageMediaGeneration: (input?: Partial<MediaGenerationCreateRequest>) => void;
  onInjectGeneration: (generation: MediaGeneration, action: MediaGenerationInjectRequest["action"]) => Promise<void>;
}) {
  const generations = mediaLibrary?.generations ?? [];
  const assets = mediaLibrary?.assets ?? [];
  const selectedInputAssets = assets.filter((asset) => selectedInputAssetIds.includes(asset.id));
  const inputReferenceHint = mediaInputReferenceHint(mediaDraft.kind, selectedInputAssets.length);

  return (
    <section className={`render-agent-console ${isFullscreen ? "is-fullscreen" : ""}`}>
      <div className="render-agent-panel agent-chat-panel">
        <div className="editor-section-header">
          <div>
            <h3>Cocoa Director</h3>
            <p>Draft commands, inspect context, and stage confirmed media or pipeline work.</p>
          </div>
          <StateBadge state={job?.status ?? "pending"} label={job ? "context" : "idle"} compact />
        </div>
        <div className="agent-message-list">
          {agentMessages.slice(-5).map((message, index) => (
            <div key={`${message.role}-${index}`} className={`agent-message is-${message.role}`}>
              {message.text}
            </div>
          ))}
        </div>
        <div className="agent-input-row">
          <textarea
            value={agentInput}
            onChange={(event) => onAgentInputChange(event.target.value)}
            placeholder="Ask for a render: make a red-sun ink anchor, rebuild shot 3 with slower camera, or draft a darker bridge section."
            aria-label="Cocoa Director message"
          />
          <button type="button" className="primary-command" disabled={busy || !agentInput.trim() || !job} onClick={onSendAgent}>
            <Send className="h-4 w-4" aria-hidden />
            Ask
          </button>
        </div>
        {agentProposal ? (
          <div className="agent-proposal">
            <strong>{agentProposal.title}</strong>
            <p>{agentProposal.rationale}</p>
            <button
              type="button"
              className="secondary-command"
              disabled={busy || !job}
              onClick={() =>
                onStageMediaGeneration({
                  kind: agentProposal.kind,
                  provider: agentProposal.provider,
                  prompt: agentProposal.prompt,
                  controls: agentProposal.controls,
                  inputAssetIds: agentProposal.inputAssetIds,
                  label: agentProposal.title,
                })
              }
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              Stage proposal
            </button>
          </div>
        ) : null}
      </div>

      <div className="render-agent-panel media-composer-panel">
        <div className="editor-section-header">
          <div>
            <h3>Media lab render</h3>
            <p>Generate project media first, then explicitly inject chosen results into the video.</p>
          </div>
        </div>
        <div className="media-kind-tabs" role="tablist" aria-label="Media render type">
          {(["image", "video", "music", "render"] as MediaKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className={mediaDraft.kind === kind ? "is-active" : ""}
              onClick={() => onMediaKindChange(kind)}
            >
              {mediaKindIcon(kind)}
              <span>{kind}</span>
            </button>
          ))}
        </div>
        <div className="media-input-strip" aria-label="Selected render inputs">
          <div className="media-input-strip-heading">
            <span>Input references</span>
            <small>{inputReferenceHint}</small>
          </div>
          {selectedInputAssets.length > 0 ? (
            <>
              <div className="media-input-chip-list">
                {selectedInputAssets.map((asset) => (
                  <button
                    key={asset.id}
                    type="button"
                    className="media-input-chip"
                    onClick={() => onToggleInputAsset(asset.id)}
                    title={`Remove ${asset.role} reference`}
                  >
                    {mediaKindIcon(asset.kind)}
                    <span>{asset.role}</span>
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ))}
              </div>
              <button type="button" className="ghost-command media-clear-inputs" onClick={onClearInputAssets}>
                Clear inputs
              </button>
            </>
          ) : (
            <p>Select successful media below to feed image edits, Seedance references, music/video inspiration, or render manifests.</p>
          )}
        </div>
        <label className="provider-field provider-field-wide">
          <span>Prompt / command</span>
          <textarea
            value={mediaDraft.prompt}
            maxLength={2000}
            onChange={(event) => onMediaPromptChange(event.target.value)}
          />
        </label>
        <MediaProviderControlsEditor
          kind={mediaDraft.kind}
          controls={mediaDraft.controls}
          job={job}
          onChange={onMediaControlsChange}
        />
        <div className="editor-command-actions">
          <button
            type="button"
            className="primary-command"
            title={!job ? "Start or stage a run before creating project media." : undefined}
            disabled={busy || !job || !mediaDraft.prompt.trim()}
            onClick={() => onStageMediaGeneration()}
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            Stage {mediaDraft.kind}
          </button>
        </div>
      </div>

      <div className="render-agent-panel media-library-panel">
        <div className="editor-section-header">
          <div>
            <h3>Project media</h3>
            <p>{generations.length} generation{generations.length === 1 ? "" : "s"} · {assets.length} asset{assets.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div className="media-library-list">
          {generations.slice(0, isFullscreen ? 10 : 4).map((generation) => {
            const asset = primaryAssetForMediaGeneration(assets, generation);
            const isSelectedInput = Boolean(asset && selectedInputAssetIds.includes(asset.id));
            return (
              <div key={generation.id} className="media-generation-row">
                <MediaAssetPreview asset={asset} fallbackKind={generation.kind} />
                <div className="min-w-0">
                  <div className="media-generation-title">
                    <strong>{generationLabel(generation)}</strong>
                    <StateBadge state={generation.status === "failed" ? "failed" : generation.status === "success" ? "complete" : generation.status === "running" ? "running" : "pending"} label={generation.status} compact />
                  </div>
                  <p>{generation.prompt}</p>
                  {asset ? (
                    <small className="media-asset-meta">{asset.kind} · {asset.role}</small>
                  ) : null}
                  <div className="media-generation-actions">
                    {asset ? (
                      <button
                        type="button"
                        className={`ghost-command ${isSelectedInput ? "is-selected" : ""}`}
                        disabled={busy || generation.status !== "success"}
                        onClick={() => onToggleInputAsset(asset.id)}
                      >
                        {isSelectedInput ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                        {isSelectedInput ? "Input selected" : "Use as input"}
                      </button>
                    ) : null}
                    {asset && generation.status === "success" ? (
                      <a
                        className="ghost-command"
                        href={mediaGenerationDownloadUrl(generation)}
                        download={mediaGenerationDownloadFileName(generation.kind, generation.id, asset.mimeType)}
                      >
                        <Download className="h-4 w-4" aria-hidden />
                        Download
                      </a>
                    ) : null}
                    {mediaActionsForGeneration(generation, selectedShotIndex).map((action) => (
                      <button
                        key={action}
                        type="button"
                        className="ghost-command"
                        disabled={busy || !job || generation.status !== "success"}
                        onClick={() => onInjectGeneration(generation, action)}
                      >
                        {mediaInjectionLabel(action)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {generations.length === 0 ? (
            <p className="editor-muted">Confirmed individual renders will appear here with input and injection actions before they are used in the pipeline.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function MediaProviderControlsEditor({
  kind,
  controls,
  job,
  onChange,
}: {
  kind: MediaKind;
  controls: Record<string, unknown>;
  job?: VideoJob;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const update = (key: string, value: unknown) => onChange({ ...controls, [key]: value });

  if (kind === "image") {
    return (
      <div className="provider-control-block">
        <div className="provider-control-title">
          <span>OpenAI image controls</span>
          <small>{PROVIDER_CAPABILITIES.anchors.provider}</small>
        </div>
        <div className="provider-control-grid">
          <SelectControl label="Role" value={String(controls.role ?? "style")} options={anchorRoleOptions} onChange={(value) => update("role", value)} />
          <SelectControl label="Size" value={String(controls.size ?? "1024x1536")} options={PROVIDER_CAPABILITIES.anchors.sizes} onChange={(value) => update("size", value)} />
          <SelectControl label="Quality" value={String(controls.quality ?? "high")} options={PROVIDER_CAPABILITIES.anchors.qualities} onChange={(value) => update("quality", value)} />
          <SelectControl label="Format" value={String(controls.outputFormat ?? "png")} options={PROVIDER_CAPABILITIES.anchors.outputFormats} onChange={(value) => update("outputFormat", value)} />
        </div>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="provider-control-block">
        <div className="provider-control-title">
          <span>Seedance controls</span>
          <small>{PROVIDER_CAPABILITIES.shots.provider}</small>
        </div>
        <div className="provider-control-grid">
          <SelectControl label="Mode" value={String(controls.seedanceMode ?? "reference-to-video")} options={PROVIDER_CAPABILITIES.shots.modes} onChange={(value) => update("seedanceMode", value)} />
          <SelectControl label="Tier" value={String(controls.seedanceTier ?? "standard")} options={PROVIDER_CAPABILITIES.shots.tiers} onChange={(value) => update("seedanceTier", value)} />
          <SelectControl label="Resolution" value={String(controls.resolution ?? "720p")} options={PROVIDER_CAPABILITIES.shots.resolutions} onChange={(value) => update("resolution", value)} />
          <SelectControl label="Aspect" value={String(controls.aspectRatio ?? job?.aspectRatio ?? "9:16")} options={PROVIDER_CAPABILITIES.shots.aspectRatios} onChange={(value) => update("aspectRatio", value)} />
          <NumberControl label="Seconds" value={numberControlValue(controls.durationSeconds, 8)} min={4} max={15} onChange={(value) => update("durationSeconds", value)} />
          <SelectControl label="Seed" value={String(controls.seedMode ?? "randomize")} options={seedModeOptions} onChange={(value) => update("seedMode", value)} />
        </div>
        <ToggleControl label="Generate Seedance audio" detail="Off by default so ElevenLabs remains the soundtrack owner." checked={Boolean(controls.generateAudio)} onChange={(value) => update("generateAudio", value)} />
      </div>
    );
  }

  if (kind === "music") {
    const musicControlsValue: MusicControls = {
      ...DEFAULT_MUSIC_CONTROLS,
      ...((controls.musicControls as Partial<MusicControls>) ?? {}),
    };
    return (
      <div className="provider-control-block">
        <MusicConsole
          density="full"
          value={musicControlsValue}
          onChange={(next) => onChange({ ...controls, musicControls: next })}
        />
        <div className="provider-control-title">
          <span>ElevenLabs controls (advanced)</span>
          <small>{PROVIDER_CAPABILITIES.music.provider}</small>
        </div>
        <div className="provider-control-grid">
          <SelectControl label="Format" value={String(controls.outputFormat ?? "mp3_44100_192")} options={PROVIDER_CAPABILITIES.music.outputFormats} onChange={(value) => update("outputFormat", value)} />
          <NumberControl label="Seconds" value={numberControlValue(controls.durationSeconds, job?.durationSeconds ?? 60)} min={12} max={120} onChange={(value) => update("durationSeconds", value)} />
          <NumberControl label="BPM" value={numberControlValue(controls.bpm, job?.musicPlan?.bpm ?? 124)} min={60} max={180} onChange={(value) => update("bpm", value)} />
          <TextControl label="Global style" value={String(controls.globalStyle ?? "")} placeholder="cleaner synth pulse, wider low end" onChange={(value) => update("globalStyle", value.trim() || undefined)} />
        </div>
        <ToggleControl label="Strict section timing" detail="Respect the current composition plan when one exists." checked={controls.respectSectionDurations !== false} onChange={(value) => update("respectSectionDurations", value)} />
        <ToggleControl label="Return timestamps" detail="Ask for timestamps when lyrics exist." checked={Boolean(controls.withTimestamps)} onChange={(value) => update("withTimestamps", value)} />
      </div>
    );
  }

  return (
    <div className="provider-control-block">
      <div className="provider-control-title">
        <span>Render controls</span>
        <small>{PROVIDER_CAPABILITIES.render.provider}</small>
      </div>
      <div className="provider-capability-note">Standalone render commands are recorded in the media library. Final MP4 rendering still uses the canonical manifest path.</div>
    </div>
  );
}

type EditorTarget = { scope: EditorScope; phase?: PhaseNumber; targetId?: string };
type EditorArtifact = {
  label: string;
  detail: string;
  payload: unknown;
  urls: Array<{ label: string; href: string }>;
};

function RegenerateStrategyControl({
  mode,
  value,
  onChange,
}: {
  mode: EditorMode;
  value: RegenerateStrategy;
  onChange: (value: RegenerateStrategy) => void;
}) {
  const options = strategyOptionsForMode(mode);
  if (options.length <= 1) return null;
  return (
    <div className="provider-control-block">
      <div className="provider-control-title">
        <span>Regenerate strategy</span>
        <small>{providerLabelForMode(mode)}</small>
      </div>
      <div className="provider-segmented" role="radiogroup" aria-label="Regenerate strategy">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "is-active" : ""}
            onClick={() => onChange(option.value)}
            title={option.detail}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProviderControlsEditor({
  mode,
  controls,
  selectedShot,
  job,
  onChange,
}: {
  mode: EditorMode;
  controls: ProviderControls;
  selectedShot?: Shot;
  job: VideoJob;
  onChange: (value: ProviderControls) => void;
}) {
  if (mode === "anchors") {
    const anchorControls = controls.anchors ?? {};
    const update = <K extends keyof NonNullable<ProviderControls["anchors"]>>(
      key: K,
      value: NonNullable<ProviderControls["anchors"]>[K],
    ) => onChange({ ...controls, anchors: { ...anchorControls, [key]: value } });
    return (
      <div className="provider-control-block">
        <div className="provider-control-title">
          <span>Provider controls</span>
          <small>{PROVIDER_CAPABILITIES.anchors.provider}</small>
        </div>
        <div className="provider-control-grid">
          <SelectControl
            label="Size"
            value={anchorControls.size ?? "1024x1536"}
            options={PROVIDER_CAPABILITIES.anchors.sizes}
            onChange={(value) => update("size", value as NonNullable<ProviderControls["anchors"]>["size"])}
          />
          <SelectControl
            label="Quality"
            value={anchorControls.quality ?? "high"}
            options={PROVIDER_CAPABILITIES.anchors.qualities}
            onChange={(value) => update("quality", value as NonNullable<ProviderControls["anchors"]>["quality"])}
          />
          <SelectControl
            label="Format"
            value={anchorControls.outputFormat ?? "png"}
            options={PROVIDER_CAPABILITIES.anchors.outputFormats}
            onChange={(value) => update("outputFormat", value as NonNullable<ProviderControls["anchors"]>["outputFormat"])}
          />
          <NumberControl
            label="Variants"
            value={anchorControls.variantCount ?? 1}
            min={1}
            max={4}
            onChange={(value) => update("variantCount", value)}
          />
        </div>
      </div>
    );
  }

  if (mode === "shots") {
    const shotControls = controls.shots ?? {};
    const update = <K extends keyof NonNullable<ProviderControls["shots"]>>(
      key: K,
      value: NonNullable<ProviderControls["shots"]>[K],
    ) => onChange({ ...controls, shots: { ...shotControls, [key]: value } });
    return (
      <div className="provider-control-block">
        <div className="provider-control-title">
          <span>Provider controls</span>
          <small>{PROVIDER_CAPABILITIES.shots.provider}</small>
        </div>
        <div className="provider-control-grid">
          <SelectControl
            label="Mode"
            value={shotControls.seedanceMode ?? selectedShot?.seedanceMode ?? "reference-to-video"}
            options={PROVIDER_CAPABILITIES.shots.modes}
            onChange={(value) => update("seedanceMode", value as NonNullable<ProviderControls["shots"]>["seedanceMode"])}
          />
          <SelectControl
            label="Tier"
            value={shotControls.seedanceTier ?? selectedShot?.seedanceTier ?? "standard"}
            options={PROVIDER_CAPABILITIES.shots.tiers}
            onChange={(value) => update("seedanceTier", value as NonNullable<ProviderControls["shots"]>["seedanceTier"])}
          />
          <SelectControl
            label="Resolution"
            value={shotControls.resolution ?? selectedShot?.resolution ?? "720p"}
            options={PROVIDER_CAPABILITIES.shots.resolutions}
            onChange={(value) => update("resolution", value as NonNullable<ProviderControls["shots"]>["resolution"])}
          />
          <SelectControl
            label="Aspect"
            value={shotControls.aspectRatio ?? job.aspectRatio}
            options={PROVIDER_CAPABILITIES.shots.aspectRatios}
            onChange={(value) => update("aspectRatio", value as NonNullable<ProviderControls["shots"]>["aspectRatio"])}
          />
          <NumberControl
            label="Seconds"
            value={shotControls.durationSeconds ?? selectedShotDuration(selectedShot)}
            min={4}
            max={15}
            onChange={(value) => update("durationSeconds", value)}
          />
          <NumberControl
            label="References"
            value={shotControls.referenceImageLimit ?? Math.max(1, selectedShot?.referenceImages.length ?? 3)}
            min={1}
            max={9}
            onChange={(value) => update("referenceImageLimit", value)}
          />
          <SelectControl
            label="Seed"
            value={shotControls.seedMode ?? "lock"}
            options={[
              { value: "lock", label: "Lock" },
              { value: "randomize", label: "Random" },
            ]}
            onChange={(value) => update("seedMode", value as NonNullable<ProviderControls["shots"]>["seedMode"])}
          />
          <NumberControl
            label="Seed value"
            value={shotControls.seed ?? selectedShot?.seed ?? 0}
            min={0}
            max={2_147_483_647}
            disabled={(shotControls.seedMode ?? "lock") === "randomize"}
            onChange={(value) => update("seed", value)}
          />
        </div>
        <ToggleControl
          label="Generate Seedance audio"
          detail="Off by default so ElevenLabs remains the soundtrack owner."
          checked={Boolean(shotControls.generateAudio)}
          onChange={(value) => update("generateAudio", value)}
        />
      </div>
    );
  }

  if (mode === "music") {
    const musicControls = controls.music ?? {};
    const update = <K extends keyof NonNullable<ProviderControls["music"]>>(
      key: K,
      value: NonNullable<ProviderControls["music"]>[K],
    ) => onChange({ ...controls, music: { ...musicControls, [key]: value } });
    type SectionEdit = NonNullable<NonNullable<ProviderControls["music"]>["sectionEdits"]>[number];
    const sectionEdits = musicControls.sectionEdits ?? [];
    const editForSection = (id: string) => sectionEdits.find((section) => section.id === id);
    const updateSection = (id: string, patch: Partial<SectionEdit>) => {
      const existing = editForSection(id);
      const nextEdit = { id, ...existing, ...patch };
      const nextSections = existing
        ? sectionEdits.map((section) => (section.id === id ? nextEdit : section))
        : [...sectionEdits, nextEdit];
      update("sectionEdits", nextSections);
    };
    return (
      <div className="provider-control-block">
        <div className="provider-control-title">
          <span>Provider controls</span>
          <small>{PROVIDER_CAPABILITIES.music.provider}</small>
        </div>
        <div className="provider-control-grid">
          <SelectControl
            label="Format"
            value={musicControls.outputFormat ?? "mp3_44100_192"}
            options={PROVIDER_CAPABILITIES.music.outputFormats}
            onChange={(value) => update("outputFormat", value as NonNullable<ProviderControls["music"]>["outputFormat"])}
          />
          <NumberControl
            label="Seed"
            value={musicControls.seed ?? 0}
            min={0}
            max={2_147_483_647}
            onChange={(value) => update("seed", value === 0 ? undefined : value)}
          />
          <TextControl
            label="Global style"
            value={musicControls.globalStyle ?? ""}
            placeholder="e.g. cleaner synth pulse, wider low end"
            onChange={(value) => update("globalStyle", value.trim() || undefined)}
          />
          <TextControl
            label="Avoid style"
            value={musicControls.negativeStyle ?? ""}
            placeholder="e.g. no muddy mix, no bright pop sheen"
            onChange={(value) => update("negativeStyle", value.trim() || undefined)}
          />
        </div>
        {job.musicPlan?.sections.length ? (
          <div className="provider-section-list" aria-label="Music section controls">
            {job.musicPlan.sections.map((section) => {
              const edit = editForSection(section.id);
              return (
                <div key={section.id} className="provider-section-row">
                  <div className="provider-section-heading">
                    <strong>{section.id}</strong>
                    <span>{section.durationSeconds}s · energy {section.energy.toFixed(2)}</span>
                  </div>
                  <NumberControl
                    label="Seconds"
                    value={edit?.durationSeconds ?? section.durationSeconds}
                    min={4}
                    max={120}
                    onChange={(value) => updateSection(section.id, { durationSeconds: value })}
                  />
                  <TextControl
                    label="Local style"
                    value={edit?.localStyle ?? ""}
                    placeholder={section.instrumentation}
                    onChange={(value) => updateSection(section.id, { localStyle: value.trim() || undefined })}
                  />
                  <TextControl
                    label="Avoid"
                    value={edit?.negativeStyle ?? ""}
                    placeholder="section-specific negatives"
                    onChange={(value) => updateSection(section.id, { negativeStyle: value.trim() || undefined })}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
        <ToggleControl
          label="Strict section timing"
          detail="Preserve the current composition plan section durations."
          checked={musicControls.respectSectionDurations ?? true}
          onChange={(value) => update("respectSectionDurations", value)}
        />
        <ToggleControl
          label="Return timestamps"
          detail="Ask ElevenLabs for word timestamps when lyrics are present."
          checked={Boolean(musicControls.withTimestamps)}
          onChange={(value) => update("withTimestamps", value)}
        />
        <ToggleControl
          label="Store for inpainting"
          detail="Enterprise-only ElevenLabs capability."
          checked={Boolean(musicControls.storeForInpainting)}
          onChange={(value) => update("storeForInpainting", value)}
        />
        <ToggleControl
          label="Request stems"
          detail="Stores the intent for a follow-up stem separation pass."
          checked={Boolean(musicControls.requestStems)}
          onChange={(value) => update("requestStems", value)}
        />
        <div className="provider-capability-note">Stem separation is available through ElevenLabs and should become a post-render action, not part of normal composition regeneration.</div>
      </div>
    );
  }

  if (mode === "preview") {
    return (
      <div className="provider-control-block">
        <div className="provider-control-title">
          <span>Provider controls</span>
          <small>{PROVIDER_CAPABILITIES.render.provider}</small>
        </div>
        <div className="provider-capability-note">Render regeneration reuses the current manifest until upstream anchors, shots, or music are replaced.</div>
      </div>
    );
  }

  return null;
}

function SelectControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string; detail?: string; disabled?: boolean }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="provider-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} title={options.find((option) => option.value === value)?.detail}>
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NumberControl({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="provider-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(clampNumber(event.target.valueAsNumber, min, max))}
      />
    </label>
  );
}

function TextControl({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="provider-field provider-field-wide">
      <span>{label}</span>
      <textarea
        value={value}
        maxLength={220}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ToggleControl({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="provider-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

const anchorRoleOptions = [
  { value: "style", label: "Style" },
  { value: "environment", label: "Environment" },
  { value: "palette", label: "Palette" },
  { value: "character", label: "Character" },
  { value: "title", label: "Title" },
];

const seedModeOptions = [
  { value: "randomize", label: "Random" },
  { value: "lock", label: "Lock" },
];

function defaultMediaControls(kind: MediaKind, job?: VideoJob): Record<string, unknown> {
  if (kind === "image") {
    return {
      model: "gpt-image-2",
      role: "style",
      size: "1024x1536",
      quality: "high",
      outputFormat: "png",
    };
  }
  if (kind === "video") {
    return {
      seedanceMode: "reference-to-video",
      seedanceTier: "standard",
      durationSeconds: 8,
      aspectRatio: job?.aspectRatio ?? "9:16",
      resolution: "720p",
      seedMode: "randomize",
      generateAudio: false,
    };
  }
  if (kind === "music") {
    return {
      outputFormat: "mp3_44100_192",
      durationSeconds: job?.durationSeconds ?? 60,
      bpm: job?.musicPlan?.bpm ?? 124,
      respectSectionDurations: true,
      withTimestamps: false,
      musicControls: DEFAULT_MUSIC_CONTROLS,
    };
  }
  return {};
}

function providerForMediaKind(kind: MediaKind): MediaProvider {
  if (kind === "image") return "openai";
  if (kind === "video") return "fal";
  if (kind === "music") return "elevenlabs";
  return "vercel-render";
}

function triggerBrowserDownload(url: string, fileName?: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName ?? "";
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function directorOutputFromGeneration(generation: MediaGeneration, asset?: MediaAsset, fallbackLabel?: string): DirectorOutput {
  const url = asset?.url ?? Object.values(generation.outputUrls)[0];
  const mimeType = asset?.mimeType ?? mimeTypeForMediaKind(generation.kind);
  const isDownloadable = generation.status === "success" && Boolean(url);
  return {
    id: generation.id,
    kind: generation.kind,
    status: generation.status,
    provider: generation.provider,
    label: fallbackLabel ?? generationLabel(generation),
    prompt: generation.prompt,
    url,
    downloadUrl: isDownloadable ? mediaGenerationDownloadUrl(generation) : undefined,
    fileName: isDownloadable ? mediaGenerationDownloadFileName(generation.kind, generation.id, mimeType) : undefined,
    mimeType,
    queueStatus: mediaGenerationQueueStatus(generation),
    requestId: generation.requestId,
    error: generation.error,
    createdAt: generation.createdAt,
    updatedAt: generation.updatedAt,
  };
}

function directorOutputsMatch(left: DirectorOutput, right: DirectorOutput) {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.status === right.status &&
    left.provider === right.provider &&
    left.label === right.label &&
    left.prompt === right.prompt &&
    left.url === right.url &&
    left.downloadUrl === right.downloadUrl &&
    left.fileName === right.fileName &&
    left.mimeType === right.mimeType &&
    left.queueStatus === right.queueStatus &&
    left.requestId === right.requestId &&
    left.error === right.error &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function directorOutputStatusDetail(output: DirectorOutput) {
  if (output.status === "queued" || output.status === "running") {
    const provider = output.provider === "fal" ? "Seedance" : providerLabelForMediaKind(output.kind);
    const request = output.requestId ? ` Request ${output.requestId.slice(0, 10)}.` : "";
    const checked = output.updatedAt ? ` Last checked ${formatClock(output.updatedAt)}.` : "";
    return `${provider} is ${output.status}; Cocoa Director checks every few seconds and will attach the clip here when ready.${request}${checked}`;
  }
  if (output.status === "failed") {
    return output.error ?? "The provider did not return a usable output.";
  }
  return null;
}

function mediaGenerationQueueStatus(generation: MediaGeneration) {
  const explicitStatus = generation.metadata.queueStatus;
  if (typeof explicitStatus === "string") return explicitStatus;
  const submission = generation.metadata.seedanceSubmission;
  if (submission && typeof submission === "object" && "queueStatus" in submission) {
    const queueStatus = (submission as { queueStatus?: unknown }).queueStatus;
    return typeof queueStatus === "string" ? queueStatus : undefined;
  }
  return undefined;
}

function normalizedDirectorMediaControls(
  kind: MediaKind,
  controls: Record<string, unknown> | undefined,
  hasInputAssets: boolean,
  prompt: string,
) {
  const next = { ...(controls ?? {}) };
  if (kind !== "video") return next;
  if (!hasInputAssets && next.seedanceMode === "reference-to-video") {
    next.seedanceMode = "text-to-video";
  }
  if (next.generateAudio === undefined && wantsVideoAudio(prompt)) {
    next.generateAudio = true;
  }
  return next;
}

function wantsVideoAudio(prompt: string) {
  return /\b(audio|sound|soundtrack|score|music|musical|song|dialogue|ambient|ambience|background)\b/i.test(prompt);
}

function mediaGenerationDownloadUrl(generation: Pick<MediaGeneration, "projectId" | "id">) {
  return `/api/projects/${generation.projectId}/media/generations/${generation.id}/download`;
}

function mediaGenerationDownloadFileName(kind: MediaKind, generationId: string, mimeType?: string) {
  return `cocoa-director-${kind}-${generationId.slice(0, 8)}.${extensionForMimeType(mimeType, kind)}`;
}

function extensionForMimeType(mimeType: string | undefined, kind: MediaKind) {
  const normalized = mimeType ?? "";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("quicktime")) return "mov";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mp4")) return kind === "music" ? "m4a" : "mp4";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (kind === "image") return "png";
  if (kind === "video" || kind === "render") return "mp4";
  if (kind === "music") return "mp3";
  return "bin";
}

function mimeTypeForMediaKind(kind: MediaKind) {
  if (kind === "image") return "image/png";
  if (kind === "music") return "audio/mpeg";
  if (kind === "video" || kind === "render") return "video/mp4";
  return "application/octet-stream";
}

function providerLabelForMediaKind(kind: MediaKind) {
  if (kind === "image") return PROVIDER_CAPABILITIES.anchors.provider;
  if (kind === "video") return PROVIDER_CAPABILITIES.shots.provider;
  if (kind === "music") return PROVIDER_CAPABILITIES.music.provider;
  return PROVIDER_CAPABILITIES.render.provider;
}

function mediaKindIcon(kind: MediaKind) {
  if (kind === "image") return <ImageIcon className="h-4 w-4" aria-hidden />;
  if (kind === "video") return <Clapperboard className="h-4 w-4" aria-hidden />;
  if (kind === "music") return <Music2 className="h-4 w-4" aria-hidden />;
  return <Film className="h-4 w-4" aria-hidden />;
}

function MediaAssetPreview({ asset, fallbackKind }: { asset?: MediaAsset; fallbackKind: MediaKind }) {
  if (asset?.kind === "image") {
    return (
      <div className="media-generation-thumb is-media">
        {/* eslint-disable-next-line @next/next/no-img-element -- Media lab previews use arbitrary project/provider URLs. */}
        <img src={asset.url} alt={`${asset.role} media asset`} />
      </div>
    );
  }

  if (asset?.kind === "video") {
    return (
      <div className="media-generation-thumb is-media">
        <video src={asset.url} muted playsInline preload="metadata" aria-label={`${asset.role} media clip`} />
      </div>
    );
  }

  if (asset?.kind === "music") {
    return (
      <div className="media-generation-thumb is-audio" aria-label={`${asset.role} audio asset`}>
        {[0.35, 0.72, 0.52, 0.9, 0.6].map((scale, index) => (
          <span key={`${asset.id}-${index}`} style={{ transform: `scaleY(${scale})` }} />
        ))}
      </div>
    );
  }

  return <div className="media-generation-thumb">{mediaKindIcon(asset?.kind ?? fallbackKind)}</div>;
}

function SessionAssetPreview({ asset, kind }: { asset?: MediaAsset; kind: MediaSessionKind }) {
  if (asset?.kind === "music" || asset?.mimeType.startsWith("audio/")) return <audio controls preload="metadata" src={asset.url} aria-label="Session audio preview" style={{ width: "100%" }} />;
  if (asset?.kind === "video" || asset?.kind === "render") return <video controls playsInline preload="metadata" src={asset.url} aria-label="Session video preview" style={{ width: "100%" }} />;
  if (asset) return <MediaAssetPreview asset={asset} fallbackKind={asset.kind} />;
  return (
    <div className="session-asset-empty">
      {sessionKindIcon(kind)}
      <span>{sessionKindLabel(kind)}</span>
    </div>
  );
}

function LibraryAssetPreview({ asset }: { asset: LibraryAsset }) {
  if (asset.kind === "image") {
    return (
      <div className="media-generation-thumb is-media">
        {/* eslint-disable-next-line @next/next/no-img-element -- User library previews render arbitrary uploaded/imported media URLs. */}
        <img src={asset.url} alt={asset.name} />
      </div>
    );
  }
  if (asset.kind === "video") {
    return (
      <div className="media-generation-thumb is-media">
        <video src={asset.url} muted playsInline preload="metadata" aria-label={asset.name} />
      </div>
    );
  }
  if (asset.kind === "music") {
    return (
      <div className="media-generation-thumb is-audio" aria-label={asset.name}>
        {[0.42, 0.85, 0.58, 0.96, 0.7].map((scale, index) => (
          <span key={`${asset.id}-${index}`} style={{ transform: `scaleY(${scale})` }} />
        ))}
      </div>
    );
  }
  return <div className="media-generation-thumb">{mediaKindIcon(asset.kind)}</div>;
}

const libraryVaultFilters: Array<{ id: LibraryVaultFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "project", label: "This Project" },
  { id: "favorites", label: "Favorites" },
  { id: "finished", label: "Finished" },
  { id: "generated", label: "Generated" },
  { id: "uploaded", label: "Uploaded" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "music", label: "Music" },
];

function createLibraryVaultItems(
  libraryAssets: LibraryAsset[],
  collections: LibraryCollection[],
  projectAssets: MediaAsset[],
  generations: MediaGeneration[],
  projectId: string,
) {
  return libraryAssets.map((storedAsset): LibraryVaultItem => {
    // Older projects stored narration clips as renders. Keep saved records compatible
    // while presenting audio with playback controls and outside the finished-video shelf.
    const asset: LibraryAsset = storedAsset.kind === "render" && storedAsset.mimeType.startsWith("audio/")
      ? { ...storedAsset, kind: "music", name: storedAsset.name === "Cocoa Director render" ? "Narration clip" : storedAsset.name }
      : storedAsset;
    const mediaAsset = projectMediaAssetForLibraryAsset(asset, projectAssets);
    const generationId = stringFromMetadata(asset.metadata.generationId) ?? mediaAsset?.generationId;
    const generation = generationId ? generations.find((candidate) => candidate.id === generationId) : undefined;
    const width = numberFromMetadata(asset.metadata.width);
    const height = numberFromMetadata(asset.metadata.height);
    return {
      asset,
      mediaAsset,
      generation,
      isProjectLinked: Boolean(mediaAsset && mediaAsset.projectId === projectId),
      collectionIds: collections.filter((collection) => collection.assetIds.includes(asset.id)).map((collection) => collection.id),
      prompt: stringFromMetadata(asset.metadata.prompt) ?? generation?.prompt,
      provider: stringFromMetadata(asset.metadata.provider) ?? generation?.provider,
      model: stringFromMetadata(asset.metadata.model) ?? generation?.model,
      durationSeconds: numberFromMetadata(asset.metadata.durationSeconds) ?? numberFromMetadata(mediaAsset?.metadata.durationSeconds),
      dimensions: width && height ? `${width} x ${height}` : undefined,
      thumbnailUrl: stringFromMetadata(asset.metadata.thumbnailUrl) ?? stringFromMetadata(mediaAsset?.metadata.thumbnailUrl),
      sourceProjectName: stringFromMetadata(asset.metadata.sourceProjectName),
      lastUsedAt: stringFromMetadata(asset.metadata.lastUsedAt),
    };
  });
}

function projectMediaAssetForLibraryAsset(asset: LibraryAsset, projectAssets: MediaAsset[]) {
  const mediaAssetId = stringFromMetadata(asset.metadata.mediaAssetId);
  return (
    (mediaAssetId ? projectAssets.find((candidate) => candidate.id === mediaAssetId) : undefined) ??
    projectAssets.find((candidate) => candidate.metadata.libraryAssetId === asset.id) ??
    projectAssets.find((candidate) => candidate.url === asset.url && candidate.kind === asset.kind)
  );
}

function filterLibraryVaultItems(items: LibraryVaultItem[], filter: LibraryVaultFilter, search: string) {
  const query = search.trim().toLowerCase();
  return items.filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "project" && item.isProjectLinked) ||
      (filter === "favorites" && Boolean(item.asset.favoriteAt)) ||
      (filter === "finished" && (item.asset.kind === "render" || item.asset.source === "render")) ||
      (filter === "generated" && item.asset.source === "generation") ||
      (filter === "uploaded" && (item.asset.source === "upload" || item.asset.source === "url")) ||
      (filter === "video" && item.asset.kind === "render") ||
      item.asset.kind === filter;
    if (!matchesFilter) return false;
    if (!query) return true;
    const haystack = [
      item.asset.name,
      item.asset.kind,
      item.asset.source,
      item.asset.role,
      item.prompt,
      item.provider,
      item.model,
      item.sourceProjectName,
      ...item.asset.tags,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function parseTagDraft(value: string) {
  return Array.from(new Set(value
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)))
    .slice(0, 24);
}

function libraryAssetDownloadUrl(projectId: string, assetId: string) {
  return `/api/projects/${projectId}/library/${assetId}/download`;
}

function libraryAssetDownloadFileName(asset: LibraryAsset) {
  const base = asset.name.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "") || `cocoa-vault-${asset.kind}`;
  return `${base}-${asset.id.slice(0, 8)}.${extensionForMimeType(asset.mimeType, asset.kind)}`;
}

function stringFromMetadata(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberFromMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function workspacePreferredSessionKind(workspace: WorkspaceId): MediaSessionKind | null {
  if (workspace === "assets" || workspace === "library") return "image";
  if (workspace === "shots") return "video";
  if (workspace === "music") return "music";
  return null;
}

function workspaceEyebrow(workspace: WorkspaceId) {
  if (workspace === "agent") return "Media Lab";
  if (workspace === "library") return "Reusable vault";
  if (workspace === "assets") return "Visual inputs";
  if (workspace === "shots") return "Clip workbench";
  if (workspace === "music") return "Audio lab";
  if (workspace === "settings") return "Studio preferences";
  return "Studio workspace";
}

function workspaceTitle(workspace: WorkspaceId) {
  if (workspace === "agent") return "Media sessions";
  if (workspace === "library") return "Library";
  if (workspace === "assets") return "Image and reference assets";
  if (workspace === "shots") return "Video sessions";
  if (workspace === "music") return "Music and audio sessions";
  if (workspace === "settings") return "Settings";
  return "Workspace";
}

function workspaceDescription(workspace: WorkspaceId) {
  if (workspace === "music") {
    return "Create, version, and export ElevenLabs music or audio ideas before promoting them into a full render.";
  }
  if (workspace === "shots") {
    return "Generate one Seedance clip at a time, lock references and controls, then export or replace a pipeline shot.";
  }
  if (workspace === "assets" || workspace === "library") {
    return "Bring your own media into the project vault, use it as source/reference material, then turn it into a versioned session.";
  }
  if (workspace === "settings") {
    return "The first pass keeps settings lightweight while the session system becomes the home for provider choices.";
  }
  return "Work from one image, one clip, one track, or the complete director pipeline without changing context.";
}

function sessionKindToMediaKind(kind: MediaSessionKind): MediaKind | null {
  if (kind === "image" || kind === "video" || kind === "music" || kind === "render") return kind;
  return null;
}

function sessionKindIcon(kind: MediaSessionKind) {
  if (kind === "image") return <ImageIcon className="h-5 w-5" aria-hidden />;
  if (kind === "video") return <Clapperboard className="h-5 w-5" aria-hidden />;
  if (kind === "music") return <Music2 className="h-5 w-5" aria-hidden />;
  if (kind === "render") return <Film className="h-5 w-5" aria-hidden />;
  return <Bot className="h-5 w-5" aria-hidden />;
}

function sessionKindLabel(kind: MediaSessionKind) {
  if (kind === "image") return "Image session";
  if (kind === "video") return "Video session";
  if (kind === "music") return "Music session";
  if (kind === "render") return "Render session";
  return "Film session";
}

function sessionKindDetail(kind: MediaSessionKind) {
  if (kind === "image") return "OpenAI Image 2 versions and variants";
  if (kind === "video") return "FAL / Seedance clip iteration";
  if (kind === "music") return "ElevenLabs composition versions";
  return "Manifest and export decisions";
}

function sessionGenerationRisk(kind: MediaSessionKind) {
  if (kind === "image") return "This can spend an OpenAI image call after confirmation and creates a new image version.";
  if (kind === "video") return "This can spend a FAL / Seedance video call after confirmation and creates a new clip version.";
  if (kind === "music") return "This can spend an ElevenLabs music call after confirmation and creates a new track version.";
  return "This records a render command after confirmation.";
}

function renderProposalFromAgentProposal(proposal?: AgentActionProposal): RenderAgentProposal | undefined {
  if (!proposal || proposal.actionType !== "media_generation" || !proposal.kind || !proposal.prompt) return undefined;
  return {
    title: proposal.title,
    rationale: proposal.rationale,
    kind: proposal.kind,
    provider: proposal.provider ?? providerForMediaKind(proposal.kind),
    prompt: proposal.prompt,
    controls: proposal.controls,
    inputAssetIds: proposal.inputAssetIds,
    injectionAction: proposal.injectionAction,
    targetId: proposal.targetId,
    costRisk: proposal.costRisk,
  };
}

function proposalActionLabel(proposal: AgentActionProposal) {
  if (proposal.actionType === "media_generation") return "Media generation proposal";
  if (proposal.actionType === "pipeline_directive") return "Pipeline directive proposal";
  if (proposal.actionType === "pipeline_regeneration") return "Pipeline regeneration proposal";
  return "Media injection proposal";
}

function sessionDefaultPrompt(kind: MediaSessionKind, job?: VideoJob, goal?: string | null) {
  if (goal?.trim()) return goal;
  if (kind === "image") {
    return `${job?.prompt ?? DEFAULT_PROMPT}\n\nCreate a refined single-image production plate with clear subject, lighting, palette, materials, and usable reference detail.`;
  }
  if (kind === "video") {
    return `${job?.prompt ?? DEFAULT_PROMPT}\n\nGenerate one self-contained cinematic clip with a clear camera move, strong subject motion, and continuity-friendly references.`;
  }
  if (kind === "music") {
    return `${job?.prompt ?? DEFAULT_PROMPT}\n\nCompose a polished music/audio idea with section-aware dynamics, strong rhythm, and a mix that can support visual editing.`;
  }
  return job?.prompt ?? DEFAULT_PROMPT;
}

function currentMediaSessionVersion(session: MediaSessionWithVersions) {
  return session.versions.find((version) => version.assetId === session.currentAssetId) ?? session.versions[0];
}

function sessionPromptForSession(session: MediaSessionWithVersions, job?: VideoJob) {
  const versionPrompt = currentMediaSessionVersion(session)?.prompt?.trim();
  if (versionPrompt) return versionPrompt;
  const rememberedPrompt = stringRecordValue(session.settings, "lastPrompt")?.trim();
  if (rememberedPrompt) return rememberedPrompt;
  return sessionDefaultPrompt(session.kind, job, session.goal);
}

function sessionControlsForSession(session: MediaSessionWithVersions, job?: VideoJob) {
  const versionControls = currentMediaSessionVersion(session)?.controls;
  if (versionControls && Object.keys(versionControls).length > 0) {
    return publicSessionControls(versionControls);
  }
  const rememberedControls = recordValue(session.settings, "lastControls");
  if (rememberedControls) return publicSessionControls(rememberedControls);
  return sessionDefaultControls(session.kind, job);
}

function publicSessionControls(controls: Record<string, unknown>) {
  const publicControls = { ...controls };
  delete publicControls.__idempotencyKey;
  return publicControls;
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function recordValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sessionDefaultControls(kind: MediaSessionKind, job?: VideoJob): Record<string, unknown> {
  const mediaKind = sessionKindToMediaKind(kind);
  if (!mediaKind) return {};
  const controls = defaultMediaControls(mediaKind, job);
  if (kind === "music") {
    return {
      ...controls,
      negativeStyle: "",
      requestStems: false,
      respectSectionDurations: true,
    };
  }
  return controls;
}

function generationLabel(generation: MediaGeneration) {
  const label = typeof generation.metadata.label === "string" ? generation.metadata.label : "";
  return label || `${generation.provider} ${generation.kind}`;
}

function primaryAssetForMediaGeneration(assets: MediaAsset[], generation: MediaGeneration) {
  const assetId = typeof generation.metadata.assetId === "string" ? generation.metadata.assetId : undefined;
  return (
    (assetId ? assets.find((asset) => asset.id === assetId) : undefined) ??
    assets.find((asset) => asset.generationId === generation.id)
  );
}

function mediaInputReferenceHint(kind: MediaKind, count: number) {
  if (count > 0) {
    return `${count} selected input${count === 1 ? "" : "s"} will travel with the next confirmed ${kind} render.`;
  }
  if (kind === "video") return "Select image, video, or audio assets to feed Seedance reference generation.";
  if (kind === "image") return "Select images to preserve visual continuity or prepare a versioned image pass.";
  if (kind === "music") return "Select media inspiration for section-aware prompts; provider-native audio editing is not available in this release.";
  return "Select prior outputs to include in a render manifest command.";
}

function mediaActionsForGeneration(
  generation: MediaGeneration,
  selectedShotIndex?: number,
): Array<MediaGenerationInjectRequest["action"]> {
  if (generation.kind === "image") return ["use_as_anchor", "use_as_shot_reference"];
  if (generation.kind === "video") {
    return selectedShotIndex !== undefined
      ? ["replace_selected_shot", "use_in_render_manifest"]
      : ["use_in_render_manifest"];
  }
  if (generation.kind === "music") return ["use_as_music_track", "use_in_render_manifest"];
  return ["use_in_render_manifest"];
}

function mediaInjectionLabel(action: MediaGenerationInjectRequest["action"]) {
  if (action === "use_as_anchor") return "Use as anchor";
  if (action === "use_as_shot_reference") return "Shot reference";
  if (action === "replace_selected_shot") return "Replace shot";
  if (action === "use_as_music_track") return "Use music";
  return "Use in render";
}

function mediaRoleForInjection(action: MediaGenerationInjectRequest["action"]): AnchorAsset["role"] | undefined {
  return action === "use_as_anchor" ? "style" : undefined;
}

function actionRequiresShot(action: MediaGenerationInjectRequest["action"]) {
  return action === "use_as_shot_reference" || action === "replace_selected_shot";
}

function mediaBlastRadius(kind: MediaKind) {
  if (kind === "image") return "Creates a reusable image asset in the project library.";
  if (kind === "video") return "Creates a standalone Seedance clip without replacing shots yet.";
  if (kind === "music") return "Creates a standalone ElevenLabs track without replacing the current soundtrack yet.";
  return "Records a render command; final export still uses explicit render actions.";
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "Unable to preview controls";
  }
}

function numberControlValue(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
}

function defaultStrategyForMode(mode: EditorMode): RegenerateStrategy {
  if (mode === "anchors" || mode === "music") return "regenerate_replacement";
  if (mode === "shots") return "regenerate_replacement";
  return "regenerate_replacement";
}

function strategyOptionsForMode(mode: EditorMode) {
  const values =
    mode === "anchors"
      ? PROVIDER_CAPABILITIES.anchors.strategies
      : mode === "shots"
        ? PROVIDER_CAPABILITIES.shots.strategies
        : mode === "music"
          ? PROVIDER_CAPABILITIES.music.strategies
          : PROVIDER_CAPABILITIES.render.strategies;
  return values.map((value) => ({
    value,
    label: strategyLabel(value),
    detail: strategyDetail(value),
  }));
}

function strategyLabel(value: RegenerateStrategy) {
  if (value === "edit_current") return "Edit";
  if (value === "extend_continue") return "Extend";
  return "Replace";
}

function strategyDetail(value: RegenerateStrategy) {
  if (value === "edit_current") return "Use provider-native editing when available; otherwise save as edit direction.";
  if (value === "extend_continue") return "Continue or extend from the current artifact where the provider supports it.";
  return "Generate a versioned replacement and keep the previous artifact in history.";
}

function providerLabelForMode(mode: EditorMode) {
  if (mode === "anchors") return PROVIDER_CAPABILITIES.anchors.provider;
  if (mode === "shots") return PROVIDER_CAPABILITIES.shots.provider;
  if (mode === "music") return PROVIDER_CAPABILITIES.music.provider;
  return PROVIDER_CAPABILITIES.render.provider;
}

function defaultProviderControlsForMode(mode: EditorMode, selectedShot: Shot | undefined, job?: VideoJob): ProviderControls {
  if (mode === "anchors") {
    return {
      anchors: {
        model: "gpt-image-2",
        size: "1024x1536",
        quality: "high",
        outputFormat: "png",
        variantCount: 1,
      },
    };
  }

  if (mode === "shots") {
    return {
      shots: {
        seedanceMode: selectedShot?.seedanceMode ?? "reference-to-video",
        seedanceTier: selectedShot?.seedanceTier ?? "standard",
        resolution: selectedShot?.resolution === "1080p" ? "720p" : selectedShot?.resolution ?? "720p",
        durationSeconds: selectedShotDuration(selectedShot),
        aspectRatio: job?.aspectRatio ?? "9:16",
        seedMode: "lock",
        seed: selectedShot?.seed ?? 0,
        referenceImageLimit: Math.max(1, selectedShot?.referenceImages.length ?? 3),
        generateAudio: false,
      },
    };
  }

  if (mode === "music") {
    return {
      music: {
        outputFormat: "mp3_44100_192",
        respectSectionDurations: true,
        withTimestamps: false,
        storeForInpainting: false,
      },
    };
  }

  return {};
}

function selectedShotDuration(shot?: Shot) {
  if (!shot) return 8;
  return Math.min(15, Math.max(4, Math.round((shot.endMs - shot.startMs) / 1000)));
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function editorModeEyebrow(mode: EditorMode) {
  if (mode === "preview") return "Preview / render";
  if (mode === "anchors") return "Visual system";
  if (mode === "shots") return "Shot workbench";
  if (mode === "music") return "Composition";
  return "Artifact history";
}

function editorModeTitle(mode: EditorMode) {
  if (mode === "preview") return "Render editor";
  if (mode === "anchors") return "Anchor editor";
  if (mode === "shots") return "Shot editor";
  if (mode === "music") return "Music editor";
  return "Versions";
}

function editorTargetForMode(mode: EditorMode, shotIndex?: number): EditorTarget {
  if (mode === "preview") return { scope: "render", phase: 9 };
  if (mode === "anchors") return { scope: "anchors", phase: 5 };
  if (mode === "shots") return { scope: "shots", phase: 7, targetId: shotIndex !== undefined ? String(shotIndex) : undefined };
  if (mode === "music") return { scope: "music", phase: 2 };
  return { scope: "phase" };
}

function defaultPhaseAction(mode: EditorMode): EditorPendingAction | null {
  if (mode === "preview") {
    return { kind: "regenerate-phase", label: "Regenerate render", phase: 9, scope: "render" };
  }
  if (mode === "anchors") {
    return { kind: "regenerate-phase", label: "Regenerate anchors", phase: 5, scope: "anchors" };
  }
  if (mode === "shots") {
    return { kind: "regenerate-phase", label: "Regenerate all shots", phase: 7, scope: "shots" };
  }
  if (mode === "music") {
    return { kind: "regenerate-phase", label: "Regenerate music system", phase: 2, scope: "music" };
  }
  return null;
}

function editorArtifact(job: VideoJob | undefined, mode: EditorMode, shotIndex?: number): EditorArtifact {
  if (!job) {
    return { label: "No active run", detail: "Start a job to inspect artifacts.", payload: {}, urls: [] };
  }

  if (mode === "preview") {
    return {
      label: "Render manifest",
      detail: job.finalVideoUrl ? "Final render and export URLs are available." : "The render manifest appears after phase 9.",
      payload: {
        renderManifest: job.renderManifest,
        finalVideoUrl: job.finalVideoUrl,
        thumbnailUrl: job.thumbnailUrl,
      },
      urls: [
        ...(job.finalVideoUrl ? [{ label: "final mp4", href: job.finalVideoUrl }] : []),
        ...(job.thumbnailUrl ? [{ label: "thumbnail", href: job.thumbnailUrl }] : []),
        ...(job.renderManifest ? [{ label: "manifest", href: `/api/videos/${job.id}/manifest` }] : []),
        ...(job.finalVideoUrl ? [{ label: "download", href: `/api/videos/${job.id}/download` }] : []),
      ],
    };
  }

  if (mode === "anchors") {
    return {
      label: "Anchor assets",
      detail: `${job.anchorAssets.length} reusable visual reference${job.anchorAssets.length === 1 ? "" : "s"}.`,
      payload: job.anchorAssets,
      urls: job.anchorAssets.map((asset) => ({ label: asset.role, href: asset.url })),
    };
  }

  if (mode === "shots") {
    const shotPlanShot = shotIndex !== undefined
      ? job.shotPlan?.shots.find((shot) => shot.shotIndex === shotIndex)
      : undefined;
    const generatedShot = shotIndex !== undefined
      ? job.generatedShots.find((shot) => shot.shotIndex === shotIndex)
      : undefined;
    return {
      label: shotIndex !== undefined ? `Shot ${shotIndex + 1}` : "Shot set",
      detail: shotIndex !== undefined ? "Selected shot prompt, seed, QA, and rendered clip." : "Full shot plan and generated shot set.",
      payload: shotIndex !== undefined ? { shotPlanShot, generatedShot } : { shotPlan: job.shotPlan, generatedShots: job.generatedShots },
      urls: generatedShot?.videoUrl && shotIndex !== undefined ? [{ label: `shot ${shotIndex + 1}`, href: generatedShot.videoUrl }] : [],
    };
  }

  if (mode === "music") {
    return {
      label: "Music and beat grid",
      detail: job.musicTrack ? "Composition, audio render, beat grid, and section timing." : "Music artifacts appear after phases 2-4.",
      payload: {
        musicPlan: job.musicPlan,
        musicTrack: job.musicTrack,
        beatGrid: job.beatGrid,
      },
      urls: job.musicTrack?.url ? [{ label: "music track", href: job.musicTrack.url }] : [],
    };
  }

  return {
    label: "Artifact versions",
    detail: "Snapshots retained before regenerate and restore actions.",
    payload: job.artifactVersions.map((version) => ({
      id: version.id,
      scope: version.scope,
      phase: version.phase,
      targetId: version.targetId,
      label: version.label,
      createdAt: version.createdAt,
      urls: version.urls,
    })),
    urls: [],
  };
}

function directiveMatchesTarget(directive: VideoJob["editDirectives"][number], target: EditorTarget) {
  const scopeMatches =
    directive.scope === target.scope ||
    (directive.scope === "phase" && directive.phase === target.phase) ||
    (Boolean(directive.phase) && directive.phase === target.phase);
  if (!scopeMatches) return false;
  if (directive.targetId && target.targetId) return directive.targetId === target.targetId;
  if (directive.targetId && !target.targetId) return target.scope === "shots";
  return true;
}

function versionMatchesTarget(version: VideoJob["artifactVersions"][number], target: EditorTarget) {
  if (target.scope === "render") return version.scope === "render" || version.scope === "preview";
  if (version.scope !== target.scope) return false;
  if (version.targetId && target.targetId) return version.targetId === target.targetId;
  if (version.targetId && !target.targetId) return target.scope === "shots";
  return true;
}

function editInstructionHint(mode: EditorMode, shotIndex?: number) {
  if (mode === "preview") return "Notes here are stored with render scope; render regeneration uses the current manifest.";
  if (mode === "anchors") return "Guide future image anchor regeneration without touching the current run until confirmed.";
  if (mode === "shots" && shotIndex !== undefined) return `Scoped to shot ${shotIndex + 1}; use all-shots regeneration for broader rhythm changes.`;
  if (mode === "shots") return "Use shot notes for Seedance prompt direction, QA, and replacement strategy.";
  if (mode === "music") return "Shape composition plan, voice family, instrumentation, and beat-driven timing.";
  return "Versions are read-only until restored.";
}

function pendingSummary(action: EditorPendingAction) {
  if (action.kind === "restore-version") return "Restores a prior artifact snapshot into the current job.";
  if (action.kind === "regenerate-shot") return "Replaces one generated shot while keeping a version snapshot.";
  return "Queues regeneration from this phase with matching active edit instructions.";
}

function blastRadius(action: EditorPendingAction) {
  if (action.kind === "restore-version") return "Only the restored artifact fields are replaced.";
  if (action.kind === "regenerate-shot") return "Selected shot, QA score, and any later render that includes it.";
  if (action.phase === 2) return "Composition, music, beat grid, anchors, shot plan, shots, QA, and render.";
  if (action.phase === 5) return "Anchor assets plus shot plan, shots, QA, and render.";
  if (action.phase === 7) return "Generated shots, QA, and render.";
  if (action.phase === 9) return "Final MP4, thumbnail, and render manifest only.";
  return "Current phase and downstream artifacts.";
}

function costRisk(action: EditorPendingAction) {
  if (action.kind === "restore-version") return "No provider calls expected.";
  if (action.kind === "regenerate-shot") return "One Seedance shot call may run.";
  if (action.phase === 2) return "Music, image, Seedance, QA, and render calls may run.";
  if (action.phase === 5) return "Image anchor and downstream video calls may run.";
  if (action.phase === 7) return "Seedance shot calls may run.";
  if (action.phase === 9) return "Render infrastructure cost only.";
  return "Provider costs depend on the selected phase.";
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{\n  \"error\": \"Unable to stringify artifact\"\n}";
  }
}

function StateBadge({
  state,
  label,
  compact,
}: {
  state: VideoJob["status"] | WorkflowPhase["state"];
  label?: string;
  compact?: boolean;
}) {
  const classes = {
    pending: "border-line bg-background text-muted",
    running: "border-accent/50 bg-accent/10 text-accent",
    awaiting_user: "border-accent-2/50 bg-accent-2/10 text-accent-2",
    complete: "border-accent-2/50 bg-accent-2/10 text-accent-2",
    failed: "border-danger/50 bg-danger/10 text-danger",
    cancelled: "border-danger/40 bg-danger/10 text-danger",
  }[state];

  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-full border font-mono ${
        compact ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"
      } ${classes}`}
    >
      {statusIcon(state, compact ? "h-3 w-3" : "h-3.5 w-3.5")}
      {label ?? stateLabel(state)}
    </span>
  );
}

function TimelineStateBadge({ state }: { state: VideoJob["status"] | WorkflowPhase["state"] }) {
  const classes = {
    pending: "border-line bg-background text-muted",
    running: "border-accent/50 bg-accent/10 text-accent",
    awaiting_user: "border-accent-2/50 bg-accent-2/10 text-accent-2",
    complete: "border-accent-2/50 bg-accent-2/10 text-accent-2",
    failed: "border-danger/50 bg-danger/10 text-danger",
    cancelled: "border-danger/40 bg-danger/10 text-danger",
  }[state];

  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 font-mono text-[10px] leading-none ${classes}`}>
      {statusIcon(state, "h-3 w-3 shrink-0")}
      <span className="truncate">{stateLabel(state)}</span>
    </span>
  );
}

function statusIcon(state: VideoJob["status"] | WorkflowPhase["state"], className = "h-4 w-4") {
  if (state === "running") return <Loader2 className={`${className} animate-spin text-accent`} aria-hidden />;
  if (state === "awaiting_user") return <Clock3 className={`${className} text-accent-2`} aria-hidden />;
  if (state === "complete") return <CheckCircle2 className={`${className} text-accent-2`} aria-hidden />;
  if (state === "failed" || state === "cancelled") return <AlertTriangle className={`${className} text-danger`} aria-hidden />;
  return <Clock3 className={`${className} text-muted`} aria-hidden />;
}

function stateLabel(state: VideoJob["status"] | WorkflowPhase["state"]) {
  if (state === "awaiting_user") return "waiting";
  return state.replace("_", " ");
}

function currentJobPhase(job?: VideoJob) {
  return job?.phases.find((phase) => phase.phaseNumber === job.currentPhase);
}

function currentWorkflowStep(job?: VideoJob) {
  if (!job?.workflowSteps?.length) return undefined;
  return job.workflowSteps.find((step) => step.state === "running")
    ?? job.workflowSteps.find((step) => step.state === "awaiting_user")
    ?? job.workflowSteps.find((step) => step.state === "failed")
    ?? job.workflowSteps.find((step) => step.state === "pending")
    ?? job.workflowSteps.at(-1);
}

function pipelineRecords(job?: VideoJob) {
  if (job?.workflowSteps?.length) return job.workflowSteps;
  return phases.map((name, index) => {
    const phaseNumber = index + 1;
    const phase = job?.phases.find((item) => item.phaseNumber === phaseNumber);
    return {
      id: `phase-${phaseNumber}`,
      name,
      state: phase?.state ?? "pending" as const,
      completedAt: phase?.completedAt,
      error: phase?.error,
    };
  });
}

function progressRecords(progress: ProductionProgressSnapshot) {
  return progress.stages.map((stage) => ({
    id: stage.id,
    name: stage.label,
    state: stage.state === "needs_attention" ? "awaiting_user" as const
      : stage.state === "not_started" ? "pending" as const
        : stage.state,
    completedAt: stage.completedAt,
    error: stage.failed > 0 ? stage.detail : undefined,
  }));
}

function progressHealthLabel(state: ProductionProgressSnapshot["state"]) {
  if (state === "active") return "Active";
  if (state === "possibly_stalled") return "Possibly stalled";
  if (state === "needs_attention") return "Needs attention";
  if (state === "awaiting_user") return "Waiting for your approval";
  if (state === "queued") return "Queued";
  if (state === "complete") return "Complete";
  if (state === "cancelled") return "Cancelled";
  return "Failed";
}

function progressStatusForIcon(state: ProductionProgressSnapshot["state"]): VideoJob["status"] {
  if (state === "active") return "running";
  if (state === "queued") return "pending";
  if (state === "needs_attention" || state === "possibly_stalled" || state === "awaiting_user") return "awaiting_user";
  return state;
}

function formatRelativeActivity(timestamp: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function workflowStepPosition(job: VideoJob) {
  if (!job.workflowSteps?.length) return `Step ${job.currentPhase} of 9`;
  const active = currentWorkflowStep(job);
  const index = Math.max(0, job.workflowSteps.findIndex((step) => step.id === active?.id));
  return `Step ${index + 1} of ${job.workflowSteps.length}`;
}

function statusSummary(job: VideoJob, phase?: WorkflowPhase) {
  if (job.workflowSteps?.length && currentContentType(job) !== "music_video") {
    const step = currentWorkflowStep(job);
    if (job.status === "awaiting_user") {
      const qaBlocked = job.qaReport && !job.qaReport.passed;
      return {
        title: qaBlocked ? "Draft is blocked by quality checks" : "Outline, script, and timeline are ready",
        detail: qaBlocked
          ? "Review the QA findings and source coverage before narration or generation can begin."
          : "Review the source-first draft. Narration and billable visual generation remain gated until approval.",
      };
    }
    return {
      title: `${step?.name ?? "Production workflow"} ${stateLabel(step?.state ?? job.status)}`,
      detail: job.error ?? "Artifacts are durable and can be regenerated by stable workflow step without resetting unrelated work.",
    };
  }
  const phaseName = phase?.name ?? phases[job.currentPhase - 1] ?? "Pipeline";
  const activeCall = latestActiveProviderCall(job);
  if (job.status === "pending") {
    if (job.currentPhase === 7 && job.shotPlan) {
      return {
        title: "Shot generation queued",
        detail: `${job.generatedShots.length}/${job.shotPlan.shots.length} Seedance shot blocks are ready. The next durable shot step will start when Vercel picks up the workflow.`,
      };
    }
    return {
      title: "Queued with the director",
      detail: `${phaseName} is waiting to start. The dashboard will refresh automatically as soon as Vercel starts the workflow.`,
    };
  }
  if (job.status === "running") {
    if (job.currentPhase === 7 && job.shotPlan) {
      const nextShot = Math.min(job.generatedShots.length + 1, job.shotPlan.shots.length);
      const remaining = estimatedRemaining(job);
      return {
        title: `Seedance shot ${nextShot}/${job.shotPlan.shots.length} is running`,
        detail: `${job.generatedShots.length}/${job.shotPlan.shots.length} shot blocks have completed. ${activeCall ? `fal request ${activeCall.requestId.slice(0, 12)} is ${activeCall.status}. ` : ""}Each successful shot is saved to Blob and appears in the preview as soon as it lands.${remaining ? ` Rough time remaining: ${remaining}.` : ""}`,
      };
    }
    if (job.currentPhase === 9) {
      return {
        title: "Final MP4 is being assembled",
        detail: "The Sandbox renderer is stitching clips, normalizing the soundtrack, creating the thumbnail, and finalizing the MP4. This usually takes a few minutes after all Seedance shots are ready.",
      };
    }
    return {
      title: `${phaseName} is running`,
      detail: phase?.startedAt
        ? `Work started at ${formatClock(phase.startedAt)}. Provider calls appear as each paid generation step completes.`
        : "The phase has started and the next artifact will appear below when it finishes.",
    };
  }
  if (job.status === "awaiting_user") {
    return {
      title: `${phaseName} is ready`,
      detail: "Review the output and use the next action button when you want the director to continue.",
    };
  }
  if (job.status === "complete") {
    return {
      title: "Final render complete",
      detail: "The finished MP4, mastered soundtrack, thumbnail, and render manifest are ready.",
    };
  }
  if (job.status === "cancelled") {
    return {
      title: "Generation cancelled",
      detail: "No new provider calls will be started for this job. Any in-flight vendor work may still finish remotely.",
    };
  }
  const failedCall = latestFailedProviderCall(job);
  return {
    title: `${phaseName} needs attention`,
    detail: failedCall?.error
      ? `${phase?.error ?? job.error ?? "The workflow stopped before the next phase could complete."} The latest failed call has the provider detail below.`
      : phase?.error ?? job.error ?? "The workflow stopped before the next phase could complete.",
  };
}

function estimatedRemaining(job: VideoJob) {
  if (job.status !== "running" && job.status !== "pending") return null;
  if (job.currentPhase === 7 && job.shotPlan) {
    const totalShots = job.shotPlan.shots.length;
    const completedShots = job.generatedShots.length;
    const remainingShots = Math.max(0, totalShots - completedShots);
    const completedLatencies = job.generatedShots
      .map((shot) => shot.latencyMs)
      .filter((latency) => Number.isFinite(latency) && latency > 0);
    const averageShotMs =
      completedLatencies.length > 0
        ? completedLatencies.reduce((sum, latency) => sum + latency, 0) / completedLatencies.length
        : 150_000;
    const qaAndRenderBufferMs = remainingShots === 0 ? 240_000 : 360_000;
    return formatDuration(remainingShots * averageShotMs + qaAndRenderBufferMs);
  }
  if (job.currentPhase === 9) return "3-6 min";
  return null;
}

function latestActiveProviderCall(job: VideoJob) {
  return [...job.providerCalls]
    .reverse()
    .find((call) => call.provider === "fal" && (call.status === "queued" || call.status === "running"));
}

function latestFailedProviderCall(job: VideoJob) {
  return [...job.providerCalls].reverse().find((call) => call.status === "failed");
}

function providerCallState(status: VideoJob["providerCalls"][number]["status"]): VideoJob["status"] {
  if (status === "success") return "complete";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "pending";
}

function composeDirectorPrompt(
  rawPrompt: string,
  style: (typeof STYLE_PRESETS)[number],
  intensity: number,
) {
  const prompt = rawPrompt.trim() || DEFAULT_PROMPT;
  if (!style.directive || intensity === 0) return prompt.slice(0, 1500);

  const intervention = [
    "",
    `Director style intervention (${style.label}, ${intensity}%): ${style.directive}.`,
    "Keep the result identity-safe, cinematic, visually coherent, and practical for the existing 9:16 pipeline.",
  ].join("\n");
  return `${prompt}${intervention}`.slice(0, 1500);
}

function jobProgressPercent(job?: VideoJob) {
  if (!job) return 0;
  if (job.status === "complete") return 100;
  if (job.workflowSteps?.length) {
    const completed = job.workflowSteps.filter((step) => step.state === "complete").length;
    const partial = job.workflowSteps.some((step) => step.state === "running" || step.state === "awaiting_user") ? 0.5 : 0;
    return Math.min(99, ((completed + partial) / job.workflowSteps.length) * 100);
  }
  if (job.status === "cancelled" || job.status === "failed") {
    return Math.max(8, Math.min(100, ((job.currentPhase - 1) / 9) * 100));
  }
  const base = ((job.currentPhase - 1) / 9) * 100;
  if (job.currentPhase === 7 && job.shotPlan) {
    const shotProgress = job.generatedShots.length / Math.max(1, job.shotPlan.shots.length);
    return Math.min(95, base + (shotProgress / 9) * 100);
  }
  return Math.min(95, base + (job.status === "running" ? 6 : 3));
}

function formatSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function durationRangeFor(contentType: ContentType) {
  if (contentType === "music_video") return { min: 60, max: 120 };
  if (contentType === "product_social") return { min: 15, max: 180 };
  if (contentType === "custom") return { min: 15, max: 600 };
  return { min: 30, max: 300 };
}

function editorialNarrationSeconds(job: VideoJob) {
  const narration = job.script ?? job.storyboard?.scenes.map((scene) => scene.narration).join(" ") ?? "";
  const words = narration.replace(/\[claim:[^\]]+\]/g, "").trim().split(/\s+/).filter(Boolean).length;
  return words / 2.35;
}

function isProductionId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function currentContentType(job?: VideoJob): ContentType {
  return job?.contentType ?? "music_video";
}

function formatContentType(contentType: ContentType) {
  return FORMAT_OPTIONS.find((option) => option.id === contentType)?.label ?? contentType.replaceAll("_", " ");
}

function formatDuration(durationMs: number) {
  const minutes = Math.max(1, Math.ceil(durationMs / 60_000));
  if (minutes < 2) return "about 1 min";
  if (minutes < 10) return `about ${minutes} min`;
  const low = Math.max(1, Math.floor(minutes / 5) * 5);
  const high = low + 5;
  return `about ${low}-${high} min`;
}

function outputSummary(job?: VideoJob) {
  if (!job) {
    return {
      icon: <Film className="h-10 w-10" aria-hidden />,
      title: "Awaiting first stage",
      detail: "Start with Stage for a cheap treatment gate or Make Video for full autopilot.",
    };
  }
  if (job.finalVideoUrl) {
    return {
      icon: <PlayCircle className="h-4 w-4 text-accent" aria-hidden />,
      title: "Final MP4 ready",
      detail: "The rendered video is available in Blob storage.",
    };
  }
  if (job.generatedShots.length > 0) {
    return {
      icon: <Clapperboard className="h-4 w-4 text-accent" aria-hidden />,
      title: `${job.generatedShots.length} Seedance shot${job.generatedShots.length === 1 ? "" : "s"} ready`,
      detail: "QA and render are the next steps once the shot set is accepted.",
    };
  }
  if (job.shotPlan) {
    return {
      icon: <Clapperboard className="h-4 w-4 text-accent" aria-hidden />,
      title: `${job.shotPlan.shots.length} shot blocks planned`,
      detail: "The director has the beat-aware Seedance prompts ready for generation.",
    };
  }
  if (job.anchorAssets.length > 0) {
    return {
      icon: <ImageIcon className="h-4 w-4 text-accent" aria-hidden />,
      title: `${job.anchorAssets.length} anchor asset${job.anchorAssets.length === 1 ? "" : "s"} ready`,
      detail:
        job.visualMode === "conceptual"
          ? "These style, environment, and palette references keep the conceptual video coherent."
          : "These references keep the performer, style, and environment coherent.",
    };
  }
  if (job.musicTrack) {
    return {
      icon: <Music2 className="h-4 w-4 text-accent" aria-hidden />,
      title: "Music rendered",
      detail: "The soundtrack is ready and beat extraction can align the edit to it.",
    };
  }
  if (job.musicPlan) {
    return {
      icon: <Music2 className="h-4 w-4 text-accent" aria-hidden />,
      title: "Composition plan ready",
      detail: `${job.musicPlan.sections.length} song sections are locked with a ${job.musicPlan.voiceFamily ?? "vocal"} voice direction for the ElevenLabs render.`,
    };
  }
  if (job.creativeBrief) {
    return {
      icon: <FileText className="h-4 w-4 text-accent" aria-hidden />,
      title: "Treatment ready",
      detail: job.creativeBrief.storySpine,
    };
  }
  if (job.status === "failed") {
    return {
      icon: <AlertTriangle className="h-10 w-10 text-danger" aria-hidden />,
      title: "Workflow stopped",
      detail: job.error ?? "Check the failed phase details and Vercel logs.",
    };
  }
  return {
    icon: <Loader2 className="h-10 w-10 animate-spin text-accent" aria-hidden />,
    title: job.status === "pending" ? "Queued" : "Working",
    detail: "The next artifact will appear here as soon as the current phase finishes.",
  };
}

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function createClientIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function mergeSources(current: ProductionSource[], additions: ProductionSource[]) {
  const sources = new Map(current.map((source) => [source.id, source]));
  for (const source of additions) sources.set(source.id, source);
  return [...sources.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function formatBytes(value?: number) {
  if (!value) return "size pending";
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function safeDomain(value?: string) {
  if (!value) return "source";
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
}

function formatSourceDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function nextLabel(job?: VideoJob) {
  if (!job) return "Advance";
  if (job.currentPhase === 1) return "Plan";
  if (job.currentPhase === 2) return "Compose";
  if (job.currentPhase === 3) return "Anchors";
  if (job.currentPhase === 5) return "Shots";
  if (job.currentPhase === 6) return "Final";
  return "Advance";
}
