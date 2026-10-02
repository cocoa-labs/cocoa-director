import type { AnchorAsset, AnchorProviderControls, CreativeBrief, MusicPlan, VideoSeeds } from "@/lib/schemas";
import { getProviders } from "@/providers";
import type { AnchorReferenceInput, ProviderContext } from "@/providers/types";

const VISIBLE_PERFORMER_ROLES: AnchorAsset["role"][] = ["character", "style", "environment", "palette"];
const CONCEPTUAL_ROLES: AnchorAsset["role"][] = ["style", "environment", "palette"];

// Intent of a user-seeded anchor. A CHARACTER seed (consented) renders a stylized "you";
// an AESTHETIC seed steers look/motif. Threaded into promptFor to pick the right clauses.
type SeedIntent = "character" | "aesthetic";

// The identity-safety ban — applied to every UNSEEDED anchor and every AESTHETIC seed
// (a foliage reference must never grow a person). Lifted ONLY for a consented character seed.
const IDENTITY_SAFETY_CLAUSE =
  "Fictional adult performers only. No real-person or celebrity likeness. Identity-safe stylized concept art only: no photorealistic portrait, no live-action photo look, no face that resembles a specific real person.";
// Replaces the ban for a consented character seed: a true-to-life likeness rendered in the
// video's own medium — photoreal for this app's cinematic videos, matching the style for a
// stylized one — with the original photo's background/occasion explicitly discarded.
const PHOTOREAL_LIKENESS_CLAUSE =
  "Render a true-to-life likeness from the provided reference image(s): preserve the person's real facial structure, features, skin texture, and hairstyle so they are unmistakably recognizable as themselves. Render them in this video's established medium and realism — when the art direction is photographic or cinematic, keep them fully photorealistic, like a real film still (not an illustration, not a cartoon); when the art direction is illustrated or animated, match that style instead. Discard the original photo's background, setting, lighting, clothing context, and occasion; place them on a clean backdrop consistent with the video world. No readable text, names, or logos.";
// Leads an aesthetic-seeded style/environment/palette prompt so the reference steers
// look/motif rather than being copied literally.
const AESTHETIC_SEED_LEAD =
  "Derive color grade, palette, materials, lighting logic, and motifs from the provided reference image(s); reinterpret them in this video's medium rather than copying the image literally.";

export const ANCHOR_ROLE_ATTEMPT: Record<AnchorAsset["role"], number> = {
  character: 1,
  style: 2,
  environment: 3,
  palette: 4,
  title: 5,
};

export async function createAnchorAssets(
  brief: CreativeBrief,
  musicPlan: MusicPlan | undefined,
  context: Omit<ProviderContext, "idempotencyKey">,
  idempotencyKeyFor: (role: AnchorAsset["role"]) => string,
  editDirection = "",
  providerControls?: AnchorProviderControls,
  seeds?: VideoSeeds,
) {
  const providers = getProviders();
  const roles = getAnchorRoles(brief, seeds);

  const results = await mapWithConcurrency(roles, 2, async (role) => {
    const seed = anchorSeedFor(role, seeds);
    const result = await providers.images.generateAnchorAsset(
      role,
      promptFor(role, brief, musicPlan, editDirection, seed?.intent),
      {
        ...context,
        idempotencyKey: idempotencyKeyFor(role),
      },
      providerControls,
      seed?.references,
    );
    return seed ? withSeedProvenance(result, seed) : result;
  });

  return results;
}

export function getAnchorRoles(brief: CreativeBrief, seeds?: VideoSeeds): AnchorAsset["role"][] {
  const base = brief.visualMode === "visible_performer" && brief.subject.type === "character"
    ? VISIBLE_PERFORMER_ROLES
    : CONCEPTUAL_ROLES;
  // A consented character seed forces the character anchor even in conceptual mode,
  // so the user appears regardless of the inferred visual mode.
  const hasCharacterSeed = (seeds?.subjects.length ?? 0) > 0;
  return hasCharacterSeed && !base.includes("character") ? ["character", ...base] : base;
}

export type ResolvedAnchorSeed = { intent: SeedIntent; references: AnchorReferenceInput };

