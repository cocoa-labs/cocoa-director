import { AsyncLocalStorage } from "node:async_hooks";
import { hasDatabase, withDatabaseLock } from "@/lib/server/db";

const queues = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** Process mutex in mock mode, transaction advisory lock across live instances. */
export async function criticalSection<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(key)) return operation();
  const run = () => held.run(new Set([...(held.getStore() ?? []), key]), operation);
  if (hasDatabase()) return withDatabaseLock(key, run);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  await previous;
  try { return await run(); }
  finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}
