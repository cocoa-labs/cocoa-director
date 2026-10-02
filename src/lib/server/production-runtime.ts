import type { ProductionWorkflowRun, VideoJob, WorkflowStep } from "@/lib/schemas";
import { initialWorkflowSteps, workflowProfileFor } from "@/lib/production";
import { getStore } from "@/lib/server/store";

export async function recordEditorialStep(
  productionId: string,
  stepId: string,
  state: WorkflowStep["state"],
  error?: string,
) {
  const store = getStore();
  const updated = await store.mutateJob(productionId, (job) => {
  const now = new Date().toISOString();
  const steps = editorialStepsFor(job).map((step): WorkflowStep => {
    if (step.id !== stepId) return step;
    return {
      ...step,
      state,
      startedAt: state === "running" ? step.startedAt ?? now : step.startedAt,
      completedAt: state === "complete" || state === "failed" || state === "cancelled" ? now : undefined,
      error,
    };
  });
  const status = state === "awaiting_user" ? "awaiting_user" as const
    : state === "failed" ? "failed" as const
      : job.status === "awaiting_user" || job.status === "pending" ? "running" as const : job.status;
  return {
    workflowVersion: workflowProfileFor(job.contentType ?? "news_digest").id,
    workflowSteps: steps,
    status,
    error: error ?? (state === "running" || state === "complete" ? undefined : job.error),
  };
  });
  await heartbeatLatestRun(productionId, state === "failed" ? "failed" : state === "awaiting_user" ? "awaiting_user" : "active", error);
  return updated;
}

export async function recordProductionFailure(productionId: string, stepId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const beforeFailure = await requireProduction(productionId);
  const runningIds = new Set(beforeFailure.workflowSteps?.filter((step) => step.state === "running").map((step) => step.id) ?? []);
  const persistedDownstreamStep = ["final_qa", "render", "preflight_qa", "timeline", "visual_rough_cut_qa"].find((candidate) => runningIds.has(candidate));
  await recordEditorialStep(productionId, persistedDownstreamStep ?? stepId, "failed", message);
  const store = getStore();
  return store.updateJob(productionId, { status: "failed", error: message });
}

export async function recordProductionNeedsAttention(productionId: string, message: string, recoveryToken?: string) {
  const store = getStore();
  await recordEditorialStep(productionId, "generation", "awaiting_user", message);
  await store.updateJob(productionId, { status: "awaiting_user", error: message });
  const run = (await store.listProductionWorkflowRuns(productionId))[0];
  if (run) await store.updateProductionWorkflowRun(run.runId, { state: "awaiting_user", recoveryToken, error: message, heartbeatAt: new Date().toISOString() });
}

export async function recordProductionComplete(productionId: string) {
  const store = getStore();
  const runs = await store.listProductionWorkflowRuns(productionId);
  const run = runs[0];
  if (run) await store.updateProductionWorkflowRun(run.runId, { state: "complete", heartbeatAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: undefined, errorCode: undefined });
}

export async function registerProductionWorkflowRun(input: {
  productionId: string;
  runId: string;
  kind: ProductionWorkflowRun["kind"];
  workflowVersion: string;
  metadata?: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  return getStore().createProductionWorkflowRun({
    ...input,
    state: "active",
    metadata: input.metadata ?? {},
    startedAt: now,
    heartbeatAt: now,
  });
}

export async function heartbeatLatestRun(productionId: string, state: ProductionWorkflowRun["state"] = "active", error?: string) {
  const store = getStore();
  const run = (await store.listProductionWorkflowRuns(productionId))[0];
  if (!run) return;
  await store.updateProductionWorkflowRun(run.runId, {
    state,
    error,
    heartbeatAt: new Date().toISOString(),
    completedAt: state === "complete" || state === "failed" || state === "cancelled" ? new Date().toISOString() : undefined,
  });
}

export function editorialStepsFor(job: VideoJob) {
  const profile = initialWorkflowSteps(job.contentType ?? "news_digest");
  const existing = new Map((job.workflowSteps ?? []).map((step) => [step.id, step]));
  return profile.map((step) => ({ ...step, ...existing.get(step.id), name: step.name, dependsOn: step.dependsOn }));
}

async function requireProduction(productionId: string) {
  const job = await getStore().getJob(productionId);
  if (!job) throw new Error("Production not found.");
  return job;
}
