import "./env.mjs";
import { readFile } from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for schema initialization.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
await client.connect();
try {
  await client.query("begin");
  await client.query("select pg_advisory_xact_lock(hashtextextended('cocoa-schema', 0))");
  await client.query(await readFile(new URL("../src/lib/server/schema.sql", import.meta.url), "utf8"));
  await client.query("commit");
  console.log("Database schema is current.");
} catch (error) {
  await client.query("rollback");
  console.error("Schema initialization failed:", error.code ?? error.name);
  process.exitCode = 1;
} finally { await client.end(); }
