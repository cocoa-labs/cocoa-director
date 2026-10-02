import { providerFetch } from "@/lib/server/provider-execution";
import type { CreativeStyleContract, MusicControls, VideoJob, VisualMode } from "@/lib/schemas";
import { GENRE_PRESETS_BY_ID } from "@/lib/music-controls";
import { styleModel } from "@/lib/model-routing";
import { getProviderMode } from "@/lib/server/config";
import { nowIso } from "@/lib/trace";
import { hasPositivePromptMatch, negativePatternFor, stripDirectorInterventions } from "@/workflow/promptGuards";

const STYLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["musicIntent", "visualIntent", "userMotifs", "routing", "conflicts", "confidence"],
  properties: {
    musicIntent: {
      type: "object",
      additionalProperties: false,
      required: ["primaryGenre", "secondaryGenres", "requestedInstruments", "vocalMode", "lyricsPolicy", "tempoFeel", "positiveStyle"],
      properties: {
        primaryGenre: { type: "string" },
        secondaryGenres: { type: "array", items: { type: "string" } },
        requestedInstruments: { type: "array", items: { type: "string" } },
        vocalMode: { type: "string", enum: ["vocal", "instrumental", "mixed", "unspecified"] },
        lyricsPolicy: { type: "string" },
        tempoFeel: { type: "string" },
        positiveStyle: { type: "array", items: { type: "string" } },
      },
    },
    visualIntent: {
      type: "object",
      additionalProperties: false,
      required: ["primaryStyle", "secondaryStyles", "setting", "palette", "materials", "camera", "positiveVocabulary"],
      properties: {
        primaryStyle: { type: "string" },
        secondaryStyles: { type: "array", items: { type: "string" } },
        setting: { type: "string" },
        palette: { type: "array", items: { type: "string" } },
        materials: { type: "array", items: { type: "string" } },
        camera: { type: "array", items: { type: "string" } },
        positiveVocabulary: { type: "array", items: { type: "string" } },
      },
    },
    userMotifs: { type: "array", items: { type: "string" } },
    routing: {
      type: "object",
      additionalProperties: false,
      required: ["musicProfile", "visualLane"],
      properties: {
        musicProfile: { type: "string" },
        visualLane: { type: "string" },
      },
    },
    conflicts: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
};

export async function resolveCreativeStyleContract(job: VideoJob): Promise<CreativeStyleContract> {
  const prompt = stripDirectorInterventions(job.prompt);
  // Explicit Advanced-music-panel controls override inferred genre/voice/tempo as the LAST step,
  // so a chosen preset wins over both the LLM parse and the deterministic keyword path.
  const controls = job.musicControls;
  if (getProviderMode() === "live" && process.env.OPENAI_API_KEY) {
    const llm = await parseWithOpenAi(prompt, job.visualMode).catch(() => null);
    if (llm) return applyMusicControls(llm, controls);
    return applyMusicControls({ ...deterministicStyleContract(prompt, job.visualMode), source: "llm_fallback" }, controls);
  }
  return applyMusicControls(deterministicStyleContract(prompt, job.visualMode), controls);
}

// Maps an explicit MusicControls selection onto a resolved contract. Returns the contract unchanged
// when controls are absent or fully "auto", so default behavior is byte-identical (no breaking change).
export function applyMusicControls(
  contract: CreativeStyleContract,
  controls: MusicControls | undefined,
): CreativeStyleContract {
  if (!controls) return contract;
  const next: CreativeStyleContract = {
    ...contract,
    musicIntent: { ...contract.musicIntent },
    routing: { ...contract.routing },
  };
  if (controls.genre && controls.genre !== "auto") {
    const preset = GENRE_PRESETS_BY_ID[controls.genre];
    if (preset) {
      next.routing.musicProfile = preset.musicProfile;
      next.musicIntent.primaryGenre = preset.genreLabel;
      next.musicIntent.positiveStyle = unique([...preset.positiveStyle, ...next.musicIntent.positiveStyle]);
      next.confidence = Math.max(next.confidence ?? 0, 0.92);
    }
  }
  if (controls.vocals && controls.vocals !== "auto") {
    next.musicIntent.vocalMode =
      controls.vocals === "instrumental"
        ? "instrumental"
        : controls.vocals === "mixed" || controls.vocals === "choir"
          ? "mixed"
          : "vocal";
  }
  if (controls.bpm) {
    next.musicIntent.tempoFeel = `${controls.bpm} bpm`;
  } else if (controls.tempo && controls.tempo !== "auto") {
    next.musicIntent.tempoFeel =
      controls.tempo === "slow" ? "laid-back" : controls.tempo === "fast" ? "up-tempo" : "section-aware cinematic build";
  }
  if (controls.intensity && controls.intensity !== "auto") {
    next.musicIntent.positiveStyle = unique([`${controls.intensity} intensity`, ...next.musicIntent.positiveStyle]);
  }
  return next;
}

