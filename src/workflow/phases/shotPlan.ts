import type { AnchorAsset, AnchorRole, BeatGrid, CreativeBrief, MusicPlan, Shot, ShotPlan } from "@/lib/schemas";

type SceneLane = {
  id: string;
  description: string;
};

type DiversityScore = {
  score: number;
  laneVariety: number;
  motifVariety: number;
  cameraVariety: number;
  adjacentRepeatCount: number;
};

const CONCEPTUAL_SCENE_LANES: SceneLane[] = [
  {
    id: "object_micro_chapter",
    description: "object-scale imagery where tactile materials, light, and motion become the lead subject",
  },
  {
    id: "interior_threshold",
    description: "a fresh interior or threshold space with practical light and a clear sense of arrival",
  },
  {
    id: "wide_world_reveal",
    description: "a wider establishing chapter that expands the world with a clearly different location",
  },
  {
    id: "abstract_motion_bridge",
    description: "graphic movement, reflections, shadows, and material transitions carry the rhythm",
  },
  {
    id: "silhouette_ritual",
    description: "distant adult silhouettes, hands, or bodies move as shapes inside the art direction",
  },
  {
    id: "material_transformation",
    description: "a prompt-derived material or continuity focus changes physical state through water, smoke, fabric, glass, metal, or light",
  },
  {
    id: "group_energy_tableau",
    description: "anonymous group movement or environmental choreography raises the section energy",
  },
  {
    id: "final_icon_escalation",
    description: "a resolved final image returns a prior visual idea at larger scale, stronger light, or a new angle",
  },
];

const VISIBLE_PERFORMER_SCENE_LANES: SceneLane[] = [
  {
    id: "performer_intro",
    description: "the matched fictional adult performer is introduced through body movement and silhouette",
  },
  {
    id: "wardrobe_detail",
    description: "hands, instruments, fabric, props, and light tell the performance story through detail-forward staging",
  },
  {
    id: "environment_stage",
    description: "the performer occupies a new stage-like environment with practical light and group energy",
  },
  {
    id: "movement_bridge",
    description: "camera and body movement create an edit-friendly bridge between musical sections",
  },
  {
    id: "ensemble_escalation",
    description: "anonymous adult silhouettes or dancers amplify the performer without changing the lead identity",
  },
];

const FALLBACK_CAMERA_LANGUAGE = [
  "medium tracking shot with controlled internal cuts",
  "macro insert with beat-synced physical motion",
  "wide reveal with practical light choreography",
  "push-in transition aligned to a downbeat",
  "locked graphic tableau with a strong center of gravity",
];

export async function createShotPlan(
  brief: CreativeBrief,
  beatGrid: BeatGrid,
  anchors: AnchorAsset[],
  musicPlan?: MusicPlan,
  editDirection = "",
): Promise<ShotPlan> {
  const sectionChanges = beatGrid.events.filter((event) => event.type === "section_change");
  // A user-seeded character plate is ALWAYS reuse-eligible: a stylized self-portrait can
  // score low on the vision audit, but dropping it would erase the user from their own video.
  const reusableAnchors = anchors.filter(
    (asset) => asset.audit?.reuseEligible !== false || asset.seededFrom?.intent === "character",
  );
  const hasSeededCharacter = reusableAnchors.some(
    (asset) => asset.role === "character" && asset.seededFrom?.intent === "character",
  );
  const shots: Shot[] = [];

  sectionChanges.forEach((section, index) => {
    const nextSection = sectionChanges[index + 1];
    const sectionEnd = nextSection?.timeMs ?? brief.durationSeconds * 1000;
    const sectionDuration = sectionEnd - section.timeMs;
    const generationCount = Math.max(1, Math.ceil(sectionDuration / 12000));
    let sectionCursor = section.timeMs;

    for (let i = 0; i < generationCount; i += 1) {
      const shotIndex = shots.length;
      const start = sectionCursor;
      const remainingShots = generationCount - i;
      const remainingDuration = sectionEnd - start;
      const targetEnd = start + Math.round(remainingDuration / remainingShots);
      const minimumEnd = start + Math.min(4_000, remainingDuration);
      const maximumEnd = Math.min(
        start + 15_000,
        sectionEnd - Math.max(0, remainingShots - 1) * 4_000,
      );
      const proposedEnd = i === generationCount - 1 ? sectionEnd : nearestDownbeat(beatGrid, targetEnd);
      const end = i === generationCount - 1
        ? sectionEnd
        : Math.max(minimumEnd, Math.min(maximumEnd, proposedEnd));
      sectionCursor = end;
      const duration = end - start;
      const internalCuts = internalCutsFor(duration, section.sectionId);
      const sceneLane = selectDistinct(
        sceneLanePool(brief),
        shotIndex + index,
        shots,
        (shot) => shot.sceneLane,
      );
      const visualMotif = selectDistinct(
        motifPool(brief),
        shotIndex + i + motifOffsetFor(section.sectionId),
        shots,
        (shot) => shot.visualMotif,
      );
      const cameraIntent = selectDistinct(
        cameraPool(brief),
        shotIndex + index + i,
        shots,
        (shot) => shot.cameraIntent,
      );
      const hasUserMotif = hasUserDerivedMotifs(brief);
      const referenceRoles = referenceRolesFor(brief, sceneLane, shotIndex, section.sectionId);
      const referenceImages = referenceUrls(referenceRoles, reusableAnchors);
      const cutDescriptions = timelineCuesFor(duration, internalCuts, cameraIntent, sceneLane, hasUserMotif);

      shots.push({
        shotIndex,
        startMs: start,
        endMs: end,
        seedanceMode: "reference-to-video",
        seedanceTier: "standard",
        resolution: "720p",
        prompt: buildShotPrompt({
          brief,
          musicPlan,
          editDirection,
          sectionId: section.sectionId,
          durationSeconds: Math.round(duration / 1000),
          sceneLane,
          visualMotif,
          cameraIntent,
          cutDescriptions,
          referenceRoles,
          hasUserMotif,
        }),
        referenceImages,
        sceneLane,
        visualMotif,
        cameraIntent,
        referenceRoles,
        seed: deterministicSeed(brief.videoId, shotIndex),
        internalCuts,
        seededCharacter: hasSeededCharacter && referenceRoles.includes("character") ? true : undefined,
      });
    }
  });

  return { videoId: brief.videoId, shots };
}

