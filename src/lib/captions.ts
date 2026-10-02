import type { TimelineManifestV2, TimelineSegment } from "@/lib/schemas";

type CaptionCue = { startMs: number; endMs: number; text: string };

export function captionCuesFromTimeline(timeline: TimelineManifestV2): CaptionCue[] {
  return timeline.tracks
    .filter((track) => track.kind === "captions")
    .flatMap((track) => track.segments)
    .filter((segment) => segment.kind === "caption")
    .map(captionCue)
    .filter((cue): cue is CaptionCue => Boolean(cue))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

export function timelineToSrt(timeline: TimelineManifestV2) {
  return captionCuesFromTimeline(timeline)
    .map((cue, index) => [
      String(index + 1),
      `${timestamp(cue.startMs, ",")} --> ${timestamp(cue.endMs, ",")}`,
      cue.text,
    ].join("\n"))
    .join("\n\n") + "\n";
}

export function timelineToVtt(timeline: TimelineManifestV2) {
  const cues = captionCuesFromTimeline(timeline)
    .map((cue) => [
      `${timestamp(cue.startMs, ".")} --> ${timestamp(cue.endMs, ".")}`,
      cue.text,
    ].join("\n"))
    .join("\n\n");
  return `WEBVTT\n\n${cues}${cues ? "\n" : ""}`;
}

function captionCue(segment: TimelineSegment): CaptionCue | null {
  const rawText = segment.metadata.text;
  if (typeof rawText !== "string") return null;
  const text = rawText.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  return { startMs: segment.startMs, endMs: segment.endMs, text };
}

function timestamp(totalMs: number, millisecondSeparator: "," | ".") {
  const bounded = Math.max(0, Math.round(totalMs));
  const milliseconds = bounded % 1_000;
  const totalSeconds = Math.floor(bounded / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${millisecondSeparator}${String(milliseconds).padStart(3, "0")}`;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
