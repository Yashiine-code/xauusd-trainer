#!/usr/bin/env node

import { createReadStream, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import process from "node:process";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";

const projectRoot = path.resolve(import.meta.dirname, "..");
const dataRoot = path.join(projectRoot, "data/aggregated/xauusd");
const failureLog = path.join(projectRoot, "data/reports/postgres_import_failures.jsonl");
const timeframeFiles = new Map([
  ["1m", "xauusd_1m.csv"],
  ["3m", "xauusd_3m.csv"],
  ["5m", "xauusd_5m.csv"],
  ["15m", "xauusd_15m.csv"],
  ["1H", "xauusd_1H.csv"],
]);
const batchSize = Math.max(100, Number(process.env.IMPORT_BATCH_SIZE ?? 2_000));

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith("--")) continue;
    result.set(argv[index].slice(2), argv[index + 1]?.startsWith("--") ? true : argv[++index] ?? true);
  }
  return result;
}

async function migrate(sql) {
  await runMigrations(drizzle(sql), { migrationsFolder: path.join(projectRoot, "drizzle") });
}

async function importCandles(sql, timeframe, filePath) {
  let processed = 0;
  let nextProgress = 100_000;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      processed += chunk.toString().split("\n").length - 1;
      while (processed - 1 >= nextProgress) {
        console.log(`[${timeframe}] staged ${nextProgress.toLocaleString()} rows`);
        nextProgress += 100_000;
      }
      callback(null, chunk);
    },
  });
  const connection = await sql.reserve();
  try {
    await connection`
      create temporary table market_candles_import_stage (
        timestamp timestamptz not null,
        open numeric(18, 6) not null,
        high numeric(18, 6) not null,
        low numeric(18, 6) not null,
        close numeric(18, 6) not null,
        volume numeric(24, 6) not null
      ) on commit preserve rows
    `;
    const copyStream = await connection`
      copy market_candles_import_stage (timestamp, open, high, low, close, volume)
      from stdin with (format csv, header true)
    `.writable();
    await pipeline(createReadStream(filePath), counter, copyStream);
    const [stage] = await connection`select count(*)::bigint as count from market_candles_import_stage`;
    processed = Number(stage.count);
    const [conflicts] = await connection`
      select count(*)::bigint as count
      from market_candles_import_stage staged
      join market_candles stored
        on stored.symbol = 'XAUUSD'
       and stored.timeframe = ${timeframe}::market_timeframe
       and stored.timestamp = staged.timestamp
      where (stored.open, stored.high, stored.low, stored.close, stored.volume)
        is distinct from (staged.open, staged.high, staged.low, staged.close, staged.volume)
    `;
    if (Number(conflicts.count) > 0) {
      throw new Error(`[${timeframe}] ${conflicts.count} conflicting rows already exist in PostgreSQL.`);
    }
    const result = await connection`
      insert into market_candles (symbol, timeframe, timestamp, open, high, low, close, volume)
      select 'XAUUSD', ${timeframe}::market_timeframe, timestamp, open, high, low, close, volume
      from market_candles_import_stage
      on conflict (symbol, timeframe, timestamp) do nothing
    `;
    const [verified] = await connection`
      select count(*)::bigint as count
      from market_candles where symbol = 'XAUUSD' and timeframe = ${timeframe}
    `;
    console.log(`[${timeframe}] source=${processed.toLocaleString()} inserted=${result.count.toLocaleString()} database=${Number(verified.count).toLocaleString()} conflicts=0`);
  } catch (error) {
    await appendFile(failureLog, JSON.stringify({ at: new Date().toISOString(), timeframe, filePath, processed, error: String(error) }) + "\n");
    throw error;
  } finally {
    connection.release();
  }
}

async function importQuestions(sql, filePath) {
  let processed = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await sql`
      insert into question_pool ${sql(batch, "question_id", "symbol", "hidden_timestamp", "future_available_until", "status", "quality_flag", "metadata")}
      on conflict (question_id) do update set
        future_available_until = excluded.future_available_until,
        status = excluded.status,
        quality_flag = excluded.quality_flag,
        metadata = excluded.metadata
    `;
    batch = [];
  };
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) {
    if (first) { first = false; continue; }
    if (!line) continue;
    // csv.writer quotes metadata; split stable scalar prefix and parse JSON tail.
    const match = line.match(/^([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),"(.*)"$/);
    if (!match) throw new Error(`Invalid question_pool CSV row ${processed + 2}`);
    const [, question_id, symbol, hidden_timestamp, future_available_until, status, quality_flag, escaped] = match;
    batch.push({
      question_id, symbol, hidden_timestamp, future_available_until, status, quality_flag,
      metadata: escaped.replaceAll('""', '"'),
    });
    processed += 1;
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  const [verified] = await sql`select count(*)::bigint as count from question_pool where symbol = 'XAUUSD'`;
  console.log(`[questions] source=${processed.toLocaleString()} database=${Number(verified.count).toLocaleString()}`);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const args = argumentsMap(process.argv.slice(2));
  const selected = args.get("timeframe");
  const sql = postgres(process.env.DATABASE_URL, { max: 4, prepare: false });
  try {
    if (args.has("migrate")) await migrate(sql);
    for (const [timeframe, filename] of timeframeFiles) {
      if (selected && selected !== timeframe) continue;
      const filePath = args.get("file") || path.join(dataRoot, filename);
      if (!existsSync(filePath)) throw new Error(`Missing aggregate file: ${filePath}`);
      await importCandles(sql, timeframe, filePath);
      if (args.has("file")) break;
    }
    if (!selected || args.has("questions")) {
      const questionPath = path.join(dataRoot, "question_pool.csv");
      if (existsSync(questionPath)) await importQuestions(sql, questionPath);
    }
  } finally {
    await sql.end();
  }
}

main().catch(async (error) => {
  await appendFile(failureLog, JSON.stringify({ at: new Date().toISOString(), stage: "fatal", error: String(error) }) + "\n").catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
