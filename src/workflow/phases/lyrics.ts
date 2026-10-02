import { providerFetch } from "@/lib/server/provider-execution";
import type { CreativeBrief } from "@/lib/schemas";
import { lyricsModel } from "@/lib/model-routing";
import { getProviderMode } from "@/lib/server/config";

// Genre-aware lyric generation. Replaces the old single hardcoded pop chorus ("turn the lights
// up …") that every vocal track inherited regardless of genre. In live mode we ask the LLM for
// original, non-explicit, era/genre/language-appropriate lyrics in ONE call; otherwise (and on any
// failure) we fall back to deterministic per-genre templates. Instrumental tracks never call this.

export type LyricRequest = {
  videoId: string;
  genre: string;
  language: string;
  vocalMode: "vocal" | "mixed";
  sectionIds: string[];
  themeHints: string[];
};

const LYRIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "lines"],
        properties: {
          id: { type: "string" },
          lines: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export function languageForGenre(genre: string): string {
  const text = genre.toLowerCase();
  if (/gregorian|plainchant|plainsong|liturg|sacred choral|monastic/.test(text)) return "Latin";
  if (/latin|salsa|reggaeton|cumbia|bachata|merengue|mariachi|flamenco|bossa|samba|spanish/.test(text)) return "Spanish";
  return "en";
}

export function themeHintsForBrief(brief: CreativeBrief): string[] {
  // Only concrete visual motifs make good lyric imagery; brief.mood is the musical tempo-feel
  // (e.g. "driving live-band pulse") and would read as nonsense if used as a lyric subject.
  return unique((brief.visualSignature?.recurringMotifs ?? []).filter(Boolean)).slice(0, 5);
}

export async function generateSectionLyrics(req: LyricRequest): Promise<Record<string, string>> {
  if (getProviderMode() === "live" && process.env.OPENAI_API_KEY) {
    const result = await callOpenAiLyrics(req).catch(() => null);
    if (result) return result;
  }
  return fallbackSectionLyrics(req);
}

async function callOpenAiLyrics(req: LyricRequest): Promise<Record<string, string> | null> {
  const response = await providerFetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: lyricsModel(),
      input: [
        {
          role: "system",
          content: [
            "You write ORIGINAL song lyrics for Cocoa Director's music engine.",
            "Original only: never quote or paraphrase existing songs, artists, or copyrighted lines.",
            "Non-explicit and broadcast-safe: no profanity, slurs, sexual content, drugs, or graphic violence.",
            "Match the requested genre and era idiomatically: rhythmic bars for rap/trap; liturgical Latin plainchant (e.g. \"Kyrie eleison\", \"Dona nobis pacem\") for Gregorian chant; Spanish for Latin genres; call-and-response for gospel.",
            "Write in the requested language.",
            "Keep each section short and singable: intros and bridges 1-2 lines, verses and choruses 2-4 lines.",
            "Provide lyrics for every requested section id. Return only JSON matching the schema.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            genre: req.genre,
            language: req.language,
            vocalMode: req.vocalMode,
            sectionIds: req.sectionIds,
            themeHints: req.themeHints,
          }),
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "section_lyrics",
          strict: true,
          schema: LYRIC_SCHEMA,
        },
      },
    }),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
  };
  const text = json.output_text ?? json.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
  if (!text) return null;
  const parsed = JSON.parse(text) as { sections?: Array<{ id: string; lines: string[] }> };
  const byId = new Map((parsed.sections ?? []).map((section) => [section.id, section.lines.join("\n").trim()]));
  const fallback = fallbackSectionLyrics(req);
  const out: Record<string, string> = {};
  for (const id of req.sectionIds) {
    const lines = byId.get(id);
    out[id] = lines && lines.length > 0 ? lines : fallback[id];
  }
  return out;
}

type LyricFamily = "chant" | "spanish" | "rap" | "gospel" | "default";

