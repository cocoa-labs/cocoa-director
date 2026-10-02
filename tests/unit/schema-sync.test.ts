import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SCHEMA_SQL } from "@/lib/server/schema";

describe("database schema", () => {
  it("keeps the runtime initializer synchronized with schema.sql", () => {
    const schemaPath = fileURLToPath(new URL("../../src/lib/server/schema.sql", import.meta.url));
    const checkedInSchema = readFileSync(schemaPath, "utf8").trim();

    expect(SCHEMA_SQL.trim()).toBe(checkedInSchema);
  });
});
