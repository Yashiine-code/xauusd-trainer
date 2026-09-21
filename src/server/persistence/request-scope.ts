import { AsyncLocalStorage } from "node:async_hooks";
import { createRequestSqlClient, getDatabaseClientCreationCount, shouldReuseProcessClient, type SqlClient } from "../../../db/index.ts";

type TimingEvent = { stage: string; wallMs: number; outcome: "ok" | "error" };
type RequestScope = { sql?: SqlClient; operation?: string; started?: number; events?: TimingEvent[]; clientsBefore?: number };
const requestScope = new AsyncLocalStorage<RequestScope>();

export async function timedPhase<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  const scope = requestScope.getStore();
  if (!scope?.events) return operation();
  const started = performance.now();
  let outcome: TimingEvent["outcome"] = "ok";
  try { return await operation(); }
  catch (cause) { outcome = "error"; throw cause; }
  finally { scope.events.push({ stage, wallMs: Number((performance.now() - started).toFixed(2)), outcome }); }
}

export function setTimingOperation(operation: string): void {
  const scope = requestScope.getStore();
  if (scope?.events) scope.operation = operation;
}

export function recordTiming(stage: string, elapsedMs: number, outcome: TimingEvent["outcome"] = "ok"): void {
  const scope = requestScope.getStore();
  if (scope?.events) scope.events.push({ stage, wallMs: Number(elapsedMs.toFixed(2)), outcome });
}

export function persistenceSql(): SqlClient {
  const scope = requestScope.getStore();
  if (!scope) return createRequestSqlClient();
  if (!scope.sql) {
    const started = performance.now();
    scope.sql = createRequestSqlClient();
    recordTiming("SQL_CLIENT_CREATE_LAZY", performance.now() - started);
  }
  return scope.sql;
}

export async function withPersistenceRequest<T>(operation: () => Promise<T>, timingOperation?: string): Promise<T> {
  const timed = Boolean(timingOperation && (process.env.PHASE2_TIMING_DIAGNOSTICS === "true" ||
    timingOperation === "resume_session" && process.env.NODE_ENV !== "production"));
  return requestScope.run(timed ? { operation: timingOperation, started: performance.now(), events: [], clientsBefore: getDatabaseClientCreationCount() } : { clientsBefore: getDatabaseClientCreationCount() }, async () => {
    try {
      return await operation();
    } finally {
      const scope = requestScope.getStore();
      const sql = scope?.sql;
      const reuseProcessClient = shouldReuseProcessClient();
      try {
        if (sql && !reuseProcessClient) await timedPhase("SQL_CLIENT_CLOSE", () => sql.end({ timeout: 2 }));
      } finally {
        if (scope?.events && scope.started !== undefined) console.info("PHASE2_TIMING", JSON.stringify({
          operation: scope.operation,
          totalMs: Number((performance.now() - scope.started).toFixed(2)),
          sqlClientsCreated: getDatabaseClientCreationCount() - (scope.clientsBefore ?? 0),
          reuseProcessClient,
          events: scope.events,
        }));
      }
    }
  });
}
