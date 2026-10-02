import { createHash, randomUUID } from "node:crypto";

import type { PhaseNumber } from "@/lib/schemas";

export function createTraceId() {
  return `trace_${randomUUID()}`;
}

export function createIdempotencyKey(input: {
  videoId: string;
  phase: PhaseNumber;
  attempt?: number;
  shotIndex?: number;
  nonce?: string;
}) {
  const source = [
    input.videoId,
    input.phase,
    input.attempt ?? 1,
    input.shotIndex ?? "phase",
    input.nonce ?? "default",
  ].join(":");

  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

export function nowIso() {
  return new Date().toISOString();
}
