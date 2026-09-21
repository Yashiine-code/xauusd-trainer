#!/usr/bin/env node

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { getSql } from "../db/index.ts";
import { getAuthorizedCandles } from "../src/server/market-data/access.ts";
import {
  PostgresMarketDataService,
  PostgresQuestionPoolService,
} from "../src/server/market-data/postgres-service.ts";
import type { Timeframe } from "../src/types/market.ts";

const EXPECTED = { "1m": 2_196_367, "3m": 732_310, "5m": 439_400, "15m": 146_474, "1H": 36_635 } as const;
const BENCHMARKS: Array<{ name: string; timeframe: Timeframe; rows: number }> = [
  { name: "240x1H", timeframe: "1H", rows: 240 },
  { name: "500x15m", timeframe: "15m", rows: 500 },
  { name: "1000x5m", timeframe: "5m", rows: 1_000 },
];
const BENCHMARK_ITERATIONS = 20;
const BENCHMARK_SUITE_TIMEOUT_MS = 60_000;

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)];
  return {
    iterations: samples.length,
    averageMs: Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(2)),
    p50Ms: Number(percentile(0.5).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1)!.toFixed(2)),
  };
}

async function timed<T>(operation: () => Promise<T>) {
  const started = performance.now();
  const value = await operation();
  return { value, elapsed: performance.now() - started };
}

async function runBenchmark(operation: () => Promise<void>, concurrency: number) {
  let next = 0;
  let errorCount = 0;
  const samples: number[] = [];
  const work = Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < BENCHMARK_ITERATIONS) {
      next += 1;
      try {
        const result = await timed(operation);
        samples.push(result.elapsed);
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
        )), BENCHMARK_SUITE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert.equal(errorCount, 0);
  return { ...stats(samples), errorCount };
}

const sql = getSql();
const service = new PostgresMarketDataService(sql);
const questions = new PostgresQuestionPoolService(sql);
const progress = (stage: string, result?: unknown) => console.error(JSON.stringify({ stage, result }));

