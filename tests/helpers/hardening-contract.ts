import { POST as recoverProduction } from "@/app/api/productions/[id]/recovery/route";
import { GET as getProduction } from "@/app/api/productions/[id]/route";
import { GET as exportSession } from "@/app/api/projects/[projectId]/media-sessions/[sessionId]/export/route";
import { GET as downloadVideo } from "@/app/api/videos/[id]/download/route";
import { GET as getMedia } from "@/app/api/projects/[projectId]/media/route";
import { GET as downloadSource } from "@/app/api/projects/[projectId]/sources/[sourceId]/download/route";
import { GET as getAdminAudit } from "@/app/api/admin/provider-audit/route";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as config from "@/lib/server/config";
import { actionRequest, rememberActionResource } from "@/lib/server/action-request";
import { reserveBudget, reserveProviderAttempt, budgetSnapshot } from "@/lib/server/budget-ledger";
import { getStore } from "@/lib/server/store";
import { VideoCreateRequest, type ArtifactVersion } from "@/lib/schemas";
import { GET as getProject } from "@/app/api/projects/[projectId]/route";
import { throttleLogin } from "@/lib/server/login-throttle";

const user = () => ({ id: randomUUID(), email: "hardening@example.test", planTier: "dev" as const, dailyBudgetCents: 10_000 });
const request = (id: string, key: string, input: unknown = { prompt: "one" }, path = "/api/videos") => new Request(`http://localhost${path}`, {
  method: "POST", headers: { "x-user-id": id, "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(input),
});

export function hardeningContract() {
  describe("durable hardening contract", () => {
    // These contracts isolate ledger/approval behavior from deployment configuration.
    // public-release.test.ts separately verifies every fail-closed live prerequisite.
    beforeEach(() => { vi.spyOn(config, "assertLiveEnvironmentReady").mockImplementation(() => {}); });
    afterEach(() => { vi.restoreAllMocks(); });
    it("carries pending budget across midnight and closes completed resources", async () => {
      process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "1";
      const owner = user();
      const job = await getStore().createJob(VideoCreateRequest.parse({ prompt: "A reserved job that crosses the daily budget boundary.", durationSeconds: 60 }), owner);
      await reserveBudget({ user: owner, scope: "create", key: randomUUID(), videoJobId: job.id, estimatedCostCents: 60 });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
      try {
        await expect(reserveBudget({ user: owner, scope: "create", key: randomUUID(), estimatedCostCents: 50 })).rejects.toMatchObject({ code: "global_spend_cap_reached" });
        await getStore().updateJob(job.id, { status: "complete" });
        await reserveBudget({ user: owner, scope: "create", key: randomUUID(), estimatedCostCents: 50 });
        expect((await budgetSnapshot()).reservedTodayCents).toBe(50);
      } finally { vi.useRealTimers(); }
    });

    it("releases unused successful allowance while retaining every attempt and failed request", async () => {
      process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "1";
      const owner = user();
      const job = await getStore().createJob(VideoCreateRequest.parse({ prompt: "A successful resource with conservative provider allowances.", durationSeconds: 60 }), owner);
      await reserveBudget({ user: owner, scope: "create", videoJobId: job.id, estimatedCostCents: 100 });
      process.env.PROVIDER_MODE = "live";
      await reserveProviderAttempt({ videoId: job.id, scope: "attempt:first", costCents: 15 });
      await reserveProviderAttempt({ videoId: job.id, scope: "attempt:retry", costCents: 10 });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(100);
      await getStore().updateJob(job.id, { status: "failed" });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(100);
      await getStore().updateJob(job.id, { status: "complete" });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(25);
      await expect(reserveBudget({ user: owner, scope: "regenerate", videoJobId: job.id, estimatedCostCents: 80 })).rejects.toMatchObject({ code: "global_spend_cap_reached" });
      await reserveBudget({ user: owner, scope: "new", estimatedCostCents: 70 });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(95);
      await getStore().updateJob(job.id, { status: "running" });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(95);
      expect((await budgetSnapshot()).reservations.filter((value) => value.metadata.attempt)).toHaveLength(2);
    });

    it.each(["failed", "complete"] as const)("does not change a %s production when recovery is denied by the budget", async (status) => {
      process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "1";
      const owner = user();
      const job = await getStore().createJob(VideoCreateRequest.parse({ prompt: "A production whose recovery must be authorized before state changes.", durationSeconds: 60 }), owner);
      await getStore().updateJob(job.id, { contentType: "explainer", status });
      await reserveBudget({ user: owner, scope: "other-work", estimatedCostCents: 100 });
      const before = await getStore().getJob(job.id);
      const response = await recoverProduction(request(owner.id, randomUUID(), { action: "resume", beatIds: [] }, `/api/productions/${job.id}/recovery`), { params: Promise.resolve({ id: job.id }) });
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: "global_spend_cap_reached" });
      const after = await getStore().getJob(job.id);
      expect(after?.status).toBe(status);
      expect(after?.updatedAt).toBe(before?.updatedAt);
    });

    it("rechecks current editorial approvals before paid media submission", async () => {
      const job = await getStore().createJob(VideoCreateRequest.parse({ prompt: "An editorial production whose approval has been invalidated.", durationSeconds: 60 }), user());
      await getStore().updateJob(job.id, { contentType: "explainer", approvals: [] });
      process.env.PROVIDER_MODE = "live";
      await expect(reserveProviderAttempt({ videoId: job.id, scope: "elevenlabs:narration", costCents: 10 })).rejects.toMatchObject({ code: "current_approval_required" });
      expect((await budgetSnapshot()).reservations).toHaveLength(0);
    });
    it("enforces login limits atomically across concurrent requests", async () => {
      process.env.AUTH_SECRET = randomUUID();
      const login = new Request("https://studio.test/api/auth/login");
      const results = await Promise.allSettled(Array.from({ length: 14 }, () => throttleLogin(login, "same-invalid-code")));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(10);
      await expect(throttleLogin(login, "same-invalid-code")).rejects.toMatchObject({ code: "login_throttled", status: 429 });
    });
    it("claims concurrent requests once, replays the original resource, and rejects changed input", async () => {
      const owner = user(); const key = randomUUID();
      let finish!: () => void; const barrier = new Promise<void>((resolve) => { finish = resolve; });
      let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
      let submissions = 0;
      const first = actionRequest(request(owner.id, key), async () => {
        submissions++; entered(); await barrier;
        return Response.json({ videoId: "original" }, { status: 201 });
      });
      await started;
      const simultaneous = await actionRequest(request(owner.id, key), async () => { submissions++; return Response.json({ videoId: "duplicate" }); });
      expect(simultaneous.status).toBe(409);
      finish();
      expect((await first).status).toBe(201);
      const replay = await actionRequest(request(owner.id, key), async () => { throw new Error("must not run"); });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual({ videoId: "original" });
      const conflict = await actionRequest(request(owner.id, key, { prompt: "changed" }), async () => { throw new Error("must not run"); });
      expect(conflict.status).toBe(409);
      expect(submissions).toBe(1);
    });

    it("scopes keys by owner and action and persists identity before workflow dispatch", async () => {
      const owner = user(); const key = randomUUID();
      await actionRequest(request(owner.id, key), async () => {
        await rememberActionResource({ videoId: "survives-restart" });
        throw new Error("dispatch stopped");
      });
      expect(await (await actionRequest(request(owner.id, key), async () => { throw new Error("must not run"); })).json()).toEqual({ videoId: "survives-restart" });
      const differentOwner = await actionRequest(request(user().id, key), async () => Response.json({ ok: true }));
      const differentAction = await actionRequest(request(owner.id, key, {}, "/api/productions"), async () => Response.json({ ok: true }));
      expect(differentOwner.status).toBe(200); expect(differentAction.status).toBe(200);
    });

    it("reuses editorial approval allowances without confusing editorial with edit actions", async () => {
      const owner = user();
      const job = await getStore().createJob(VideoCreateRequest.parse({ prompt: "A sourced production with repeated version approvals.", durationSeconds: 60 }), owner);
      await reserveBudget({ user: owner, scope: "video_action_guard:create_explainer_draft", key: randomUUID(), videoJobId: job.id, estimatedCostCents: 50 });
      for (let index = 0; index < 3; index += 1) await reserveBudget({ user: owner, scope: "video_action_guard:approve_editorial_storyboard_and_generate", key: randomUUID(), videoJobId: job.id, estimatedCostCents: 600 });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(600);
      await reserveBudget({ user: owner, scope: "video_action_guard:regenerate_shot", key: randomUUID(), videoJobId: job.id, estimatedCostCents: 100 });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(700);
    });

    it("atomically reserves pending spending and enforces the global cap for exempt users", async () => {
      process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "1";
      const owner = { ...user(), spendCapExempt: true, dailyBudgetCents: 1 };
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveBudget({ user: owner, scope: "generate", key: String(i), estimatedCostCents: 60 })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect((await budgetSnapshot()).reservedTodayCents).toBe(60);
      await expect(reserveBudget({ user: { ...user(), spendCapExempt: true }, scope: "generate", estimatedCostCents: 50 })).rejects.toMatchObject({ status: 429, code: "global_spend_cap_reached" });
    });

    it("does not leak a failed reservation top-up and requires explicit enablement in live mode", async () => {
      process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "1";
      const owner = user(); const videoJobId = randomUUID();
      await reserveBudget({ user: owner, scope: "create", key: "first", videoJobId, estimatedCostCents: 60 });
      await expect(reserveBudget({ user: owner, scope: "regenerate", videoJobId, estimatedCostCents: 50 })).rejects.toMatchObject({ status: 429 });
      expect((await budgetSnapshot()).reservedTodayCents).toBe(60);
      process.env.PROVIDER_MODE = "live";
      delete process.env.PROVIDER_CALLS_ENABLED;
      await expect(reserveProviderAttempt({ scope: "image", costCents: 1 })).rejects.toMatchObject({ code: "provider_calls_paused" });
    });

    it("preserves concurrent fields and version history and makes cancellation terminal", async () => {
      const store = getStore();
      const job = await store.createJob(VideoCreateRequest.parse({ prompt: "A complete fixture for hardening verification.", durationSeconds: 60 }), user());
      const version = (label: string): ArtifactVersion => ({ id: randomUUID(), scope: "render", label, payload: {}, urls: {}, createdAt: new Date().toISOString() });
      await Promise.all([
        store.updateJob(job.id, { prompt: "Updated prompt", artifactVersions: [version("one")] }),
        store.updateJob(job.id, { durationSeconds: 90, artifactVersions: [version("two")] }),
      ]);
      const updated = await store.getJob(job.id);
      expect(updated?.prompt).toBe("Updated prompt"); expect(updated?.durationSeconds).toBe(90);
      expect(updated?.artifactVersions).toHaveLength(2);
      await store.updateJob(job.id, { cancellationRequested: true });
      await store.updateJob(job.id, { status: "complete", finalVideoUrl: "https://example.com/late.mp4", cancellationRequested: false, artifactVersions: [] });
      const cancelled = await store.getJob(job.id);
      expect(cancelled?.status).toBe("cancelled"); expect(cancelled?.cancellationRequested).toBe(true);
      expect(cancelled?.finalVideoUrl).toBeUndefined(); expect(cancelled?.artifactVersions).toHaveLength(2);
      process.env.PROVIDER_MODE = "live"; process.env.PROVIDER_CALLS_ENABLED = "true";
      await expect(reserveProviderAttempt({ videoId: job.id, scope: "image", costCents: 1 })).rejects.toMatchObject({ code: "production_cancelled" });
    });

    it("enforces ownership for productions, media, source downloads, exports and administration", async () => {
      const owner = user();
      const job = await getStore().createJob(VideoCreateRequest.parse({ prompt: "An owned project used to verify private routes.", durationSeconds: 60 }), owner);
      const session = await getStore().createMediaSession({ projectId: job.projectId, kind: "image", title: "Private image session", settings: {} });
      const other = user();
      const ownProject = await getStore().createProject({ userId: other.id, name: "Other project" });
      const unauthorized = new Request("http://localhost/api/test", { headers: { "x-user-id": other.id } });
      expect((await getProduction(unauthorized, { params: Promise.resolve({ id: job.id }) })).status).toBe(404);
      expect((await downloadVideo(unauthorized, { params: Promise.resolve({ id: job.id }) })).status).toBe(404);
      expect((await getMedia(unauthorized, { params: Promise.resolve({ projectId: job.projectId }) })).status).toBe(404);
      expect((await downloadSource(unauthorized, { params: Promise.resolve({ projectId: job.projectId, sourceId: randomUUID() }) })).status).toBe(404);
      expect((await exportSession(unauthorized, { params: Promise.resolve({ projectId: job.projectId, sessionId: session.id }) })).status).toBe(404);
      expect((await exportSession(unauthorized, { params: Promise.resolve({ projectId: ownProject.id, sessionId: session.id }) })).status).toBe(404);
      expect((await getAdminAudit(unauthorized)).status).toBe(404);
    });

    it("conceals another owner's project and rejects malformed JSON consistently", async () => {
      const project = await getStore().createProject({ userId: user().id, name: "Private project" });
      const response = await getProject(new Request(`http://localhost/api/projects/${project.id}`, { headers: { "x-user-id": "other" } }), { params: Promise.resolve({ projectId: project.id }) });
      expect(response.status).toBe(404);
      const malformed = await actionRequest(new Request("http://localhost/api/videos", { method: "POST", body: "{", headers: { "content-type": "application/json" } }), async () => Response.json({ ok: true }));
      expect(malformed.status).toBe(400); expect(await malformed.json()).toMatchObject({ code: "invalid_json" });
    });
  });
}
