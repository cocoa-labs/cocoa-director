import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as demoGet } from "@/app/api/demo/media/route";
import { fetchBlobUrl } from "@/lib/server/blob";
import { mediaTools } from "@/lib/server/media-tools";
import { createSessionForInviteCode, getUserContext, isAuthRequired, STUDIO_SESSION_COOKIE } from "@/lib/server/auth";
import { mockVideoUrl, mockAudioUrl } from "@/lib/mock-assets";
import { assertProvidersEnabled } from "@/lib/server/budget-ledger";
const run = promisify(execFile);
afterEach(() => vi.unstubAllEnvs());

describe("public release boundaries", () => {
  it.each(["OPENAI_API_KEY", "FAL_KEY", "ELEVENLABS_API_KEY", "AUTH_SECRET", "ADMIN_INVITE_CODES", "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "PRIVATE_BLOB_READ_WRITE_TOKEN", "DAILY_BUDGET_CAP_USD_GLOBAL", "DAILY_BUDGET_CAP_USD_PER_USER"])("blocks live calls when %s is missing, including in local development", (missing) => {
    vi.stubEnv("PROVIDER_MODE", "live"); vi.stubEnv("PROVIDER_CALLS_ENABLED", "true");
    vi.stubEnv("NEWS_DIGEST_V2_ENABLED", "true");
    for (const key of ["OPENAI_API_KEY", "FAL_KEY", "ELEVENLABS_API_KEY", "AUTH_SECRET", "ADMIN_INVITE_CODES", "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "PRIVATE_BLOB_READ_WRITE_TOKEN"]) vi.stubEnv(key, "fixture-not-a-real-secret");
    for (const key of ["DAILY_BUDGET_CAP_USD_GLOBAL", "DAILY_BUDGET_CAP_USD_PER_USER"]) vi.stubEnv(key, "50");
    vi.stubEnv(missing, "");
    expect(() => assertProvidersEnabled()).toThrow(missing);
  });
  it("keeps live auth required even with the retired development bypass flag", () => {
    vi.stubEnv("PROVIDER_MODE", "live"); vi.stubEnv("REQUIRE_AUTH", "false"); vi.stubEnv("DISABLE_BETA_AUTH", "true");
    expect(isAuthRequired()).toBe(true);
  });
  it("gives owners no implicit personal cap exemption", async () => {
    vi.stubEnv("PROVIDER_MODE", "live"); vi.stubEnv("AUTH_SECRET", "test-only-signing-secret"); vi.stubEnv("ADMIN_INVITE_CODES", "test-only-owner-code");
    vi.stubEnv("SPEND_CAP_EXEMPT_USER_IDS", ""); vi.stubEnv("SPEND_CAP_EXEMPT_EMAILS", "");
    const token = await createSessionForInviteCode("test-only-owner-code");
    const user = await getUserContext(new Request("http://localhost/", { headers: { cookie: `${STUDIO_SESSION_COOKIE}=${token}` } }));
    expect(user.spendCapExempt).toBe(false);
  });
  it("exports synthetic media with real audio/video duration and supports range playback", async () => {
    vi.stubEnv("PROVIDER_MODE", "mock"); vi.stubEnv("REQUIRE_AUTH", "false");
    const url = mockVideoUrl("demo", 0, 2, "16:9");
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Demo must not use the network"));
    const directory = await mkdtemp(join(tmpdir(), "cocoa-demo-test-"));
    try {
      const asset = await fetchBlobUrl(url);
      expect(asset.headers.get("content-type")).toBe("video/mp4");
      const bytes = Buffer.from(await asset.arrayBuffer()); expect(bytes.length).toBeGreaterThan(10_000);
      const path = join(directory, "demo.mp4"); await writeFile(path, bytes);
      const { stdout } = await run((await mediaTools()).ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path]);
      const probe = JSON.parse(stdout); expect(Number(probe.format.duration)).toBeCloseTo(2, 1);
      expect(probe.streams.map((stream: { codec_type: string }) => stream.codec_type).sort()).toEqual(["audio", "video"]);
      const range = await demoGet(new Request(`http://localhost${url}`, { headers: { range: "bytes=0-99" } }));
      expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(100);
      expect((await demoGet(new Request(`http://localhost${url}`, { headers: { range: "bytes=999999999-" } }))).status).toBe(416);
      const audio = await fetchBlobUrl(mockAudioUrl("demo", 2)); expect(audio.headers.get("content-type")).toBe("audio/mpeg");
      expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
  it("rejects unbounded demo options and does not offer synthetic media in live mode", async () => {
    vi.stubEnv("PROVIDER_MODE", "mock"); vi.stubEnv("REQUIRE_AUTH", "false");
    expect((await demoGet(new Request("http://localhost/api/demo/media?kind=video&duration=999999"))).status).toBe(400);
    expect((await demoGet(new Request("http://localhost/api/demo/media?kind=video&aspect=../../etc/passwd"))).status).toBe(400);
    vi.stubEnv("PROVIDER_MODE", "live");
    await expect(fetchBlobUrl(mockVideoUrl("demo"))).rejects.toMatchObject({ status: 404 });
  });
  it("sets up without overwriting an environment or printing generated secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocoa-setup-test-"));
    const script = join(process.cwd(), "scripts/setup.mjs");
    try {
      const { stdout } = await run(process.execPath, [script, "--mode=live"], { cwd: directory });
      const config = await readFile(join(directory, ".env"), "utf8");
      const secret = /^AUTH_SECRET=(.+)$/m.exec(config)![1]; expect(secret).toHaveLength(64); expect(stdout).not.toContain(secret);
      expect(config).toContain("PROVIDER_CALLS_ENABLED=false"); expect(config).toContain("DAILY_BUDGET_CAP_USD_GLOBAL=50");
      expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
      await run(process.execPath, [script, "--mode=demo"], { cwd: directory });
      expect(await readFile(join(directory, ".env"), "utf8")).toBe(config);
      await rm(join(directory, ".env")); await writeFile(join(directory, ".env.local"), "DO_NOT_TOUCH=yes\n");
      await run(process.execPath, [script, "--mode=demo"], { cwd: directory });
      await expect(stat(join(directory, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