try {
  progress("database-state:start");
  const counts = await sql<{ timeframe: Timeframe; rows: string }[]>`
    select timeframe, count(*)::text as rows
    from market_candles where symbol = 'XAUUSD'
    group by timeframe order by timeframe
  `;
  for (const row of counts) assert.equal(Number(row.rows), EXPECTED[row.timeframe]);

  const [questionCount] = await sql<{ rows: string }[]>`
    select count(*)::text as rows from question_pool where symbol = 'XAUUSD'
  `;
  assert.equal(Number(questionCount.rows), 29_746);

  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('market_candles', 'question_pool', 'training_sessions', 'users', 'trades')
    order by table_name
  `;
  assert.equal(tables.length, 5);

  const constraints = await sql<{ constraint_type: string; count: string }[]>`
    select constraint_type, count(*)::text as count
    from information_schema.table_constraints
    where table_schema = 'public'
      and table_name in ('market_candles', 'question_pool', 'training_sessions', 'users', 'trades')
      and constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
    group by constraint_type order by constraint_type
  `;
  const constraintCounts = Object.fromEntries(
    constraints.map((row) => [row.constraint_type, Number(row.count)]),
  );
  assert.equal(constraintCounts["PRIMARY KEY"], 5);
  assert.equal(constraintCounts["FOREIGN KEY"], 2);
  const indexes = await sql<{ tablename: string; indexname: string }[]>`
    select tablename, indexname from pg_indexes
    where schemaname = 'public'
      and tablename in ('market_candles', 'question_pool', 'training_sessions', 'users', 'trades')
    order by tablename, indexname
  `;
  assert.ok(indexes.some((row) => row.indexname === "question_pool_symbol_hidden_timestamp_uidx"));
  const [nonTimezoneTimestamps] = await sql<{ count: string }[]>`
    select count(*)::text as count from information_schema.columns
    where table_schema = 'public'
      and table_name in ('market_candles', 'question_pool', 'training_sessions', 'users', 'trades')
      and data_type like 'timestamp%'
      and data_type <> 'timestamp with time zone'
  `;
  assert.equal(Number(nonTimezoneTimestamps.count), 0);

  const [redundantPrimaryIndexes] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from pg_index candidate
    join pg_index primary_index
      on primary_index.indrelid = candidate.indrelid
     and primary_index.indisprimary
     and primary_index.indkey::text = candidate.indkey::text
    join pg_class relation on relation.oid = candidate.indrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and not candidate.indisprimary
      and relation.relname in ('market_candles', 'question_pool', 'training_sessions', 'users', 'trades')
  `;
  assert.equal(Number(redundantPrimaryIndexes.count), 0);

  const duplicates = await sql<{ groups: string }[]>`
    select count(*)::text as groups from (
      select symbol, timeframe, timestamp
      from market_candles
      group by symbol, timeframe, timestamp
      having count(*) > 1
    ) duplicated
  `;
  assert.equal(Number(duplicates[0].groups), 0);
  const [invalidOhlcv] = await sql<{ rows: string }[]>`
    select count(*)::text as rows from market_candles
    where high < greatest(open, close)
       or low > least(open, close)
       or high < low
       or volume < 0
  `;
  assert.equal(Number(invalidOhlcv.rows), 0);
  progress("database-state:pass");

  progress("service-validation:start");
  const question = await questions.allocate("XAUUSD");
  const bounds = await service.getBounds("XAUUSD");
  assert.ok(question.hiddenTimestamp < question.futureAvailableUntil);
  assert.ok(question.futureAvailableUntil < bounds.lastTimestamp);

  const context = await service.getContext("XAUUSD", question.hiddenTimestamp, 14_400);
  assert.equal(context.length, 14_400);
  assert.equal(context.at(-1)?.timestamp, question.hiddenTimestamp);
  const future = await service.get1mRange("XAUUSD", question.hiddenTimestamp + 1, question.futureAvailableUntil);
  assert.equal(future.length, 720);
  const questionRange = [...context, ...future];
  const maximumGapSeconds = questionRange.slice(1).reduce(
    (maximum, candle, index) => Math.max(maximum, candle.timestamp - questionRange[index].timestamp),
    0,
  );
  assert.ok(maximumGapSeconds <= 72 * 60 * 60);
  const replay = await service.getReplayChunk("XAUUSD", question.hiddenTimestamp, question.hiddenTimestamp + 30 * 60);
  assert.ok(replay.length <= 30);
  assert.ok(replay.every((row) => row.timestamp > question.hiddenTimestamp && row.timestamp <= question.hiddenTimestamp + 30 * 60));
  let replayCursor = question.hiddenTimestamp;
  const replayTimestamps = new Set<number>();
  for (let chunkIndex = 0; chunkIndex < 4; chunkIndex += 1) {
    const chunkEnd = replayCursor + 30 * 60;
    const chunk = await service.getReplayChunk("XAUUSD", replayCursor, chunkEnd);
    assert.ok(chunk.every((row) => row.timestamp > replayCursor && row.timestamp <= chunkEnd));
    for (const row of chunk) {
      assert.equal(replayTimestamps.has(row.timestamp), false);
      replayTimestamps.add(row.timestamp);
    }
    replayCursor = chunkEnd;
  }

  const protectedFuture = await getAuthorizedCandles({
    service,
    symbol: "XAUUSD",
    timeframe: "1m",
    start: question.hiddenTimestamp - 60 * 60,
    end: question.hiddenTimestamp + 24 * 60 * 60,
    maximumAllowedTime: question.hiddenTimestamp,
  });
  assert.ok(protectedFuture.length > 0);
  assert.ok(protectedFuture.every((row) => row.timestamp <= question.hiddenTimestamp));

  const [partialPoint] = await sql<{ timestamp: Date }[]>`
    select timestamp from market_candles
    where symbol = 'XAUUSD' and timeframe = '1m'
      and extract(minute from timestamp) = 37
    order by timestamp desc limit 1
  `;
  const partialTime = Math.floor(partialPoint.timestamp.getTime() / 1000);
  const hourStart = Math.floor(partialTime / 3600) * 3600;
  const partial = await getAuthorizedCandles({
    service,
    symbol: "XAUUSD",
    timeframe: "1H",
    start: hourStart,
    end: partialTime + 3600,
    maximumAllowedTime: partialTime,
  });
  const source = await service.get1mRange("XAUUSD", hourStart, partialTime);
  const lockedFutureSource = await service.get1mRange("XAUUSD", partialTime + 60, hourStart + 59 * 60);
  assert.ok(lockedFutureSource.length > 0);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].open, source[0].open);
  assert.equal(partial[0].high, Math.max(...source.map((row) => row.high)));
  assert.equal(partial[0].low, Math.min(...source.map((row) => row.low)));
  assert.equal(partial[0].close, source.at(-1)?.close);
  assert.ok(partial[0].timestamp <= partialTime);
  progress("service-validation:pass");

  const benchmarkOperations: Record<string, { rows: number; operation: () => Promise<void> }> = {};
  for (const benchmark of BENCHMARKS) {
    const [range] = await sql<{ start: Date }[]>`
      select min(timestamp) as start from (
        select timestamp from market_candles
        where symbol = 'XAUUSD' and timeframe = ${benchmark.timeframe}
          and timestamp <= ${new Date(question.hiddenTimestamp * 1000)}
        order by timestamp desc limit ${benchmark.rows}
      ) selected
    `;
    const start = Math.floor(range.start.getTime() / 1000);
    benchmarkOperations[benchmark.name] = {
      rows: benchmark.rows,
      operation: async () => {
        const rows = await service.getCandles({
          symbol: "XAUUSD",
          timeframe: benchmark.timeframe,
          start,
          end: question.hiddenTimestamp,
          limit: benchmark.rows,
        });
        assert.equal(rows.length, benchmark.rows);
      },
    };
  }

  benchmarkOperations["30m-replay-chunk"] = {
    rows: replay.length,
    operation: async () => {
      const rows = await service.getReplayChunk(
        "XAUUSD",
        question.hiddenTimestamp,
        question.hiddenTimestamp + 30 * 60,
      );
      assert.ok(rows.length <= 30);
    },
  };
  benchmarkOperations["question-allocation"] = {
    rows: 1,
    operation: async () => {
      const allocated = await questions.allocate("XAUUSD");
      assert.equal(allocated.symbol, "XAUUSD");
    },
  };

  const benchmarks: Record<string, {
    rows: number;
    serial: Awaited<ReturnType<typeof runBenchmark>>;
    concurrency2: Awaited<ReturnType<typeof runBenchmark>>;
    concurrency4: Awaited<ReturnType<typeof runBenchmark>>;
  }> = {};
  for (const [name, benchmark] of Object.entries(benchmarkOperations)) {
    progress(`benchmark:${name}:warmup`);
    await benchmark.operation();
    progress(`benchmark:${name}:serial`);
    const serial = await runBenchmark(benchmark.operation, 1);
    progress(`benchmark:${name}:serial:pass`, serial);
    progress(`benchmark:${name}:concurrency2`);
    const concurrency2 = await runBenchmark(benchmark.operation, 2);
    progress(`benchmark:${name}:concurrency2:pass`, concurrency2);
    progress(`benchmark:${name}:concurrency4`);
    const concurrency4 = await runBenchmark(benchmark.operation, 4);
    progress(`benchmark:${name}:concurrency4:pass`, concurrency4);
    benchmarks[name] = {
      rows: benchmark.rows,
      serial,
      concurrency2,
      concurrency4,
    };
    progress(`benchmark:${name}:pass`);
  }

  const [database] = await sql<{ size_bytes: string; size_pretty: string }[]>`
    select pg_database_size(current_database())::text as size_bytes,
           pg_size_pretty(pg_database_size(current_database())) as size_pretty
  `;
  console.log(JSON.stringify({
    status: "PASS",
    counts: Object.fromEntries(counts.map((row) => [row.timeframe, Number(row.rows)])),
    questionPoolRows: Number(questionCount.rows),
    tables: tables.map((row) => row.table_name),
    constraints: constraintCounts,
    indexes,
    timestampTimezone: "PASS",
    redundantPrimaryIndexes: Number(redundantPrimaryIndexes.count),
    duplicateGroups: 0,
    invalidOhlcvRows: Number(invalidOhlcv.rows),
    question: {
      contextRows: context.length,
      futureRows: future.length,
      futureBeforeDatasetEnd: question.futureAvailableUntil < bounds.lastTimestamp,
      maximumGapSeconds,
    },
    serviceMethods: ["getCandles", "get1mRange", "getContext", "getReplayChunk"],
    futureProtection: "PASS",
    partialCandle: "PASS",
    replayChunks: { chunks: 4, uniqueRows: replayTimestamps.size, status: "PASS" },
    benchmarks,
    database,
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
  await sql.end({ timeout: 1 });
}
