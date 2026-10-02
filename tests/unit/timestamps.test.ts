import { describe, expect, it } from "vitest";

import { databaseTimestamp } from "@/lib/server/timestamps";

describe("databaseTimestamp", () => {
  it("serializes node-postgres Date values as UTC ISO timestamps", () => {
    expect(databaseTimestamp(new Date("2026-07-29T04:00:00.000Z"))).toBe(
      "2026-07-29T04:00:00.000Z",
    );
  });

  it("normalizes browser-style GMT offsets before they can be written back", () => {
    expect(databaseTimestamp("Tue Jul 28 2026 23:00:00 GMT-0500 (Central Daylight Time)"))
      .toBe("2026-07-29T04:00:00.000Z");
  });
});
