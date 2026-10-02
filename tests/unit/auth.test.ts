vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STUDIO_SESSION_COOKIE,
  createSessionForInviteCode,
  getSessionFromToken,
  getUserContext,
} from "@/lib/server/auth";
import { cents } from "@/lib/cost";
import { assertMediaGenerationAllowed, SpendGuardError } from "@/lib/server/spend-guard";
import { getStore } from "@/lib/server/store";
import { validateRemoteUpload } from "@/lib/server/upload-validation";

const originalEnv = {
  AUTH_SECRET: process.env.AUTH_SECRET,
  INVITE_CODES: process.env.INVITE_CODES,
  ADMIN_INVITE_CODES: process.env.ADMIN_INVITE_CODES,
  PROVIDER_MODE: process.env.PROVIDER_MODE,
  PROVIDER_CALLS_ENABLED: process.env.PROVIDER_CALLS_ENABLED,
  REQUIRE_AUTH: process.env.REQUIRE_AUTH,
  DISABLE_BETA_AUTH: process.env.DISABLE_BETA_AUTH,
  DEV_SPEND_CAP_EXEMPT: process.env.DEV_SPEND_CAP_EXEMPT,
  SPEND_CAP_EXEMPT_EMAILS: process.env.SPEND_CAP_EXEMPT_EMAILS,
  SPEND_CAP_EXEMPT_USER_IDS: process.env.SPEND_CAP_EXEMPT_USER_IDS,
};

describe("studio access", () => {
  afterEach(() => {
    restoreEnv("AUTH_SECRET", originalEnv.AUTH_SECRET);
    restoreEnv("INVITE_CODES", originalEnv.INVITE_CODES);
    restoreEnv("ADMIN_INVITE_CODES", originalEnv.ADMIN_INVITE_CODES);
    restoreEnv("PROVIDER_MODE", originalEnv.PROVIDER_MODE);
    restoreEnv("PROVIDER_CALLS_ENABLED", originalEnv.PROVIDER_CALLS_ENABLED);
    restoreEnv("REQUIRE_AUTH", originalEnv.REQUIRE_AUTH);
    restoreEnv("DISABLE_BETA_AUTH", originalEnv.DISABLE_BETA_AUTH);
    restoreEnv("DEV_SPEND_CAP_EXEMPT", originalEnv.DEV_SPEND_CAP_EXEMPT);
    restoreEnv("SPEND_CAP_EXEMPT_EMAILS", originalEnv.SPEND_CAP_EXEMPT_EMAILS);
    restoreEnv("SPEND_CAP_EXEMPT_USER_IDS", originalEnv.SPEND_CAP_EXEMPT_USER_IDS);
  });

  it("signs invite sessions and rejects anonymous live provider requests", async () => {
    process.env.AUTH_SECRET = "test-secret";
    process.env.INVITE_CODES = "artist-beta";
    process.env.PROVIDER_MODE = "live";
    delete process.env.DISABLE_BETA_AUTH;

    const token = await createSessionForInviteCode("artist-beta");
    expect(token).toBeTruthy();
    const session = await getSessionFromToken(token);
    expect(session?.uid).toMatch(/^beta_/);

    await expect(getUserContext(new Request("https://local.test"))).rejects.toMatchObject({ status: 401 });
    const user = await getUserContext(new Request("https://local.test", {
      headers: { cookie: `${STUDIO_SESSION_COOKIE}=${token}` },
    }));
    expect(user.id).toBe(session?.uid);
  });

  it("keeps owner sessions capped unless explicitly exempted", async () => {
    process.env.AUTH_SECRET = "test-secret";
    process.env.ADMIN_INVITE_CODES = "owner-admin";
    process.env.REQUIRE_AUTH = "true";

    const token = await createSessionForInviteCode("owner-admin");
    const owner = await getUserContext(new Request("https://local.test", {
      headers: { cookie: `${STUDIO_SESSION_COOKIE}=${token}` },
    }));

    expect(owner.planTier).toBe("pro");
    expect(owner.spendCapExempt).toBe(false);

    process.env.REQUIRE_AUTH = "false";
    process.env.PROVIDER_MODE = "mock";
    process.env.DEV_SPEND_CAP_EXEMPT = "true";
    const localDemo = await getUserContext(new Request("https://local.test"));
    expect(localDemo.spendCapExempt).toBe(true);
  });

  it("records a provider audit event when the provider kill switch blocks spend", async () => {
    process.env.PROVIDER_CALLS_ENABLED = "false";
    const user = {
      id: `audit-${crypto.randomUUID()}`,
      email: "audit@example.com",
      planTier: "dev" as const,
      dailyBudgetCents: cents(50),
    };

    await expect(assertMediaGenerationAllowed(user, {
      kind: "image",
      provider: "mock",
      prompt: "one image",
      controls: {},
      inputAssetIds: [],
      execute: true,
      idempotencyKey: `audit-${crypto.randomUUID()}`,
    })).rejects.toBeInstanceOf(SpendGuardError);

    const events = await getStore().listProviderAuditEvents(20);
    expect(events.some((event) => event.userId === user.id && event.status === "blocked_paused")).toBe(true);
  });

  it("lets owner demo sessions bypass app-level daily caps while keeping audit records", async () => {
    delete process.env.PROVIDER_CALLS_ENABLED;
    const user = {
      id: `owner-${crypto.randomUUID()}`,
      email: "owner@example.com",
      planTier: "pro" as const,
      dailyBudgetCents: 1,
      spendCapExempt: true,
    };
    const idempotencyKey = `owner-bypass-${crypto.randomUUID()}`;

    await expect(assertMediaGenerationAllowed(user, {
      kind: "image",
      provider: "mock",
      prompt: "Owner demo image version.",
      controls: { quality: "high" },
      inputAssetIds: [],
      execute: true,
      idempotencyKey,
    })).resolves.toBeUndefined();

    const events = await getStore().listProviderAuditEvents(50);
    const event = events.find((candidate) => candidate.userId === user.id && candidate.idempotencyKey === idempotencyKey);
    expect(event?.status).toBe("submitted");
    expect(event?.metadata.spendCapExempt).toBe(true);
  });

  it("rejects upload magic bytes that do not match the selected media type", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
      status: 206,
      headers: { "content-type": "image/png" },
    })) as typeof fetch;

    await expect(validateRemoteUpload("https://blob.test/file.png", "image", "image/png")).rejects.toThrow(
      "Uploaded file does not match",
    );
    globalThis.fetch = originalFetch;
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
