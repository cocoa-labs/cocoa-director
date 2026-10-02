import { reserveProviderAttempt } from "@/lib/server/budget-ledger";
import { fingerprint } from "@/lib/server/action-request";
import { Music } from "@elevenlabs/elevenlabs-js";

import type { MusicPlan, MusicProviderControls, MusicTrack } from "@/lib/schemas";
import {
  getElevenLabsMusicModel,
  getElevenLabsMusicOutputFormat,
  requireEnv,
} from "@/lib/server/config";
import { uploadPublicBlob } from "@/lib/server/blob";
import type { MusicProvider, ProviderContext, ProviderResult } from "@/providers/types";

// The ElevenLabs SDK (2.49.1) camelCases composeDetailed response keys at runtime
// (e.g. is_explicit -> isExplicit), but its SongMetadata type still declares snake_case.
// This describes the real runtime shape we read from response.json.songMetadata; title /
// genres / languages have no underscores and are unaffected, only isExplicit needs it.
type ElevenSongMetadata = {
  title?: string;
  genres?: string[];
  languages?: string[];
  isExplicit?: boolean;
};

export function toElevenCompositionPlan(plan: MusicPlan, controls: MusicProviderControls = {}) {
  const sectionEdits = new Map((controls.sectionEdits ?? []).map((section) => [section.id, section]));
  return {
    positiveGlobalStyles: uniqueStrings([
      "studio-grade music video soundtrack",
      `${plan.bpm} bpm`,
      `key ${plan.key}`,
      plan.styleSummary,
      vocalStyleFor(plan),
      controls.globalStyle,
    ]),
    negativeGlobalStyles: uniqueStrings([
      "copyrighted lyrics",
      "specific artist imitation",
      controls.negativeStyle,
    ]),
    sections: plan.sections.map((section) => {
      const edit = sectionEdits.get(section.id);
      return {
        sectionName: section.id,
        positiveLocalStyles: uniqueStrings([
          section.instrumentation,
          edit?.localStyle,
          `energy ${section.energy.toFixed(2)}`,
        ]),
        negativeLocalStyles: uniqueStrings([
          "uncontrolled tempo drift",
          // Very low-energy sections (chant, ambient, sustained reverb tails) intentionally breathe;
          // penalizing "long silent gap" there fights the genre, so only guard it on active sections.
          section.energy < 0.25 ? undefined : "long silent gap",
          edit?.negativeStyle,
        ]),
        durationMs: (edit?.durationSeconds ?? section.durationSeconds) * 1000,
        lines: section.lyrics ? section.lyrics.split(/\n+/).filter(Boolean) : [],
      };
    }),
  };
}

function isString(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter(isString))];
}

function vocalStyleFor(plan: MusicPlan) {
  if (!plan.vocal || plan.voiceFamily === "instrumental") return "instrumental score, no sung lead vocal";
  if (plan.voiceFamily === "male") return "clear male lead vocalist, expressive tenor or baritone vocal";
  if (plan.voiceFamily === "female") return "clear female lead vocalist, expressive alto or soprano vocal";
  // Sacred / gospel / operatic material reads as an ensemble rather than a duet-style pop blend.
  if (/\bchant\b|\bchoir\b|gregorian|gospel|sacred|liturg|opera/i.test(plan.styleSummary ?? "")) {
    return "unison or harmonized choir ensemble vocal, no single pop lead";
  }
  return "mixed male and female vocal layers, duet-friendly hook";
}

