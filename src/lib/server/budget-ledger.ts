import { randomUUID } from "node:crypto";
import { cents } from "@/lib/cost";
import type { UserContext } from "@/lib/server/auth";
import { actionContext, fingerprint } from "@/lib/server/action-request";
import { assertLiveEnvironmentReady, getGlobalDailyBudgetCapUsd, getDailyBudgetCapUsd, getProviderMode } from "@/lib/server/config";
import { criticalSection } from "@/lib/server/critical-section";
import { getSql, hasDatabase } from "@/lib/server/db";
import { getStore } from "@/lib/server/store";
import { ApiRequestError } from "@/lib/server/api-error";
import { usesNaturalDuration } from "@/lib/editorial-duration";

export type Reservation = {
  id: string; userId: string; scope: string; key: string; fingerprint: string;
  reservedCents: number; actualCents: number; metadata: Record<string, unknown>; createdAt: string;
};
const memory = new WeakMap<object, Map<string, Reservation>>();
function memoryLedger() {
  const store = getStore();
  let ledger = memory.get(store);
  if (!ledger) { ledger = new Map(); memory.set(store, ledger); }
  return ledger;
}

export function assertProvidersEnabled() {
  if (process.env.PROVIDER_CALLS_ENABLED === "false" ||
    (getProviderMode() === "live" && process.env.PROVIDER_CALLS_ENABLED !== "true")) {
    throw new ApiRequestError("Provider calls are paused.", 503, "provider_calls_paused");
  }
  if (getProviderMode() === "live") assertLiveEnvironmentReady();
}

async function reservations(): Promise<Reservation[]> {
  const rows = hasDatabase() ? await getSql()`select * from provider_reservations` : [];
  const values: Reservation[] = hasDatabase() ? rows.map((row) => ({ id: String(row.id), userId: String(row.user_id), scope: String(row.scope), key: String(row.request_key),
    fingerprint: String(row.fingerprint), reservedCents: Number(row.reserved_cents), actualCents: Number(row.actual_cents),
    metadata: row.metadata as Record<string, unknown>, createdAt: new Date(String(row.created_at)).toISOString() })) : structuredClone([...memoryLedger().values()]);
  for (const value of values.filter((item) => !item.metadata.parentId)) {
    const job = typeof value.metadata.videoJobId === "string" ? await getStore().getJob(value.metadata.videoJobId) : null;
    const generation = typeof value.metadata.projectId === "string" && typeof value.metadata.mediaGenerationId === "string"
      ? await getStore().getMediaGeneration(value.metadata.projectId, value.metadata.mediaGenerationId) : null;
    // Failed/cancelled calls can still have ambiguous provider outcomes. Keep their
    // allowance until reconciled; a successful saved resource is safe to close.
    const resource = job ?? generation;
    const grantedAt = String(value.metadata.allowanceUpdatedAt ?? value.createdAt);
    value.metadata.settled = (job?.status === "complete" || generation?.status === "success") &&
      Boolean(resource?.updatedAt && resource.updatedAt >= grantedAt);
  }
  return values;
}

async function closeCompletedAllowances(values: Reservation[]) {
  for (const value of values.filter((item) => !item.metadata.parentId && item.metadata.settled === true)) {
    const calls = values.filter((item) => item.metadata.parentId === value.id && item.metadata.attempt);
    if (!calls.length) continue;
    const committed = Math.max(value.actualCents, calls.reduce((sum, call) => sum + Math.max(call.reservedCents, call.actualCents), 0));
    if (value.reservedCents !== committed) {
      value.reservedCents = committed;
      await save(value);
    }
  }
}

async function save(value: Reservation) {
  if (!hasDatabase()) { memoryLedger().set(value.id, structuredClone(value)); return; }
  await getSql()`insert into provider_reservations(id, user_id, scope, request_key, fingerprint, reserved_cents, actual_cents, metadata)
    values (${value.id}, ${value.userId}, ${value.scope}, ${value.key}, ${value.fingerprint}, ${value.reservedCents}, ${value.actualCents}, ${JSON.stringify(value.metadata)}::jsonb)
    on conflict (id) do update set reserved_cents = excluded.reserved_cents, actual_cents = excluded.actual_cents, metadata = excluded.metadata`;
}