export function deterministicStyleContract(prompt: string, visualMode: VisualMode = "conceptual"): CreativeStyleContract {
  const musicProfile = inferMusicProfile(prompt);
  const visualLane = inferVisualLane(prompt, musicProfile, visualMode);
  const userMotifs = extractUserMotifs(prompt);
  const vocabulary = positiveVocabularyFor(prompt, visualLane, musicProfile, userMotifs);
  const secondaryGenres = secondaryGenresFor(prompt, musicProfile);
  return {
    source: "deterministic",
    confidence: secondaryGenres.length > 0 ? 0.72 : 0.82,
    musicIntent: {
      primaryGenre: genreLabelFor(musicProfile, prompt),
      secondaryGenres,
      requestedInstruments: requestedInstrumentsFor(prompt, musicProfile),
      vocalMode: vocalModeFor(prompt),
      lyricsPolicy: lyricsPolicyFor(prompt),
      tempoFeel: tempoFeelFor(prompt, musicProfile),
      positiveStyle: positiveMusicStyleFor(musicProfile, prompt),
    },
    visualIntent: {
      primaryStyle: visualStyleLabelFor(visualLane, prompt),
      secondaryStyles: secondaryVisualStylesFor(prompt, visualLane),
      setting: settingFor(prompt, visualLane),
      palette: paletteFor(visualLane, prompt),
      materials: materialsFor(visualLane, prompt),
      camera: cameraFor(visualLane, musicProfile),
      positiveVocabulary: vocabulary,
    },
    userMotifs,
    routing: { musicProfile, visualLane },
    conflicts: conflictsFor(prompt, musicProfile, visualLane),
    createdAt: nowIso(),
  };
}

async function parseWithOpenAi(prompt: string, visualMode: VisualMode): Promise<CreativeStyleContract | null> {
  const startedAt = nowIso();
  const response = await providerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: styleModel(),
      input: [
        {
          role: "system",
          content: [
            "You parse creative intent for Cocoa Director.",
            "Return only JSON matching the schema.",
            "Separate music genre from visual style.",
            "Only list userMotifs that are explicitly requested as visual objects or symbols.",
            "Do not invent cassette tapes, microphones, hearts, logos, or generic music props unless the user asked for them.",
            "Use positive, concrete vocabulary; no broad negative prompt advice.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({ prompt, visualMode }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "creative_style_contract",
          strict: true,
          schema: STYLE_SCHEMA,
        },
      },
    }),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { id?: string; output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = json.output_text ?? json.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
  if (!text) return null;
  const parsed = JSON.parse(text) as CreativeStyleContract;
  const fallback = deterministicStyleContract(prompt, visualMode);
  const merged = {
    ...fallback,
    ...parsed,
    musicIntent: { ...fallback.musicIntent, ...parsed.musicIntent },
    visualIntent: { ...fallback.visualIntent, ...parsed.visualIntent },
    routing: { ...fallback.routing, ...parsed.routing },
    userMotifs: sanitizeMotifs(parsed.userMotifs, prompt),
    source: "llm" as const,
    providerRequestId: json.id,
    createdAt: startedAt,
  };
  // Normalize the LLM's free-text routing token so downstream curated profiles + voice defaults fire.
  merged.routing.musicProfile = canonicalizeMusicProfile(merged.routing.musicProfile);
  return merged;
}