export function scoreShotPlanDiversity(planOrShots: ShotPlan | Shot[]): DiversityScore {
  const shots = Array.isArray(planOrShots) ? planOrShots : planOrShots.shots;
  if (shots.length <= 1) {
    return { score: 1, laneVariety: 1, motifVariety: 1, cameraVariety: 1, adjacentRepeatCount: 0 };
  }
  const laneVariety = uniqueRatio(shots.map((shot) => shot.sceneLane));
  const motifVariety = uniqueRatio(shots.map((shot) => shot.visualMotif));
  const cameraVariety = uniqueRatio(shots.map((shot) => shot.cameraIntent));
  const adjacentRepeatCount = shots.reduce((count, shot, index) => {
    if (index < 2) return count;
    const previous = shots[index - 1];
    const beforePrevious = shots[index - 2];
    const repeated =
      shot.sceneLane === previous.sceneLane && shot.sceneLane === beforePrevious.sceneLane ||
      shot.visualMotif === previous.visualMotif && shot.visualMotif === beforePrevious.visualMotif ||
      shot.cameraIntent === previous.cameraIntent && shot.cameraIntent === beforePrevious.cameraIntent;
    return repeated ? count + 1 : count;
  }, 0);
  const repeatPenalty = Math.min(0.35, adjacentRepeatCount * 0.12);
  const score = Math.max(0, Math.min(1, (laneVariety + motifVariety + cameraVariety) / 3 - repeatPenalty));
  return {
    score: Number(score.toFixed(2)),
    laneVariety: Number(laneVariety.toFixed(2)),
    motifVariety: Number(motifVariety.toFixed(2)),
    cameraVariety: Number(cameraVariety.toFixed(2)),
    adjacentRepeatCount,
  };
}

function buildShotPrompt(input: {
  brief: CreativeBrief;
  musicPlan?: MusicPlan;
  editDirection?: string;
  sectionId: string;
  durationSeconds: number;
  sceneLane: string;
  visualMotif: string;
  cameraIntent: string;
  cutDescriptions: string;
  referenceRoles: AnchorRole[];
  hasUserMotif: boolean;
}) {
  const escalation = input.hasUserMotif
    ? /chorus|peak|final/.test(input.sectionId)
      ? "This chorus-scale chapter revisits the user-derived motif with stronger scale, brighter light, denser motion, or a more decisive camera angle."
      : "This chapter moves into a fresh setting, material scale, or lighting state while staying in the same art direction."
    : /chorus|peak|final/.test(input.sectionId)
      ? "This chorus-scale chapter deepens the established palette, material language, movement density, or camera decisiveness."
      : "This chapter moves into a fresh setting, material scale, or lighting state while staying in the same art direction.";
  const visualFocus = input.hasUserMotif
    ? `Primary user-derived motif: ${input.visualMotif}.`
    : `Continuity focus: ${input.visualMotif}.`;
  return [
    `[Duration] ${input.durationSeconds} seconds, vertical music-video sequence for ${input.sectionId}.`,
    `[Scene lane] ${input.sceneLane}: ${sceneLaneDescription(input.brief, input.sceneLane)}.`,
    `[Shot-specific direction] ${escalation} ${visualFocus}`,
    referenceDirection(input.brief, input.referenceRoles, input.musicPlan),
    input.editDirection ? `[User edit directives] ${input.editDirection}` : "",
    castDirection(input.brief, input.musicPlan),
    `[Timeline] ${input.cutDescriptions}`,
    `[Camera intent] ${input.cameraIntent}; use clear physical motion, beat-aware blocking, controlled internal cuts, stable anatomy, and clean frame composition.`,
    `[Continuity] Preserve ${signatureContinuity(input.brief)}. Each chapter uses a fresh setting, material scale, or lighting state.`,
    positiveVocabularyDirection(input.brief),
  ].filter(Boolean).join(" ");
}

