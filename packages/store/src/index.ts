export * from "./types.js";
export { MemoryStore } from "./memory.js";
export { PgStore } from "./pg.js";

import type { SefiStore } from "./types.js";
import { MemoryStore } from "./memory.js";
import { PgStore } from "./pg.js";

/**
 * Choose a store from the environment: a PostgreSQL store when `DATABASE_URL`
 * is set, otherwise the in-memory store (MVP / on-demand mode, spec §4.2/§4.4).
 */
export function createStore(databaseUrl = process.env.DATABASE_URL): SefiStore {
  if (databaseUrl) return new PgStore(databaseUrl);
  return new MemoryStore();
}

/** Apply a migration SQL string against a PostgreSQL database (idempotent). */
export async function runMigrations(
  databaseUrl: string,
  sql: string,
): Promise<void> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}
