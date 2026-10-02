import { describe, expect, it } from "vitest";

import { isTransientSandboxError } from "@/lib/server/sandbox-retry";

describe("isTransientSandboxError", () => {
  it("retries the transient Vercel Sandbox API failures we observed in production", () => {
    for (const message of [
      "Status code 403 is not ok",
      "Stream ended before command finished",
      "Stream ended before command data was received",
      "Status code 429 is not ok",
      "Status code 503 is not ok",
    ]) {
      expect(isTransientSandboxError(new Error(message))).toBe(true);
    }
  });

  it("follows the cause chain (fetch failed -> ECONNRESET)", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isTransientSandboxError(new Error("fetch failed", { cause }))).toBe(true);
  });

  it("does NOT retry deterministic render failures", () => {
    for (const message of [
      "Sandbox video render failed with exit code 1: ffmpeg exited with code 1: Invalid data found",
      "Sandbox render completed without producing final.mp4.",
      "Render manifest does not contain any generated shots.",
      "Status code 404 is not ok",
    ]) {
      expect(isTransientSandboxError(new Error(message))).toBe(false);
    }
  });

  it("ignores non-Error throwables", () => {
    expect(isTransientSandboxError("403")).toBe(false);
    expect(isTransientSandboxError(null)).toBe(false);
    expect(isTransientSandboxError(undefined)).toBe(false);
  });
});