function nearestDownbeat(beatGrid: BeatGrid, timeMs: number) {
  const downbeats = beatGrid.events.filter((event) => event.type === "downbeat");
  if (downbeats.length === 0) return timeMs;
  const nearest = downbeats.reduce((best, event) =>
    Math.abs(event.timeMs - timeMs) < Math.abs(best.timeMs - timeMs) ? event : best,
  );
  return nearest.timeMs;
}

function internalCutsFor(durationMs: number, sectionId: string) {
  const cutCount = /chorus|peak|final/.test(sectionId) ? 3 : 2;
  return Array.from({ length: cutCount }, (_, index) =>
    Math.round(((index + 1) * durationMs) / (cutCount + 1)),
  );
}

function timelineCuesFor(
  durationMs: number,
  internalCuts: number[],
  cameraIntent: string,
  sceneLane: string,
  hasUserMotif: boolean,
) {
  const boundaries = [0, ...internalCuts, durationMs];
  return boundaries
    .slice(0, -1)
    .map((start, index) => {
      const end = boundaries[index + 1];
      const action = index === 0
        ? `${cameraIntent} introduces ${humanize(sceneLane)}`
        : index === boundaries.length - 2
          ? hasUserMotif
            ? "the user-derived motif escalates into a clear section-ending image"
            : "the visual idea escalates into a clear section-ending image"
          : `a related but distinct detail, scale, or lighting source takes over`;
      return `${msToSeconds(start)}-${msToSeconds(end)}s: ${action}`;
    })
    .join(" ");
}

function msToSeconds(timeMs: number) {
  return Number((timeMs / 1000).toFixed(1));
}

function referenceDirection(brief: CreativeBrief, referenceRoles: AnchorRole[], musicPlan?: MusicPlan) {
  const roleText = referenceRoles.length > 0 ? referenceRoles.join(", ") : "available visual";
  if (brief.visualMode === "visible_performer") {
    return `[References] Use the ${roleText} references for continuity: fictional adult ${performerPresentation(musicPlan)} performer presentation, generic wardrobe silhouette, lighting palette, lens texture, and selected environment mood.`;
  }
  const motifDirection = hasUserDerivedMotifs(brief) ? "user-derived motif language, " : "";
  return `[References] Use the ${roleText} references as guidance for shared color grade, ${motifDirection}lighting palette, atmospheric depth, and lens texture. Let the shot move into its own visual chapter.`;
}

function castDirection(brief: CreativeBrief, musicPlan?: MusicPlan) {
  if (brief.visualMode === "visible_performer") {
    return `[Cast] Every visible person is a fictional adult ${performerPresentation(musicPlan)} performer age 25 or older with an original non-celebrity face, generic wardrobe details, and clean identity-safe styling. Movement, staging, and edit rhythm carry the vocal energy.`;
  }
  return "[Cast] Conceptual-first video: silhouettes, hands, objects, environments, reflections, dance-like movement, light pulses, color shifts, and prompt-derived motion act as the synchronization layer.";
}

function performerPresentation(musicPlan?: MusicPlan) {
  if (musicPlan?.voiceFamily === "male") return "male-presenting";
  if (musicPlan?.voiceFamily === "female") return "female-presenting";
  if (musicPlan?.voiceFamily === "mixed") return "mixed-gender ensemble";
  return "gender-neutral";
}

function sceneLanePool(brief: CreativeBrief) {
  return (brief.visualMode === "visible_performer" ? VISIBLE_PERFORMER_SCENE_LANES : CONCEPTUAL_SCENE_LANES).map(
    (lane) => lane.id,
  );
}

