import type { CreativeBrief, CreativeStyleContract, VideoJob, VisualSignature } from "@/lib/schemas";
import { hasPositivePromptMatch, negativePatternFor, stripDirectorInterventions } from "@/workflow/promptGuards";
import { resolveCreativeStyleContract } from "@/workflow/creativeStyleContract";

const CELEBRITY_STYLE = /\b(in the style of|like|as)\s+([A-Z][\w-]+(?:\s+[A-Z][\w-]+){0,3})/g;

type SignaturePreset = VisualSignature & {
  promptHints: RegExp[];
};

const OVERUSED_CONCEPTUAL_MOTIFS = [
  "teal cyberpunk skyline",
  "rain-slick megacity",
  "glowing circular portal",
  "single black-clad figure under a monolith",
  "repeated wet street reflection",
];

const VISUAL_SIGNATURES: SignaturePreset[] = [
  {
    id: "live_band_performance",
    paletteFamily: "stage tungsten, road-case black, oxidized silver, denim blue, and warm white",
    palette: ["stage tungsten", "road-case black", "oxidized silver", "denim blue", "warm white"],
    medium: "grounded live-band music-video cinema with practical stage light, instrument texture, and performance blocking",
    worldGrammar: "rehearsal rooms, small stages, amplifier walls, drum risers, backstage corridors, loading doors, and raw studio floors",
    recurringMotifs: [],
    texture: "amplifier grille cloth, scuffed stage wood, cable coils, cymbal shimmer, denim, leather, and controlled haze",
    cameraLanguage: ["low guitar tracking", "drum-riser push", "handheld stage orbit", "amp-wall reveal", "chorus crash zoom"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/\brock(?:[- ]?and[- ]?roll)?\b|\bguitars?\b|\bbands?\b|\bamps?\b|\bamplifiers?\b|\bdrums?\b|\briffs?\b|\bbass guitar\b/i],
  },
  {
    id: "analog_warmth",
    paletteFamily: "sun-faded amber, rose, denim blue, cream, and soft black",
    palette: ["sun-faded amber", "dusty rose", "denim blue", "cream", "soft black"],
    medium: "16mm analog music-film collage with practical bulbs and hand-built sets",
    worldGrammar: "motels, gymnasiums, paper streamers, parking-lot stages, diner glass, and handmade light rigs",
    recurringMotifs: [],
    texture: "warm film grain, halation, worn paper, scuffed vinyl, and soft lens bloom",
    cameraLanguage: ["handheld orbit", "snap zoom", "slow dolly", "stage-left tracking", "whip-pan cut"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/80s|1980|retro|nostalg|first[- ]?love|campus|dance|prom/i],
  },
  {
    id: "surreal_domestic",
    paletteFamily: "porcelain white, soap blue, butter yellow, tomato red, and chrome",
    palette: ["porcelain white", "soap blue", "butter yellow", "tomato red", "chrome"],
    medium: "surreal practical-object cinema with macro photography and miniature set pieces",
    worldGrammar: "kitchens, laundromats, tiled bathrooms, sinks, steam, bubbles, glassware, and impossible household scale shifts",
    recurringMotifs: [],
    texture: "wet ceramic, suds, soft steam, polished metal, and tactile everyday objects",
    cameraLanguage: ["macro push-in", "overhead choreography", "tabletop tracking", "waterline glide", "match cut"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/dish|kitchen|laundry|bath|home|domestic|chores?|sink|clean/i],
  },
  {
    id: "natural_mythic",
    paletteFamily: "moss green, river silver, ember gold, clay, and twilight blue",
    palette: ["moss green", "river silver", "ember gold", "clay", "twilight blue"],
    medium: "mythic nature cinema with grounded tactile effects and elemental lighting",
    worldGrammar: "forests, river stones, wind fields, cave mouths, handmade lanterns, smoke, and weather-worn ritual objects",
    recurringMotifs: [],
    texture: "moss, water, smoke, bark, linen, and ember haze",
    cameraLanguage: ["low tracking", "aerial drift", "lantern-lit close-up", "slow reveal", "wind-driven pan"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/forest|river|nature|myth|mountain|ocean|desert|animal|garden|wild/i],
  },
  {
    id: "glossy_pop",
    paletteFamily: "cherry red, cobalt, glass white, bubblegum, and black lacquer",
    palette: ["cherry red", "cobalt", "glass white", "bubblegum", "black lacquer"],
    medium: "glossy pop-art music-video set design with reflective acrylic and clean stage geometry",
    worldGrammar: "modular stages, mirrored rooms, oversized props, kinetic product-like objects, color-blocked corridors, and bright practicals",
    recurringMotifs: [],
    texture: "acrylic gloss, lacquer, mirror glass, crisp shadow, and saturated gel light",
    cameraLanguage: ["crane drop", "locked-off tableau", "fast dolly", "split diopter-style depth", "graphic match cut"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/pop|joy|party|dance|gloss|fashion|bright|bubble|candy/i],
  },
  {
    id: "industrial_color",
    paletteFamily: "rust orange, sodium amber, marine blue, bone, and oil black",
    palette: ["rust orange", "sodium amber", "marine blue", "bone", "oil black"],
    medium: "industrial color cinema with practical machinery, vapor, and graphic light blocks",
    worldGrammar: "workshops, freight elevators, warehouses, fabrication tables, catwalks, rolling doors, and painted steel",
    recurringMotifs: [],
    texture: "oxidized metal, canvas, vapor, concrete dust, chipped paint, and hard sidelight",
    cameraLanguage: ["forklift tracking", "catwalk reveal", "hard side pan", "low dolly", "strobe-cut insert"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/industrial|factory|machine|workshop|metal|garage|\bpunk\b|heavy/i],
  },
  {
    id: "monochrome_drama",
    paletteFamily: "ink black, pearl white, pewter, fog gray, and one restrained accent",
    palette: ["ink black", "pearl white", "pewter", "fog gray", "restrained accent"],
    medium: "high-contrast monochrome performance cinema with noir shadows and sculptural light",
    worldGrammar: "bare stages, venetian shadows, smoke rooms, stairwells, curtains, spotlights, and negative space",
    recurringMotifs: [],
    texture: "silver grain, smoke, velvet, polished floor, and hard edge light",
    cameraLanguage: ["slow lateral track", "spotlight reveal", "close insert", "shadow wipe", "long lens compression"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/noir|black and white|monochrome|jazz|dramatic|shadow/i],
  },
  {
    id: "jazz_lounge",
    paletteFamily: "warm amber, deep burgundy, brass gold, smoke gray, and polished black",
    palette: ["warm amber", "deep burgundy", "brass gold", "smoke gray", "polished black"],
    medium: "intimate jazz-lounge cinema with live instrumental detail, practical spotlights, and relaxed camera movement",
    worldGrammar: "small club stages, lounge booths, piano corners, backstage hallways, velvet curtains, smoky spotlights, and close instrument details",
    recurringMotifs: [],
    texture: "brass, lacquered wood, velvet, smoke haze, piano gloss, brushed cymbals, and warm room grain",
    cameraLanguage: ["slow sax close-up", "piano-key lateral track", "club spotlight push", "upright-bass orbit", "brushed-cymbal insert"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/smooth jazz|jazz club|lounge|sax(?:ophone)?|upright bass|brushed drums/i],
  },
  {
    id: "digital_grid",
    paletteFamily: "electric blue, white light, black glass, cyan edge light, and restrained orange",
    palette: ["electric blue", "white light", "black glass", "cyan edge light", "restrained orange"],
    medium: "luminous digital-grid cinema with clean circuit geometry, black-glass surfaces, and precise electronic motion",
    worldGrammar: "endless grid planes, black-glass corridors, horizon-line stages, light-trail paths, circuit chambers, and abstract digital thresholds",
    recurringMotifs: [],
    texture: "black glass, light strips, polished polymer, circuit surfaces, clean haze, and crisp glow edges",
    cameraLanguage: ["precise grid push", "sweeping light-trail orbit", "locked symmetrical tableau", "low horizon glide", "circuit-plane reveal"],
    avoidMotifs: ["rain-slick megacity", "analog tape props", "paper craft symbols", "retro domestic staging"],
    promptHints: [/tron|light cycles?|neon grid|digital grid|circuit|black glass/i],
  },
  {
    id: "ritual_traditional",
    paletteFamily: "ink black, rice-paper white, warm wood, restrained red, and brushed metal",
    palette: ["ink black", "rice-paper white", "warm wood", "restrained red", "brushed metal"],
    medium: "traditional ritual-inspired music-video cinema with tactile instruments, ink-shadow staging, and grounded performance objects",
    worldGrammar: "ritual stages, textured screens, instrument close-ups, wooden thresholds, paper surfaces, lantern edges, and spare ceremonial geometry",
    recurringMotifs: [],
    texture: "rice paper, ink, wood grain, woven textile, lacquer, brushed metal, and controlled haze",
    cameraLanguage: ["ink-shadow lateral track", "instrument close insert", "slow ritual reveal", "low ceremonial dolly", "monochrome silhouette push"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/samurai|katana|Japanese harp|koto|taiko|shamisen|ritual|ink wash/i],
  },
  {
    id: "cosmic_minimalism",
    paletteFamily: "midnight blue, violet-black, ivory, comet silver, and muted gold",
    palette: ["midnight blue", "violet-black", "ivory", "comet silver", "muted gold"],
    medium: "cosmic minimalist art film with restrained geometry and slow gravitational motion",
    worldGrammar: "empty stages, suspended objects, eclipse shapes, mirrored floors, star fields, fabric arcs, and quiet horizon lines",
    recurringMotifs: [],
    texture: "soft cosmic dust, matte plaster, glass, silk, and controlled haze",
    cameraLanguage: ["slow orbit", "symmetrical push", "vertical tilt", "locked wide tableau", "weightless drift"],
    avoidMotifs: ["teal cyberpunk skyline", "rain-slick megacity", "busy city architecture", "crowded neon street"],
    promptHints: [/space|cosmic|star|moon|minimal|dream|ambient|quiet/i],
  },
  {
    id: "retro_theater",
    paletteFamily: "velvet red, tungsten gold, dusty mauve, ivory, and backstage black",
    palette: ["velvet red", "tungsten gold", "dusty mauve", "ivory", "backstage black"],
    medium: "retro theater music-video staging with curtains, spotlights, props, and miniature scenic flats",
    worldGrammar: "backstage corridors, footlights, velvet curtains, painted flats, dressing-room mirrors, and empty auditorium rows",
    recurringMotifs: [],
    texture: "velvet, wood grain, tungsten haze, dust, painted canvas, and stage smoke",
    cameraLanguage: ["proscenium reveal", "backstage follow", "footlight close-up", "curtain wipe", "crane over rows"],
    avoidMotifs: OVERUSED_CONCEPTUAL_MOTIFS,
    promptHints: [/theater|stage|musical|cabaret|cinema|movie|performance/i],
  },
  {
    id: "cyberpunk_signal",
    paletteFamily: "electric green, cyan, bone white, graphite black, and saturated magenta accents",
    palette: ["electric green", "cyan", "bone white", "graphite black", "magenta accent"],
    medium: "rain-glossed future-city cinema with broadcast graphics, hard practical light, and signal artifacts",
    worldGrammar: "skybridges, antenna towers, underground broadcast rooms, wet streets, server shrines, transit tunnels, and signal plazas",
    recurringMotifs: [],
    texture: "rain sheen, glass, concrete, LED haze, screen glow, and clean cinematic grain",
    cameraLanguage: ["running tracking shot", "low wet-street dolly", "tower reveal", "signal-glitch whip", "wide skyline pullback"],
    avoidMotifs: ["literal monolith repetition", "same street in every shot", "one identical hero silhouette"],
    promptHints: [/cyberpunk|neon|future city|futuristic city|rain|signal|broadcast|skyline|synthwave|chillsynth|techno/i],
  },
];

