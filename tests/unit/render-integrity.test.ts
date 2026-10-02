import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { mediaTools, mediaToolsSource } from "@/lib/server/media-tools";
import { describe, expect, it } from "vitest";

import { renderBackendForEnvironment, sandboxRenderScript } from "@/lib/server/render";
import { extractReadableHtml } from "@/lib/server/source-processing";
import { providerDurationSecondsForShot } from "@/providers/seedance";

describe("render integrity", () => {
  it("never uses cloned-frame padding and validates rendered frames", () => {
    const script = sandboxRenderScript();

    expect(script).not.toContain("stop_mode=clone");
    expect(script).not.toContain("tpad=");
    expect(script).toContain("ffprobe");
    expect(script).toContain("freezedetect");
    expect(script).toContain("freeze.boundary");
    expect(script).toContain("freeze.short_motion");
    expect(script).toContain("editBoundaries");
    expect(script).toContain("materialBoundaryFreezeSeconds = 0.5");
    expect(script).not.toContain("detectSourceFreezes");
    expect(script).not.toContain("selectedSourceOut");
    expect(script).not.toContain("frozenTailTrimSeconds");
    expect(script).toContain("blackdetect");
    expect(script).toContain("silencedetect");
    expect(script).toContain("channel_layouts=stereo");
    expect(script).not.toContain("minterpolate");
  });

  it("executes the isolated render script with real media and checks its output", async () => {
    const run = promisify(execFile);
    const root = join(process.cwd(), "node_modules", ".cache");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "render-contract-"));
    try {
      await run((await mediaTools()).ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(directory, "source.mp4")], { timeout: 30_000 });
      await run((await mediaTools()).ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "4.1", join(directory, "music.wav")], { timeout: 30_000 });
      await writeFile(join(directory, "manifest.json"), JSON.stringify({ videoId: "render-contract", aspectRatio: "16:9",
        music: { url: `preloaded://${join(directory, "music.wav")}` },
        shots: [{ shotIndex: 0, durationSeconds: 4, videoUrl: `preloaded://${join(directory, "source.mp4")}` }],
      }));
      await writeFile(join(directory, "render.mjs"), sandboxRenderScript());
      await writeFile(join(directory, "media-tools.mjs"), await mediaToolsSource());
      await run(process.execPath, [join(directory, "render.mjs")], { env: { ...process.env, COCOA_RENDER_WORKDIR: directory, COCOA_RENDER_BACKEND: "local-process" }, timeout: 45_000, maxBuffer: 1_000_000 });
      const qa = JSON.parse(await readFile(join(directory, "qa-report.json"), "utf8"));
      expect(qa.passed).toBe(true);
      expect(qa.metrics.durationMs).toBeCloseTo(4000, 0);
      expect(qa.metrics.avStartOffsetMs).toBe(0);
      expect((await stat(join(directory, "final.mp4"))).size).toBeGreaterThan(10_000);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("renders locally unless Vercel OIDC or complete explicit Sandbox credentials are available", () => {
    expect(renderBackendForEnvironment({})).toBe("local");
    expect(renderBackendForEnvironment({ VERCEL: "1" })).toBe("sandbox");
    expect(renderBackendForEnvironment({
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    })).toBe("sandbox");
    expect(renderBackendForEnvironment({ VERCEL_TOKEN: "token" })).toBe("local");
  });

  it("rounds fractional Seedance requests once at the provider boundary", () => {
    expect(providerDurationSecondsForShot({ startMs: 0, endMs: 5_200 } as never)).toBe(6);
    expect(providerDurationSecondsForShot({ startMs: 0, endMs: 5_600 } as never)).toBe(6);
    expect(providerDurationSecondsForShot({ startMs: 0, endMs: 2_000 } as never)).toBe(4);
    expect(providerDurationSecondsForShot({ startMs: 0, endMs: 20_000 } as never)).toBe(15);
  });

  it("extracts readable URL source text without active or chrome content", () => {
    const text = extractReadableHtml(`
      <html><head><title>Example</title><style>.x{display:none}</style></head>
      <body><nav>Navigation</nav><main><h1>What changed</h1><p>Useful &amp; cited detail.</p></main>
      <script>steal()</script><footer>Footer</footer></body></html>
    `);

    expect(text).toContain("What changed");
    expect(text).toContain("Useful & cited detail.");
    expect(text).not.toContain("Navigation");
    expect(text).not.toContain("steal");
  });
});