// Resolve the seed (if any) bound to a given anchor role: the single character subject
// for the "character" role, or a matching aesthetic reference for style/environment/palette.
export function anchorSeedFor(role: AnchorAsset["role"], seeds?: VideoSeeds): ResolvedAnchorSeed | null {
  if (!seeds) return null;
  if (role === "character") {
    const subject = seeds.subjects[0];
    if (!subject) return null;
    return {
      intent: "character",
      references: {
        images: subject.images.map((image) => ({ url: image.url, mimeType: image.mimeType })),
        intent: "character",
        allowLikeness: subject.consent.affirmed === true,
      },
    };
  }
  const aesthetic = seeds.aesthetic.find((entry) => entry.role === role);
  if (!aesthetic) return null;
  return {
    intent: "aesthetic",
    references: {
      images: [{ url: aesthetic.image.url, mimeType: aesthetic.image.mimeType }],
      intent: "aesthetic",
      allowLikeness: false,
    },
  };
}

// Stamp where a seeded anchor came from so downstream (shot plan reuse-audit, UI badges)
// can tell a user-seeded plate apart and protect it.
export function seededFromFor(seed: ResolvedAnchorSeed): NonNullable<AnchorAsset["seededFrom"]> {
  return { intent: seed.intent, referenceCount: seed.references.images.length };
}

