import { randomUUID } from "node:crypto";

import { mockAudioUrl, mockImageUrl, mockVideoUrl } from "@/lib/mock-assets";
import type {
  AnchorAsset,
  CreativeBrief,
  GeneratedShot,
  MusicPlan,
  MusicTrack,
  Shot,
} from "@/lib/schemas";
import type {
  AnchorReferenceInput,
  ImageProvider,
  ModerationProvider,
  MusicProvider,
  ProviderContext,
  ProviderResult,
  VideoProvider,
} from "@/providers/types";

export class MockImageProvider implements ImageProvider {
  async generateAnchorAsset(
    role: AnchorAsset["role"],
    prompt: string,
    context: ProviderContext,
    _options = {},
    _references?: AnchorReferenceInput,
  ): Promise<ProviderResult<AnchorAsset>> {
    void _options;
    void _references;
    const variant = role === "style" ? 1 : role === "environment" ? 2 : 0;
    return {
      data: {
        role,
        url: mockImageUrl(variant),
        promptUsed: prompt,
        c2paClaim: `mock-c2pa-${context.videoId}-${role}`,
      },
      requestId: `mock-image-${role}-${randomUUID()}`,
      latencyMs: 120,
      costUsd: 0.12,
    };
  }
}

export class MockMusicProvider implements MusicProvider {
  async compose(plan: MusicPlan, context: ProviderContext, _options = {}): Promise<ProviderResult<MusicTrack>> {
    void _options;
    const durationSeconds = plan.sections.reduce((sum, section) => sum + section.durationSeconds, 0);
    return {
      data: {
        videoId: plan.videoId,
        url: mockAudioUrl(plan.videoId, durationSeconds),
        durationSeconds,
        songId: `mock-song-${plan.videoId}`,
        lyrics: [],
        providerRequestId: `mock-eleven-${context.idempotencyKey}`,
        title: `Mock Track (${plan.key})`,
        genres: ["mock"],
        languages: [plan.language ?? "en"],
        isExplicit: false,
      },
      requestId: `mock-eleven-${randomUUID()}`,
      latencyMs: 240,
      costUsd: 0,
    };
  }
}

export class MockVideoProvider implements VideoProvider {
  async generateShot(
    shot: Shot,
    _brief: CreativeBrief,
    context: ProviderContext,
    _options = {},
  ): Promise<ProviderResult<GeneratedShot>> {
    void _options;
    const durationSeconds = Math.min(15, Math.max(4, Math.round((shot.endMs - shot.startMs) / 1000)));
    return {
      data: {
        shotIndex: shot.shotIndex,
        providerRequestId: `mock-seedance-${context.idempotencyKey}`,
        videoUrl: mockVideoUrl(context.videoId, shot.shotIndex, durationSeconds, _brief.aspectRatio),
        requestedDurationSeconds: durationSeconds,
        actualDurationSeconds: durationSeconds,
        durationSeconds,
        seed: shot.seed,
        costUsd: Number((durationSeconds * 0.02).toFixed(2)),
        latencyMs: 350,
        attempts: 1,
      },
      requestId: `mock-fal-${randomUUID()}`,
      latencyMs: 350,
      costUsd: Number((durationSeconds * 0.02).toFixed(2)),
    };
  }
}

export class MockModerationProvider implements ModerationProvider {
  async checkText(input: string) {
    const blocked = /(celebrity|deepfake|nude|explicit|travis scott|taylor swift)/i.test(input);
    return {
      allowed: !blocked,
      categories: blocked ? ["policy_reference_rewrite_required"] : [],
    };
  }
}
