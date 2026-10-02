import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiRequestError, apiErrorResponse } from "@/lib/server/api-error";

describe("apiErrorResponse", () => {
  it("maps a ZodError to 400 with a readable message and field issues", async () => {
    const schema = z.object({ url: z.string().url() });
    const result = schema.safeParse({ url: "not a url" });
    if (result.success) throw new Error("expected parse to fail");

    const res = apiErrorResponse(result.error, "fallback");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("url");
    expect(body.issues.url).toBeDefined();
  });

  it("sanitizes unexpected errors with a diagnostic identifier", async () => {
    const res = apiErrorResponse(new Error("boom"), "fallback");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("boom");
    expect(body.code).toBe("request_failed");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.issues).toBeUndefined();
  });

  it("maps expected request errors without turning them into server failures", async () => {
    const res = apiErrorResponse(
      new ApiRequestError("Feature disabled", 409, "feature_unavailable"),
      "fallback",
    );
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Feature disabled",
      code: "feature_unavailable",
    });
  });

  it("sanitizes non-Error throwables and unsafe fallbacks", async () => {
    const res = apiErrorResponse("weird string throw", "fallback message");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toContain("fallback message");
    expect(body.code).toBe("request_failed");
  });
});
