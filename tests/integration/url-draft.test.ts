import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/productions/route";
import { createSessionForInviteCode } from "@/lib/server/auth";
import * as config from "@/lib/server/config";
import { getStore, resetInMemoryStoreForDev } from "@/lib/server/store";

const { fetchGuarded } = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));
vi.mock("@/lib/server/ssrf", () => ({ fetchGuarded }));

const sourceId = "0ee481fc-7937-42d5-a78c-217fd678ed84";
const paragraphs = [
  "The study’s original system processed inputs sequentially, restricting how much work could be performed at the same time during evaluation.",
  "The proposed mechanism compares each input with its surrounding context and combines relevant information into a useful representation for later processing.",
  "Separate comparison groups learn different relationships, allowing several patterns in the same input to contribute to the resulting representation at once.",
  "The evaluation reported an eighteen percent improvement on the selected benchmark under the experimental conditions described in the detailed methods section.",
  "The authors evaluated only a limited set of tasks, so the reported evidence does not establish effectiveness in every possible setting.",
  "The conclusion identifies parallel processing as a practical benefit while calling for additional evaluation before broader applications can confidently be established.",
];
const providerRequests: Array<Record<string, unknown>> = [];
let sourceReply: "valid" | "unknown-evidence" | "invalid-json" | "empty" = "valid";
let articleParagraphs = paragraphs;
let sessionCookie: string;

function request(key: string) {
  return new Request("http://localhost/api/productions", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, Cookie: sessionCookie },
    body: JSON.stringify({ contentType: "explainer", brief: "Explain the method, results and limitations in this article.",
      targetDurationSeconds: 60, sourceBundle: { inputs: [{ id: sourceId, kind: "url", url: "https://example.com/research" }] } }),
  });
}

