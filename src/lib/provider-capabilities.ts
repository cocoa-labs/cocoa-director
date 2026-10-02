import type {
  AnchorProviderControls,
  MusicProviderControls,
  MusicPlan,
  ProviderControls,
  QualityTier,
  RegenerateStrategy,
  Shot,
  ShotProviderControls,
} from "@/lib/schemas";

export type CapabilityOption<T extends string = string> = {
  value: T;
  label: string;
  detail?: string;
  disabled?: boolean;
  experimental?: boolean;
};

export const PROVIDER_CAPABILITIES = {
  anchors: {
    provider: "OpenAI gpt-image-2",
    strategies: ["edit_current", "regenerate_replacement"] satisfies RegenerateStrategy[],
    sizes: [
      option("1024x1536", "Portrait"),
      option("1024x1024", "Square"),
      option("1536x1024", "Landscape"),
      option("2048x2048", "2K square", "Experimental larger image"),
      option("2160x3840", "4K portrait", "Experimental larger image"),
    ],
    qualities: [
      option("low", "Draft"),
      option("medium", "Medium"),
      option("high", "High"),
      option("auto", "Auto"),
    ],
    outputFormats: [
      option("png", "PNG"),
      option("jpeg", "JPEG"),
      option("webp", "WebP"),
    ],
  },
  shots: {
    provider: "fal.ai / Seedance 2.0",
    strategies: ["regenerate_replacement", "extend_continue"] satisfies RegenerateStrategy[],
    modes: [
      option("reference-to-video", "Reference"),
      option("image-to-video", "Image"),
      option("text-to-video", "Text"),
    ],
    tiers: [
      option("standard", "Standard"),
      option("fast", "Fast"),
    ],
    resolutions: [
      option("480p", "480p"),
      option("720p", "720p"),
      { ...option("1080p", "1080p", "Needs provider verification"), disabled: true, experimental: true },
    ],
    aspectRatios: [
      option("9:16", "9:16"),
      option("16:9", "16:9"),
      option("1:1", "1:1"),
      option("3:4", "3:4"),
      option("4:3", "4:3"),
      option("21:9", "21:9"),
      option("auto", "Auto"),
    ],
  },
  music: {
    provider: "ElevenLabs music",
    strategies: ["regenerate_replacement", "edit_current", "extend_continue"] satisfies RegenerateStrategy[],
    outputFormats: [
      option("mp3_44100_192", "MP3 192"),
      option("mp3_44100_128", "MP3 128"),
      option("mp3_24000_48", "MP3 48"),
      option("mp3_22050_32", "MP3 32"),
    ],
  },
  render: {
    provider: "Vercel render pipeline",
    strategies: ["regenerate_replacement"] satisfies RegenerateStrategy[],
  },
  media: {
    providers: [
      option("openai", "OpenAI images", "Standalone image or edit render"),
      option("fal", "fal.ai / Seedance", "Standalone video clip render"),
      option("elevenlabs", "ElevenLabs music", "Standalone music render"),
      option("vercel-render", "Render pipeline", "Manifest-based final render"),
    ],
    imageUseCases: [
      option("use_as_anchor", "Use as anchor"),
      option("use_as_shot_reference", "Use as shot reference"),
    ],
    videoUseCases: [
      option("replace_selected_shot", "Replace selected shot"),
      option("use_in_render_manifest", "Use in render manifest"),
    ],
    musicUseCases: [
      option("use_as_music_track", "Use as music track"),
      option("use_in_render_manifest", "Use in render manifest"),
    ],
  },
} as const;

export function applyShotProviderControls(shot: Shot, controls?: ShotProviderControls): Shot {
  if (!controls) return shot;
  const durationSeconds = clampDuration(controls.durationSeconds ?? durationSecondsForShot(shot));
  const seed =
    controls.seedMode === "randomize"
      ? Math.floor(Math.random() * 2_147_483_647)
      : controls.seed ?? shot.seed;

  return {
    ...shot,
    endMs: shot.startMs + durationSeconds * 1000,
    seedanceMode: controls.seedanceMode ?? shot.seedanceMode,
    seedanceTier: controls.seedanceTier ?? shot.seedanceTier,
    resolution: controls.resolution === "1080p" ? "720p" : controls.resolution ?? shot.resolution,
    referenceImages: controls.referenceImageLimit
      ? shot.referenceImages.slice(0, controls.referenceImageLimit)
      : shot.referenceImages,
    audioReferenceUrl: controls.audioReferenceUrl ?? shot.audioReferenceUrl,
    seedanceAspectRatio: controls.aspectRatio ?? shot.seedanceAspectRatio,
    generateAudio: controls.generateAudio ?? shot.generateAudio,
    seed,
  };
}