export async function createTreatment(job: VideoJob): Promise<CreativeBrief> {
  const safePrompt = sanitizeTreatmentPrompt(
    job.prompt.replace(CELEBRITY_STYLE, "with a broad contemporary music-video influence"),
  );
  const userPrompt = stripDirectorInterventions(safePrompt);
  const styleContract = await resolveCreativeStyleContract({ ...job, prompt: safePrompt });
  const visualMode = job.visualMode ?? "conceptual";
  const subjectType = visualMode === "visible_performer"
      ? "character"
      : /city|landscape|environment|world|forest|ocean|desert|stage|room|kitchen/i.test(userPrompt)
        ? "environment"
        : "abstract";
  const genre = styleContract.musicIntent.primaryGenre || inferGenre(userPrompt);
  const visualSignature = chooseVisualSignature(safePrompt, job.id, styleContract);

  return {
    videoId: job.id,
    durationSeconds: job.durationSeconds,
    aspectRatio: job.aspectRatio,
    visualMode,
    storySpine: `A vertical music-video journey follows ${userPrompt}. Music direction: ${styleContract.musicIntent.primaryGenre}. Visual direction: ${styleContract.visualIntent.primaryStyle}. The piece starts intimate, opens into distinct visual chapters, then resolves with a bold final image that feels authored rather than generated.`,
    visualWorld: visualWorldFor(visualSignature, visualMode, styleContract),
    visualSignature,
    subject: {
      type: subjectType,
      description:
        subjectType === "character"
          ? `A singular fictional adult lead performer, age 25 or older, with a readable silhouette and styling rooted in ${visualSignature.medium}.`
          : subjectType === "environment"
            ? `A connected cinematic world that acts like the protagonist, moving through ${visualSignature.worldGrammar}.`
            : abstractSubjectDescription(visualSignature),
    },
    energyArc: ["build", "calm", "build", "peak", "drop"],
    mood: styleContract.musicIntent.tempoFeel ?? "kinetic, stylish, emotionally direct",
    genre,
    styleContract,
    musicControls: job.musicControls,
    safetyNotes: safePrompt === job.prompt ? [] : ["Potentially unsafe identity, age, or artist references were rewritten."],
  };
}