describe("URL draft HTTP contract", () => {
  beforeEach(async () => {
    // Use isolated memory storage; deployment completeness is tested separately.
    // Provider enablement, request ownership and spending reservations stay real.
    vi.spyOn(config, "assertLiveEnvironmentReady").mockImplementation(() => {});
    vi.stubEnv("PROVIDER_MODE", "live");
    vi.stubEnv("PROVIDER_CALLS_ENABLED", "true");
    vi.stubEnv("DISABLE_BETA_AUTH", "false");
    vi.stubEnv("REQUIRE_AUTH", "true");
    vi.stubEnv("AUTH_SECRET", "local-fixture-signing-key");
    vi.stubEnv("ADMIN_INVITE_CODES", "local-fixture-invite");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "local-fixture-no-network");
    vi.stubEnv("OPENAI_AGENT_MODEL", "gpt-5.6-terra");
    vi.stubEnv("DAILY_BUDGET_CAP_USD_GLOBAL", "1000");
    vi.stubEnv("REMOTION_GRAPHICS_ENABLED", "false");
    resetInMemoryStoreForDev();
    sessionCookie = `studio_session=${await createSessionForInviteCode("local-fixture-invite")}`;
    providerRequests.length = 0;
    sourceReply = "valid";
    articleParagraphs = paragraphs;
    fetchGuarded.mockImplementation(async () => new Response(`<html><head><title>Example research</title></head><body><nav>Unrelated navigation</nav><article>${articleParagraphs.map((text) => `<p>${text}</p>`).join("")}</article></body></html>`, { headers: { "Content-Type": "text/html" } }));
    // Exercise the real SDK, structured response format, provider guard and
    // HTTP handler. Network responses are substituted; no live API runs.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init.body));
      providerRequests.push(body);
      const input = JSON.parse(body.input[1].content);
      let output: string;
      if (input.sources) {
        const passages = input.sources.flatMap((source: { passages: Array<{ id: string; text: string }> }) => source.passages);
        output = sourceReply === "invalid-json" ? "{incomplete" : JSON.stringify({ claims: sourceReply === "empty" ? [] : passages.map((passage: { id: string; text: string }) => ({
          text: passage.text.replaceAll("’", "'"), evidenceId: sourceReply === "unknown-evidence" ? "invented" : passage.id,
        })) });
      } else {
        output = JSON.stringify({ title: "How the method works", scenes: input.claims.map((claim: { id: string; text: string }, index: number) => ({
          title: `Finding ${index + 1}`, narration: claim.text.split(" ").slice(0, 19).join(" ") + ".",
          visual: "Compare the supplied evidence in a clear diagram.", claimIds: [claim.id],
        })) });
      }
      return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [{
        type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations: [] }],
      }] });
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("reads a URL and links exact original evidence through the real SDK and draft endpoint", async () => {
    const response = await POST(request("url-success"));
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const job = await getStore().getJob(body.productionId);
    expect(job?.status).toBe("awaiting_user");
    expect(job?.sourceBundle?.claims).toHaveLength(paragraphs.length);
    expect(job?.sourceBundle?.claims.every((claim) => claim.status === "supported")).toBe(true);
    const quote = job!.sourceBundle!.claims[0].evidenceRefs[0];
    expect(quote).toMatchObject({ sourceId, excerpt: paragraphs[0], sourceUrl: "https://example.com/research",
      excerptHash: createHash("sha256").update(paragraphs[0]).digest("hex") });
    expect(job?.storyboard?.scenes.at(-1)?.narration).toContain("additional evaluation");
    expect(providerRequests).toHaveLength(2);
    expect(providerRequests[0]).toMatchObject({ text: { format: { type: "json_schema", strict: true } } });
    expect(JSON.stringify(providerRequests[0])).not.toContain(sourceId);
    const replay = await POST(request("url-success"));
    expect(await replay.json()).toMatchObject({ productionId: body.productionId });
    expect(providerRequests).toHaveLength(2);
  });

  it.each(["invalid-json", "unknown-evidence"] as const)("makes %s recoverable without inventing evidence or replaying a successful creation", async (failure) => {
    sourceReply = failure;
    const response = await POST(request("failed-analysis"));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "source_analysis_failed", error: expect.stringContaining("Your sources are saved") });
    sourceReply = "valid";
    expect((await POST(request("failed-analysis"))).headers.get("Idempotency-Replayed")).toBe("true");
    expect(providerRequests).toHaveLength(1);
    const retry = await POST(request("deliberate-retry"));
    expect(retry.status, JSON.stringify(await retry.clone().json())).toBe(200);
    expect(providerRequests).toHaveLength(3);
  });

  it("reports insufficient evidence as a source problem rather than a generic server error", async () => {
    sourceReply = "empty";
    const response = await POST(request("empty-evidence"));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "source_claims_missing", error: expect.stringContaining("source was readable") });
    expect(providerRequests).toHaveLength(1);
  });

  it("bounds passage IDs and prompt size while preserving later sections of a long article", async () => {
    articleParagraphs = [...Array.from({ length: 2_000 }, (_, index) => `Finding ${index} measured two outcomes.`), "The final conclusion records the study's uncertainty."];
    sourceReply = "empty";
    expect((await POST(request("long-article"))).status).toBe(422);
    const body = providerRequests[0];
    const input = JSON.parse((body.input as Array<{ content: string }>)[1].content);
    const passages = input.sources[0].passages;
    expect(passages.length).toBeLessThanOrEqual(600);
    expect(passages.at(-1).text).toContain("final conclusion");
    expect(passages.every((passage: { text: string }) => passage.text.length <= 1_000 && !passage.text.includes("excerpt gap"))).toBe(true);
    expect(JSON.stringify(body.input).length).toBeLessThan(200_000);
  });

  it("keeps provider spending controls ahead of URL drafting", async () => {
    vi.stubEnv("PROVIDER_CALLS_ENABLED", "false");
    const response = await POST(request("provider-disabled"));
    expect(response.status).toBe(503);
    expect(providerRequests).toHaveLength(0);
  });

  it("preserves a guard error wrapped by the real provider SDK", async () => {
    vi.stubEnv("OPENAI_AGENT_MODEL", "unpriced-fixture-model");
    const response = await POST(request("unpriced-model"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unpriced_model" });
    expect(providerRequests).toHaveLength(0);
  });
});
