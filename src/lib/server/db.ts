import { Pool, type PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

type SqlRow = Record<string, unknown>;
type SqlClient = {
  <T extends SqlRow = SqlRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  query: <T extends SqlRow = SqlRow>(text: string, params?: unknown[]) => Promise<T[]>;
};

let pool: Pool | null = null;
let sqlClient: SqlClient | null = null;
let schemaReady: Promise<void> | null = null;
const transactions = new AsyncLocalStorage<SqlClient>();

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL!;
    pool = new Pool({
      connectionString,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
      max: 10,
    });
  }
  return pool;
}

export function getSql(): SqlClient {
  const transaction = transactions.getStore();
  if (transaction) return transaction;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Postgres storage");
  }

  if (!sqlClient) {
    const activePool = getPool();
    sqlClient = createSqlClient(activePool);
  }

  return sqlClient;
}

function createSqlClient(queryable: Pool | PoolClient): SqlClient {
  const sql = (async <T extends SqlRow = SqlRow>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<T[]> => {
      let text = "";
      for (let i = 0; i < strings.length; i += 1) {
        text += strings[i];
        if (i < values.length) text += `$${i + 1}`;
      }
      const result = await queryable.query<T>(text, values);
      return result.rows;
    }) as SqlClient;

  sql.query = async <T extends SqlRow = SqlRow>(text: string, params?: unknown[]): Promise<T[]> => {
    const result = await queryable.query<T>(text, params);
    return result.rows;
  };

  return sql;
}

export async function withTransaction<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for Postgres storage");
  const existing = transactions.getStore();
  if (existing) return operation(existing);
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const sql = createSqlClient(client);
    const result = await transactions.run(sql, () => operation(sql));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only: migrations are an explicit deployment step, never a request side effect. */
export async function checkDatabaseSchema() {
  const rows = await getSql()`select version from app_schema_migrations where version = 1
    and exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = 'video_jobs' and column_name = 'duration_plan')`;
  if (rows.length !== 1) throw new Error("Database migration required. Run npm run db:migrate.");
}

export async function ensureDatabaseSchema() {
  if (!hasDatabase()) return;
  schemaReady ??= checkDatabaseSchema().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export async function withDatabaseLock<T>(key: string, operation: () => Promise<T>) {
  await ensureDatabaseSchema();
  return withTransaction(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    return operation();
  });
}
