import { randomUUID } from "node:crypto";

import {
  ArtifactVersion,
  EditDirective,
  type EditorScope,
  type PhaseNumber,
  type ProviderControls,
  type RegenerateStrategy,
  type VideoJob,
} from "@/lib/schemas";
import {
  describeProviderControls,
  hasProviderControls,
  mergeProviderControls,
} from "@/lib/provider-capabilities";
import { nowIso } from "@/lib/trace";

export type EditTarget = {
  scope?: EditorScope;
  phase?: PhaseNumber;
  targetId?: string;
};

export function scopeForPhase(phase: PhaseNumber): EditorScope {
  if (phase === 1) return "treatment";
  if (phase >= 2 && phase <= 4) return "music";
  if (phase === 5) return "anchors";
  if (phase >= 6 && phase <= 8) return "shots";
  return "render";
}

export function createEditDirective(input: {
  scope: EditorScope;
  phase?: PhaseNumber;
  targetId?: string;
  text: string;
  strategy?: RegenerateStrategy;
  providerControls?: ProviderControls;
}) {
  return EditDirective.parse({
    id: randomUUID(),
    scope: input.scope,
    phase: input.phase,
    targetId: input.targetId,
    text: input.text,
    strategy: input.strategy,
    providerControls: input.providerControls,
    status: "active",
    createdAt: nowIso(),
  });
}

export function activeDirectivesFor(job: VideoJob, target: EditTarget, directiveIds: string[] = []) {
  return job.editDirectives.filter((directive) => {
    if (directive.status !== "active") return false;
    if (directiveIds.length > 0) return directiveIds.includes(directive.id);
    return directiveAppliesToTarget(directive, target);
  });
}

export function directiveTextBlock(job: VideoJob, target: EditTarget, directiveIds: string[] = []) {
  const directives = activeDirectivesFor(job, target, directiveIds);
  if (directives.length === 0) return "";
  return directives.map((directive) => `- ${directiveLine(directive)}`).join("\n");
}

export function providerControlsFor(job: VideoJob, target: EditTarget, directiveIds: string[] = []) {
  return mergeProviderControls(
    activeDirectivesFor(job, target, directiveIds).map((directive) => directive.providerControls),
  );
}

export function directiveTextForControls(
  providerControls?: ProviderControls,
  strategy?: RegenerateStrategy,
  fallback = "Apply provider controls for this regeneration.",
) {
  const description = describeProviderControls(providerControls, strategy);
  return description ? `Apply ${description}.` : fallback;
}

export function appendDirectiveText(text: string, directives: string) {
  if (!directives.trim()) return text;
  return `${text}\n\n[User edit directives]\n${directives}`;
}

export function markDirectivesApplied(job: VideoJob, target: EditTarget, directiveIds: string[] = []) {
  const applied = activeDirectivesFor(job, target, directiveIds);
  if (applied.length === 0) return job.editDirectives;
  const appliedIds = new Set(applied.map((directive) => directive.id));
  const appliedAt = nowIso();
  return job.editDirectives.map((directive) =>
    appliedIds.has(directive.id) ? { ...directive, appliedAt } : directive,
  );
}

export function createArtifactSnapshot(
  job: VideoJob,
  target: EditTarget,
  label = "Before regeneration",
): ArtifactVersion | null {
  const scope = target.scope ?? (target.phase ? scopeForPhase(target.phase) : "phase");
  const payload = payloadForTarget(job, { ...target, scope });
  if (!hasSnapshotPayload(payload)) return null;
  return ArtifactVersion.parse({
    id: randomUUID(),
    scope,
    phase: target.phase,
    targetId: target.targetId,
    label,
    payload,
    urls: urlsForTarget(job, { ...target, scope }),
    createdAt: nowIso(),
  });
}