function sceneLaneDescription(brief: CreativeBrief, laneId: string) {
  const lane = (brief.visualMode === "visible_performer" ? VISIBLE_PERFORMER_SCENE_LANES : CONCEPTUAL_SCENE_LANES)
    .find((candidate) => candidate.id === laneId);
  return lane?.description ?? humanize(laneId);
}

function motifPool(brief: CreativeBrief) {
  const signatureMotifs = brief.visualSignature?.recurringMotifs ?? [];
  if (signatureMotifs.length > 0) return unique(signatureMotifs);
  const contractVocabulary = brief.styleContract?.visualIntent.positiveVocabulary ?? [];
  if (contractVocabulary.length > 0) return unique(contractVocabulary).slice(0, 6);
  const fallback = brief.visualMode === "visible_performer"
    ? ["wardrobe texture", "stage light", "instrument detail", "group shadow", "performance pose"]
    : ["material change", "lighting shift", "reflection behavior", "camera rhythm", "environment scale"];
  return unique(fallback);
}

function cameraPool(brief: CreativeBrief) {
  return unique([...(brief.visualSignature?.cameraLanguage ?? []), ...FALLBACK_CAMERA_LANGUAGE]);
}

function referenceRolesFor(
  brief: CreativeBrief,
  sceneLane: string,
  shotIndex: number,
  sectionId: string,
): AnchorRole[] {
  if (brief.visualMode === "visible_performer") {
    if (/environment|ensemble|chorus|final/.test(`${sceneLane} ${sectionId}`)) {
      return ["character", "style", "environment"];
    }
    return ["character", "style"];
  }
  if (shotIndex === 0 || /wide|interior|group|final|chorus/.test(`${sceneLane} ${sectionId}`)) {
    return shotIndex === 0 ? ["style", "environment"] : ["style", "palette"];
  }
  if (/object|material|abstract/.test(sceneLane)) return ["style", "palette"];
  return ["style"];
}

function referenceUrls(referenceRoles: AnchorRole[], anchors: AnchorAsset[]) {
  return referenceRoles
    .map((role) => anchors.find((asset) => asset.role === role)?.url)
    .filter((url): url is string => Boolean(url));
}

function selectDistinct<T>(pool: T[], baseIndex: number, shots: Shot[], selector: (shot: Shot) => T) {
  let candidate = pool[baseIndex % pool.length];
  if (shots.length >= 2) {
    const previous = selector(shots[shots.length - 1]);
    const beforePrevious = selector(shots[shots.length - 2]);
    if (candidate === previous && candidate === beforePrevious) {
      candidate = pool[(baseIndex + 1) % pool.length];
    }
  }
  return candidate;
}

function motifOffsetFor(sectionId: string) {
  if (/chorus|final/.test(sectionId)) return 2;
  if (/bridge/.test(sectionId)) return 4;
  if (/pre/.test(sectionId)) return 1;
  return 0;
}

function signatureContinuity(brief: CreativeBrief) {
  const signature = brief.visualSignature;
  if (!signature) return "the established color grade, texture, lighting, material logic, and rhythm";
  const motifText = signature.recurringMotifs.length > 0
    ? `; user-derived motifs such as ${signature.recurringMotifs.slice(0, 3).join(", ")}`
    : "";
  return `${signature.paletteFamily}; ${signature.texture}${motifText}; palette, lighting, materials, and rhythm`;
}

function positiveVocabularyDirection(brief: CreativeBrief) {
  const motifs = brief.visualSignature?.recurringMotifs ?? [];
  const contractVocabulary = brief.styleContract?.visualIntent.positiveVocabulary ?? [];
  const vocabulary = motifs.length > 0
    ? motifs.slice(0, 5)
    : contractVocabulary.length > 0
      ? contractVocabulary.slice(0, 5)
      : brief.visualSignature?.id === "live_band_performance"
      ? ["stage light", "instrument texture", "amplifier grille cloth", "cable motion", "drum-riser energy"]
      : ["palette shifts", "material texture", "lighting sources", "setting geometry", "camera rhythm"];
  return `[Positive visual vocabulary] Build the shot around ${unique(vocabulary).join(", ")}, then vary scale, light, and camera motion for this section.`;
}

function uniqueRatio(values: string[]) {
  return new Set(values).size / Math.max(1, values.length);
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function humanize(value: string) {
  return value.replace(/_/g, " ");
}

function hasUserDerivedMotifs(brief: CreativeBrief) {
  return Boolean(brief.visualSignature?.recurringMotifs.length);
}

function deterministicSeed(videoId: string, shotIndex: number) {
  let seed = shotIndex + 17;
  for (const char of videoId) {
    seed = (seed * 31 + char.charCodeAt(0)) % 2147483647;
  }
  return seed;
}
