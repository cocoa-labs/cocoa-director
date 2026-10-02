import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hardeningContract } from "../helpers/hardening-contract";
import { SCHEMA_SQL } from "@/lib/server/schema";
import { getSql, withTransaction } from "@/lib/server/db";
import { getStore } from "@/lib/server/store";

describe.skipIf(!process.env.TEST_DATABASE_URL)("real Postgres upgrade and concurrency", () => {
  const schema = `hardening_${randomUUID().replaceAll("-", "")}`;
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const projectId = randomUUID();
  beforeAll(async () => {
    await client.connect();
    await client.query(`create schema "${schema}"`);
    await client.query(`set search_path to "${schema}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    await client.query(await readFile(new URL("../fixtures/schema-before-hardening.sql", import.meta.url), "utf8"));
    await client.query("insert into users(id,email) values ('existing-user','existing@example.test')");
    await client.query("insert into projects(id,user_id,name) values ($1,'existing-user','Existing-format project')", [projectId]);
    await client.query(SCHEMA_SQL);
    await client.query(SCHEMA_SQL); // migrations remain safe on a second deployment
  });
  beforeEach(async () => {
    process.env.PROVIDER_MODE = "mock";
    process.env.DISABLE_BETA_AUTH = "true";
    process.env.PROVIDER_CALLS_ENABLED = "true";
    process.env.DAILY_BUDGET_CAP_USD_GLOBAL = "50";
    await client.query("truncate action_requests, provider_reservations, provider_audit_events");
  });
  afterAll(async () => {
    await client.query(`drop schema "${schema}" cascade`);
    await client.end();
  });
  it("preserves existing records and shares transactions across store helpers", async () => {
    expect((await getStore().getProject(projectId))?.name).toBe("Existing-format project");
    const owner = `rollback-${randomUUID()}`;
    await expect(withTransaction(async () => {
      await getStore().createProject({ userId: owner, name: "must roll back" });
      throw new Error("forced rollback");
    })).rejects.toThrow("forced rollback");
    expect(await getSql()`select id from projects where user_id = ${owner}`).toHaveLength(0);
  });
  hardeningContract();
});