function inferMusicProfile(prompt: string) {
  const text = prompt.toLowerCase();
  // Specific genre names are matched first so an incidental instrument word (e.g. "guitar")
  // can't pull a named genre such as reggae or latin into the broad rock bucket below.
  if (/\bgregorian\b|\bplainchant\b|\bplainsong\b|\bchant\b|\bliturgical\b|\bsacred choral\b|\bmonastic\b|\bcathedral choir\b/.test(text)) return "gregorian";
  if (/\bgospel\b|\bspiritual\b|\bworship choir\b|\bpraise (?:&|and) worship\b/.test(text)) return "gospel";
  if (/\bopera\b|\baria\b|\bbel canto\b|\boperatic\b|\bcoloratura\b/.test(text)) return "opera";
  if (/\breggae\b|\bska\b|\bdub\b|\bdancehall\b|\brocksteady\b/.test(text)) return "reggae";
  if (/\bafrobeat\b|\bafrobeats\b|\bhighlife\b|\bamapiano\b/.test(text)) return "afrobeat";
  if (/\blatin\b|\bsalsa\b|\breggaeton\b|\bcumbia\b|\bbachata\b|\bmerengue\b|\bmariachi\b|\bbossa nova\b|\bsamba\b|\bflamenco\b/.test(text)) return "latin";
  if (/\bbluegrass\b|\bbanjo\b|\bhoedown\b/.test(text)) return "bluegrass";
  if (/\btrap\b|\b808s?\b/.test(text)) return "trap";
  if (/\bdrum\s*(?:&|and|n)\s*bass\b|\bdnb\b|\bjungle\b|\bdubstep\b|\briddim\b/.test(text)) return "dnb";
  if (/\bmetal\b|\bheavy metal\b|\bthrash\b|\bdeath metal\b|\bblack metal\b|\bdoom metal\b|\bmetalcore\b/.test(text)) return "metal";
  if (/\bpunk\b|post-punk|garage punk|\bhardcore\b|\bd-beat\b/.test(text)) return "punk";
  if (/\brock(?:[- ]?and[- ]?roll)?\b|\brock n roll\b|\bgrunge\b|\brockabilly\b|\bguitars?\b|\bbands?\b|\bamps?\b|\bamplifiers?\b|\briffs?\b/.test(text)) return "rock";
  if (/\bsmooth jazz\b|\bjazz\b|\bsax(?:ophone)?\b|\bupright bass\b|\bbrushed drums\b/.test(text)) return "jazz";
  if (/\btechno\b|\btron\b|\belectronic\b|\bsynthwave\b|\bsynth\b|\bchillsynth\b|\bedm\b|\bhouse\b|\btrance\b|\bgarage\b|\bbreakbeat\b/.test(text)) return "electronic";
  if (/\bhip[- ]?hop\b|\brap\b|\bboom[- ]?bap\b|\bbeats?\b/.test(text)) return "hip_hop";
  if (/\bfunk\b|\bdisco\b/.test(text)) return "funk_disco";
  if (/\bblues\b|\br&b\b|\brnb\b|\bsoul\b|\bmotown\b/.test(text)) return "blues_rnb";
  if (/\bcountry\b|\bamericana\b|\bfolk\b|\bacoustic\b|\bhonky[- ]?tonk\b/.test(text)) return /\bcountry\b|\bhonky[- ]?tonk\b/.test(text) ? "country" : "folk";
  if (/\borchestral\b|\bclassical\b|\bbaroque\b|\bsymphon|\bconcerto\b|\bstrings?\b|\bchoir\b|\bcinematic score\b|\bfilm score\b/.test(text)) return "orchestral";
  if (/\bambient\b|\bdrone\b|\bmeditative\b|\bquiet\b/.test(text)) return "ambient";
  if (/\bpop\b|\bdance\b/.test(text)) return "pop";
  if (/\bkoto\b|\bJapanese harp\b|\btabla\b|\bsitar\b|\bbansuri\b|\bduduk\b|\btaiko\b|\boud\b|\bshamisen\b/i.test(prompt)) return "world_traditional";
  return "cinematic";
}

// The full set of canonical music-profile tokens the engine understands (curated named profiles in
// compositionPlan + the synthesizedProfile pass-through). Kept in sync with inferMusicProfile/
// genreLabelFor and musicProfileById.
const CANONICAL_MUSIC_PROFILES = new Set([
  "gregorian", "gospel", "opera", "reggae", "afrobeat", "latin", "bluegrass", "trap", "dnb",
  "metal", "punk", "rock", "jazz", "electronic", "hip_hop", "funk_disco", "blues_rnb", "country",
  "folk", "orchestral", "ambient", "world_traditional", "pop", "cinematic",
]);

// Normalizes a (possibly free-text) music profile to a canonical token. In live mode the LLM returns
// routing.musicProfile as free prose (e.g. "hip-hop", "boom-bap hip-hop", "drum and bass"), which
// otherwise wouldn't key-match the engine's curated profiles or genre-aware voice defaults. Already-
// canonical tokens (and underscore/space/hyphen variants) pass straight through; anything else is
// classified by the same keyword classifier used by the deterministic path. The rich free-text genre
// is preserved separately in musicIntent.primaryGenre, so styleSummary richness is not lost.
export function canonicalizeMusicProfile(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (CANONICAL_MUSIC_PROFILES.has(raw)) return raw;
  const underscored = raw.replace(/[\s/&-]+/g, "_");
  if (CANONICAL_MUSIC_PROFILES.has(underscored)) return underscored;
  return inferMusicProfile(raw);
}

