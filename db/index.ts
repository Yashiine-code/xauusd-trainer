import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

let client: ReturnType<typeof postgres> | undefined;
export type SqlClient = ReturnType<typeof postgres>;

const databaseDiagnostics = globalThis as typeof globalThis & {
  __marketDatabaseClientCreations?: number;
};

const configuredPoolSize = Number(process.env.DATABASE_POOL_SIZE ?? 2);
export const databasePoolSize = Number.isFinite(configuredPoolSize)
  ? Math.min(Math.max(Math.trunc(configuredPoolSize), 1), 3)
  : 2;

export function getDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required when MARKET_DATA_MODE=postgres.");
  return value;
}

export function getSql() {
  client ??= createSqlClient();
  return client;
}

function createSqlClient(max = databasePoolSize) {
  databaseDiagnostics.__marketDatabaseClientCreations =
    (databaseDiagnostics.__marketDatabaseClientCreations ?? 0) + 1;
  return postgres(getDatabaseUrl(), {
    max,
    idle_timeout: 0,
    connect_timeout: 10,
    max_lifetime: 30 * 60,
    keep_alive: 30,
    prepare: false,
  });
}

export function shouldReuseProcessClient(): boolean {
  return typeof navigator === "undefined" || navigator.userAgent !== "Cloudflare-Workers";
}

export function createRequestSqlClient(): SqlClient {
  // A Cloudflare request cannot retain sockets after it completes. Keep the
  // fallback to one physical connection so concurrent logical queries queue on
  // that connection instead of paying two remote handshakes in one request.
  return shouldReuseProcessClient() ? getSql() : createSqlClient(1);
}

/**
 * Retained for callers that need an operation-scoped helper. The underlying
 * postgres.js pool is process-scoped and must not be closed after a query.
 */
export async function withSql<T>(operation: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  return operation(createRequestSqlClient());
}

export function getDatabaseClientCreationCount(): number {
  return databaseDiagnostics.__marketDatabaseClientCreations ?? 0;
}

/** Only process shutdown and test teardown may close the shared pool. */
export async function closeSqlForShutdown(): Promise<void> {
  const active = client;
  client = undefined;
  if (active) await active.end({ timeout: 5 });
}

export function getDb() {
  return drizzle(getSql(), { schema });
}