export function chooseVisualSignature(prompt: string, videoId: string, styleContract?: CreativeStyleContract): VisualSignature {
  const userPrompt = stripDirectorInterventions(prompt);
  const cyberpunk = VISUAL_SIGNATURES.find((signature) => signature.id === "cyberpunk_signal");
  const contractPreset = styleContract
    ? signatureForLane(styleContract.routing.visualLane)
    : undefined;
  const requested = contractPreset ?? (cyberpunk?.promptHints.some((hint) => hint.test(userPrompt))
    ? cyberpunk
    : VISUAL_SIGNATURES.find((signature) =>
        signature.promptHints.some((hint) => hint.test(userPrompt)),
      ));
  const pool = requested ? [requested] : VISUAL_SIGNATURES.filter((signature) => signature.id !== "cyberpunk_signal");
  const selected = pool[requested ? 0 : stableHash(`${userPrompt}:${videoId}`) % pool.length];
  const contractPalette = styleContract?.visualIntent.palette ?? [];
  const contractMaterials = styleContract?.visualIntent.materials ?? [];
  const contractCamera = styleContract?.visualIntent.camera ?? [];
  return {
    id: selected.id,
    paletteFamily: contractPalette.length >= 3 ? contractPalette.join(", ") : selected.paletteFamily,
    palette: contractPalette.length >= 3 ? contractPalette.slice(0, 5) : [...selected.palette],
    medium: styleContract?.visualIntent.primaryStyle
      ? `${selected.medium}; ${styleContract.visualIntent.primaryStyle}`
      : selected.medium,
    worldGrammar: styleContract?.visualIntent.setting ?? selected.worldGrammar,
    recurringMotifs: styleContract ? styleContract.userMotifs : extractPromptMotifs(userPrompt),
    texture: contractMaterials.length > 0 ? contractMaterials.join(", ") : selected.texture,
    cameraLanguage: contractCamera.length >= 3 ? contractCamera.slice(0, 5) : [...selected.cameraLanguage],
    avoidMotifs: [...selected.avoidMotifs],
  };
}