function inferVisualLane(prompt: string, musicProfile: string, visualMode: VisualMode) {
  const text = prompt.toLowerCase();
  if (/\btron\b|\blight cycle\b|\bgrid\b|\bneon circuit\b|\bdigital grid\b/.test(text)) return "digital_grid";
  if (/\bcyberpunk\b|\bneon\b|\bfuture city\b|\bfuturistic city\b|\brain[- ]?slick\b|\bfilm noir\b/.test(text)) return "cyberpunk_noir";
  if (/\bsmooth jazz\b|\bjazz club\b|\blounge\b|\bsmoky club\b/.test(text)) return "jazz_lounge";
  if (/\bsamurai\b|\bkatana\b|\bkoto\b|\bJapanese harp\b|\bink wash\b/.test(text)) return "ritual_traditional";
  if (/\bdishes\b|\bkitchen\b|\blaundry\b|\bbath\b|\bhome\b|\bdomestic\b|\bsink\b|\bsoap\b|\bbubbles?\b/.test(text)) return "surreal_domestic";
  if (/\blive\b|\bstage\b|\brehearsal\b|\bband\b|\bamp\b|\bguitar\b/.test(text) || musicProfile === "rock" || musicProfile === "metal" || musicProfile === "punk") return "live_performance";
  if (/\bblack and white\b|\bmonochrome\b|\bnoir\b|\bshadow\b/.test(text)) return "monochrome_drama";
  if (/\bforest\b|\briver\b|\bnature\b|\bmountain\b|\bocean\b|\bdesert\b/.test(text)) return "natural_mythic";
  if (/\bretro\b|\b80s\b|\b1980\b|\bcabaret\b|\btheater\b/.test(text)) return "retro_stage";
  if (visualMode === "visible_performer") return "performance_portrait";
  return "generalist_cinema";
}

function genreLabelFor(profile: string, prompt: string) {
  const labels: Record<string, string> = {
    afrobeat: "afrobeat with polyrhythmic groove",
    ambient: "ambient textural score",
    bluegrass: "bluegrass with banjo and fiddle",
    blues_rnb: "blues and R&B groove",
    cinematic: "cinematic generalist soundtrack",
    country: "modern country",
    dnb: "drum and bass with fast breakbeats",
    electronic: /\btron\b/i.test(prompt) ? "techno-pop electronic with gridlike synth momentum" : "electronic and synth-forward production",
    folk: "folk acoustic production",
    funk_disco: "funk and disco groove",
    gospel: "contemporary gospel with choir and organ",
    gregorian: "Gregorian chant and sacred choral, modal and reverberant",
    hip_hop: "cinematic hip-hop",
    jazz: /\bsmooth jazz\b/i.test(prompt) ? "smooth jazz" : "cinematic jazz",
    latin: "latin groove with clave and brass",
    metal: "heavy guitar-driven metal",
    opera: "operatic classical vocal with full orchestra",
    orchestral: "orchestral cinematic score",
    pop: "pop production",
    punk: "punk rock",
    reggae: "roots reggae with offbeat skank",
    rock: "guitar-driven rock and roll",
    trap: "modern trap with booming 808s",
    world_traditional: "world/traditional instrumental influence",
  };
  return labels[profile] ?? profile.replace(/_/g, " ");
}

function requestedInstrumentsFor(prompt: string, profile: string) {
  const candidates: Array<[RegExp, string]> = [
    [/\belectric guitars?\b/i, "electric guitar"],
    [/\bguitars?\b/i, "guitar"],
    [/\bbass guitar\b|\bbass\b/i, "bass"],
    [/\blive drums?\b|\bdrums?\b/i, "live drums"],
    [/\bamps?\b|\bamplifiers?\b/i, "amplifiers"],
    [/\bsax(?:ophone)?\b/i, "saxophone"],
    [/\bpiano\b|\bkeys?\b|\brhodes\b/i, "piano/keys"],
    [/\bbrushed drums?\b|\bbrushes\b/i, "brushed drums"],
    [/\bupright bass\b/i, "upright bass"],
    [/\bsynths?\b|\bsynthesizers?\b/i, "synthesizer"],
    [/\bdrum machines?\b/i, "drum machine"],
    [/\b808\b|\bsub bass\b/i, "808/sub bass"],
    [/\bkoto\b|\bJapanese harp\b/i, "Japanese harp/koto"],
    [/\btaiko\b/i, "taiko drums"],
    [/\bstrings?\b/i, "strings"],
    [/\bhorns?\b|\bbrass\b/i, "horns"],
  ];
  const found = unique(candidates.filter(([pattern]) => pattern.test(prompt)).map(([, instrument]) => instrument));
  if (found.length > 0) return found;
  const defaults: Record<string, string[]> = {
    electronic: ["synthesizer", "programmed drums", "electronic bass"],
    jazz: ["saxophone", "piano/keys", "upright or warm electric bass", "brushed drums"],
    rock: ["electric guitar", "live drums", "bass", "amplifiers"],
  };
  return defaults[profile] ?? [];
}

