import type { MusicControls } from "@/lib/schemas";

// Shared, single source of truth for the Advanced music panel. The UI renders these chips and
// the server (creativeStyleContract.applyMusicControls) maps a chosen preset onto the style
// contract, so a one-tap chip and the matching free-text prompt resolve to the same engine token.
//
// `musicProfile` MUST be a token the composition engine understands: either an existing named
// profile in compositionPlan.musicProfileById, or any string (handled by synthesizedProfile via
// the contract's primaryGenre + positiveStyle). `positiveStyle` seeds the global style summary so
// even genres that share an engine bucket (e.g. house vs techno → "electronic") stay distinct.

export type GenreGroupId = "loud" | "urban" | "electronic" | "acoustic_world";

export type GenrePreset = {
  id: string;
  label: string;
  group: GenreGroupId;
  musicProfile: string;
  genreLabel: string;
  positiveStyle: string[];
  negativeStyle?: string[];
};

export const DEFAULT_MUSIC_CONTROLS: MusicControls = {
  vocals: "auto",
  tempo: "auto",
  intensity: "auto",
};

export const GENRE_GROUPS: Array<{ id: GenreGroupId; label: string }> = [
  { id: "loud", label: "Loud & guitar-driven" },
  { id: "urban", label: "Hip-hop, urban & R&B" },
  { id: "electronic", label: "Electronic & dance" },
  { id: "acoustic_world", label: "Acoustic, world & sacred" },
];

