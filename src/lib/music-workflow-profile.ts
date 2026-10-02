import type { PhaseNumber } from "@/lib/schemas";

export type LegacyPhaseRunner = "phase" | "anchor_assets" | "shot_generation";

export type LegacyMusicPhaseDefinition = {
  phaseNumber: PhaseNumber;
  name: string;
  runner: LegacyPhaseRunner;
};

/** Single compatibility definition for every music-video-v1 phase consumer. */
export const MUSIC_VIDEO_V1_PHASES: readonly LegacyMusicPhaseDefinition[] = [
  { phaseNumber: 1, name: "Treatment", runner: "phase" },
  { phaseNumber: 2, name: "Composition plan", runner: "phase" },
  { phaseNumber: 3, name: "Music render", runner: "phase" },
  { phaseNumber: 4, name: "Beat extraction", runner: "phase" },
  { phaseNumber: 5, name: "Anchor assets", runner: "anchor_assets" },
  { phaseNumber: 6, name: "Shot plan", runner: "phase" },
  { phaseNumber: 7, name: "Shot generation", runner: "shot_generation" },
  { phaseNumber: 8, name: "QA and regeneration", runner: "phase" },
  { phaseNumber: 9, name: "Render", runner: "phase" },
] as const;

/** Phases executed by one approval-gate advance from a completed phase. */
export function musicVideoAdvanceBatch(currentPhase: number): LegacyMusicPhaseDefinition[] {
  const phaseNumbersByGate: Partial<Record<PhaseNumber, PhaseNumber[]>> = {
    1: [2],
    2: [3],
    3: [4, 5],
    4: [5],
    5: [6],
    6: [7, 8, 9],
    7: [8, 9],
    8: [9],
    9: [],
  };
  const numbers = phaseNumbersByGate[currentPhase as PhaseNumber] ?? [];
  return numbers.map((phaseNumber) => {
    const definition = MUSIC_VIDEO_V1_PHASES.find((phase) => phase.phaseNumber === phaseNumber);
    if (!definition) throw new Error(`Unknown music-video-v1 phase ${phaseNumber}.`);
    return definition;
  });
}