export class ElevenMusicProvider implements MusicProvider {
  async compose(
    plan: MusicPlan,
    context: ProviderContext,
    options: MusicProviderControls = {},
  ): Promise<ProviderResult<MusicTrack>> {
    const started = Date.now();
    const client = new Music({ apiKey: requireEnv("ELEVENLABS_API_KEY") });
    const durationSeconds = durationSecondsForPlan(plan, options);
    const modelId = getElevenLabsMusicModel();
    await reserveProviderAttempt({ scope: "elevenlabs:music", videoId: context.videoId, key: context.idempotencyKey, costCents: Math.ceil(durationSeconds / 60 * 80) });
    let response: Awaited<ReturnType<typeof client.composeDetailed>>;
    try {
      response = await client.composeDetailed({
        compositionPlan: toElevenCompositionPlan(plan, options),
        // The SDK still types modelId as the literal "music_v1" (@elevenlabs/elevenlabs-js 2.49.1),
        // so we cast the configured value through. The real string is sent verbatim, so "music_v2"
        // works the moment ElevenLabs enables it for this account.
        // TODO(elevenlabs-sdk): remove this cast once the SDK types modelId as "music_v1" | "music_v2"
        // (the same release should also fix the SongMetadata is_explicit/isExplicit .d.ts-vs-runtime bug).
        modelId: modelId as "music_v1",
        outputFormat: options.outputFormat ?? getElevenLabsMusicOutputFormat(),
        seed: options.seed,
        respectSectionsDurations: modelId === "music_v1" ? options.respectSectionDurations ?? true : undefined,
        storeForInpainting: options.storeForInpainting,
        withTimestamps: options.withTimestamps ?? false,
        signWithC2Pa: true,
      }, { maxRetries: 0, timeoutInSeconds: 180 });
    } catch (error) {
      // music_v2 is early-access / UI-only at launch ("coming soon to ElevenAPI"). If it was
      // selected and the API rejected it, surface an actionable error instead of an opaque one.
      if (modelId === "music_v2") {
        throw new Error(
          "ElevenLabs music_v2 was requested but the request failed — music_v2 requires early-access " +
            "API enablement on this account. Set ELEVENLABS_MUSIC_MODEL_ID=music_v1 unless v2 is enabled " +
            `for you. Cause: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
    const blob = await uploadPublicBlob({
      pathname: context.outputPathPrefix ? `${context.outputPathPrefix}/music.mp3` : `videos/${plan.videoId}/music-${fingerprint(context.idempotencyKey).slice(0, 20)}.mp3`,
      immutable: true,
      body: response.audio,
      contentType: "audio/mpeg",
    });

    // See ElevenSongMetadata: the SDK camelCases keys at runtime, so isExplicit (not is_explicit)
    // is the live key. Without this the explicit flag was silently undefined on every real track.
    const songMetadata = response.json?.songMetadata as ElevenSongMetadata | undefined;

    // Content-safety audit signal: surface explicit tracks at the source so the captured flag is
    // actionable rather than dead data. User-facing gating/labeling of explicit music is a separate
    // product decision; this just makes the signal observable.
    if (songMetadata?.isExplicit) {
      console.warn(
        JSON.stringify({
          event: "music_explicit_content_flagged",
          videoId: plan.videoId,
          traceId: context.traceId,
          title: songMetadata.title,
        }),
      );
    }

    return {
      data: {
        videoId: plan.videoId,
        url: blob.url,
        durationSeconds,
        songId: response.songId ?? `eleven-${context.idempotencyKey}`,
        lyrics: [],
        providerRequestId: response.songId ?? context.idempotencyKey,
        title: songMetadata?.title,
        genres: songMetadata?.genres,
        languages: songMetadata?.languages,
        isExplicit: songMetadata?.isExplicit,
      },
      requestId: response.songId ?? context.idempotencyKey,
      latencyMs: Date.now() - started,
      costUsd: Number((durationSeconds / 60 * 0.15).toFixed(4)),
    };
  }
}

function durationSecondsForPlan(plan: MusicPlan, controls: MusicProviderControls) {
  const sectionEdits = new Map((controls.sectionEdits ?? []).map((section) => [section.id, section.durationSeconds]));
  return plan.sections.reduce(
    (sum, section) => sum + (sectionEdits.get(section.id) ?? section.durationSeconds),
    0,
  );
}