function visualWorldFor(
  signature: VisualSignature,
  visualMode: CreativeBrief["visualMode"],
  styleContract?: CreativeStyleContract,
) {
  const motifDirection = signature.recurringMotifs.length > 0
    ? `User-derived motifs: ${signature.recurringMotifs.join(", ")}.`
    : "Continuity comes from palette, texture, lighting, setting logic, material detail, and camera rhythm.";
  const contractDirection = styleContract
    ? `Music intent: ${styleContract.musicIntent.primaryGenre}${styleContract.musicIntent.secondaryGenres.length ? ` with ${styleContract.musicIntent.secondaryGenres.join(", ")}` : ""}. Visual intent: ${styleContract.visualIntent.primaryStyle}. Positive visual vocabulary: ${styleContract.visualIntent.positiveVocabulary.join(", ")}.`
    : "";
  const core = [
    contractDirection,
    `${signature.medium}.`,
    `Palette family: ${signature.paletteFamily}.`,
    `World grammar: ${signature.worldGrammar}.`,
    motifDirection,
    `Texture: ${signature.texture}.`,
    `Camera language: ${signature.cameraLanguage.join(", ")}.`,
  ].join(" ");
  if (visualMode === "visible_performer") {
    return `${core} Any people shown are fictional adult performers age 25 or older, identity-safe, anonymized, and free of readable names, school identifiers, brand marks, or real-person likenesses. Performer movement and edit rhythm carry the vocal energy.`;
  }
  return `${core} Conceptual-first direction: each section should move into a fresh location, object scale, or lighting state while coherence comes from ${signature.recurringMotifs.length > 0 ? "user-derived motifs, palette, texture, and rhythm" : "palette, texture, materials, light, and rhythm"}.`;
}

