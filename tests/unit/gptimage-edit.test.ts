import { describe, expect, it } from "vitest";

import { buildGptImageEditForm } from "@/providers/gptimage";

// A few arbitrary bytes standing in for an uploaded reference image.
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

describe("buildGptImageEditForm — image-to-image anchor seeding", () => {
  it("carries model/prompt/size/quality/n/user and one image part per reference", () => {
    const form = buildGptImageEditForm(
      "character",
      "Stylized, art-directed likeness design sheet.",
      { model: "gpt-image-2", size: "1024x1536", quality: "high", outputFormat: "png" },
      [
        { bytes: BYTES, mimeType: "image/png" },
        { bytes: BYTES, mimeType: "image/jpeg" },
      ],
    );

    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("Stylized, art-directed likeness design sheet.");
    expect(form.get("size")).toBe("1024x1536");
    expect(form.get("quality")).toBe("high");
    expect(form.get("n")).toBe("1");
    expect(form.get("user")).toBe("anchor:character");
    expect(form.getAll("image[]")).toHaveLength(2);
  });

  it("is a pure function of its inputs (deterministic field values across calls)", () => {
    const make = () =>
      buildGptImageEditForm(
        "style",
        "Derive palette and motifs from the reference.",
        { quality: "medium" },
        [{ bytes: BYTES, mimeType: "image/png" }],
      );
    const a = make();
    const b = make();

    expect(a.get("prompt")).toBe(b.get("prompt"));
    expect(a.get("quality")).toBe(b.get("quality"));
    expect(a.get("user")).toBe(b.get("user"));
    expect(a.getAll("image[]").length).toBe(b.getAll("image[]").length);
  });
});
