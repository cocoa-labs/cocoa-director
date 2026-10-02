import { sleep } from "workflow";

import { MUSIC_VIDEO_V1_PHASES, type LegacyMusicPhaseDefinition } from "@/lib/music-workflow-profile";
import {
  completeAnchorAssetsPhaseStep,
  completeShotGenerationPhaseStep,
  failShotGenerationPhaseStep,
  generateAnchorAssetStep,
  pollSeedanceShotStep,
  prepareAnchorAssetsPhaseStep,
  prepareShotGenerationPhaseStep,
  resubmitSeedanceShotStep,
  runVideoPhaseStep,
  submitSeedanceShotStep,
} from "@/workflow/steps";

const SEEDANCE_POLL_INTERVAL = "15s";
const SEEDANCE_MAX_POLLS_PER_SHOT = 100;
const SEEDANCE_MAX_REPLACEMENTS_PER_SHOT = 2;

export async function runVideoAutopilot(videoId: string) {
  "use workflow";
  let result: unknown;
  for (const phase of MUSIC_VIDEO_V1_PHASES) {
    result = await runConfiguredPhase(videoId, phase);
  }
  return result;
}

async function runConfiguredPhase(videoId: string, phase: LegacyMusicPhaseDefinition) {
  if (phase.runner === "anchor_assets") {
    const anchorRoles = await prepareAnchorAssetsPhaseStep(videoId, false);
    for (const role of anchorRoles) await generateAnchorAssetStep(videoId, role);
    return completeAnchorAssetsPhaseStep(videoId);
  }
  if (phase.runner === "shot_generation") {
    const shots = await prepareShotGenerationPhaseStep(videoId, false);
    for (const shot of shots) await runQueuedSeedanceShot(videoId, shot.shotIndex);
    return completeShotGenerationPhaseStep(videoId);
  }
  return runVideoPhaseStep(videoId, phase.phaseNumber);
}

async function runQueuedSeedanceShot(videoId: string, shotIndex: number) {
  let submission = await submitSeedanceShotStep(videoId, shotIndex);
  if (submission.state === "complete") return submission;
  let replacements = 0;

  for (let attempt = 0; attempt < SEEDANCE_MAX_POLLS_PER_SHOT; attempt += 1) {
    const result = await pollSeedanceShotStep(
      videoId,
      shotIndex,
      submission.requestId,
      submission.submittedAt,
    );
    if (result.state === "complete") return result;
    if (result.state === "retryable_failed") {
      replacements += 1;
      if (replacements > SEEDANCE_MAX_REPLACEMENTS_PER_SHOT) {
        const message = `Seedance shot ${shotIndex + 1} could not produce a retrievable result after ${SEEDANCE_MAX_REPLACEMENTS_PER_SHOT} replacement attempts.`;
        await failShotGenerationPhaseStep(videoId, message);
        throw new Error(message);
      }
      submission = await resubmitSeedanceShotStep(
        videoId,
        shotIndex,
        result.requestId,
        result.error,
        replacements,
      );
      if (submission.state === "complete") return submission;
    }
    await sleep(SEEDANCE_POLL_INTERVAL);
  }

  const message = `Seedance shot ${shotIndex + 1} did not complete before the polling budget expired.`;
  await failShotGenerationPhaseStep(videoId, message);
  throw new Error(message);
}