function signatureForLane(visualLane: string) {
  const idForLane: Record<string, string> = {
    cyberpunk_noir: "cyberpunk_signal",
    digital_grid: "digital_grid",
    generalist_cinema: "glossy_pop",
    jazz_lounge: "jazz_lounge",
    live_performance: "live_band_performance",
    monochrome_drama: "monochrome_drama",
    natural_mythic: "natural_mythic",
    performance_portrait: "retro_theater",
    retro_stage: "retro_theater",
    ritual_traditional: "ritual_traditional",
    surreal_domestic: "surreal_domestic",
  };
  const id = idForLane[visualLane];
  return id ? VISUAL_SIGNATURES.find((signature) => signature.id === id) : undefined;
}

function abstractSubjectDescription(signature: VisualSignature) {
  if (signature.recurringMotifs.length > 0) {
    return `A cohesive visual subject built from ${signature.recurringMotifs.slice(0, 3).join(", ")}, light, texture, and rhythmic motion.`;
  }
  return "A flexible visual subject built from user-requested imagery, light, texture, material changes, camera motion, and rhythm.";
}

function inferGenre(prompt: string) {
  if (/\brock(?:[- ]?and[- ]?roll)?\b|\bguitars?\b|\bbands?\b|\bamps?\b|\bamplifiers?\b|\briffs?\b/i.test(prompt)) {
    return /80s|1980/i.test(prompt)
      ? "1980s guitar rock with live drums, bass, amps, and riff-forward hooks"
      : "guitar-driven rock with live drums, bass, amps, and riff-forward hooks";
  }
  if (/80s|1980/i.test(prompt)) return "1980s music-video production guided by the user's requested instruments and mood";
  if (/country/i.test(prompt)) return "modern country with acoustic and electric guitars, live drums, bass, and organic storytelling";
  if (/metal|\bpunk\b/i.test(prompt)) return "high-energy guitar music with live drums and cinematic dynamics";
  if (/jazz/i.test(prompt)) return "cinematic jazz";
  if (/hip[- ]?hop|rap/i.test(prompt)) return "cinematic hip-hop";
  if (/synth|neon|future/i.test(prompt)) return "electronic, synth-forward production with cinematic percussion";
  return "cinematic instrumental score guided by the requested instruments and mood, with organic textures and no fixed pop styling";
}