function positiveMusicStyleFor(profile: string, prompt: string) {
  const requested = requestedInstrumentsFor(prompt, profile);
  const defaults: Record<string, string[]> = {
    afrobeat: ["polyrhythmic percussion", "horn section", "interlocking guitars", "deep groove"],
    ambient: ["slow evolving texture", "soft pulses", "wide space"],
    bluegrass: ["banjo", "fiddle", "upright bass", "acoustic guitar", "high-lonesome harmony"],
    blues_rnb: ["warm groove", "expressive bass", "soulful keys", "pocket drums"],
    cinematic: ["clear section dynamics", "tactile rhythm", "focused arrangement"],
    country: ["acoustic guitar", "electric guitar fills", "live drums", "storytelling vocal"],
    dnb: ["fast breakbeats", "deep sub-bass", "rolling energy", "atmospheric pads"],
    electronic: ["synth pulse", "programmed drums", "electronic bass", "clean gridlike momentum"],
    folk: ["acoustic guitar", "organic percussion", "warm room tone"],
    funk_disco: ["syncopated bass", "tight drums", "rhythm guitar", "bright keys"],
    gospel: ["Hammond organ", "gospel choir harmonies", "piano", "warm bass", "hand claps"],
    gregorian: ["male monastic choir in unison", "Latin plainchant", "modal melody", "vast cathedral reverb"],
    hip_hop: ["grounded drums", "bass movement", "sample-like texture", "clear vocal pocket"],
    jazz: ["saxophone color", "piano or keys", "brushed drums", "upright or warm bass"],
    latin: ["nylon or Spanish guitar", "clave and congas", "brass stabs", "montuno piano"],
    metal: ["heavy electric guitars", "live drums", "bass guitar", "amplifier energy"],
    opera: ["operatic lead vocal", "full orchestra", "dramatic dynamics", "soaring melody"],
    orchestral: ["strings", "brass", "cinematic percussion", "dynamic swells"],
    pop: ["clear hook", "polished drums", "supporting bass", "bright melodic lift"],
    punk: ["fast guitars", "live drums", "bass drive", "raw room energy"],
    reggae: ["offbeat guitar skank", "one-drop drums", "dub bass", "organ bubble"],
    rock: ["electric guitars", "live drums", "bass guitar", "amplifier room tone", "riff-forward hooks"],
    trap: ["booming 808 sub-bass", "rapid hi-hat rolls", "dark sparse keys", "half-time drums"],
    world_traditional: ["featured traditional instrument", "organic percussion", "modal melody"],
  };
  return unique([...requested, ...(defaults[profile] ?? defaults.cinematic)]);
}

function secondaryGenresFor(prompt: string, primary: string) {
  const profiles = ["rock", "jazz", "electronic", "hip_hop", "pop", "country", "folk", "orchestral", "ambient", "funk_disco", "blues_rnb", "world_traditional"];
  return profiles
    .filter((profile) => profile !== primary && promptMatchesProfile(prompt, profile))
    .map((profile) => genreLabelFor(profile, prompt))
    .slice(0, 4);
}

function promptMatchesProfile(prompt: string, profile: string) {
  const text = prompt.toLowerCase();
  const tests: Record<string, RegExp> = {
    ambient: /\bambient\b|\bdrone\b|\bquiet\b/,
    blues_rnb: /\bblues\b|\br&b\b|\brnb\b/,
    country: /\bcountry\b|\bamericana\b/,
    electronic: /\btechno\b|\btron\b|\belectronic\b|\bsynthwave\b|\bsynth\b|\bchillsynth\b|\bedm\b/,
    folk: /\bfolk\b|\bacoustic\b/,
    funk_disco: /\bfunk\b|\bdisco\b|\bsoul\b/,
    hip_hop: /\bhip[- ]?hop\b|\brap\b|\btrap\b|\bbeats?\b/,
    jazz: /\bjazz\b|\bsax(?:ophone)?\b/,
    orchestral: /\borchestral\b|\bstrings?\b|\bchoir\b/,
    pop: /\bpop\b|\bdance\b/,
    rock: /\brock\b|\bguitars?\b|\bbands?\b|\briffs?\b/,
    world_traditional: /\bkoto\b|\bJapanese harp\b|\btabla\b|\bsitar\b|\btaiko\b|\bshamisen\b/i,
  };
  return tests[profile]?.test(text) ?? false;
}

