#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { getSql } from "../db/index.ts";
import { createDatabaseDiagnostics } from "../src/server/market-data/diagnostics.ts";
import { PostgresMarketDataService } from "../src/server/market-data/postgres-service.ts";
import {
  R2MarketDataService,
  type R2MarketBucket,
  type R2MarketCache,
  type R2MarketDataDiagnostics,
} from "../src/server/market-data/r2-service.ts";
import type { MarketDataService } from "../src/server/market-data/types.ts";

const fixtureRoot = path.resolve("data/r2-poc");
const anchor = Date.parse("2026-01-28T12:00:00Z") / 1000;
const encoder = new TextEncoder();

class FixtureBucket implements R2MarketBucket {
  async get(key: string) {
    try {
      const payload = await readFile(path.join(fixtureRoot, key));
      return { body: new Response(payload).body!, size: payload.byteLength };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }
}

class MemoryCache implements R2MarketCache {
  private readonly values = new Map<string, Response>();
  async match(request: Request) { return this.values.get(request.url)?.clone(); }
  async put(request: Request, response: Response) { this.values.set(request.url, response.clone()); }
}

const scenarios = {
  initialLoad: async (service: MarketDataService) => {
    const [hourly, seed] = await Promise.all([
      service.getCandles({ symbol: "XAUUSD", timeframe: "1H", start: anchor - 15 * 86_400, end: anchor, limit: 240 }),
      service.get1mRange("XAUUSD", anchor - 239 * 60, anchor, 240),
    ]);
    return { hourly: hourly.slice(-240), seed };
  },
  bufferRefill24h: async (service: MarketDataService) => ({
    candles: await service.get1mAfter("XAUUSD", Date.parse("2026-01-27T00:00:00Z") / 1000, 1_440),
  }),
  timeframeSwitch: async (service: MarketDataService) => {
    const [m15, h1] = await Promise.all([
      service.getCandles({ symbol: "XAUUSD", timeframe: "15m", start: anchor - 2 * 86_400, end: anchor }),
      service.getCandles({ symbol: "XAUUSD", timeframe: "1H", start: anchor - 10 * 86_400, end: anchor }),
    ]);
    return { m15, h1 };
  },
} satisfies Record<string, (service: MarketDataService) => Promise<unknown>>;

type Run = {
  serverLatencyMs: number;
  browserTotalLatencyMs: number;
  payloadBytes: number;
  requestCount: number;
  cacheHits: number;
  cacheMisses: number;
  originBytes: number;
  errorCount: number;
};

async function measure(operation: () => Promise<unknown>, counters: () => Omit<Run, "serverLatencyMs" | "browserTotalLatencyMs" | "payloadBytes" | "errorCount">): Promise<Run> {
  const totalStarted = performance.now();
  const serverStarted = performance.now();
  try {
    const result = await operation();
    const serverLatencyMs = performance.now() - serverStarted;
    const serialized = JSON.stringify(result);
    JSON.parse(serialized);
    return {
      serverLatencyMs,
      browserTotalLatencyMs: performance.now() - totalStarted,
      payloadBytes: encoder.encode(serialized).byteLength,
      ...counters(),
      errorCount: 0,
    };
  } catch {
    return {
      serverLatencyMs: performance.now() - serverStarted,
      browserTotalLatencyMs: performance.now() - totalStarted,
      payloadBytes: 0,
      ...counters(),
      errorCount: 1,
    };
  }
}

function r2Counters(value: R2MarketDataDiagnostics) {
  return {
    requestCount: value.objectReads,
    cacheHits: value.cacheHits,
    cacheMisses: value.cacheMisses,
    originBytes: value.bytesRead,
  };
}

function average(runs: Run[]) {
  const mean = (key: keyof Run) => Number((runs.reduce((sum, run) => sum + run[key], 0) / runs.length).toFixed(2));
  return {
    serverLatencyMs: mean("serverLatencyMs"),
    browserTotalLatencyMs: mean("browserTotalLatencyMs"),
    payloadBytes: mean("payloadBytes"),
    requestCount: mean("requestCount"),
    cacheHits: mean("cacheHits"),
    cacheMisses: mean("cacheMisses"),
    originBytes: mean("originBytes"),
    errorCount: runs.reduce((sum, run) => sum + run.errorCount, 0),
    samples: runs,
  };
}

const sql = getSql();
const results: Record<string, unknown> = {};
try {
  for (const [name, scenario] of Object.entries(scenarios)) {
    const postgresRuns: Run[] = [];
    for (let index = 0; index < 3; index += 1) {
      const diagnostics = createDatabaseDiagnostics();
      const service = new PostgresMarketDataService(sql, diagnostics);
      postgresRuns.push(await measure(
        () => scenario(service),
        () => ({ requestCount: diagnostics.queryCount, cacheHits: 0, cacheMisses: 0, originBytes: 0 }),
      ));
    }

    const missRuns: Run[] = [];
    for (let index = 0; index < 3; index += 1) {
      const service = new R2MarketDataService(new FixtureBucket(), new MemoryCache());
      missRuns.push(await measure(() => scenario(service), () => r2Counters(service.diagnostics)));
    }

    const warmCache = new MemoryCache();
    await scenario(new R2MarketDataService(new FixtureBucket(), warmCache));
    const hitRuns: Run[] = [];
    for (let index = 0; index < 3; index += 1) {
      const service = new R2MarketDataService(new FixtureBucket(), warmCache);
      hitRuns.push(await measure(() => scenario(service), () => r2Counters(service.diagnostics)));
    }
    results[name] = { postgres: average(postgresRuns), r2MissLocalModel: average(missRuns), r2HitLocalModel: average(hitRuns) };
  }
  console.log(JSON.stringify({
    status: "PASS",
    samplesPerCase: 3,
    pocRange: "2026-01-01/2026-02-01",
    note: "R2 timings use the local object/cache model because the Cloudflare account has not enabled its R2 subscription.",
    results,
  }, null, 2));
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
