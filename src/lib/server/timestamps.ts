/**
 * Convert timestamps returned by database drivers into a stable UTC value.
 *
 * node-postgres returns `timestamptz` columns as Date objects. Calling String()
 * on those objects produces browser-style text containing `GMT-0500`, which
 * PostgreSQL cannot reliably parse if that value is later written back.
 */
export function databaseTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? text : new Date(timestamp).toISOString();
}
