#!/usr/bin/env node

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { databasePoolSize, getSql } from "../db/index.ts";
import {
  PostgresMarketDataService,
  PostgresQuestionPoolService,
} from "../src/server/market-data/postgres-service.ts";

const ITERATIONS = 20;

function summarize(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  return {
    runs: samples.length,
    p50Ms: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
  };
}

async function measure(operation: () => Promise<void>) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function runSerial(operation: () => Promise<void>) {
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) samples.push(await measure(operation));
  return summarize(samples);
}

async function runConcurrent(concurrency: number, operation: () => Promise<void>) {
  let next = 0;
  const samples: number[] = [];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < ITERATIONS) {
      next += 1;
      samples.push(await measure(operation));
    }
  }));
  return summarize(samples);
}

const sql = getSql();
const service = new PostgresMarketDataService(sql);
const questions = new PostgresQuestionPoolService(sql);

try {
  assert.strictEqual(sql, getSql(), "getSql() must return the process singleton");

  const question = await questions.allocate("XAUUSD");
  const [range] = await sql<{ start: Date }[]>`
    select min(timestamp) as start from (
      select timestamp from market_candles
      where symbol = 'XAUUSD' and timeframe = '1H'
        and timestamp <= ${new Date(question.hiddenTimestamp * 1000)}
      order by timestamp desc limit 240
    ) selected
  `;
  const start = Math.floor(range.start.getTime() / 1000);

  const selectOne = async () => {
    const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
    assert.equal(row.ok, 1);
  };
  const candleRange = async () => {
    const rows = await service.getCandles({
      symbol: "XAUUSD",
      timeframe: "1H",
      start,
      end: question.hiddenTimestamp,
      limit: 240,
    });
    assert.equal(rows.length, 240);
  };
  const allocateQuestion = async () => {
    const allocated = await questions.allocate("XAUUSD");
    assert.equal(allocated.symbol, "XAUUSD");
  };
  const replayChunk = async () => {
    const rows = await service.getReplayChunk(
      "XAUUSD",
      question.hiddenTimestamp,
      question.hiddenTimestamp + 30 * 60,
    );
    assert.ok(rows.length <= 30);
  };

  const serial = {
    select1: await runSerial(selectOne),
    candleRange: await runSerial(candleRange),
    questionPool: await runSerial(allocateQuestion),
    replayChunk: await runSerial(replayChunk),
  };

  const concurrency: Record<string, ReturnType<typeof summarize>> = {};
  for (const level of [1, 2, 4]) {
    concurrency[String(level)] = await runConcurrent(level, candleRange);
  }

  console.log(JSON.stringify({
    status: "PASS",
    driver: "postgres.js",
    orm: "Drizzle ORM",
    sharedClient: true,
    poolMaxConnections: databasePoolSize,
    serial,
    concurrency,
    protocolViolation: false,
    connectTimeout: false,
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
