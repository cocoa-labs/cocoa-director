import { describe, expect, it } from "vitest";

import { clearResolvedBackgroundError } from "@/lib/ui-errors";

describe("UI error recovery", () => {
  it("clears a background error after that refresh recovers", () => {
    expect(
      clearResolvedBackgroundError(
        'relation "workflow_steps" does not exist',
        'relation "workflow_steps" does not exist',
      ),
    ).toBeNull();
  });

  it("preserves a newer user-action error", () => {
    expect(
      clearResolvedBackgroundError(
        "Media generation failed",
        'relation "workflow_steps" does not exist',
      ),
    ).toBe("Media generation failed");
  });
});