export function fallbackSectionLyrics(req: LyricRequest): Record<string, string> {
  const family = lyricFamilyFor(req.genre, req.language);
  const motifs = req.themeHints.map(lyricSafe).filter(Boolean);
  const m1 = motifs[0] ?? "light";
  const m2 = motifs[1] ?? "motion";
  const m3 = motifs[2] ?? "shadow";
  const out: Record<string, string> = {};
  for (const id of req.sectionIds) {
    out[id] = LYRIC_BUILDERS[family](id, m1, m2, m3);
  }
  return out;
}

function lyricFamilyFor(genre: string, language: string): LyricFamily {
  if (language === "Latin") return "chant";
  if (language === "Spanish") return "spanish";
  const text = genre.toLowerCase();
  if (/hip[- ]?hop|\brap\b|\btrap\b|drill|boom[- ]?bap/.test(text)) return "rap";
  if (/gospel|spiritual|worship/.test(text)) return "gospel";
  return "default";
}

// Liturgical Latin uses public-domain sacred phrases (not copyrighted lyrics), era-appropriate for chant.
const CHANT_LINES: Record<string, string> = {
  intro: "Kyrie eleison",
  verse_1: "Dona nobis pacem\nlux aeterna luceat",
  pre_chorus: "Gloria, gloria",
  chorus_1: "Gloria in excelsis\nsanctus, sanctus",
  bridge: "Agnus Dei",
  final_chorus: "Amen, amen",
};

const SPANISH_LINES: Record<string, string> = {
  intro: "esta noche comienza",
  verse_1: "siento el ritmo crecer\nbajo la luz de la ciudad",
  pre_chorus: "sube, sube el corazon",
  chorus_1: "baila conmigo hasta el amanecer\nsiente la musica renacer",
  bridge: "despacio, despacio",
  final_chorus: "baila conmigo una vez mas\nla noche no se va a acabar",
};

const LYRIC_BUILDERS: Record<LyricFamily, (id: string, m1: string, m2: string, m3: string) => string> = {
  chant: (id) => CHANT_LINES[id] ?? "alleluia",
  spanish: (id) => SPANISH_LINES[id] ?? "esta noche brilla",
  rap: (id, m1, m2, m3) => {
    const lines: Record<string, string> = {
      intro: `${m1} on the rise, hold tight`,
      verse_1: `moving through the ${m2}, every step locked in\n${m1} in the frame, let the story begin`,
      pre_chorus: `feel it building up, here we go`,
      chorus_1: `we run it back, ${m1} in the night\nkeep the ${m2} moving, everything feels right`,
      bridge: `slow it down, breathe in the ${m3}`,
      final_chorus: `we run it back, one more time tonight\nkeep the ${m1} burning, hold the light`,
    };
    return lines[id] ?? `keep the ${m1} moving`;
  },
  gospel: (id, m1, m2, m3) => {
    const lines: Record<string, string> = {
      intro: `oh, the ${m1} is rising`,
      verse_1: `through the ${m2} we are walking on\nlift it up, let the morning come`,
      pre_chorus: `higher, higher now`,
      chorus_1: `lift the ${m1} (lift it high)\nlet it carry us home tonight`,
      bridge: `in the quiet of the ${m3}, we believe`,
      final_chorus: `lift the ${m1} (lift it high)\nlet it carry us through the sky`,
    };
    return lines[id] ?? `lift the ${m1} higher`;
  },
  default: (id, m1, m2, m3) => {
    const lines: Record<string, string> = {
      intro: `where the ${m1} begins to move`,
      verse_1: `moving through the ${m2}\nchasing what the room won't say`,
      pre_chorus: `hold the frame until it opens`,
      chorus_1: `carry the ${m1} wide\nlet the ${m2} lead the way\nwe are the moment now\nwe are the frame`,
      bridge: `quiet in the ${m3}\nbreathing slow`,
      final_chorus: `carry the ${m1} on\nlet it break across the day\nwe are the spark now\nwe are the frame`,
    };
    return lines[id] ?? `the ${m1} moves through the frame`;
  },
};

function lyricSafe(value: string) {
  return (
    value
      .replace(/[^a-z0-9\s-]/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .slice(0, 32) || ""
  );
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}
