import { beforeEach, describe, expect, it } from "vitest";

import { ProductionCreateRequest } from "@/lib/schemas";
import { approveNewsGate } from "@/lib/server/news-editorial";
import { addTextProductionSource } from "@/lib/server/production-sources";
import { createProduction } from "@/lib/server/productions";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";

const user = {
  id: "news-pipeline-user",
  email: "news@example.com",
  planTier: "dev" as const,
  dailyBudgetCents: 10_000,
};

describe("news digest v2 pipeline", () => {
  beforeEach(() => {
    process.env.PROVIDER_MODE = "mock";
    process.env.NEWS_DIGEST_V2_ENABLED = "true";
    resetInMemoryStoreForDev();
  });

  it("keeps generation behind two versioned approvals and exports a final delivery", async () => {
    const project = await getStore().createProject({ userId: user.id, name: "News fixture" });
    const text = Array.from({ length: 16 }, (_, index) =>
      `Verified point ${index + 1} documents a policy outcome with attributable measured results.`
    ).join(" ");
    const source = await addTextProductionSource({ projectId: project.id, title: "Policy report", text, user });
    const request = ProductionCreateRequest.parse({
      contentType: "news_digest",
      projectId: project.id,
      sourceRecordIds: [source.id],
      brief: "Create a concise, cited digest of the supplied policy report.",
      sourceBundle: { inputs: [], claims: [] },
      digestMode: "single_topic",
      researchMode: "supplied_only",
      targetDurationSeconds: 30,
      aspectRatio: "16:9",
    });
    const draft = await createProduction(request, user);
    expect(draft.status).toBe("awaiting_user");
    expect(draft.finalVideoUrl).toBeUndefined();
    expect(draft.sourceBundle?.claims.every((claim) => claim.status === "supported" && claim.evidenceRefs.length > 0)).toBe(true);

    const scriptVersionId = draft.workflowSteps?.find((step) => step.id === "script")?.artifactVersionId;
    expect(scriptVersionId).toBeTruthy();
    const draftWithUnusedClaim = {
      ...draft,
      sourceBundle: {
        ...draft.sourceBundle!,
        claims: [
          ...draft.sourceBundle!.claims,
          {
            id: "unused-unsupported-claim",
            text: "This unsupported claim is not narrated.",
            sourceIds: [],
            confidence: 0,
            status: "unverified" as const,
            evidence: [],
            evidenceRefs: [],
            editorialStatus: "draft" as const,
            breaking: false,
          },
        ],
      },
    };
    const scriptApproved = await approveNewsGate({ job: draftWithUnusedClaim, user, gate: "script", artifactVersionId: scriptVersionId! });
    expect(scriptApproved.finalVideoUrl).toBeUndefined();
    expect(scriptApproved.workflowSteps?.find((step) => step.id === "storyboard_approval")?.state).toBe("awaiting_user");

    const storyboardVersionId = scriptApproved.workflowSteps?.find((step) => step.id === "storyboard")?.artifactVersionId;
    expect(storyboardVersionId).toBeTruthy();
    await expect(approveNewsGate({ job: scriptApproved, user, gate: "storyboard", artifactVersionId: storyboardVersionId! }))
      .rejects.toThrow("Spend confirmation");
    await approveNewsGate({ job: scriptApproved, user, gate: "storyboard", artifactVersionId: storyboardVersionId!, confirmSpend: true });

    const finalJob = await getStore().getJob(draft.id);
    expect(finalJob?.status).toBe("complete");
    expect(finalJob?.finalVideoUrl).toMatch(/\.mp4$/);
    expect(finalJob?.thumbnailUrl).toMatch(/\.png$/);
    expect(finalJob?.timelineManifest?.tracks.some((track) => track.kind === "captions")).toBe(true);
    const delivery = finalJob?.artifactVersions.find((version) => version.scope === "render");
    expect(delivery?.urls.srt).toMatch(/\.srt$/);
    expect(delivery?.urls.vtt).toMatch(/\.vtt$/);
    expect(delivery?.urls.sourceManifestJson).toMatch(/\.json$/);
    expect(delivery?.urls.claimLedger).toMatch(/\.json$/);
  }, 120_000);
});