export function routeShotForQuality(shot: Shot, qualityTier: QualityTier): Shot {
  if (qualityTier === "draft") {
    return {
      ...shot,
      seedanceTier: "fast",
      resolution: "480p",
      routingReason: "Draft tier selected the lower-cost Seedance fast route for proxy review.",
    };
  }
  if (qualityTier === "premium") {
    return {
      ...shot,
      seedanceTier: "standard",
      resolution: "720p",
      routingReason: "Premium tier selected the highest currently validated reference-consistency route; unbenchmarked candidates remain disabled.",
    };
  }
  return {
    ...shot,
    seedanceTier: "standard",
    resolution: "720p",
    routingReason: "Standard tier selected the balanced Seedance route for quality and reliability.",
  };
}

export function applyMusicProviderControls(plan: MusicPlan, controls?: MusicProviderControls): MusicPlan {
  if (!controls?.sectionEdits?.length) return plan;
  const sectionEdits = new Map(controls.sectionEdits.map((section) => [section.id, section]));
  return {
    ...plan,
    sections: plan.sections.map((section) => {
      const edit = sectionEdits.get(section.id);
      if (!edit) return section;
      return {
        ...section,
        durationSeconds: edit.durationSeconds ?? section.durationSeconds,
        instrumentation: edit.localStyle?.trim() || section.instrumentation,
      };
    }),
  };
}

export function describeProviderControls(controls?: ProviderControls, strategy?: RegenerateStrategy) {
  const parts: string[] = [];
  if (strategy) parts.push(`strategy ${strategy.replace(/_/g, " ")}`);
  if (controls?.anchors) parts.push(`anchor controls ${describeMap(controls.anchors)}`);
  if (controls?.shots) parts.push(`shot controls ${describeMap(controls.shots)}`);
  if (controls?.music) parts.push(`music controls ${describeMap(controls.music)}`);
  return parts.filter(Boolean).join("; ");
}

export function hasProviderControls(controls?: ProviderControls) {
  return Boolean(
    controls &&
      Object.values(controls).some((value) => value && Object.keys(value).length > 0),
  );
}

export function mergeProviderControls(values: Array<ProviderControls | undefined>): ProviderControls | undefined {
  const merged: ProviderControls = {};
  for (const value of values) {
    if (!value) continue;
    if (value.anchors) merged.anchors = { ...merged.anchors, ...value.anchors };
    if (value.shots) merged.shots = { ...merged.shots, ...value.shots };
    if (value.music) merged.music = { ...merged.music, ...value.music };
  }
  return hasProviderControls(merged) ? merged : undefined;
}

export function controlsForAnchorRequest(controls?: AnchorProviderControls) {
  return controls;
}

export function controlsForMusicRequest(controls?: MusicProviderControls) {
  return controls;
}

function option<T extends string>(value: T, label: string, detail?: string): CapabilityOption<T> {
  return { value, label, detail };
}

function durationSecondsForShot(shot: Shot) {
  return Math.round((shot.endMs - shot.startMs) / 1000);
}

function clampDuration(value: number) {
  return Math.min(15, Math.max(4, Math.round(value)));
}

function describeMap(value: Record<string, unknown>) {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined && entry !== "")
    .map(([key, entry]) => `${key}=${describeControlValue(entry)}`)
    .join(", ");
}

function describeControlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (entry && typeof entry === "object" && "id" in entry) {
          const section = entry as { id: string; durationSeconds?: number; localStyle?: string };
          return [
            section.id,
            section.durationSeconds ? `${section.durationSeconds}s` : "",
            section.localStyle ? "style" : "",
          ].filter(Boolean).join(":");
        }
        return String(entry);
      })
      .join("|");
  }
  return String(value);
}