function chargedToday(values: Reservation[], userId?: string) {
  const today = new Date().toISOString().slice(0, 10);
  const groups = new Map<string, { envelope: number; calls: number }>();
  const roots = new Map(values.filter((value) => !value.metadata.parentId).map((value) => [value.id, value]));
  const trackedRoots = new Set(values.filter((value) => value.metadata.parentId && value.metadata.attempt).map((value) => String(value.metadata.parentId)));
  for (const value of values) {
    const root = String(value.metadata.parentId ?? value.id);
    if (userId && value.userId !== userId) continue;
    if (!value.createdAt.startsWith(today) && roots.get(root)?.metadata.settled === true) continue;
    const group = groups.get(root) ?? { envelope: 0, calls: 0 };
    if (value.metadata.parentId) group.calls += Math.max(value.reservedCents, value.actualCents);
    // Close only unused parent allowance after a saved success. Every actual attempt,
    // including failed retries with uncertain billing, keeps its full reservation.
    else group.envelope += value.metadata.settled === true && trackedRoots.has(root)
      ? value.actualCents : Math.max(value.reservedCents, value.actualCents);
    groups.set(root, group);
  }
  return [...groups.values()].reduce((sum, group) => sum + Math.max(group.envelope, group.calls), 0);
}

export async function bindCurrentMediaReservation(projectId: string, mediaGenerationId: string) {
  const id = actionContext.getStore()?.reservationId;
  if (!id) return;
  await criticalSection("provider-budget", async () => {
    const value = (await reservations()).find((item) => item.id === id);
    if (value && !value.metadata.videoJobId) {
      value.metadata = { ...value.metadata, projectId, mediaGenerationId };
      await save(value);
    }
  });
}

async function checkCaps(values: Reservation[], user: UserContext) {
  // Include billing from before the ledger migration without double-counting covered requests/jobs.
  const today = new Date().toISOString().slice(0, 10);
  const events = (await getStore().listProviderAuditEvents(0)).filter((event) => event.createdAt.startsWith(today) &&
    ["submitted", "success"].includes(event.status) && !event.metadata.reservationId &&
    !values.some((value) => value.userId === event.userId && (
      (event.idempotencyKey && value.key === event.idempotencyKey) ||
      (event.videoJobId && value.metadata.videoJobId === event.videoJobId))));
  const legacy = new Map<string, { user: string; cost: number }>();
  for (const event of events) {
    const key = JSON.stringify([event.userId, event.metadata.source, event.model, event.idempotencyKey ?? event.requestId ?? event.id]);
    legacy.set(key, { user: event.userId, cost: Math.max(legacy.get(key)?.cost ?? 0, event.actualCostCents, event.estimatedCostCents) });
  }
  const global = chargedToday(values) + [...legacy.values()].reduce((sum, value) => sum + value.cost, 0);
  const personal = chargedToday(values, user.id) + [...legacy.values()].filter((value) => value.user === user.id).reduce((sum, value) => sum + value.cost, 0);
  if (global > cents(getGlobalDailyBudgetCapUsd())) throw new ApiRequestError("Global daily provider budget reached.", 429, "global_spend_cap_reached");
  if (!user.spendCapExempt && personal > user.dailyBudgetCents) throw new ApiRequestError("Daily provider budget reached.", 429, "daily_spend_cap_reached");
}

