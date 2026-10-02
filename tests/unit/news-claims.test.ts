import { describe, expect, it } from "vitest";

import { isExplicitBreakingClaim } from "@/lib/news-claims";

describe("isExplicitBreakingClaim", () => {
  it("does not mistake category-page chrome or evergreen language for breaking news", () => {
    expect(isExplicitBreakingClaim("Topics Latest AI Amazon Apps and the ethical issues AI raises today.")).toBe(false);
  });

  it("recognizes explicit breaking and developing-news language", () => {
    expect(isExplicitBreakingClaim("Breaking: The agency has issued a new order.")).toBe(true);
    expect(isExplicitBreakingClaim("The company just announced the acquisition.")).toBe(true);
    expect(isExplicitBreakingClaim("A major event reportedly happened today.")).toBe(true);
  });
});
