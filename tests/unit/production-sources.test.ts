import { beforeEach, describe, expect, it } from "vitest";

import { hydrateBundleFromRecords, isPublisherAccessRestricted, RESEARCH_LEAD_WARNING } from "@/lib/server/source-processing";
import { reconcileStaleProductionSources } from "@/lib/server/production-sources";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";

const user = { id: "source-test-user", email: "source@example.com", planTier: "dev" as const, dailyBudgetCents: 10_000 };

describe("durable production source states", () => {
  beforeEach(() => {
    process.env.PROVIDER_MODE = "mock";
    resetInMemoryStoreForDev();
  });

  it("recognizes publisher authentication and anti-bot walls as research leads", () => {
    expect(isPublisherAccessRestricted(401)).toBe(true);
    expect(isPublisherAccessRestricted(403)).toBe(true);
    expect(isPublisherAccessRestricted(404)).toBe(false);
  });

  it("terminalizes an orphaned processing record instead of leaving an endless spinner", async () => {
    const store = getStore();
    const project = await store.createProject({ userId: user.id, name: "Source durability" });
    const source = await store.createProductionSource({
      projectId: project.id,
      userId: user.id,
      kind: "url",
      title: "Stalled source",
      url: "https://example.com/stalled",
      canonicalUrl: "https://example.com/stalled",
      suppliedAt: new Date().toISOString(),
      rights: "evidence_only",
      processingState: "processing",
      extractionVersion: "source-v3-intelligent",
      warnings: [],
    });

    const sources = await reconcileStaleProductionSources(project.id, { staleMs: -1 });
    expect(sources.find((candidate) => candidate.id === source.id)).toMatchObject({
      processingState: "failed",
      error: expect.stringContaining("stopped before completion"),
    });
  });

  it("keeps a warning-only record as a research lead without refetching it", async () => {
    const store = getStore();
    const project = await store.createProject({ userId: user.id, name: "Research lead" });
    const source = await store.createProductionSource({
      projectId: project.id,
      userId: user.id,
      kind: "url",
      title: "Protected publisher topic",
      url: "https://example.com/protected",
      canonicalUrl: "https://example.com/protected",
      suppliedAt: new Date().toISOString(),
      rights: "evidence_only",
      processingState: "warning",
      extractionVersion: "source-v3-intelligent",
      warnings: [RESEARCH_LEAD_WARNING],
    });

    const bundle = await hydrateBundleFromRecords({ inputs: [], claims: [] }, [source.id], user.id, project.id);
    expect(bundle.inputs).toEqual([expect.objectContaining({
      kind: "url",
      sourceRecordId: source.id,
      url: "https://example.com/protected",
      extractedText: "",
    })]);
  });
});