function extractPromptMotifs(prompt: string) {
  const candidates: Array<{ pattern: RegExp; motif: string; negativePattern?: RegExp }> = [
    {
      pattern: /\bcassette(?:s)?\b|\btape loops?\b/i,
      motif: "cassette tape",
      negativePattern: negativePatternFor("cassette(?:s)?|tape loops?"),
    },
    {
      pattern: /\bmicrophones?\b|\bmics?\b/i,
      motif: "microphone",
      negativePattern: negativePatternFor("microphones?|mics?"),
    },
    {
      pattern: /\bhearts?\b/i,
      motif: "heart",
      negativePattern: negativePatternFor("hearts?"),
    },
    { pattern: /\bsamurai\b/i, motif: "samurai armor" },
    { pattern: /\bkatana\b|\bswords?\b/i, motif: "katana silhouette" },
    { pattern: /\bJapanese harp\b|\bkoto\b/i, motif: "Japanese harp" },
    { pattern: /\bblack and white\b|\bmonochrome\b/i, motif: "monochrome contrast" },
    { pattern: /\belectric guitars?\b/i, motif: "electric guitar" },
    { pattern: /\bacoustic guitars?\b/i, motif: "acoustic guitar" },
    { pattern: /\bguitars?\b/i, motif: "guitar" },
    { pattern: /\bdrum(?:s| kit| riser)?\b/i, motif: "drums" },
    { pattern: /\bbass guitar\b/i, motif: "bass guitar" },
    { pattern: /\bamps?\b|\bamplifiers?\b/i, motif: "amplifier" },
    { pattern: /\briffs?\b/i, motif: "guitar riff" },
    { pattern: /\bsignals?\b/i, motif: "signal" },
    { pattern: /\bbroadcasts?\b/i, motif: "broadcast" },
    { pattern: /\bneon\b/i, motif: "neon light" },
    { pattern: /\brain(?:-slick| slick)?\b/i, motif: "rain" },
    { pattern: /\bskylines?\b/i, motif: "skyline" },
    { pattern: /\bforests?\b/i, motif: "forest" },
    { pattern: /\brivers?\b/i, motif: "river" },
    { pattern: /\boceans?\b/i, motif: "ocean" },
    { pattern: /\bmountains?\b/i, motif: "mountain" },
    { pattern: /\bdeserts?\b/i, motif: "desert" },
    { pattern: /\bmoons?\b/i, motif: "moon" },
    { pattern: /\bstars?\b/i, motif: "stars" },
    { pattern: /\bdishes\b/i, motif: "dishes" },
    { pattern: /\bsinks?\b/i, motif: "sink" },
    { pattern: /\bbubbles?\b/i, motif: "bubbles" },
    { pattern: /\bsmoke\b/i, motif: "smoke" },
    { pattern: /\bmirrors?\b/i, motif: "mirror" },
    { pattern: /\bshadows?\b/i, motif: "shadow" },
    { pattern: /\bflowers?\b/i, motif: "flower" },
    { pattern: /\blanterns?\b/i, motif: "lantern" },
  ];

  const motifs = candidates
    .filter((candidate) => hasPositivePromptMatch(prompt, candidate.pattern, candidate.negativePattern))
    .map(({ motif }) => motif);
  return unique(motifs).slice(0, 5);
}

function sanitizeTreatmentPrompt(prompt: string) {
  return prompt
    .replace(/\bfalling in love in high school\b/gi, "a nostalgic first-love story at a retro campus dance performed by adult musicians")
    .replace(/\bhigh school\b/gi, "retro campus dance venue")
    .replace(/\bteenagers?\b/gi, "young adult performers")
    .replace(/\bteens?\b/gi, "young adult performers")
    .replace(/\bstudents?\b/gi, "adult performers")
    .replace(/\bminors?\b/gi, "adult performers")
    .replace(/\bunderage\b/gi, "adult");
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}
