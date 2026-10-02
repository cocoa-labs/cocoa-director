"use client";

import type { VideoJob } from "@/lib/schemas";
import { useState } from "react";

const runtime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export function EditorialDurationReview({ job, busy, onReplan }: { job: VideoJob; busy?: boolean; onReplan: (excluded: string[]) => void }) {
  const plan = job.durationPlan;
  const [excluded, setExcluded] = useState<string[]>(plan?.excludedClaimIds ?? []);
  if (!plan || plan.mode === "fixed") return null;
  const included = plan.coverage.filter((point) => point.included);
  const omitted = plan.coverage.filter((point) => !point.included);
  return <section className="status-card space-y-3 text-sm" aria-label="Runtime and coverage">
    <div className="flex items-center justify-between gap-3">
      <strong>{plan.resolvedDurationSeconds ? "Recorded runtime" : "Recommended runtime"}</strong>
      <span className="font-mono text-accent">{runtime(plan.resolvedDurationSeconds ?? plan.estimatedDurationSeconds)}</span>
    </div>
    <p>{plan.rationale}</p>
    {plan.requestedTargetSeconds ? <p className="text-xs text-muted">Requested about {runtime(plan.requestedTargetSeconds)} · usual range {runtime(Math.round(plan.requestedTargetSeconds * .8))}–{runtime(Math.round(plan.requestedTargetSeconds * 1.2))}</p> : null}
    <p className="text-xs">{included.length} source points included · {included.filter((point) => point.priority === "essential").length} essential · {omitted.length} omitted</p>
    <details className="text-xs">
      <summary className="cursor-pointer text-accent">Review coverage and omissions</summary>
      <ul className="mt-3 space-y-3">{plan.coverage.map((point) => <li key={point.claimId}>
        <label className="flex items-start gap-2"><input type="checkbox" aria-label={`Include ${point.claimId}`} checked={!excluded.includes(point.claimId)} disabled={busy || job.status === "running"} onChange={(event) => setExcluded((current) => event.target.checked ? current.filter((id) => id !== point.claimId) : [...current, point.claimId])} /><span><strong>{point.included ? "Included" : "Omitted"} · {point.role}</strong>: {point.text}</span></label>
        <p className="mt-1 text-muted">{point.reason} Sources: {point.sourceIds.map((id) => job.sourceBundle?.inputs.find((source) => source.id === id)?.title ?? id).join(", ")}</p>
      </li>)}</ul>
      <button type="button" className="secondary-command mt-3 w-full" disabled={busy || job.status === "running" || plan.coverage.every((point) => excluded.includes(point.claimId))} onClick={() => onReplan(excluded)}>Replan selected scope</button>
    </details>
    {!plan.scopeTooLong ? <p className="text-xs text-muted">Estimated remaining allowance: ${((job.estimatedCostCents + job.recoveryBudgetCents) / 100).toFixed(2)}. Review the script and storyboard before narration and visuals begin.</p> : null}
    {plan.scopeTooLong ? <p className="text-amber-200">This outline is saved in full. Narrow the script or selected source points to fit within ten minutes.</p> : null}
  </section>;
}