export async function reserveBudget(input: {
  user: UserContext; scope: string; key?: string; estimatedCostCents: number; metadata?: Record<string, unknown>; videoJobId?: string;
  allowanceMode?: "remaining";
}) {
  assertProvidersEnabled();
  if (!Number.isSafeInteger(input.estimatedCostCents) || input.estimatedCostCents < 0) throw new ApiRequestError("Invalid cost estimate.", 400, "invalid_cost");
  const context = actionContext.getStore();
  const key = input.key ?? randomUUID();
  const hash = context?.fingerprint ?? fingerprint({ scope: input.scope, estimate: input.estimatedCostCents, metadata: input.metadata, allowanceMode: input.allowanceMode });
  return criticalSection("provider-budget", async () => {
    const values = await reservations();
    const existing = values.find((value) => value.userId === input.user.id && value.scope === input.scope && value.key === key);
    if (existing) {
      if (existing.fingerprint !== hash) throw new ApiRequestError("Idempotency key input changed.", 409, "idempotency_conflict");
      if (context) context.reservationId = String(existing.metadata.parentId ?? existing.id);
      return { reservation: existing, replayed: true };
    }
    const root = input.videoJobId ? values.find((value) => value.metadata.videoJobId === input.videoJobId && !value.metadata.parentId) : undefined;
    const value: Reservation = { id: randomUUID(), userId: input.user.id, scope: input.scope, key, fingerprint: hash,
      reservedCents: root ? 0 : input.estimatedCostCents, actualCents: 0,
      metadata: { ...input.metadata, videoJobId: input.videoJobId, spendCapExempt: input.user.spendCapExempt === true,
        ...(root ? { parentId: root.id, actionOnly: true } : {}) }, createdAt: new Date().toISOString() };
    if (root) {
      const wasSettled = root.metadata.settled === true && values.some((item) => item.metadata.parentId === root.id && item.metadata.attempt);
      if (wasSettled) {
        root.reservedCents = Math.max(root.actualCents, values.filter((item) => item.metadata.parentId === root.id)
          .reduce((sum, item) => sum + Math.max(item.reservedCents, item.actualCents), 0));
      }
      root.metadata = { ...root.metadata, settled: false, allowanceUpdatedAt: new Date().toISOString() };
      // Advancing consumes the original envelope; explicit regeneration/recovery adds a new allowance.
      if (input.allowanceMode === "remaining") {
        // A newly approved editorial version needs headroom after earlier calls,
        // including conservative reservations whose final charge is not known.
        const committed = values.filter((item) => item.metadata.parentId === root.id)
          .reduce((sum, item) => sum + Math.max(item.reservedCents, item.actualCents), 0);
        // Timing-only recovery continues the same storyboard's generation
        // allowance; its reusable narration must not be reserved a second time.
        const existingEditorialAllowance = !wasSettled && input.scope === "video_action_guard:approve_editorial_storyboard_and_generate" &&
          typeof input.metadata?.artifactVersionId === "string" && values.some((item) =>
            item.userId === input.user.id && item.scope === input.scope && item.metadata.parentId === root.id && item.metadata.actionOnly === true &&
            item.metadata.artifactVersionId === input.metadata?.artifactVersionId &&
            typeof item.metadata.maximumAuthorizedCents === "number" && item.metadata.maximumAuthorizedCents >= input.estimatedCostCents);
        if (!existingEditorialAllowance) root.reservedCents = Math.max(root.reservedCents, committed + input.estimatedCostCents);
      } else if (wasSettled || /(?:^|[:_])(?:regenerat(?:e|ion)|recover(?:y)?|edit|polish)(?:_|$)/.test(input.scope)) root.reservedCents += input.estimatedCostCents;
      else root.reservedCents = Math.max(root.reservedCents, input.estimatedCostCents);
    }
    await checkCaps([...values, value], input.user);
    await closeCompletedAllowances(values);
    if (root) await save(root);
    await save(value);
    if (context) context.reservationId = root?.id ?? value.id;
    return { reservation: value, replayed: false };
  });
}

export async function bindReservation(scope: string, key: string | undefined, userId: string, metadata: Record<string, unknown>) {
  if (!key) return;
  await criticalSection("provider-budget", async () => {
    const value = (await reservations()).find((value) => value.userId === userId && value.scope === scope && value.key === key);
    if (value) { value.metadata = { ...value.metadata, ...metadata }; await save(value); }
  });
}

/** Read only: report this production's actual allowance, not its planning estimate. */
export async function productionBudgetSnapshot(videoId: string) {
  const rows = hasDatabase() ? await getSql()`select id, reserved_cents, actual_cents, metadata from provider_reservations
    where metadata->>'videoJobId' = ${videoId}
      or metadata->>'parentId' in (select id::text from provider_reservations where metadata->>'videoJobId' = ${videoId})` : undefined;
  const values = rows ? rows.map((row) => ({ id: String(row.id), reservedCents: Number(row.reserved_cents), actualCents: Number(row.actual_cents), metadata: row.metadata as Record<string, unknown> }))
    : [...memoryLedger().values()];
  const roots = values.filter((value) => value.metadata.videoJobId === videoId && !value.metadata.parentId);
  if (roots.length === 0) return undefined;
  const ids = new Set(roots.map((root) => root.id));
  const authorizedCents = roots.reduce((sum, root) => sum + Math.max(root.reservedCents, root.actualCents), 0);
  const committedCents = values.filter((value) => ids.has(String(value.metadata.parentId)))
    .reduce((sum, value) => sum + Math.max(value.reservedCents, value.actualCents), 0);
  return { authorizedCents, committedCents, remainingCents: Math.max(0, authorizedCents - committedCents) };
}

