export type DatabaseDiagnostics = {
  queryCount: number;
  queryTimeMs: number;
  clientCreations: number;
  httpRequestCount: number;
};

const diagnosticsGlobal = globalThis as typeof globalThis & {
  __marketDatabaseDiagnostics?: DatabaseDiagnostics;
  __marketDatabaseClientCreations?: number;
};

const diagnostics = diagnosticsGlobal.__marketDatabaseDiagnostics ??= {
  queryCount: 0,
  queryTimeMs: 0,
  clientCreations: 0,
  httpRequestCount: 0,
};

export function createDatabaseDiagnostics(): DatabaseDiagnostics {
  return {
    queryCount: 0,
    queryTimeMs: 0,
    clientCreations: 0,
    httpRequestCount: 0,
  };
}

export type DatabaseDiagnosticsSnapshot = Readonly<DatabaseDiagnostics>;

export function snapshotDatabaseDiagnostics(target: DatabaseDiagnostics = diagnostics): DatabaseDiagnosticsSnapshot {
  return {
    ...target,
    clientCreations: diagnosticsGlobal.__marketDatabaseClientCreations ?? 0,
  };
}

export async function measureDatabaseQuery<T>(
  operation: () => Promise<T>,
  target: DatabaseDiagnostics = diagnostics,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    target.queryCount += 1;
    target.queryTimeMs += performance.now() - started;
  }
}

export async function measureDatabaseHttpRequest<T>(
  operation: () => Promise<T>,
  target: DatabaseDiagnostics = diagnostics,
): Promise<T> {
  target.httpRequestCount += 1;
  return measureDatabaseQuery(operation, target);
}

export function diffDatabaseDiagnostics(
  before: DatabaseDiagnosticsSnapshot,
  target: DatabaseDiagnostics = diagnostics,
) {
  return {
    queryCount: target.queryCount - before.queryCount,
    queryTimeMs: target.queryTimeMs - before.queryTimeMs,
    httpRequestCount: target.httpRequestCount - before.httpRequestCount,
    clientCreations: (diagnosticsGlobal.__marketDatabaseClientCreations ?? 0) - before.clientCreations,
    totalClientCreations: diagnosticsGlobal.__marketDatabaseClientCreations ?? 0,
  };
}

export function databaseTimingHeaders(
  before: DatabaseDiagnosticsSnapshot,
  requestStarted: number,
  target: DatabaseDiagnostics = diagnostics,
): Headers {
  const delta = diffDatabaseDiagnostics(before, target);
  const headers = new Headers();
  headers.set("Server-Timing", `db;dur=${delta.queryTimeMs.toFixed(2)}, total;dur=${(performance.now() - requestStarted).toFixed(2)}`);
  headers.set("X-Database-Query-Count", String(delta.queryCount));
  headers.set("X-HTTP-Adapter-Request-Count", String(delta.httpRequestCount));
  headers.set("X-Database-Client-Creations", String(delta.clientCreations));
  headers.set("X-Database-Client-Creations-Total", String(delta.totalClientCreations));
  return headers;
}
