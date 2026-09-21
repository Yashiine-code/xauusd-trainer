#!/usr/bin/env node

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { databasePoolSize, getSql } from "../db/index.ts";
import {
  PostgresMarketDataService,
  PostgresQuestionPoolService,
} from "../src/server/market-data/postgres-service.ts";
import type { Timeframe } from "../src/types/market.ts";

const ITERATIONS = 20;
const SUITE_TIMEOUT_MS = 60_000;
const sql = getSql();
const market = new PostgresMarketDataService(sql);
const questions = new PostgresQuestionPoolService(sql);

function stats(samples: number[], errorCount: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    runs: samples.length,
    p50Ms: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
    errorCount,
  };
}

async function runSuite(operation: () => Promise<void>, concurrency: number) {
  let next = 0;
  let errorCount = 0;
  const samples: number[] = [];
  const work = Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < ITERATIONS) {
      next += 1;
      const started = performance.now();
      try {
        await operation();
        samples.push(performance.now() - started);
      } catch {
        errorCount += 1;
      }
    }
  }));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(
          new Error("Benchmark suite exceeded 60 seconds."),
          { code: "BENCHMARK_SUITE_TIMEOUT" },
        )), SUITE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert.equal(errorCount, 0);
  assert.equal(samples.length, ITERATIONS);
  return stats(samples, errorCount);
}

async function candleOperation(timeframe: Timeframe, rows: number, end: number) {
  const [range] = await sql<{ start: Date }[]>`
    select min(timestamp) as start from (
      select timestamp from market_candles
      where symbol = 'XAUUSD' and timeframe = ${timeframe}
        and timestamp <= ${new Date(end * 1000)}
      order by timestamp desc limit ${rows}
    ) selected
  `;
  const start = Math.floor(range.start.getTime() / 1000);
  return async () => {
    const result = await market.getCandles({ symbol: "XAUUSD", timeframe, start, end, limit: rows });
    assert.equal(result.length, rows);
  };
}

try {
  const anchor = await questions.allocate("XAUUSD");
  const allNames = ["240x1H", "500x15m", "1000x5m", "30m-replay-chunk", "question-allocation"];
  const selectedNames = new Set(
    (process.env.PHASE1B_BENCHMARKS ?? allNames.join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const operations: Record<string, () => Promise<void>> = {};
  if (selectedNames.has("240x1H")) operations["240x1H"] = await candleOperation("1H", 240, anchor.hiddenTimestamp);
  if (selectedNames.has("500x15m")) operations["500x15m"] = await candleOperation("15m", 500, anchor.hiddenTimestamp);
  if (selectedNames.has("1000x5m")) operations["1000x5m"] = await candleOperation("5m", 1_000, anchor.hiddenTimestamp);
  if (selectedNames.has("30m-replay-chunk")) {
    operations["30m-replay-chunk"] = async () => {
      const rows = await market.getReplayChunk(
        "XAUUSD",
        anchor.hiddenTimestamp,
        anchor.hiddenTimestamp + 30 * 60,
      );
      assert.ok(rows.length <= 30);
      assert.ok(rows.every((row) => row.timestamp > anchor.hiddenTimestamp));
      assert.ok(rows.every((row) => row.timestamp <= anchor.hiddenTimestamp + 30 * 60));
    };
  }
  if (selectedNames.has("question-allocation")) {
    operations["question-allocation"] = async () => {
      const question = await questions.allocate("XAUUSD");
      assert.equal(question.symbol, "XAUUSD");
    };
  }

  const results: Record<string, Record<string, ReturnType<typeof stats>>> = {};
  for (const [name, operation] of Object.entries(operations)) {
    await operation();
    results[name] = {};
    for (const concurrency of [1, 2, 4]) {
      const result = await runSuite(operation, concurrency);
      results[name][`concurrency${concurrency}`] = result;
      console.error(JSON.stringify({ stage: `${name}:concurrency${concurrency}:pass`, result }));
    }
  }

  console.log(JSON.stringify({
    status: "PASS",
    iterationsPerSuite: ITERATIONS,
    suiteTimeoutMs: SUITE_TIMEOUT_MS,
    poolMaxConnections: databasePoolSize,
    results,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    status: "FAIL",
    errorType: error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code ?? error.name)
      : error instanceof Error ? error.name : "UNKNOWN",
  }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