function vocalModeFor(prompt: string): CreativeStyleContract["musicIntent"]["vocalMode"] {
  if (/\binstrumental\b|\bno lyrics\b|\bno vocals?\b|\bwithout vocals?\b/i.test(prompt)) return "instrumental";
  if (/\bduet\b|\bchoir\b|\bgroup vocal\b|\bmixed\b/i.test(prompt)) return "mixed";
  if (/\bvocal\b|\bsinger\b|\blyrics?\b/i.test(prompt)) return "vocal";
  return "unspecified";
}

function lyricsPolicyFor(prompt: string) {
  if (/\binstrumental\b|\bno lyrics\b|\bno vocals?\b/i.test(prompt)) return "instrumental only; no sung lyrics";
  if (/\blyrics?\b/i.test(prompt)) return "use concise original lyrics when the music plan needs vocals";
  return "unspecified vocal/lyric direction";
}

function tempoFeelFor(prompt: string, profile: string) {
  if (/\bup[- ]?tempo\b|\bfast\b|\bhigh energy\b/i.test(prompt)) return "up-tempo";
  if (/\bslow\b|\bballad\b|\bchill\b|\blaid[- ]?back\b/i.test(prompt)) return "laid-back";
  if (profile === "gregorian") return "free, unmetered, meditative";
  if (profile === "trap") return "half-time 808 bounce";
  if (profile === "dnb") return "fast rolling breakbeat drive";
  if (profile === "reggae") return "relaxed one-drop groove";
  if (profile === "latin" || profile === "afrobeat") return "danceable syncopated groove";
  if (profile === "gospel") return "uplifting building groove";
  if (profile === "opera") return "dramatic rubato dynamics";
  if (profile === "jazz") return "relaxed swing or smooth groove";
  if (profile === "rock" || profile === "punk" || profile === "metal") return "driving live-band pulse";
  if (profile === "electronic") return "locked electronic pulse";
  return "section-aware cinematic build";
}

function extractUserMotifs(prompt: string) {
  const candidates: Array<{ pattern: RegExp; motif: string; negativePattern?: RegExp }> = [
    { pattern: /\bcassette(?:s)?\b|\btape loops?\b/i, motif: "cassette tape", negativePattern: negativePatternFor("cassette(?:s)?|tape loops?") },
    { pattern: /\bmicrophones?\b|\bmics?\b/i, motif: "microphone", negativePattern: negativePatternFor("microphones?|mics?") },
    { pattern: /\bhearts?\b/i, motif: "heart", negativePattern: negativePatternFor("hearts?") },
    { pattern: /\bsamurai\b/i, motif: "samurai armor" },
    { pattern: /\bkatana\b|\bswords?\b/i, motif: "katana silhouette" },
    { pattern: /\bJapanese harp\b|\bkoto\b/i, motif: "Japanese harp" },
    { pattern: /\bblack and white\b|\bmonochrome\b/i, motif: "monochrome contrast" },
    { pattern: /\btron\b|\blight cycles?\b/i, motif: "Tron-style light grid" },
    { pattern: /\bneon grid\b|\bdigital grid\b/i, motif: "neon grid" },
    { pattern: /\bforests?\b/i, motif: "forest" },
    { pattern: /\brivers?\b/i, motif: "river" },
    { pattern: /\boceans?\b/i, motif: "ocean" },
    { pattern: /\bmountains?\b/i, motif: "mountain" },
    { pattern: /\bdeserts?\b/i, motif: "desert" },
  ];
  return sanitizeMotifs(
    candidates
      .filter((candidate) => hasPositivePromptMatch(prompt, candidate.pattern, candidate.negativePattern))
      .map(({ motif }) => motif),
    prompt,
  ).slice(0, 5);
}

function sanitizeMotifs(motifs: string[] = [], prompt: string) {
  return unique(motifs)
    .map((motif) => motif.trim())
    .filter(Boolean)
    .filter((motif) => {
      if (/cassette|microphone|heart/i.test(motif)) {
        const requested = new RegExp(`\\b${motif.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}s?\\b`, "i").test(prompt);
        const broadRequested =
          /cassette|tape loop/i.test(prompt) && /cassette/i.test(motif) ||
          /microphone|mic\b/i.test(prompt) && /microphone/i.test(motif) ||
          /\bheart/i.test(prompt) && /heart/i.test(motif);
        return requested || broadRequested;
      }
      return true;
    });
}

