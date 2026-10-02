import type { VideoCreateRequest } from "@/lib/schemas";

// A character ("YOU") seed means the performer should appear on screen, so force performer
// visual mode: Treatment then marks the subject as a character and the shot planner threads
// the character reference into the video model downstream. Aesthetic-only seeds don't force
// it (there's no person to put on screen), and an explicit performer choice is preserved.
export function applySeedDefaults(input: VideoCreateRequest): VideoCreateRequest {
  const hasCharacterSeed = (input.seeds?.subjects.length ?? 0) > 0;
  if (hasCharacterSeed && input.visualMode === "conceptual") {
    return { ...input, visualMode: "visible_performer" };
  }
  return input;
}