/** Reserve each actual attempt, including retries, before submitting to a paid provider. */
export async function reserveProviderAttempt(input: { scope: string; key?: string; costCents: number; videoId?: string; sourceId?: string }) {
  assertProvidersEnabled();
  if (!Number.isSafeInteger(input.costCents) || input.costCents < 0) throw new ApiRequestError("Invalid cost estimate.", 400, "invalid_cost");
  if (getProviderMode() !== "live") return;
  const context = actionContext.getStore();
  const videoId = input.videoId ?? context?.videoId;
  const job = videoId ? await getStore().getJob(videoId) : null;
  if (job?.cancellationRequested || job?.status === "cancelled") throw new ApiRequestError("Production cancelled.", 409, "production_cancelled");
  const sourceId = input.sourceId ?? context?.sourceId;
  const source = sourceId ? await getStore().getProductionSource(sourceId) : null;
  const userId = job?.userId ?? source?.userId ?? context?.user.id;
  if (!userId) throw new ApiRequestError("Provider request has no authorized owner.", 409, "missing_provider_owner");
  await criticalSection("provider-budget", async () => {
    const values = await reservations();
    const root = values.find((value) => !value.metadata.parentId && (value.id === context?.reservationId || (job && value.metadata.videoJobId === job.id)));
    const user: UserContext = { ...(context?.user ?? { id: userId, email: "", planTier: "dev", dailyBudgetCents: cents(getDailyBudgetCapUsd()) }),
      spendCapExempt: context?.user.spendCapExempt ?? root?.metadata.spendCapExempt === true };
    // Recheck cancellation after acquiring the budget lock: waiting callers must not submit after cancellation.
    const currentJob = job ? await getStore().getJob(job.id) : null;
    if (currentJob?.cancellationRequested || currentJob?.status === "cancelled") throw new ApiRequestError("Production cancelled.", 409, "production_cancelled");
    if (currentJob && ["news_digest", "explainer"].includes(currentJob.contentType ?? "") && /^(fal:|openai:image|elevenlabs:|vercel:)/.test(input.scope)) {
      if (usesNaturalDuration(currentJob) && (currentJob.durationPlan?.needsReview || currentJob.durationPlan?.scopeTooLong)) throw new ApiRequestError("Review the current runtime and cost before generating media.", 409, "duration_review_required");
      for (const gate of ["script", "storyboard"] as const) {
        const version = currentJob.workflowSteps?.find((step) => step.id === gate)?.artifactVersionId;
        if (!version || !currentJob.approvals?.some((approval) => approval.gate === gate && approval.artifactVersionId === version)) {
          throw new ApiRequestError("Review and approve the current script and storyboard before generating media.", 409, "current_approval_required");
        }
      }
    }
    assertProvidersEnabled();
    const key = input.key ?? randomUUID();
    if (values.some((value) => value.userId === userId && value.scope === input.scope && value.key === key)) {
      throw new ApiRequestError("This provider attempt was already submitted. Recover its saved result before retrying.", 409, "provider_attempt_submitted");
    }
    const value: Reservation = { id: randomUUID(), userId, scope: input.scope, key, fingerprint: fingerprint(input), reservedCents: input.costCents, actualCents: 0,
      metadata: { parentId: root?.id, videoJobId: job?.id, attempt: true }, createdAt: new Date().toISOString() };
    if (root) {
      const committed = values.filter((item) => item.metadata.parentId === root.id).reduce((sum, item) => sum + item.reservedCents, 0);
      if (committed + value.reservedCents > root.reservedCents) throw new ApiRequestError("This production's reserved budget is exhausted. Review its cost before recovery.", 429, "production_budget_exhausted");
    }
    await checkCaps([...values, value], user);
    await closeCompletedAllowances(values);
    await save(value);
  });
}

export async function budgetSnapshot() {
  const values = await reservations();
  return { reservedTodayCents: chargedToday(values), reservations: values };
}
