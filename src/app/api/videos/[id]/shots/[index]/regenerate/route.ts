import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import { cents } from "@/lib/cost";
import {
  appendDirectiveText,
  createArtifactSnapshot,
  createEditDirective,
  directiveTextForControls,
  directiveTextBlock,
  markDirectivesApplied,
  providerControlsFor,
} from "@/lib/editor";
import { applyShotProviderControls, hasProviderControls } from "@/lib/provider-capabilities";
import { ShotRegenerateRequest } from "@/lib/schemas";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import {
  assertVideoActionAllowed,
  estimateShotRegenerateCents,
  spendGuardResponse,
} from "@/lib/server/video-action-guard";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";
import { createIdempotencyKey } from "@/lib/trace";
import { getProviders } from "@/providers";

export const runtime = "nodejs";

async function handlePOST(
  request: Request,
  context: RouteContext<"/api/videos/[id]/shots/[index]/regenerate">,
) {
  const { id, index } = await context.params;
  const shotIndex = Number(index);
  const store = getStore();
  const auth = await authorizeVideoRequest(request, id);
  if (auth.response) return auth.response;
  const job = auth.job;
  const shot = job?.shotPlan?.shots.find((candidate) => candidate.shotIndex === shotIndex);

  if (!job || !shot || !job.creativeBrief) {
    return NextResponse.json({ error: "Shot not found" }, { status: 404 });
  }

  try {
    const text = await request.text();
    const body = ShotRegenerateRequest.parse(text ? JSON.parse(text) : {});
    const clientIdempotencyKey = idempotencyKeyFromRequest(request, body);
    if (!clientIdempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }
    const guard = await assertVideoActionAllowed({
      action: "regenerate_selected_shot",
      estimatedCostCents: estimateShotRegenerateCents(shot, job.aspectRatio),
      idempotencyKey: clientIdempotencyKey,
      job,
      metadata: { shotIndex },
      user: auth.user,
    });
    if (guard.replayed) {
      return NextResponse.json({ videoId: job.id, shot: job.generatedShots.find((candidate) => candidate.shotIndex === shotIndex), replayed: true });
    }

    const target = { scope: "shots" as const, phase: 7 as const, targetId: String(shotIndex) };
    const directiveText = body.directiveText?.trim();
    const shouldCreateDirective = Boolean(
      directiveText || body.strategy || hasProviderControls(body.providerControls),
    );
    const directive = shouldCreateDirective
      ? createEditDirective({
          ...target,
          text: directiveText || directiveTextForControls(body.providerControls, body.strategy),
          strategy: body.strategy,
          providerControls: body.providerControls,
        })
      : null;
    const snapshot = createArtifactSnapshot(job, target, `Before shot ${shotIndex + 1} regeneration`);
    const workingJob = await store.updateJob(id, {
      editDirectives: directive ? [...job.editDirectives, directive] : job.editDirectives,
      artifactVersions: snapshot ? [...job.artifactVersions, snapshot] : job.artifactVersions,
    });
    const editDirections = directiveTextBlock(workingJob, target, body.directiveIds);
    const providerControls = providerControlsFor(workingJob, target, body.directiveIds)?.shots;
    const directedShot = applyShotProviderControls(
      { ...shot, prompt: appendDirectiveText(shot.prompt, editDirections) },
      providerControls,
    );

    const result = await getProviders().video.generateShot(directedShot, job.creativeBrief, {
      videoId: id,
      traceId: job.traceId,
      phaseNumber: 7,
      idempotencyKey: createIdempotencyKey({
        videoId: id,
        phase: 7,
        shotIndex,
        attempt: (workingJob.generatedShots.find((generated) => generated.shotIndex === shotIndex)?.attempts ?? 1) + 1,
      }),
    }, providerControls);

    await store.addProviderCall({
      videoJobId: id,
      phaseNumber: 7,
      provider: "fal",
      model: "bytedance/seedance-2.0/reference-to-video",
      requestId: result.requestId,
      idempotencyKey: result.data.providerRequestId,
      latencyMs: result.latencyMs,
      costCents: cents(result.costUsd),
      status: "success",
    });

    const previous = workingJob.generatedShots.find((candidate) => candidate.shotIndex === shotIndex);
    const generatedShots = [
      ...workingJob.generatedShots.filter((candidate) => candidate.shotIndex !== shotIndex),
      { ...result.data, attempts: previous ? previous.attempts + 1 : result.data.attempts },
    ].sort((left, right) => left.shotIndex - right.shotIndex);
    const updated = await store.updateJob(id, {
      editDirectives: markDirectivesApplied(workingJob, target, body.directiveIds),
      shotPlan: workingJob.shotPlan
        ? {
            ...workingJob.shotPlan,
            shots: workingJob.shotPlan.shots.map((candidate) =>
              candidate.shotIndex === shotIndex ? directedShot : candidate,
            ),
          }
        : workingJob.shotPlan,
      generatedShots,
    });

    return NextResponse.json({ videoId: updated.id, shot: result.data });
  } catch (error) {
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    const message = error instanceof Error ? error.message : "Shot regeneration failed";
    console.error("POST /api/videos/[id]/shots/[index]/regenerate failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/videos/[id]/shots/[index]/regenerate">,
) {
  return actionRequest(request, () => handlePOST(request, context));
}