function positiveVocabularyFor(prompt: string, visualLane: string, musicProfile: string, motifs: string[]) {
  if (motifs.length > 0) return motifs;
  const instrumentVocabulary = [
    /\belectric guitars?\b|\bguitars?\b/i.test(prompt) ? "guitar performance detail" : "",
    /\bbass guitar\b/i.test(prompt) ? "bass guitar detail" : "",
    /\bdrums?\b|\blive drums?\b/i.test(prompt) ? "live drum detail" : "",
    /\bamps?\b|\bamplifiers?\b/i.test(prompt) ? "amplifier wall texture" : "",
    /\bsax(?:ophone)?\b/i.test(prompt) ? "saxophone brass detail" : "",
    /\bpiano\b|\bkeys?\b|\brhodes\b/i.test(prompt) ? "piano and key reflections" : "",
  ].filter(Boolean);
  const laneVocabulary: Record<string, string[]> = {
    cyberpunk_noir: ["wet pavement reflections", "hard rim light", "towering city geometry", "fogged glass", "noir silhouettes"],
    digital_grid: ["luminous grid lines", "black glass surfaces", "electric blue edges", "clean circuit geometry", "precise light trails"],
    generalist_cinema: ["palette shifts", "material texture", "motivated light sources", "setting geometry", "camera rhythm"],
    jazz_lounge: ["club spotlights", "polished brass", "piano lacquer", "smoke haze", "velvet shadow"],
    live_performance: ["stage light", "instrument texture", "amplifier grille cloth", "cable motion", "drum-riser energy"],
    monochrome_drama: ["high contrast shadow", "silver grain", "spotlight cones", "polished floor reflections", "hard edge light"],
    natural_mythic: ["weathered stone", "water movement", "lantern glow", "wind texture", "organic silhouettes"],
    performance_portrait: ["wardrobe texture", "stage blocking", "motivated key light", "movement silhouette", "lens texture"],
    retro_stage: ["velvet curtains", "footlights", "painted flats", "backstage haze", "practical bulbs"],
    ritual_traditional: ["ink shadow", "woven texture", "ritual staging", "paper grain", "monochrome light"],
    surreal_domestic: ["wet ceramic", "soap bubbles", "chrome fixtures", "tabletop reflections", "steam texture"],
  };
  return unique([...instrumentVocabulary, ...(laneVocabulary[visualLane] ?? positiveMusicStyleFor(musicProfile, prompt))]).slice(0, 6);
}

function visualStyleLabelFor(visualLane: string, prompt: string) {
  const labels: Record<string, string> = {
    cyberpunk_noir: /\bfilm noir\b/i.test(prompt) ? "cyberpunk noir city cinema" : "future-city neon cinema",
    digital_grid: "Tron-inspired luminous digital grid",
    generalist_cinema: "generalist cinematic production design",
    jazz_lounge: "smooth jazz lounge performance cinema",
    live_performance: "grounded live-performance cinema",
    monochrome_drama: "high-contrast monochrome drama",
    natural_mythic: "mythic natural cinema",
    performance_portrait: "identity-safe performer-forward cinema",
    retro_stage: "retro stage and theater cinema",
    ritual_traditional: "traditional ritual-inspired cinematic staging",
    surreal_domestic: "surreal domestic practical-object cinema",
  };
  return labels[visualLane] ?? visualLane.replace(/_/g, " ");
}

function secondaryVisualStylesFor(prompt: string, primary: string) {
  const styles = [
    ["cyberpunk_noir", /\bcyberpunk\b|\bneon\b|\bfuture/i],
    ["monochrome_drama", /\bblack and white\b|\bmonochrome\b|\bnoir\b/i],
    ["live_performance", /\blive\b|\bstage\b|\bband\b|\bguitar\b/i],
    ["digital_grid", /\btron\b|\bgrid\b/i],
    ["jazz_lounge", /\bjazz club\b|\blounge\b/i],
  ] as const;
  return styles
    .filter(([id, pattern]) => id !== primary && pattern.test(prompt))
    .map(([id]) => visualStyleLabelFor(id, prompt))
    .slice(0, 3);
}

