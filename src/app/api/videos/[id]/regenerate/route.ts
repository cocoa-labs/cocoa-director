import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/server/api-error";

import {
  createArtifactSnapshot,
  createEditDirective,
  directiveTextForControls,
  scopeForPhase,
} from "@/lib/editor";
import { hasProviderControls } from "@/lib/provider-capabilities";
import { RegenerateRequest } from "@/lib/schemas";
import { getProviderMode } from "@/lib/server/config";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import {
  assertVideoActionAllowed,
  estimateRegeneratePhaseCents,
  spendGuardResponse,
} from "@/lib/server/video-action-guard";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: RouteContext<"/api/videos/[id]/regenerate">) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const existing = auth.job;

    const body = RegenerateRequest.parse(await request.json());
    const idempotencyKey = idempotencyKeyFromRequest(request, body);
    if (!idempotencyKey) {
      return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });
    }
    const guard = await assertVideoActionAllowed({
      action: `regenerate_phase_${body.phase}`,
      estimatedCostCents: estimateRegeneratePhaseCents(existing, body.phase),
      idempotencyKey,
      job: existing,
      metadata: { phase: body.phase, target: body.target },
      user: auth.user,
    });
    if (guard.replayed) {
      return NextResponse.json({ videoId: id, state: existing.status, currentPhase: existing.currentPhase, replayed: true });
    }

    const scope = body.target?.scope ?? scopeForPhase(body.phase);
    const target = {
      scope,
      phase: body.target?.phase ?? body.phase,
      targetId: body.target?.targetId,
    };
    const directiveText = body.directiveText?.trim();
    const shouldCreateDirective = Boolean(
      directiveText || body.strategy || hasProviderControls(body.providerControls),
    );
    const directive = shouldCreateDirective
      ? createEditDirective({
          scope,
          phase: target.phase,
          targetId: target.targetId,
          text: directiveText || directiveTextForControls(body.providerControls, body.strategy),
          strategy: body.strategy,
          providerControls: body.providerControls,
        })
      : null;
    const snapshot = createArtifactSnapshot(
      existing,
      target,
      `Before ${scope} regeneration`,
    );

    await getStore().updateJob(id, {
      editDirectives: directive ? [...existing.editDirectives, directive] : existing.editDirectives,
      artifactVersions: snapshot ? [...existing.artifactVersions, snapshot] : existing.artifactVersions,
    });

    if (getProviderMode() === "live") {
      await getStore().updateJob(id, { status: "pending", error: undefined });
      await getStore().updatePhase(id, body.phase, {
        state: "pending",
        startedAt: undefined,
        completedAt: undefined,
        artifactUrl: undefined,
        error: undefined,
      });
      const { start } = await import("workflow/api");
      const { regenerateVideoPhaseWorkflow } = await import("@/workflow/live");
      await start(regenerateVideoPhaseWorkflow, [id, body.phase]);
      return NextResponse.json(
        { videoId: id, state: "pending", currentPhase: body.phase, queued: true },
        { status: 202 },
      );
    }

    const { regeneratePhase } = await import("@/workflow");
    const job = await regeneratePhase(id, body.phase);
    return NextResponse.json({ videoId: job.id, state: job.status, currentPhase: job.currentPhase });
  } catch (error) {
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    const message = error instanceof Error ? error.message : "Regenerate failed";
    console.error("POST /api/videos/[id]/regenerate failed", error);
    return apiErrorResponse(error, message);
  }
}

export async function POST(request: Request, context: RouteContext<"/api/videos/[id]/regenerate">) {
  return actionRequest(request, () => handlePOST(request, context));
}
