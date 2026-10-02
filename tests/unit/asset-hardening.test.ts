import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkedStoragePath, storagePath } from "@/lib/server/storage-path";
import { authorizeUpload, uploadCompletion } from "@/lib/server/upload-callback";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";
import { POST as issueLibraryToken } from "@/app/api/projects/[projectId]/library/upload/route";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

describe("asset boundary hardening", () => {
  beforeEach(() => {
    process.env.PROVIDER_MODE = "mock";
    delete process.env.DATABASE_URL;
    process.env.DISABLE_BETA_AUTH = "true";
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_callback_secret";
    resetInMemoryStoreForDev();
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.BLOB_READ_WRITE_TOKEN; });

  it.each(["../secret", "%2e%2e/secret", "%252e%252e/secret", "/etc/passwd", "ok/../../secret", "ok\\..\\secret", "ok//secret", "ok/%00secret"])("rejects storage escape %s", (path) => {
    expect(() => storagePath("/tmp/storage", path)).toThrow();
  });
  it("rejects symlink escapes while accepting ordinary nested files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cocoa-path-test-"));
    try {
      await mkdir(join(dir, "root")); await writeFile(join(dir, "secret"), "private");
      await symlink(dir, join(dir, "root", "escape"));
      await expect(checkedStoragePath(join(dir, "root"), "escape/secret")).rejects.toThrow();
      expect(await checkedStoragePath(join(dir, "root"), "safe/new.png")).toBe(join(dir, "root", "safe", "new.png"));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("verifies Blob signatures without a session and handles simultaneous callbacks once", async () => {
    const project = await getStore().createProject({ userId: "upload-owner", name: "Uploads" });
    const issued = await authorizeUpload({ userId: project.userId, projectId: project.id, kind: "library", pathname: "picture.png",
      payload: { kind: "image", name: "Picture", tags: [], role: "reference", mimeType: "image/png" } }, new Request("https://preview.example/api/upload"));
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png, { headers: { "content-type": "image/png" } })));
    const body = { type: "blob.upload-completed", payload: { blob: { url: "https://test.public.blob.vercel-storage.com/picture-abc123.png", pathname: "picture-abc123.png", contentType: "image/png" }, tokenPayload: issued.tokenPayload } };
    const request = (signed: boolean) => new Request("https://preview.example/api/uploads/library/completed", { method: "POST",
      headers: { "Content-Type": "application/json", ...(signed ? { "x-vercel-signature": createHmac("sha256", process.env.BLOB_READ_WRITE_TOKEN!).update(JSON.stringify(body)).digest("hex") } : {}) },
      body: JSON.stringify(body) });
    expect((await uploadCompletion(request(false), "library")).status).toBe(401);
    expect(await getStore().listLibraryAssets(project.userId)).toHaveLength(0);
    const responses = await Promise.all([uploadCompletion(request(true), "library"), uploadCompletion(request(true), "library")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await getStore().listLibraryAssets(project.userId)).toHaveLength(1);
    expect(await getStore().listProjectAssetLinks(project.id)).toHaveLength(1);
  });

  it("rejects malformed and null upload bodies consistently", async () => {
    for (const body of ["null", "{"]) {
      const request = new Request("https://preview.example/api/uploads/library/completed", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      expect((await uploadCompletion(request, "library")).status).toBe(400);
    }
  });

  it("requires ownership for token issuance and rejects token requests at the callback endpoint", async () => {
    const project = await getStore().createProject({ userId: "owner", name: "Private" });
    const request = new Request("https://preview.example/api/upload", { method: "POST", headers: { "x-user-id": "other", "Content-Type": "application/json" }, body: JSON.stringify({ type: "blob.generate-client-token" }) });
    expect((await issueLibraryToken(request, { params: Promise.resolve({ projectId: project.id }) })).status).toBe(404);
    expect((await uploadCompletion(request.clone(), "library")).status).toBe(400);
  });
});