export function restorePatchForVersion(job: VideoJob, version: ArtifactVersion): Partial<VideoJob> {
  const payload = version.payload as Record<string, unknown>;

  if (version.scope === "treatment") {
    return { creativeBrief: version.payload as VideoJob["creativeBrief"] };
  }

  if (version.scope === "music") {
    return {
      musicPlan: payload.musicPlan as VideoJob["musicPlan"],
      musicTrack: payload.musicTrack as VideoJob["musicTrack"],
      beatGrid: payload.beatGrid as VideoJob["beatGrid"],
    };
  }

  if (version.scope === "anchors") {
    return { anchorAssets: Array.isArray(version.payload) ? version.payload as VideoJob["anchorAssets"] : job.anchorAssets };
  }

  if (version.scope === "shots") {
    if (version.targetId) {
      const shotPlanShot = payload.shotPlanShot as NonNullable<VideoJob["shotPlan"]>["shots"][number] | undefined;
      const generatedShot = payload.generatedShot as VideoJob["generatedShots"][number] | undefined;
      return {
        shotPlan: shotPlanShot && job.shotPlan
          ? {
              ...job.shotPlan,
              shots: job.shotPlan.shots.map((shot) =>
                String(shot.shotIndex) === version.targetId ? shotPlanShot : shot,
              ),
            }
          : job.shotPlan,
        generatedShots: generatedShot
          ? [
              ...job.generatedShots.filter((shot) => String(shot.shotIndex) !== version.targetId),
              generatedShot,
            ].sort((left, right) => left.shotIndex - right.shotIndex)
          : job.generatedShots,
      };
    }

    return {
      shotPlan: payload.shotPlan as VideoJob["shotPlan"],
      generatedShots: (payload.generatedShots as VideoJob["generatedShots"]) ?? job.generatedShots,
    };
  }

  if (version.scope === "preview" || version.scope === "render") {
    return {
      renderManifest: payload.renderManifest as VideoJob["renderManifest"],
      finalVideoUrl: payload.finalVideoUrl as VideoJob["finalVideoUrl"],
      thumbnailUrl: payload.thumbnailUrl as VideoJob["thumbnailUrl"],
    };
  }

  return {};
}

function directiveAppliesToTarget(directive: EditDirective, target: EditTarget) {
  const targetScope = target.scope ?? (target.phase ? scopeForPhase(target.phase) : undefined);
  const scopeMatches =
    directive.scope === targetScope ||
    (directive.scope === "phase" && Boolean(target.phase) && directive.phase === target.phase) ||
    (Boolean(directive.phase) && directive.phase === target.phase);

  if (!scopeMatches) return false;
  if (directive.phase && target.phase && directive.phase !== target.phase) return false;
  if (directive.targetId && target.targetId) return directive.targetId === target.targetId;
  if (directive.targetId && !target.targetId) return true;
  return true;
}

function directiveLine(directive: EditDirective) {
  const detail = describeProviderControls(directive.providerControls, directive.strategy);
  if (!detail || !hasProviderControls(directive.providerControls)) return directive.text;
  return `${directive.text} (${detail})`;
}

function payloadForTarget(job: VideoJob, target: Required<Pick<EditTarget, "scope">> & EditTarget) {
  if (target.scope === "treatment") return job.creativeBrief;
  if (target.scope === "music") {
    return { musicPlan: job.musicPlan, musicTrack: job.musicTrack, beatGrid: job.beatGrid };
  }
  if (target.scope === "anchors") return job.anchorAssets;
  if (target.scope === "shots") {
    if (target.targetId) {
      return {
        shotPlanShot: job.shotPlan?.shots.find((shot) => String(shot.shotIndex) === target.targetId),
        generatedShot: job.generatedShots.find((shot) => String(shot.shotIndex) === target.targetId),
      };
    }
    return { shotPlan: job.shotPlan, generatedShots: job.generatedShots };
  }
  if (target.scope === "preview" || target.scope === "render") {
    return {
      renderManifest: job.renderManifest,
      finalVideoUrl: job.finalVideoUrl,
      thumbnailUrl: job.thumbnailUrl,
    };
  }
  return {
    creativeBrief: job.creativeBrief,
    musicPlan: job.musicPlan,
    musicTrack: job.musicTrack,
    beatGrid: job.beatGrid,
    anchorAssets: job.anchorAssets,
    shotPlan: job.shotPlan,
    generatedShots: job.generatedShots,
    renderManifest: job.renderManifest,
    finalVideoUrl: job.finalVideoUrl,
    thumbnailUrl: job.thumbnailUrl,
  };
}

function urlsForTarget(job: VideoJob, target: Required<Pick<EditTarget, "scope">> & EditTarget) {
  if (target.scope === "anchors") {
    return Object.fromEntries(job.anchorAssets.map((asset) => [asset.role, asset.url]));
  }
  if (target.scope === "shots") {
    if (target.targetId) {
      const shot = job.generatedShots.find((generated) => String(generated.shotIndex) === target.targetId);
      return shot?.videoUrl ? { shot: shot.videoUrl } : {};
    }
    return Object.fromEntries(job.generatedShots.map((shot) => [`shot-${shot.shotIndex + 1}`, shot.videoUrl]));
  }
  if (target.scope === "music") {
    return job.musicTrack?.url ? { music: job.musicTrack.url } : {};
  }
  if (target.scope === "preview" || target.scope === "render") {
    return {
      ...(job.finalVideoUrl ? { final: job.finalVideoUrl } : {}),
      ...(job.thumbnailUrl ? { thumbnail: job.thumbnailUrl } : {}),
    };
  }
  return {};
}

function hasSnapshotPayload(payload: unknown): boolean {
  if (!payload) return false;
  if (Array.isArray(payload)) return payload.length > 0;
  if (typeof payload === "object") {
    return Object.values(payload).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      return Boolean(value);
    });
  }
  return true;
}
