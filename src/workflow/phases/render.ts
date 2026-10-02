import type { BeatGrid, GeneratedShot, MusicTrack, RenderManifest } from "@/lib/schemas";
import { mockImageUrl, mockVideoUrl } from "@/lib/mock-assets";
import { compileMusicTimeline, validateTimeline } from "@/lib/production";
import { getProviderMode } from "@/lib/server/config";

export async function createRenderManifest(input: {
  videoId: string;
  musicTrack: MusicTrack;
  generatedShots: GeneratedShot[];
  beatGrid: BeatGrid;
  aspectRatio: RenderManifest["aspectRatio"];
}): Promise<{ manifest: RenderManifest; videoUrl: string; thumbnailUrl: string }> {
  const manifest: RenderManifest = {
    videoId: input.videoId,
    music: {
      url: input.musicTrack.url,
      durationSeconds: input.musicTrack.durationSeconds,
    },
    shots: input.generatedShots,
    beatGrid: input.beatGrid,
    lyrics: input.musicTrack.lyrics,
    aspectRatio: input.aspectRatio,
  };
  manifest.timeline = compileMusicTimeline({
    productionId: input.videoId,
    shots: input.generatedShots,
    music: input.musicTrack,
    beatGrid: input.beatGrid,
    aspectRatio: input.aspectRatio,
  });
  manifest.qaReport = validateTimeline({ timeline: manifest.timeline });
  if (!manifest.qaReport.passed) {
    throw new Error("The compiled timeline failed structural QA before render.");
  }

  if (getProviderMode() === "mock") {
    return {
      manifest,
      videoUrl: mockVideoUrl(input.videoId, undefined, input.musicTrack.durationSeconds, input.aspectRatio),
      thumbnailUrl: mockImageUrl(1),
    };
  }

  const { renderManifestToBlob } = await import("@/lib/server/render");
  const render = await renderManifestToBlob(manifest);
  manifest.shots = manifest.shots.map((shot) => {
    const measured = render.mediaProbes.find((entry) => entry.shotIndex === shot.shotIndex)?.probe;
    if (!measured) return shot;
    return {
      ...shot,
      actualDurationSeconds: measured.durationSeconds,
      usableOutSeconds: measured.durationSeconds,
      probe: measured,
    };
  });
  manifest.timeline = compileMusicTimeline({
    productionId: input.videoId,
    shots: manifest.shots,
    music: input.musicTrack,
    beatGrid: input.beatGrid,
    aspectRatio: input.aspectRatio,
  });
  const structuralReport = validateTimeline({ timeline: manifest.timeline });
  manifest.qaReport = {
    ...render.qaReport,
    passed: render.qaReport.passed && structuralReport.passed,
    findings: [...structuralReport.findings, ...render.qaReport.findings],
    metrics: { ...structuralReport.metrics, ...render.qaReport.metrics },
  };
  if (!manifest.qaReport.passed) {
    throw new Error(
      `Render manifest failed timeline QA: ${manifest.qaReport.findings
        .filter((finding) => finding.severity === "error")
        .map((finding) => finding.message)
        .join("; ")}`,
    );
  }
  return { manifest, ...render };
}
