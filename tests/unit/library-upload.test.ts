import { describe, expect, it } from "vitest";

import {
  allowedContentTypesForKind,
  parseUploadPayload,
  uploadLimitForKind,
} from "@/lib/server/library-upload";
import { UploadValidationError, validateUploadBytes } from "@/lib/server/upload-validation";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

describe("validateUploadBytes", () => {
  it("accepts real image bytes matching the declared type", () => {
    expect(validateUploadBytes(PNG, "image", "image/png")).toEqual({ mime: "image/png" });
    expect(validateUploadBytes(JPEG, "image", "image/jpeg")).toEqual({ mime: "image/jpeg" });
  });

  it("rejects bytes that don't match the declared type (disguised file)", () => {
    expect(() => validateUploadBytes(PNG, "image", "image/jpeg")).toThrow(UploadValidationError);
    expect(() => validateUploadBytes(PNG, "video", "video/mp4")).toThrow(UploadValidationError);
  });

  it("rejects unrecognized, empty, render, and vague-mime uploads", () => {
    expect(() => validateUploadBytes(new Uint8Array([1, 2, 3, 4]), "image", "image/png")).toThrow();
    expect(() => validateUploadBytes(new Uint8Array([]), "image", "image/png")).toThrow();
    expect(() => validateUploadBytes(PNG, "render", "image/png")).toThrow();
    expect(() => validateUploadBytes(PNG, "image", "application/octet-stream")).toThrow();
  });
});

describe("parseUploadPayload", () => {
  it("parses a valid payload", () => {
    expect(
      parseUploadPayload(JSON.stringify({ projectId: "p1", kind: "image", name: "a.png", tags: ["seed"] })),
    ).toMatchObject({ projectId: "p1", kind: "image", tags: ["seed"] });
  });

  it("returns null for a bad kind, malformed JSON, or empty input", () => {
    expect(parseUploadPayload(JSON.stringify({ kind: "bogus" }))).toBeNull();
    expect(parseUploadPayload("{not json")).toBeNull();
    expect(parseUploadPayload(null)).toBeNull();
  });
});

describe("upload limits", () => {
  it("exposes the expected image content types and 25MB cap", () => {
    expect(allowedContentTypesForKind("image")).toContain("image/png");
    expect(uploadLimitForKind("image")).toBe(25 * 1024 * 1024);
  });
});
