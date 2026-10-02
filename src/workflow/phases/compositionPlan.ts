import type { CreativeBrief, MusicPlan } from "@/lib/schemas";
import { canonicalizeMusicProfile } from "@/workflow/creativeStyleContract";
import { generateSectionLyrics, languageForGenre, themeHintsForBrief } from "@/workflow/phases/lyrics";

type MusicProfile = {
  bpm: number;
  key: string;
  styleSummary: string;
  negativeStyleSummary?: string;
  sections: ReadonlyArray<readonly [string, number, number, string]>;
};

const STYLE_SUMMARY_MAX = 240;

function clipStyle(value: string) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > STYLE_SUMMARY_MAX ? trimmed.slice(0, STYLE_SUMMARY_MAX).trim() : trimmed;
}

function clampBpm(value: number) {
  return Math.max(60, Math.min(180, Math.round(value)));
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

export async function createCompositionPlan(brief: CreativeBrief, editDirection = ""): Promise<MusicPlan> {
  const total = brief.durationSeconds;
  const voiceFamily = chooseVoiceFamily(brief, editDirection);
  const profile = applyControlOverrides(chooseMusicProfile(brief, editDirection), brief);
  const genre = brief.styleContract?.musicIntent.primaryGenre ?? brief.genre;
  const language = languageForGenre(genre);

  let allocated = 0;
  const sized = profile.sections.map(([id, ratio, energy, instrumentation], index) => {
    const durationSeconds =
      index === profile.sections.length - 1 ? total - allocated : Math.max(6, Math.round(total * ratio));
    allocated += durationSeconds;
    return { id, durationSeconds, energy, instrumentation };
  });

  // One genre-aware lyric pass for the whole song; instrumental tracks skip it entirely so
  // generic lyrics never fight the genre (e.g. a chant or metal track no longer inherits pop lines).
  const lyricsById =
    voiceFamily === "instrumental"
      ? null
      : await generateSectionLyrics({
          videoId: brief.videoId,
          genre,
          language,
          vocalMode: voiceFamily === "mixed" ? "mixed" : "vocal",
          sectionIds: sized.map((section) => section.id),
          themeHints: themeHintsForBrief(brief),
        });

  const planSections = sized.map((section) => ({
    id: section.id,
    durationSeconds: section.durationSeconds,
    energy: section.energy,
    instrumentation: editDirection
      ? `${section.instrumentation}; director edit: ${musicDirectionSummary(editDirection)}`
      : section.instrumentation,
    lyrics: lyricsById?.[section.id],
  }));

  return {
    videoId: brief.videoId,
    vocal: voiceFamily !== "instrumental",
    voiceFamily,
    language,
    bpm: profile.bpm,
    key: profile.key,
    styleSummary: profile.styleSummary,
    negativeStyleSummary: profile.negativeStyleSummary,
    sections: planSections,
  };
}

function chooseMusicProfile(brief: CreativeBrief, editDirection = ""): MusicProfile {
  const contractProfile = brief.styleContract?.routing.musicProfile;
  if (contractProfile) {
    // Canonicalize so a live LLM's free-text routing label (e.g. "hip-hop") still selects the
    // curated profile; the rich genre stays in primaryGenre and is folded in by enrichWithContract.
    return enrichWithContract(musicProfileById(canonicalizeMusicProfile(contractProfile), brief, editDirection), brief);
  }

  const text = `${brief.storySpine} ${brief.genre} ${editDirection}`.toLowerCase();

  if (/\bmetal\b|\bpunk\b/.test(text)) {
    return {
      bpm: 148,
      key: "E minor",
      styleSummary: "heavy guitar-driven rock production with aggressive electric guitars, live drums, bass guitar, amplifier energy, and urgent chorus impact",
      negativeStyleSummary: "synth-pop lead hook, EDM drop, glossy electronic dance beat, soft pop percussion",
      sections: [
        ["intro", 0.14, 0.28, "distorted guitar riff, live drum pickup, bass guitar entering through amp grit"],
        ["verse_1", 0.22, 0.48, "tight live drums, palm-muted electric guitars, bass guitar locked to the kick, close vocal"],
        ["pre_chorus", 0.14, 0.68, "rising toms, widening guitar chords, bass climb, cymbal lift"],
        ["chorus_1", 0.24, 0.96, "full live drums, heavy guitar hook, driving bass, shouted or layered vocal lift"],
        ["bridge", 0.12, 0.42, "half-time live drums, stripped guitar break, controlled feedback and room tone"],
        ["final_chorus", 0.14, 1, "maximum band energy, layered distorted guitars, crash cymbals, final live hit"],
      ],
    };
  }

  if (/\brock(?:[- ]?and[- ]?roll)?\b|\bguitars?\b|\bbands?\b|\bamps?\b|\bamplifiers?\b|\briffs?\b/.test(text)) {
    return {
      bpm: /80s|1980/.test(text) ? 136 : 128,
      key: "A minor",
      styleSummary: "guitar-driven rock production with electric guitars, live drums, bass guitar, amplifier room tone, riffs, and strong chorus lift",
      negativeStyleSummary: "synth-pop lead sound design, EDM drop, electronic dance beat, glossy pop synth hook, trap hi-hats",
      sections: [
        ["intro", 0.14, 0.25, "electric guitar riff, live drum count-in feel, bass guitar entering under amplifier room tone"],
        ["verse_1", 0.22, 0.45, "tight live drums, bass guitar groove, palm-muted electric guitars, close lead vocal"],
        ["pre_chorus", 0.14, 0.66, "guitars open wider, tom lift, bass climb, cymbal push"],
        ["chorus_1", 0.24, 0.95, "full live drums, distorted guitar hook, bass drive, layered rock vocal lift"],
        ["bridge", 0.12, 0.38, "stripped guitar break, half-time live drums, controlled amplifier feedback"],
        ["final_chorus", 0.14, 1, "maximum band energy, layered guitars, crash cymbals, final live hit"],
      ],
    };
  }

  if (/\bcountry\b/.test(text)) {
    return {
      bpm: 118,
      key: "G major",
      styleSummary: "modern country production with acoustic guitar, electric guitar fills, live drums, bass, organic vocal storytelling, and warm room tone",
      negativeStyleSummary: "EDM drop, synth-pop hook, robotic percussion, overly glossy electronic lead",
      sections: [
        ["intro", 0.14, 0.24, "acoustic guitar figure, subtle electric guitar answer, brushed live drums"],
        ["verse_1", 0.22, 0.44, "acoustic strum, bass guitar, restrained live drums, close storytelling vocal"],
        ["pre_chorus", 0.14, 0.64, "electric guitar lift, tom build, harmony hint"],
        ["chorus_1", 0.24, 0.92, "full country-rock drums, acoustic and electric guitar hook, bass drive, harmony vocal"],
        ["bridge", 0.12, 0.36, "stripped acoustic guitar, pedal-steel-like color, half-time drums"],
        ["final_chorus", 0.14, 1, "wide country-rock chorus, live drums, guitar layers, clean ending"],
      ],
    };
  }

  if (/\bjazz\b/.test(text)) {
    return {
      bpm: 112,
      key: "D minor",
      styleSummary: "cinematic jazz-pop arrangement with upright or warm electric bass, brushed drums, piano or guitar comping, horn color, and expressive vocal phrasing",
      negativeStyleSummary: "EDM drop, generic synth-pop arpeggio, heavy distorted rock wall",
      sections: [
        ["intro", 0.14, 0.22, "piano or guitar color, brushed cymbals, warm bass entrance"],
        ["verse_1", 0.22, 0.42, "brushed drums, walking bass hints, close vocal phrasing"],
        ["pre_chorus", 0.14, 0.62, "rising piano voicings, snare brush lift, horn or guitar answer"],
        ["chorus_1", 0.24, 0.88, "fuller jazz-pop groove, bass movement, bright chord lift, layered vocal"],
        ["bridge", 0.12, 0.34, "intimate breakdown, sparse piano or guitar, cymbal wash"],
        ["final_chorus", 0.14, 1, "wide jazz-pop finish, brushed drums opening up, final chord hit"],
      ],
    };
  }

  if (/\bhip[- ]?hop\b|\brap\b/.test(text)) {
    return {
      bpm: 94,
      key: "C minor",
      styleSummary: "cinematic hip-hop production with grounded drums, bass movement, sample-like texture, vocal pocket, and clear section dynamics",
      negativeStyleSummary: "rock guitar wall, EDM festival drop, generic synth-pop chorus",
      sections: [
        ["intro", 0.14, 0.22, "filtered sample texture, sparse kick, sub-bass hint"],
        ["verse_1", 0.22, 0.48, "tight hip-hop drums, bass groove, close vocal pocket"],
        ["pre_chorus", 0.14, 0.62, "percussion lift, widened sample texture, bass anticipation"],
        ["chorus_1", 0.24, 0.9, "full drums, memorable vocal hook, deeper bass movement"],
        ["bridge", 0.12, 0.36, "half-time drums, atmospheric sample, sparse vocal texture"],
        ["final_chorus", 0.14, 1, "maximum groove, stacked hook, clean final hit"],
      ],
    };
  }

  if (/\bsynth\b|\belectronic\b|\btechno\b|\bsynthwave\b|\bchillsynth\b|\bneon\b|\bfuture\b/.test(text)) {
    return {
      bpm: brief.aspectRatio === "9:16" ? 132 : 124,
      key: "A minor",
      styleSummary: "electronic production with synth pulse, clean programmed drums, bass movement, cinematic pads, and section-aware vocal texture",
      negativeStyleSummary: "generic rock-band mix, uncontrolled tempo drift, muddy low end",
      sections: [
        ["intro", 0.14, 0.25, "filtered synth pulse, sparse vocal texture"],
        ["verse_1", 0.22, 0.45, "tight programmed drums, muted bass, close vocal"],
        ["pre_chorus", 0.14, 0.66, "rising pads, syncopated percussion"],
        ["chorus_1", 0.24, 0.95, "full drums, bright hook synth, layered vocal"],
        ["bridge", 0.12, 0.38, "half-time beat, atmospheric chords"],
        ["final_chorus", 0.14, 1, "maximum energy, stacked hook, final hit"],
      ],
    };
  }

  return synthesizedProfile(brief, editDirection);
}

function musicProfileById(profileId: string, brief: CreativeBrief, editDirection = ""): MusicProfile {
  const text = `${brief.storySpine} ${brief.genre} ${editDirection}`.toLowerCase();
  const contract = brief.styleContract;
  const requested = contract?.musicIntent.requestedInstruments ?? [];
  const requestedText = requested.length ? `${requested.join(", ")}. ` : "";
  const profile = profileId.toLowerCase();

  if (profile === "metal") {
    return {
      bpm: 152,
      key: "E minor",
      styleSummary: `${requestedText}heavy guitar-driven metal with distorted electric guitars, live drums, bass guitar, amplifier pressure, tight riffs, and forceful section impact`,
      sections: rockSections("distorted electric guitar riff", "heavy guitar hook", "maximum metal band energy"),
    };
  }

  if (profile === "punk") {
    return {
      bpm: 164,
      key: "A minor",
      styleSummary: `${requestedText}raw punk-rock production with fast electric guitars, live drums, bass drive, shouted hook energy, and rehearsal-room grit`,
      sections: rockSections("fast downstroke guitar riff", "raw guitar hook", "maximum punk band energy"),
    };
  }

  if (profile === "rock") {
    return {
      bpm: /80s|1980/.test(text) ? 136 : 128,
      key: "A minor",
      styleSummary: `${requestedText}guitar-driven rock and roll production with electric guitars, live drums, bass guitar, amplifier room tone, riffs, and strong chorus lift`,
      sections: rockSections("electric guitar riff", "distorted guitar hook", "maximum band energy"),
    };
  }

  if (profile === "jazz") {
    return {
      bpm: /smooth|lounge|chill|laid/.test(text) ? 92 : 112,
      key: "D minor",
      styleSummary: `${requestedText}smooth cinematic jazz arrangement with saxophone color, piano or electric keys, upright or warm electric bass, brushed drums, tasteful fills, and relaxed expressive phrasing`,
      sections: [
        ["intro", 0.14, 0.2, "saxophone or piano opening color, brushed cymbals, warm bass entrance"],
        ["verse_1", 0.22, 0.38, "brushed drums, relaxed bass movement, piano or guitar comping, close melodic phrasing"],
        ["pre_chorus", 0.14, 0.56, "rising piano voicings, gentle snare brush lift, saxophone or guitar answer"],
        ["chorus_1", 0.24, 0.82, "fuller smooth-jazz groove, bass movement, bright chord lift, horn color"],
        ["bridge", 0.12, 0.3, "intimate breakdown, sparse piano or guitar, cymbal wash, warm room tone"],
        ["final_chorus", 0.14, 0.92, "wide jazz finish, brushed drums opening up, sax or keys resolving the hook"],
      ],
    };
  }

  if (profile === "electronic") {
    // Word boundaries matter: an unbounded /tron/ matches "elec(tron)ic", which made every
    // electronic prompt fall into the Tron/gridlike variant. Keep it to actual Tron/grid cues.
    const tron = /\btron\b|\bgrid\b|\bdigital\b/.test(text) || brief.styleContract?.visualIntent.primaryStyle.toLowerCase().includes("grid");
    return {
      bpm: tron ? 132 : brief.aspectRatio === "9:16" ? 130 : 124,
      key: "A minor",
      styleSummary: `${requestedText}${tron ? "techno-pop electronic production with precise synth pulses, drum-machine momentum, electronic bass, clean arpeggios, and luminous gridlike motion" : "electronic production with synth pulse, programmed drums, bass movement, cinematic pads, and clean section dynamics"}`,
      sections: [
        ["intro", 0.14, 0.25, "filtered synth pulse, electronic bass hint, crisp programmed percussion"],
        ["verse_1", 0.22, 0.45, "tight programmed drums, muted synth bass, clean arpeggio movement"],
        ["pre_chorus", 0.14, 0.66, "rising synth chords, syncopated percussion, widening electronic texture"],
        ["chorus_1", 0.24, 0.95, "full programmed drums, bright synth hook, electronic bass drive"],
        ["bridge", 0.12, 0.38, "half-time beat, atmospheric synth chords, filtered percussion"],
        ["final_chorus", 0.14, 1, "maximum electronic energy, stacked synth hook, clean final hit"],
      ],
    };
  }

  if (profile === "hip_hop") {
    return {
      bpm: 94,
      key: "C minor",
      styleSummary: `${requestedText}cinematic hip-hop production with grounded drums, bass movement, sample-like texture, vocal pocket, and clear section dynamics`,
      sections: [
        ["intro", 0.14, 0.22, "filtered sample texture, sparse kick, sub-bass hint"],
        ["verse_1", 0.22, 0.48, "tight hip-hop drums, bass groove, close vocal pocket"],
        ["pre_chorus", 0.14, 0.62, "percussion lift, widened sample texture, bass anticipation"],
        ["chorus_1", 0.24, 0.9, "full drums, memorable hook, deeper bass movement"],
        ["bridge", 0.12, 0.36, "half-time drums, atmospheric sample, sparse texture"],
        ["final_chorus", 0.14, 1, "maximum groove, stacked hook, clean final hit"],
      ],
    };
  }

  if (profile === "funk_disco") {
    return {
      bpm: 116,
      key: "E minor",
      styleSummary: `${requestedText}funk and disco production with syncopated bass, tight live drums, rhythm guitar, bright keys, hand percussion, and dance-floor section lift`,
      sections: grooveSections("syncopated bass", "rhythm guitar", "bright keys"),
    };
  }

  if (profile === "blues_rnb") {
    return {
      bpm: 88,
      key: "B minor",
      styleSummary: `${requestedText}blues and R&B groove with warm bass, soulful keys, pocket drums, expressive guitar or horn fills, and intimate vocal space`,
      sections: grooveSections("warm bass groove", "soulful keys", "expressive guitar fills"),
    };
  }

  if (profile === "country" || profile === "folk") {
    return {
      bpm: profile === "country" ? 118 : 104,
      key: "G major",
      styleSummary: `${requestedText}${profile === "country" ? "modern country" : "folk acoustic"} production with acoustic guitar, supportive bass, live drums or organic percussion, warm room tone, and direct storytelling dynamics`,
      sections: [
        ["intro", 0.14, 0.24, "acoustic guitar figure, warm room tone, subtle percussion"],
        ["verse_1", 0.22, 0.44, "acoustic strum, bass support, restrained live drums, close storytelling vocal"],
        ["pre_chorus", 0.14, 0.64, "guitar lift, tom or hand-percussion build, harmony hint"],
        ["chorus_1", 0.24, 0.9, "full organic chorus, acoustic and electric guitar hook, bass drive"],
        ["bridge", 0.12, 0.36, "stripped acoustic guitar, intimate room tone, half-time percussion"],
        ["final_chorus", 0.14, 1, "wide organic finish, guitar layers, clean ending"],
      ],
    };
  }

  if (profile === "orchestral") {
    return {
      bpm: 96,
      key: "D minor",
      styleSummary: `${requestedText}orchestral cinematic score with strings, brass or woodwind color, cinematic percussion, dynamic swells, and clean emotional structure`,
      sections: [
        ["intro", 0.14, 0.2, "low strings, soft piano or woodwind color, distant percussion"],
        ["verse_1", 0.22, 0.42, "pulsing strings, restrained percussion, melodic motif"],
        ["pre_chorus", 0.14, 0.66, "string rise, brass warmth, timpani or taiko-like lift"],
        ["chorus_1", 0.24, 0.92, "full orchestral swell, cinematic percussion, wide harmonic lift"],
        ["bridge", 0.12, 0.34, "reduced strings and piano, suspended harmony"],
        ["final_chorus", 0.14, 1, "maximum orchestral finish, percussion and strings resolving together"],
      ],
    };
  }

  if (profile === "ambient") {
    return {
      bpm: 78,
      key: "A minor",
      styleSummary: `${requestedText}ambient textural score with slow evolving harmony, soft pulses, spacious bass, restrained percussion, and immersive atmosphere`,
      sections: [
        ["intro", 0.14, 0.14, "slow evolving texture, soft pulse, distant harmonic color"],
        ["verse_1", 0.22, 0.28, "subtle rhythm, warm bass wash, atmospheric detail"],
        ["pre_chorus", 0.14, 0.46, "gradual harmonic bloom, delicate percussion lift"],
        ["chorus_1", 0.24, 0.7, "wide ambient swell, deeper pulse, shimmering texture"],
        ["bridge", 0.12, 0.24, "near-silence texture, sparse tone, breath-like movement"],
        ["final_chorus", 0.14, 0.82, "largest ambient bloom, resolved pulse, clean tail"],
      ],
    };
  }

  if (profile === "world_traditional") {
    return {
      bpm: 108,
      key: "D minor",
      styleSummary: `${requestedText}world/traditional-instrument arrangement with featured acoustic instrument, organic percussion, modal melody, warm room tone, and respectful cinematic dynamics`,
      sections: [
        ["intro", 0.14, 0.2, "featured traditional instrument motif, room tone, soft percussion"],
        ["verse_1", 0.22, 0.42, "organic percussion, modal melody, supportive bass or drone"],
        ["pre_chorus", 0.14, 0.62, "instrumental lift, hand percussion build, harmonic widening"],
        ["chorus_1", 0.24, 0.88, "full traditional-instrument hook, stronger percussion, cinematic bass support"],
        ["bridge", 0.12, 0.34, "stripped instrument solo, sparse percussion, resonant space"],
        ["final_chorus", 0.14, 1, "maximum acoustic ensemble energy, final resolved hit"],
      ],
    };
  }

  if (profile === "gregorian") {
    return {
      bpm: 60,
      key: "D dorian",
      styleSummary: clipStyle(
        `${requestedText}Gregorian chant and sacred choral music, monophonic modal plainsong, male monastic choir in unison, Latin liturgical text, vast stone-cathedral reverb, sacred and meditative`,
      ),
      negativeStyleSummary:
        "drums, percussion, drum machine, bass guitar, electric guitar, synth, pop beat, modern production, autotune, hand claps",
      sections: [
        ["intro", 0.18, 0.18, "solo cantor intonation, single modal line, cavernous reverb tail, no percussion"],
        ["verse_1", 0.22, 0.3, "full male choir in unison plainsong, sustained Latin syllables, no percussion"],
        ["pre_chorus", 0.14, 0.34, "choir swells gently, modal melodic rise, sustained open vowels"],
        ["chorus_1", 0.22, 0.42, "fuller unison choir, resonant cathedral bloom, still no percussion"],
        ["bridge", 0.1, 0.24, "solo cantor returns, sparse modal line, long reverb"],
        ["final_chorus", 0.14, 0.4, "full choir final cadence, sustained modal resolution, slow reverb decay"],
      ],
    };
  }

  if (profile === "pop") {
    return {
      bpm: 122,
      key: "A minor",
      styleSummary: `${requestedText}polished pop production with clear hook, supportive drums, bass movement, melodic lift, and clean section contrast`,
      sections: [
        ["intro", 0.14, 0.24, "memorable melodic color, tight kick, bass hint"],
        ["verse_1", 0.22, 0.44, "clean drums, bass movement, close vocal space"],
        ["pre_chorus", 0.14, 0.64, "rising harmony, percussion lift, widening hook elements"],
        ["chorus_1", 0.24, 0.92, "full pop drums, strong melodic hook, wider vocal layers"],
        ["bridge", 0.12, 0.36, "stripped groove, intimate melodic breakdown"],
        ["final_chorus", 0.14, 1, "maximum hook energy, layered finish, clean final hit"],
      ],
    };
  }

  return synthesizedProfile(brief, editDirection);
}

// Pass-through profile for ANY genre without a curated named branch. Builds the global style from
// the contract's primaryGenre + positiveStyle + requested instruments so the engine honors the
// genre the LLM (or user) named — instead of collapsing it to a generic pop-leaning cinematic bed.
// Section instrumentation is built from the genre's own lead so no off-genre percussion is assumed.
function synthesizedProfile(brief: CreativeBrief, editDirection = ""): MusicProfile {
  const contract = brief.styleContract;
  const text = `${brief.storySpine} ${brief.genre} ${editDirection}`;
  const genre = (contract?.musicIntent.primaryGenre ?? brief.genre ?? "cinematic").trim();
  const positive = contract?.musicIntent.positiveStyle ?? [];
  const requested = contract?.musicIntent.requestedInstruments ?? [];
  const tempoFeel = contract?.musicIntent.tempoFeel ?? "";
  const lead = uniqueStrings([...requested, ...positive]);
  const leadText = lead.length ? lead.join(", ") : "the requested instrumentation";
  const { bpm, key } = tempoKeyFor(genre, `${tempoFeel} ${text}`, brief.aspectRatio);
  const styleSummary = clipStyle(
    uniqueStrings([
      genre,
      ...positive,
      requested.length ? `featuring ${requested.join(", ")}` : undefined,
      tempoFeel ? `${tempoFeel} feel` : undefined,
      "clear section dynamics and focused arrangement",
    ]).join(", "),
  );
  return {
    bpm,
    key,
    styleSummary,
    negativeStyleSummary: "generic pop template, off-genre arrangement, muddy mix, uncontrolled tempo drift",
    sections: [
      ["intro", 0.14, 0.22, `sparse ${leadText}, intimate entrance, low dynamic`],
      ["verse_1", 0.22, 0.42, `grounded ${leadText}, steady groove, close lead focus`],
      ["pre_chorus", 0.14, 0.62, `rising arrangement, ${leadText} widening, lifting dynamic`],
      ["chorus_1", 0.24, 0.88, `full ${leadText}, strongest hook or motif, widest arrangement`],
      ["bridge", 0.12, 0.34, `stripped-back ${leadText}, intimate breakdown`],
      ["final_chorus", 0.14, 1, `maximum ${leadText} energy, resolved motif, clean final hit`],
    ],
  };
}

// Genre -> tempo/key heuristic, replacing the old "everything is ~118-126 / A minor" default.
// tempoFeel/prompt text can override (explicit "NNN bpm", or fast/slow cues).
function tempoKeyFor(genre: string, hints: string, aspectRatio: CreativeBrief["aspectRatio"]) {
  const text = `${genre} ${hints}`.toLowerCase();
  const table: Array<[RegExp, number, string]> = [
    [/gregorian|plainchant|plainsong|\bchant\b|liturg/, 60, "D dorian"],
    [/ambient|drone|meditat/, 70, "A minor"],
    [/ballad|bolero|bachata/, 76, "A minor"],
    [/gospel|\bsoul\b/, 84, "E-flat major"],
    [/trap|drill/, 140, "F minor"],
    [/boom[- ]?bap|hip[- ]?hop|\brap\b/, 90, "C minor"],
    [/reggaeton/, 95, "A minor"],
    [/reggae|\bdub\b|\bska\b/, 92, "A minor"],
    [/blues|r&b|rnb/, 88, "B minor"],
    [/jazz|swing/, 112, "D minor"],
    [/bluegrass|country|folk/, 108, "G major"],
    [/afrobeat|latin|salsa|cumbia|samba|mariachi/, 100, "C minor"],
    [/drum\s*(?:&|and|n)\s*bass|\bdnb\b|jungle/, 174, "F minor"],
    [/dubstep/, 140, "F minor"],
    [/house|techno|trance/, 126, "A minor"],
    [/synthwave/, 100, "A minor"],
    [/punk|hardcore/, 168, "A minor"],
    [/\bmetal\b|thrash/, 152, "E minor"],
    [/grunge/, 116, "E minor"],
    [/opera|orchestral|classical|baroque|symphon/, 96, "D minor"],
    [/\brock\b/, 128, "A minor"],
  ];
  let bpm = aspectRatio === "9:16" ? 126 : 118;
  let key = "A minor";
  for (const [pattern, b, k] of table) {
    if (pattern.test(text)) {
      bpm = b;
      key = k;
      break;
    }
  }
  const explicit = /\b(\d{2,3})\s*bpm\b/.exec(text);
  if (explicit) bpm = clampBpm(Number(explicit[1]));
  else if (/up-?tempo|high energy|driving|\bfast\b/.test(text)) bpm = clampBpm(bpm + 12);
  else if (/laid-?back|\bslow\b|ballad|\bchill\b/.test(text)) bpm = clampBpm(bpm - 16);
  return { bpm, key };
}

// Folds the contract's positiveStyle into a NAMED profile's global style summary (only), so even a
// matched genre improves from a richer prompt and shared buckets stay distinct (house vs techno).
// Per-section instrumentation is left untouched, and tokens that contradict the profile's own
// negatives (e.g. "synth" on a metal track) are dropped.
function enrichWithContract(profile: MusicProfile, brief: CreativeBrief): MusicProfile {
  const positive = brief.styleContract?.musicIntent.positiveStyle ?? [];
  if (positive.length === 0) return profile;
  const negative = (profile.negativeStyleSummary ?? "").toLowerCase();
  const summary = profile.styleSummary.toLowerCase();
  const additions = positive.filter((token) => {
    const lower = token.toLowerCase();
    const head = lower.split(" ")[0];
    return head.length > 0 && !negative.includes(head) && !summary.includes(lower);
  });
  if (additions.length === 0) return profile;
  return { ...profile, styleSummary: clipStyle(`${profile.styleSummary}, ${additions.join(", ")}`) };
}

// Applies explicit Advanced-music-panel tempo/intensity to any profile (named or synthesized).
// No-op when controls are absent or "auto", so default behavior is unchanged.
function applyControlOverrides(profile: MusicProfile, brief: CreativeBrief): MusicProfile {
  const controls = brief.musicControls;
  if (!controls) return profile;
  let bpm = profile.bpm;
  if (controls.bpm) bpm = clampBpm(controls.bpm);
  else if (controls.tempo === "slow") bpm = clampBpm(profile.bpm - 18);
  else if (controls.tempo === "fast") bpm = clampBpm(profile.bpm + 18);
  let sections = profile.sections;
  const delta = controls.intensity === "high" ? 0.12 : controls.intensity === "low" ? -0.14 : 0;
  if (delta !== 0) {
    sections = profile.sections.map(
      ([id, ratio, energy, instrumentation]) =>
        [id, ratio, Math.max(0, Math.min(1, energy + delta)), instrumentation] as const,
    );
  }
  if (bpm === profile.bpm && sections === profile.sections) return profile;
  return { ...profile, bpm, sections };
}

function rockSections(introHook: string, chorusHook: string, finalEnergy: string): MusicProfile["sections"] {
  return [
    ["intro", 0.14, 0.25, `${introHook}, live drum count-in feel, bass guitar entering under amplifier room tone`],
    ["verse_1", 0.22, 0.45, "tight live drums, bass guitar groove, palm-muted electric guitars, close lead vocal"],
    ["pre_chorus", 0.14, 0.66, "guitars open wider, tom lift, bass climb, cymbal push"],
    ["chorus_1", 0.24, 0.95, `full live drums, ${chorusHook}, bass drive, layered rock vocal lift`],
    ["bridge", 0.12, 0.38, "stripped guitar break, half-time live drums, controlled amplifier feedback"],
    ["final_chorus", 0.14, 1, `${finalEnergy}, layered guitars, crash cymbals, final live hit`],
  ];
}

function grooveSections(bass: string, rhythm: string, color: string): MusicProfile["sections"] {
  return [
    ["intro", 0.14, 0.24, `${bass} tease, tight kick, ${color} accent`],
    ["verse_1", 0.22, 0.44, `${bass}, pocket drums, ${rhythm}, close vocal space`],
    ["pre_chorus", 0.14, 0.64, `percussion lift, ${color}, bass anticipation`],
    ["chorus_1", 0.24, 0.92, `full groove, ${bass}, ${rhythm}, bright hook lift`],
    ["bridge", 0.12, 0.36, "stripped pocket, bass feature, sparse percussion"],
    ["final_chorus", 0.14, 1, "maximum groove, tight drums, final ensemble hit"],
  ];
}

export function chooseVoiceFamily(brief: CreativeBrief, editDirection = ""): MusicPlan["voiceFamily"] {
  // An explicit Advanced-music-panel vocal choice wins over all inference.
  const explicit = brief.musicControls?.vocals;
  if (explicit && explicit !== "auto") {
    if (explicit === "instrumental") return "instrumental";
    if (explicit === "choir" || explicit === "mixed") return "mixed";
    return explicit;
  }
  const vocalMode = brief.styleContract?.musicIntent.vocalMode;
  if (vocalMode === "instrumental") return "instrumental";
  if (vocalMode === "mixed") return "mixed";
  const profile = canonicalizeMusicProfile(brief.styleContract?.routing.musicProfile);
  const text = `${brief.storySpine} ${brief.subject.description} ${brief.genre} ${editDirection}`.toLowerCase();
  if (/\binstrumental\b|\bno vocals\b/.test(text)) return "instrumental";
  // Sacred and choir-led genres sing as an ensemble.
  if (profile === "gregorian" || profile === "gospel" || /\bchoir\b|\bchant\b|\bgregorian\b|\bgospel\b/.test(text)) return "mixed";
  if (/\bduet\b|\bgroup vocal\b|\bmixed\b/.test(text)) return "mixed";
  // Explicit gender cues take precedence over genre defaults.
  if (/\bfemale\b|\bwoman\b|\bwomen\b|\bgirl\b|\bmother\b|\bbride\b|\bshe\b|\bher\b/.test(text)) return "female";
  if (/\bmale\b|\bman\b|\bmen\b|\bboy\b|\bfather\b|\bgroom\b|\bhe\b|\bhim\b/.test(text)) return "male";
  // Aggressive guitar genres lean a male lead when no explicit gender cue is present.
  if (profile === "metal" || profile === "punk" || profile === "rock" || /\bmetal\b|\bpunk\b|\brock\b|\bcountry\b/.test(text)) return "male";
  // Inherently vocal genres get a genre-appropriate lead even without an explicit cue, so e.g. rap is
  // never left silent. Variety here (not a universal female-pop default) is the point.
  const vocalLead: Record<string, MusicPlan["voiceFamily"]> = {
    hip_hop: "male",
    trap: "male",
    reggae: "male",
    afrobeat: "male",
    latin: "male",
    funk_disco: "mixed",
    pop: "female",
    blues_rnb: "female",
    opera: "female",
  };
  if (vocalLead[profile]) return vocalLead[profile];
  // "Panel decides" / instrumental-until-set: instrumental-leaning or unknown genres (ambient,
  // orchestral, electronic, jazz, cinematic) default to instrumental instead of a pop vocalist.
  if (vocalMode === "vocal") return "female";
  return "instrumental";
}

function musicDirectionSummary(editDirection: string) {
  return editDirection
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}