function withSeedProvenance<T extends { data: AnchorAsset }>(result: T, seed: ResolvedAnchorSeed): T {
  return { ...result, data: { ...result.data, seededFrom: seededFromFor(seed) } };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function promptFor(role: AnchorAsset["role"], brief: CreativeBrief, musicPlan?: MusicPlan, editDirection = "", seedIntent?: SeedIntent) {
  const voicePresentation = performerPresentation(musicPlan);
  const signature = brief.visualSignature;
  const hasUserMotifs = Boolean(signature?.recurringMotifs.length);
  const vocabulary = positiveVisualVocabulary(brief);
  const vocabularyInstruction = `Positive visual vocabulary for this run: ${vocabulary.join(", ")}. Build anchors from these concrete elements plus palette, material texture, lighting logic, setting geometry, and camera rhythm.`;
  const signatureDirection = signature
    ? [
        `Visual signature: ${signature.id}.`,
        `Palette family: ${signature.paletteFamily}.`,
        `Medium: ${signature.medium}.`,
        `World grammar: ${signature.worldGrammar}.`,
        signature.recurringMotifs.length > 0
          ? `User-derived motifs: ${signature.recurringMotifs.join(", ")}.`
          : "Build continuity through palette, texture, lighting logic, material details, and camera grammar.",
        `Texture: ${signature.texture}.`,
        `Camera language references: ${signature.cameraLanguage.join(", ")}.`,
        vocabularyInstruction,
      ].filter(Boolean).join(" ")
    : "";
  const base = [
    brief.visualWorld,
    signatureDirection,
    `Story: ${brief.storySpine}.`,
    `Subject: ${brief.subject.description}.`,
    hasUserMotifs
      ? "Use the image model as a production art department: create dense but legible cinematic plates with clear foreground, midground, and background separation; reusable color logic; material specificity; lighting motivation; and distinctive user-derived motifs."
      : "Use the image model as a production art department: create dense but legible cinematic plates with clear foreground, midground, and background separation; reusable color logic; material specificity; lighting motivation; and distinctive prompt-provided visual details when available.",
    "Every anchor should contain enough visual information for downstream reference-to-video: consistent lens language, practical light sources, coherent world rules, and multiple reusable details without becoming cluttered.",
    editDirection ? `User edit directives for this regeneration: ${editDirection}` : "",
    seedIntent === "aesthetic" ? AESTHETIC_SEED_LEAD : "",
    "Hard safety and continuity constraints: adults only, age 25 or older; no minors; no readable text anywhere in the image; no names; no age labels; no school names; no brand logos; no band logos; no copyrighted merch; no signatures; no captions; no UI; no watermarks.",
    seedIntent === "character" ? PHOTOREAL_LIKENESS_CLAUSE : IDENTITY_SAFETY_CLAUSE,
  ].filter(Boolean).join(" ");
  const promptDerivedDetail = hasUserMotifs
    ? "user-derived objects, materials, silhouettes, lighting pulses, atmospheric depth, and rhythmic texture"
      : "prompt-derived materials, instruments, settings, silhouettes, lighting pulses, atmospheric depth, and rhythmic texture";
  switch (role) {
    case "character":
      return seedIntent === "character"
        ? `${base} Use the provided reference image(s) as the identity source for one adult ${voicePresentation} lead. Produce a clean character reference of this exact person — front view, three-quarter view, and side view in one frame — rendered in the video's established medium (photorealistic and cinematic when the art direction is photographic). Preserve true-to-life facial features, skin texture, and hair; consistent neutral wardrobe and lighting that matches the video world. Clean neutral backdrop, neutral expression, readable silhouette, no props with logos, no text labels, no name, no age, no written annotations.`
        : `${base} Clean full-body illustrated character design sheet for one fictional adult ${voicePresentation} performer, three poses in one frame: front view, three-quarter view, side view. Use polished stylized production concept art with slightly simplified facial features, signature wardrobe silhouette, material swatches implied through clothing texture, and lighting that matches the video world. Plain seamless studio background, neutral expression, consistent generic wardrobe, readable silhouette, no props with logos, no text labels, no name, no age, no chart markings, no written annotations.`;
    case "style":
      return brief.visualMode === "visible_performer"
        ? `${base} Single cinematic style frame for color grade, lens language, lighting, movement energy, atmospheric depth, and texture. Include one readable staging idea and ${hasUserMotifs ? "secondary user-derived motif details" : "secondary material and lighting details"} that can support later shots. If people appear they are ${voicePresentation} adult silhouettes or fictional adult performers only. No readable signage, no campus or school name, no text, no logos.`
        : `${base} Shared coherence anchor only: one cinematic style frame that defines color grade, lens texture, lighting logic, emotional rhythm, and motion grammar while leaving room for varied later locations. Show ${promptDerivedDetail}. Keep any human presence distant or silhouette-based, with prompt-derived objects, environments, and motion carrying the musical energy. Make the concrete visual vocabulary feel specific to this prompt. No readable signage, campus or school name, text, or logos.`;
    case "environment":
      return `${base} Connected location atlas for the video world: compose 3 to 4 distinct spaces in one vertical concept-art plate, all sharing the same art direction. Include varied scale and setting types such as an interior room, an exterior threshold, an object-scale micro environment, and one wide establishing space when appropriate. Each space should feel related but clearly different in lighting source, camera distance, geometry, weather, and subject type. Add practical environmental detail that gives Seedance strong reference cues: surfaces, depth layers, props without logos, and motivated light sources. Empty or distant adult silhouettes only. No school signage, no readable text, no logos, no posters, no license plates.`;
    case "palette":
      return hasUserMotifs
        ? `${base} Material and continuity plate, not a repeated environment: arrange user-derived motifs, tactile materials, lighting cues, color swatches, surface textures, wardrobe or prop material references when safe, and physical motion shapes that can be reused across different settings. Include variation in object scale, material, and lighting state. Make the palette feel sampled from real cinematic objects rather than flat swatches. No people, no text, no logos.`
        : `${base} Material and continuity plate, not a repeated environment: arrange tactile materials, lighting cues, color swatches, surface textures, prompt-derived prop or instrument material references when safe, and physical motion shapes that can be reused across different settings. Include variation in object scale, material, and lighting state. Make the palette feel sampled from real cinematic objects and the user's concrete visual vocabulary rather than flat swatches. No people, no text, no logos.`;
    case "title":
      return `${base} Abstract texture plate with shapes, light, and material rhythm only. Do not render any actual text in the image.`;
  }
}

function positiveVisualVocabulary(brief: CreativeBrief) {
  const motifs = brief.visualSignature?.recurringMotifs ?? [];
  if (motifs.length > 0) return unique(motifs);
  const contractVocabulary = brief.styleContract?.visualIntent.positiveVocabulary ?? [];
  if (contractVocabulary.length > 0) return unique(contractVocabulary).slice(0, 6);
  if (brief.visualSignature?.id === "live_band_performance") {
    return ["stage light", "instrument texture", "amplifier grille cloth", "cable motion", "drum-riser energy"];
  }
  return ["palette shifts", "material texture", "lighting sources", "setting geometry", "camera rhythm"];
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function performerPresentation(musicPlan?: MusicPlan) {
  if (musicPlan?.voiceFamily === "male") return "male-presenting";
  if (musicPlan?.voiceFamily === "female") return "female-presenting";
  if (musicPlan?.voiceFamily === "mixed") return "mixed-gender ensemble";
  return "gender-neutral";
}
