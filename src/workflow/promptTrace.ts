import type { AnchorAudit, PromptTrace, VideoJob } from "@/lib/schemas";
import { nowIso } from "@/lib/trace";

export function buildPromptTrace(job: VideoJob): PromptTrace {
  return {
    styleContract: job.creativeBrief?.styleContract,
    promptSummaries: {
      userPrompt: job.prompt.slice(0, 500),
      treatment: job.creativeBrief
        ? `${job.creativeBrief.genre}; ${job.creativeBrief.visualWorld.slice(0, 420)}`
        : "pending",
      music: job.musicPlan
        ? `${job.musicPlan.styleSummary ?? "style pending"}; ${job.musicPlan.sections.map((section) => section.instrumentation).join(" | ").slice(0, 560)}`
        : "pending",
      anchors: job.anchorAssets.length > 0
        ? job.anchorAssets.map((asset) => `${asset.role}: ${asset.promptUsed.slice(0, 220)}`).join("\n")
        : "pending",
      shots: job.shotPlan
        ? job.shotPlan.shots.slice(0, 4).map((shot) => `${shot.shotIndex}: ${shot.prompt.slice(0, 260)}`).join("\n")
        : "pending",
    },
    providerPayloadSummaries: {
      elevenLabs: job.musicPlan
        ? {
            bpm: job.musicPlan.bpm,
            key: job.musicPlan.key,
            styleSummary: job.musicPlan.styleSummary,
            voiceFamily: job.musicPlan.voiceFamily,
          }
        : undefined,
      seedance: job.shotPlan
        ? {
            shotCount: job.shotPlan.shots.length,
            referenceCounts: job.shotPlan.shots.map((shot) => shot.referenceImages.length),
            firstShotPrompt: job.shotPlan.shots[0]?.prompt.slice(0, 400),
          }
        : undefined,
    },
    selectedReferences: job.shotPlan?.shots.map((shot) => ({
      shotIndex: shot.shotIndex,
      roles: shot.referenceRoles,
      urlCount: shot.referenceImages.length,
    })) ?? [],
    anchorAudits: job.anchorAssets.map((asset) => asset.audit).filter(Boolean) as AnchorAudit[],
    updatedAt: nowIso(),
  };
}
