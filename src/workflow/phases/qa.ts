import type { GeneratedShot, ShotPlan } from "@/lib/schemas";

export async function judgeAndApplyRegenerationBudget(
  generatedShots: GeneratedShot[],
  shotPlan: ShotPlan,
  regenerate?: (
    generated: GeneratedShot,
    planned: ShotPlan["shots"][number],
  ) => Promise<GeneratedShot>,
) {
  const baseCost = generatedShots.reduce((sum, shot) => sum + shot.costUsd, 0);
  const regenBudget = baseCost * 0.25;
  let spent = 0;

  const judged: GeneratedShot[] = [];
  for (const shot of generatedShots) {
    const planned = shotPlan.shots.find((candidate) => candidate.shotIndex === shot.shotIndex);
    const score = scoreShot(shot, planned?.prompt ?? "");
    if (regenerate && planned && score < 0.72 && spent + shot.costUsd <= regenBudget && shot.attempts < 3) {
      spent += shot.costUsd;
      const replacement = await regenerate(shot, planned);
      judged.push({
        ...replacement,
        qaScore: scoreShot(replacement, planned.prompt),
        attempts: shot.attempts + 1,
      });
      continue;
    }
    judged.push({ ...shot, qaScore: score });
  }
  return judged;
}

function scoreShot(shot: GeneratedShot, prompt: string) {
  const promptSignal = Math.min(0.1, prompt.length / 2000);
  const durationSignal = shot.durationSeconds >= 5 && shot.durationSeconds <= 15 ? 0.18 : 0.08;
  const seedSignal = shot.seed % 2 === 0 ? 0.02 : 0.04;
  const conceptualPenalty =
    /Conceptual-first/i.test(prompt) && !/silhouettes|objects|environments|prompt-derived motion/i.test(prompt)
      ? 0.08
      : 0;
  const performerPenalty =
    /visible person|performer/i.test(prompt) &&
    !/female-presenting|male-presenting|mixed-gender ensemble|gender-neutral/i.test(prompt)
      ? 0.06
      : 0;
  return Number((0.68 + promptSignal + durationSignal + seedSignal - conceptualPenalty - performerPenalty).toFixed(2));
}
