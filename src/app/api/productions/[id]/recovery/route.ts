import { actionRequest } from "@/lib/server/action-request";
import { NextResponse } from "next/server";

import { ProductionRecoveryRequest } from "@/lib/schemas";
import { editorialRecoveryAllowanceCents } from "@/lib/editorial-costs";
import { apiErrorResponse } from "@/lib/server/api-error";
import { productionBudgetSnapshot } from "@/lib/server/budget-ledger";
import { getProductionProgress } from "@/lib/server/production-progress";
import {
  authorizeManualVisualQualityRecovery,
  authorizeIdentitySafeRecovery,
  latestFailedVisuals,
  prepareProductionDeliveryResume,
  reconcileProductionForRecovery,
  rebuildEditorialVisualPlan,
  salvageCollidedVisualAssets,
} from "@/lib/server/production-recovery";
import { registerProductionWorkflowRun } from "@/lib/server/production-runtime";
import { SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import { assertVideoActionAllowed, spendGuardResponse } from "@/lib/server/video-action-guard";
import { authorizeVideoRequest, idempotencyKeyFromRequest } from "@/lib/server/videos";

export const runtime = "nodejs";

async function handlePOST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const auth = await authorizeVideoRequest(request, id);
    if (auth.response) return auth.response;
    const body = ProductionRecoveryRequest.parse(await request.json());
    const idempotencyKey = idempotencyKeyFromRequest(request, body);
    if (!idempotencyKey) return NextResponse.json({ error: "Missing Idempotency-Key header" }, { status: 400 });

    if (body.action === "salvage_visuals" || body.action === "rebuild_visuals") {
      const guard = await assertVideoActionAllowed({
        action: "resume_editorial_production",
        estimatedCostCents: 0,
        idempotencyKey,
        job: auth.job,
        metadata: { recoveryAction: body.action, incrementalProviderCostCents: 0 },
        user: auth.user,
      });
      if (guard.replayed) return NextResponse.json({ productionId: id, replayed: true, progress: await getProductionProgress(id) });
      const result = body.action === "salvage_visuals"
        ? await salvageCollidedVisualAssets(id)
        : { job: await rebuildEditorialVisualPlan(id), salvaged: [], missing: [], incrementalProviderCostCents: 0 };
      return NextResponse.json({ productionId: id, ...result, progress: await getProductionProgress(id) }, { status: 200 });
    }

    if (body.action === "resume" && (auth.job.visualPlan?.qualityReport?.state === "failed" || auth.job.visualPlan?.qualityReport?.state === "needs_review")) {
      const runs = await getStore().listProductionWorkflowRuns(id);
      const waitingRun = runs.find((run) => run.state === "awaiting_user" && run.recoveryToken);
      if (waitingRun?.recoveryToken) {
        const { runVisualRoughCutQa } = await import("@/lib/server/visual-quality");
        const report = await runVisualRoughCutQa(id);
        if (!report.passed) {
          return NextResponse.json({
            error: "The corrected rough cut still has actionable findings.",
            code: "visual_qa_still_actionable",
            findings: report.findings,
          }, { status: 409 });
        }
        const guard = await assertVideoActionAllowed({
          action: "resume_editorial_production",
          estimatedCostCents: 0,
          idempotencyKey,
          job: auth.job,
          metadata: { recoveryAction: "resume", recoveryGate: "visual_rough_cut_qa", incrementalProviderCostCents: 0 },
          user: auth.user,
        });
        if (guard.replayed) return NextResponse.json({ productionId: id, replayed: true, progress: await getProductionProgress(id) });
        const { resumeHook } = await import("workflow/api");
        await resumeHook(waitingRun.recoveryToken, { action: "resume", beatIds: [] });
        await getStore().updateProductionWorkflowRun(waitingRun.runId, {
          state: "active",
          recoveryToken: undefined,
          error: undefined,
          heartbeatAt: new Date().toISOString(),
        });
        return NextResponse.json({ productionId: id, runId: waitingRun.runId, resumed: true, progress: await getProductionProgress(id) }, { status: 202 });
      }
    }

    if (body.action === "retry_failed_beats") {
      const report = auth.job.visualPlan?.qualityReport;
      if (!report || (report.state !== "failed" && report.state !== "needs_review")) {
        return NextResponse.json({
          error: "Visual rough-cut QA has not identified any beats that require recovery.",
          code: "visual_qa_not_actionable",
        }, { status: 409 });
      }
      const rejectedBeatIds = new Set(report.rejectedBeatIds);
      const requestedBeatIds = [...new Set(body.beatIds.length > 0 ? body.beatIds : report.rejectedBeatIds)]
        .filter((beatId) => rejectedBeatIds.has(beatId));
      if (requestedBeatIds.length === 0) {
        return NextResponse.json({
          error: "Visual rough-cut QA has no rejected beats available for recovery.",
          code: "visual_qa_has_no_rejected_beats",
        }, { status: 409 });
      }
      const runs = await getStore().listProductionWorkflowRuns(id);
      const waitingRun = runs.find((run) => run.state === "awaiting_user" && run.recoveryToken);
      if (!waitingRun?.recoveryToken) {
        return NextResponse.json({
          error: "The visual-quality workflow is not waiting for recovery input.",
          code: "visual_qa_not_waiting",
        }, { status: 409 });
      }
      const estimatedCostCents = requestedBeatIds.reduce((sum, beatId) => (
        sum + (auth.job.visualPlan?.beats.find((beat) => beat.id === beatId)?.costEstimateCents ?? 0)
      ), 0);
      const remainingReserve = Math.max(0, auth.job.recoveryBudgetCents - auth.job.recoverySpentCents);
      if (estimatedCostCents > remainingReserve && !body.confirmSpend) {
        return NextResponse.json({
          error: `Recovery requires $${(estimatedCostCents / 100).toFixed(2)}; confirm the incremental spend to continue.`,
          code: "recovery_spend_confirmation_required",
          estimatedCostCents,
          remainingReserveCents: remainingReserve,
        }, { status: 409 });
      }
      const confirmation = await recoveryAllowanceConfirmation(id, editorialRecoveryAllowanceCents(estimatedCostCents), body.confirmSpend);
      if (confirmation) return confirmation;
      const guard = await assertVideoActionAllowed({
        action: "resume_editorial_production",
        estimatedCostCents: body.confirmSpend ? editorialRecoveryAllowanceCents(estimatedCostCents) : 0,
        allowanceMode: body.confirmSpend ? "remaining" : undefined,
        idempotencyKey,
        job: auth.job,
        metadata: { requestedBeatIds, recoveryAction: body.action, recoveryGate: "visual_rough_cut_qa" },
        user: auth.user,
      });
      if (guard.replayed) return NextResponse.json({ productionId: id, replayed: true, progress: await getProductionProgress(id) });
      const authorization = await authorizeManualVisualQualityRecovery(id, requestedBeatIds, body.confirmSpend);
      if (authorization.paused) {
        return NextResponse.json({
          error: authorization.reason,
          code: "recovery_not_authorized",
          estimatedCostCents: authorization.requiredCents,
        }, { status: 409 });
      }
      const { resumeHook } = await import("workflow/api");
      await resumeHook(waitingRun.recoveryToken, {
        action: "retry_failed_beats",
        beatIds: authorization.authorized.map((item) => item.beatId),
      });
      await getStore().updateProductionWorkflowRun(waitingRun.runId, {
        state: "active",
        recoveryToken: undefined,
        error: undefined,
        heartbeatAt: new Date().toISOString(),
      });
      return NextResponse.json({ productionId: id, runId: waitingRun.runId, resumed: true, progress: await getProductionProgress(id) }, { status: 202 });
    }

    const media = await getStore().listJobMedia(id);
    const failures = latestFailedVisuals(media.generations);
    if (body.action === "resume" && failures.length === 0) {
      const confirmation = await recoveryAllowanceConfirmation(id, 50, body.confirmSpend);
      if (confirmation) return confirmation;
      const guard = await assertVideoActionAllowed({
        action: "resume_editorial_production",
        estimatedCostCents: body.confirmSpend ? 50 : 0,
        allowanceMode: body.confirmSpend ? "remaining" : undefined,
        idempotencyKey,
        job: auth.job,
        metadata: { resumeFrom: "timeline", existingSuccessfulAssets: media.assets.length },
        user: auth.user,
      });
      if (guard.replayed) return NextResponse.json({ productionId: id, replayed: true, progress: await getProductionProgress(id) });

      const prepared = await prepareProductionDeliveryResume(id);
      const { runNewsDeliveryResumeWorkflow } = await import("@/workflow/news");
      const { start } = await import("workflow/api");
      const run = await start(runNewsDeliveryResumeWorkflow, [id]);
      await registerProductionWorkflowRun({
        productionId: id,
        runId: run.runId,
        kind: "recovery",
        workflowVersion: prepared.contentType === "explainer" ? "explainer-v4" : "news-digest-v5",
        metadata: { resumeFrom: "timeline", retainedAssets: media.assets.length, incrementalProviderCostCents: 50 },
      });
      return NextResponse.json({ productionId: id, runId: run.runId, resumed: true, progress: await getProductionProgress(id) }, { status: 202 });
    }

    // Reject stale/successful selections before reserving budget or resetting steps.
    const failedBeatIds = new Set(failures.map((failure) => failure.beatId));
    const currentBeatIds = new Set(auth.job.visualPlan?.beats.map((beat) => beat.id));
    const requestedBeatIds = [...new Set(body.beatIds.length > 0 ? body.beatIds : failures.map((failure) => failure.beatId))]
      .filter((beatId) => failedBeatIds.has(beatId) && currentBeatIds.has(beatId));
    if (requestedBeatIds.length === 0) return NextResponse.json({ error: "No failed visual beats require recovery.", code: "no_failed_visuals" }, { status: 409 });
    const estimatedCostCents = requestedBeatIds.reduce((sum, beatId) => sum + (auth.job.visualPlan?.beats.find((beat) => beat.id === beatId)?.costEstimateCents ?? 0), 0);
    const remainingReserve = Math.max(0, auth.job.recoveryBudgetCents - auth.job.recoverySpentCents);
    if (estimatedCostCents > remainingReserve && !body.confirmSpend) {
      return NextResponse.json({
        error: `Recovery requires $${(estimatedCostCents / 100).toFixed(2)}; confirm the incremental spend to continue.`,
        code: "recovery_spend_confirmation_required",
        estimatedCostCents,
        remainingReserveCents: remainingReserve,
      }, { status: 409 });
    }
    const confirmation = await recoveryAllowanceConfirmation(id, editorialRecoveryAllowanceCents(estimatedCostCents), body.confirmSpend);
    if (confirmation) return confirmation;
    const guard = await assertVideoActionAllowed({
      action: "resume_editorial_production",
      estimatedCostCents: body.confirmSpend ? editorialRecoveryAllowanceCents(estimatedCostCents) : 0,
      allowanceMode: body.confirmSpend ? "remaining" : undefined,
      idempotencyKey,
      job: auth.job,
      metadata: { requestedBeatIds, recoveryAction: body.action, existingSuccessfulAssets: media.assets.length },
      user: auth.user,
    });
    if (guard.replayed) return NextResponse.json({ productionId: id, replayed: true, progress: await getProductionProgress(id) });

    const reconciled = await reconcileProductionForRecovery(id);
    const authorization = await authorizeIdentitySafeRecovery(id, failures, {
      explicit: true,
      confirmSpend: body.confirmSpend,
      requestedBeatIds,
    });
    if (authorization.paused) {
      return NextResponse.json({ error: authorization.reason, code: "recovery_not_authorized", estimatedCostCents: authorization.requiredCents }, { status: 409 });
    }

    const runs = await getStore().listProductionWorkflowRuns(id);
    const waitingRun = runs.find((run) => run.state === "awaiting_user" && run.recoveryToken);
    if (waitingRun?.recoveryToken) {
      const { resumeHook } = await import("workflow/api");
      await resumeHook(waitingRun.recoveryToken, { action: "safe_retry", beatIds: authorization.authorized.map((item) => item.beatId) });
      await getStore().updateProductionWorkflowRun(waitingRun.runId, { state: "active", recoveryToken: undefined, error: undefined, heartbeatAt: new Date().toISOString() });
      return NextResponse.json({ productionId: id, runId: waitingRun.runId, resumed: true, progress: await getProductionProgress(id) }, { status: 202 });
    }

    const { runNewsProductionWorkflow } = await import("@/workflow/news");
    const { start } = await import("workflow/api");
    const run = await start(runNewsProductionWorkflow, [id, {
      recoveryBeatIds: authorization.authorized.map((item) => item.beatId),
      identitySafeRecovery: true,
    }]);
    await registerProductionWorkflowRun({
      productionId: id,
      runId: run.runId,
      kind: "recovery",
        workflowVersion: reconciled.contentType === "explainer" ? "explainer-v4" : "news-digest-v5",
      metadata: { beatIds: authorization.authorized.map((item) => item.beatId), recoveryCostCents: authorization.requiredCents },
    });
    return NextResponse.json({ productionId: id, runId: run.runId, resumed: true, progress: await getProductionProgress(id) }, { status: 202 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof SpendGuardError) return spendGuardResponse(error);
    return apiErrorResponse(error, error instanceof Error ? error.message : "Production recovery failed.");
  }
}

/** An unconfirmed resume can consume existing allowance, but cannot enlarge it. */
async function recoveryAllowanceConfirmation(id: string, requiredCents: number, confirmed: boolean) {
  if (confirmed) return undefined;
  const remainingCents = (await productionBudgetSnapshot(id))?.remainingCents ?? 0;
  if (remainingCents >= requiredCents) return undefined;
  return NextResponse.json({
    error: `Authorize up to $${(requiredCents / 100).toFixed(2)} for the remaining work before resuming.`,
    code: "recovery_spend_confirmation_required",
    estimatedCostCents: requiredCents,
    remainingAuthorizedCents: remainingCents,
  }, { status: 409 });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return actionRequest(request, () => handlePOST(request, context));
}