export const GENRE_PRESETS: GenrePreset[] = [
  // Loud & guitar-driven
  { id: "rock", label: "Rock", group: "loud", musicProfile: "rock", genreLabel: "guitar-driven rock and roll", positiveStyle: ["electric guitars", "live drums", "bass guitar", "amplifier room tone", "riff-forward hooks"] },
  { id: "metal", label: "Metal", group: "loud", musicProfile: "metal", genreLabel: "heavy guitar-driven metal", positiveStyle: ["distorted electric guitars", "double-kick live drums", "bass guitar", "aggressive riffs", "amplifier pressure"] },
  { id: "punk", label: "Punk", group: "loud", musicProfile: "punk", genreLabel: "raw punk rock", positiveStyle: ["fast downstroke guitars", "driving live drums", "bass drive", "shouted hook energy"] },
  { id: "grunge", label: "Grunge", group: "loud", musicProfile: "rock", genreLabel: "90s grunge rock", positiveStyle: ["dynamic distorted guitars", "loud-quiet-loud dynamics", "gritty live drums", "raw vocal"] },
  { id: "classic-rock", label: "Classic R&R", group: "loud", musicProfile: "rock", genreLabel: "classic rock and roll", positiveStyle: ["twangy electric guitar", "walking bass", "shuffle live drums", "vintage amp tone"] },

  // Hip-hop, urban & R&B
  { id: "hiphop", label: "Hip-Hop", group: "urban", musicProfile: "hip_hop", genreLabel: "boom-bap hip-hop", positiveStyle: ["grounded drums", "sample-like texture", "bass groove", "clear vocal pocket"] },
  { id: "rap", label: "Rap", group: "urban", musicProfile: "hip_hop", genreLabel: "modern rap", positiveStyle: ["hard-hitting drums", "808 bass", "vocal pocket", "rhythmic flow"] },
  { id: "trap", label: "Trap", group: "urban", musicProfile: "trap", genreLabel: "modern trap", positiveStyle: ["booming 808 sub-bass", "rapid hi-hat rolls and triplets", "dark sparse keys", "half-time drums"] },
  { id: "drill", label: "Drill", group: "urban", musicProfile: "trap", genreLabel: "drill", positiveStyle: ["sliding 808 bass", "syncopated hi-hats", "ominous melody", "half-time drums"] },
  { id: "rnb", label: "R&B", group: "urban", musicProfile: "blues_rnb", genreLabel: "smooth R&B", positiveStyle: ["warm bass", "silky keys", "pocket drums", "soulful vocal"] },
  { id: "soul", label: "Soul", group: "urban", musicProfile: "blues_rnb", genreLabel: "classic soul", positiveStyle: ["horn section", "Hammond organ", "warm rhythm section", "expressive vocal"] },
  { id: "funk", label: "Funk", group: "urban", musicProfile: "funk_disco", genreLabel: "funk groove", positiveStyle: ["syncopated bass", "rhythm guitar", "tight live drums", "bright horns"] },

  // Electronic & dance
  { id: "house", label: "House", group: "electronic", musicProfile: "house", genreLabel: "house", positiveStyle: ["four-on-the-floor kick", "off-beat hats", "deep synth bass", "filtered chord stabs"] },
  { id: "techno", label: "Techno", group: "electronic", musicProfile: "house", genreLabel: "techno", positiveStyle: ["driving four-on-the-floor", "hypnotic synth", "industrial percussion", "relentless groove"] },
  { id: "trance", label: "Trance", group: "electronic", musicProfile: "house", genreLabel: "trance", positiveStyle: ["uplifting supersaw chords", "rolling bass", "euphoric build", "arpeggiated synth"] },
  { id: "dnb", label: "Drum & Bass", group: "electronic", musicProfile: "dnb", genreLabel: "drum and bass", positiveStyle: ["fast breakbeats", "deep sub-bass", "rolling energy", "atmospheric pads"] },
  { id: "dubstep", label: "Dubstep", group: "electronic", musicProfile: "dnb", genreLabel: "dubstep", positiveStyle: ["half-time wobble bass", "heavy syncopated drops", "growling synth", "sub pressure"] },
  { id: "synthwave", label: "Synthwave", group: "electronic", musicProfile: "electronic", genreLabel: "synthwave", positiveStyle: ["retro analog synths", "gated-reverb drums", "neon arpeggios", "nostalgic pads"] },
  { id: "ambient", label: "Ambient", group: "electronic", musicProfile: "ambient", genreLabel: "ambient textural score", positiveStyle: ["slow evolving pads", "soft pulses", "wide space", "immersive atmosphere"] },

  // Acoustic, world & sacred
  { id: "folk", label: "Folk", group: "acoustic_world", musicProfile: "folk", genreLabel: "folk acoustic", positiveStyle: ["acoustic guitar", "organic percussion", "warm room tone", "storytelling vocal"] },
  { id: "country", label: "Country", group: "acoustic_world", musicProfile: "country", genreLabel: "modern country", positiveStyle: ["acoustic and electric guitar", "live drums", "bass", "storytelling vocal"] },
  { id: "bluegrass", label: "Bluegrass", group: "acoustic_world", musicProfile: "bluegrass", genreLabel: "bluegrass", positiveStyle: ["banjo", "fiddle", "upright bass", "acoustic guitar", "high-lonesome harmony"] },
  { id: "reggae", label: "Reggae", group: "acoustic_world", musicProfile: "reggae", genreLabel: "roots reggae", positiveStyle: ["offbeat guitar skank", "one-drop drums", "dub bass", "organ bubble"] },
  { id: "latin", label: "Latin", group: "acoustic_world", musicProfile: "latin", genreLabel: "latin", positiveStyle: ["nylon or Spanish guitar", "clave and congas", "brass stabs", "montuno piano"] },
  { id: "afrobeat", label: "Afrobeat", group: "acoustic_world", musicProfile: "afrobeat", genreLabel: "afrobeat", positiveStyle: ["polyrhythmic percussion", "horn section", "interlocking guitars", "deep groove"] },
  { id: "jazz", label: "Jazz", group: "acoustic_world", musicProfile: "jazz", genreLabel: "smooth cinematic jazz", positiveStyle: ["saxophone", "piano or keys", "upright or warm bass", "brushed drums"] },
  { id: "blues", label: "Blues", group: "acoustic_world", musicProfile: "blues_rnb", genreLabel: "blues", positiveStyle: ["expressive electric guitar", "warm bass", "shuffle drums", "organ"] },
  { id: "gospel", label: "Gospel", group: "acoustic_world", musicProfile: "gospel", genreLabel: "contemporary gospel", positiveStyle: ["Hammond organ", "gospel choir harmonies", "piano", "warm bass", "hand claps", "call-and-response"] },
  { id: "orchestral", label: "Orchestral", group: "acoustic_world", musicProfile: "orchestral", genreLabel: "orchestral cinematic score", positiveStyle: ["strings", "brass", "woodwinds", "cinematic percussion", "dynamic swells"] },
  { id: "opera", label: "Opera", group: "acoustic_world", musicProfile: "opera", genreLabel: "operatic classical vocal", positiveStyle: ["operatic lead vocal", "full orchestra", "dramatic dynamics", "soaring melody"] },
  { id: "gregorian", label: "Gregorian Chant", group: "acoustic_world", musicProfile: "gregorian", genreLabel: "Gregorian chant and sacred choral", positiveStyle: ["male monastic choir in unison", "Latin plainchant", "modal melody", "vast cathedral reverb"], negativeStyle: ["drums", "percussion", "bass guitar", "synth", "modern pop production"] },
];

export const GENRE_PRESETS_BY_ID: Record<string, GenrePreset> = Object.fromEntries(
  GENRE_PRESETS.map((preset) => [preset.id, preset]),
);

export function genrePresetsForGroup(group: GenreGroupId): GenrePreset[] {
  return GENRE_PRESETS.filter((preset) => preset.group === group);
}