function settingFor(prompt: string, visualLane: string) {
  if (/\bcyberpunk\b|\bfuture city\b|\bfuturistic\b/i.test(prompt)) return "future city streets, interiors, and thresholds";
  if (/\bjazz club\b|\blounge\b|\bsmooth jazz\b/i.test(prompt)) return "intimate club, lounge stage, backstage hallway, and instrument close-ups";
  if (/\brehearsal\b|\blive\b|\bstage\b|\bband\b/i.test(prompt)) return "rehearsal room, small stage, amp wall, drum riser, and backstage thresholds";
  if (/\bsamurai\b|\bkoto\b|\bJapanese harp\b/i.test(prompt)) return "ritual performance space, ink-shadow stage, textured screens, and instrument details";
  if (/\bdishes\b|\bkitchen\b|\bsink\b|\bsoap\b|\bbubbles?\b/i.test(prompt)) return "kitchens, sinks, tiled thresholds, tabletop surfaces, steam, water, and object-scale spaces";
  if (visualLane === "digital_grid") return "black-glass digital space with luminous grid planes and clean horizon lines";
  return "varied connected spaces derived from the user prompt";
}

function paletteFor(visualLane: string, prompt: string) {
  if (/\bblack and white\b|\bmonochrome\b/i.test(prompt)) return ["ink black", "pearl white", "silver gray"];
  const palettes: Record<string, string[]> = {
    cyberpunk_noir: ["electric cyan", "acid green", "rain black", "warning red"],
    digital_grid: ["electric blue", "white light", "black glass", "cyan edge light"],
    jazz_lounge: ["warm amber", "deep burgundy", "brass gold", "smoke gray"],
    live_performance: ["stage tungsten", "road-case black", "oxidized silver", "denim blue"],
    ritual_traditional: ["ink black", "rice paper white", "warm wood", "restrained red"],
    surreal_domestic: ["porcelain white", "soap blue", "butter yellow", "chrome"],
  };
  return palettes[visualLane] ?? ["motivated key color", "shadow tone", "material accent"];
}

function materialsFor(visualLane: string, prompt: string) {
  const defaults: Record<string, string[]> = {
    cyberpunk_noir: ["wet concrete", "glass", "steel", "screen glow", "fog"],
    digital_grid: ["black glass", "light strips", "polished polymer", "circuit surfaces"],
    jazz_lounge: ["brass", "lacquered wood", "velvet", "smoke", "piano gloss"],
    live_performance: ["amp cloth", "stage wood", "cable rubber", "cymbal metal", "denim"],
    ritual_traditional: ["rice paper", "ink", "wood", "woven textile", "lacquer"],
    surreal_domestic: ["wet ceramic", "suds", "soft steam", "polished metal", "glass"],
  };
  const requested = [
    /\brain/i.test(prompt) ? "rain sheen" : "",
    /\bblack and white\b|\bmonochrome\b/i.test(prompt) ? "silver grain" : "",
  ].filter(Boolean);
  return unique([...requested, ...(defaults[visualLane] ?? ["tactile materials", "motivated light", "atmosphere"])]);
}

function cameraFor(visualLane: string, musicProfile: string) {
  const cameras: Record<string, string[]> = {
    cyberpunk_noir: ["low wet-street dolly", "hard backlight reveal", "noir silhouette track"],
    digital_grid: ["precise grid push", "sweeping light-trail orbit", "locked symmetrical tableau"],
    jazz_lounge: ["slow sax close-up", "piano-key lateral track", "club spotlight push"],
    live_performance: ["low guitar tracking", "drum-riser push", "handheld stage orbit"],
    ritual_traditional: ["ink-shadow lateral track", "instrument close insert", "slow ritual reveal"],
    surreal_domestic: ["macro push-in", "overhead choreography", "tabletop tracking"],
  };
  return cameras[visualLane] ?? (musicProfile === "jazz" ? cameras.jazz_lounge : ["medium tracking shot", "wide reveal", "macro insert"]);
}

function conflictsFor(prompt: string, musicProfile: string, visualLane: string) {
  const conflicts: string[] = [];
  const secondary = secondaryGenresFor(prompt, musicProfile);
  if (secondary.length > 1) conflicts.push(`Multiple music styles requested: ${secondary.join(", ")}`);
  if (musicProfile === "rock" && /\bsynth\b|\belectronic\b|\btechno\b/i.test(prompt)) {
    conflicts.push("Rock and electronic terms both appear; music should prioritize requested instruments and primary wording.");
  }
  if (visualLane === "cyberpunk_noir" && musicProfile === "rock") {
    conflicts.push("Music and visual worlds are intentionally separated: rock arrangement with cyberpunk/noir imagery.");
  }
  return conflicts;
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}
