#!/usr/bin/env node

import { closeSqlForShutdown, getSql } from "../db/index.ts";

const sql = getSql();

function executionTime(row: Record<string, unknown>): number {
  const plan = row["QUERY PLAN"] as Array<{ "Execution Time": number }>;
  return Number(plan[0]["Execution Time"].toFixed(3));
}

try {
  const [question] = await sql<{ hidden_timestamp: Date }[]>`
    select hidden_timestamp
    from question_pool
    where symbol = 'XAUUSD' and status = 'active'
    order by random()
    limit 1
  `;
  if (!question) throw new Error("No active question was available.");
  const end = question.hidden_timestamp;
  const fiveMinuteStart = new Date(end.getTime() - 20 * 24 * 60 * 60 * 1000);
  const partialStart = new Date(end.getTime() - 5 * 60 * 1000);
  const replayEnd = new Date(end.getTime() + 60 * 60 * 1000);

  const [completed] = await sql<Record<string, unknown>[]>`
    explain (analyze, format json)
    select timestamp, open, high, low, close, volume
    from market_candles
    where symbol = 'XAUUSD' and timeframe = '5m'
      and timestamp >= ${fiveMinuteStart} and timestamp <= ${end}
    order by timestamp asc
    limit 800
  `;
  const [partial] = await sql<Record<string, unknown>[]>`
    explain (analyze, format json)
    select timestamp, open, high, low, close, volume
    from market_candles
    where symbol = 'XAUUSD' and timeframe = '1m'
      and timestamp >= ${partialStart} and timestamp <= ${end}
    order by timestamp asc
    limit 5
  `;
  const [replay] = await sql<Record<string, unknown>[]>`
    explain (analyze, format json)
    select timestamp, open, high, low, close, volume
    from market_candles
    where symbol = 'XAUUSD' and timeframe = '1m'
      and timestamp > ${end} and timestamp <= ${replayEnd}
    order by timestamp asc
    limit 60
  `;

  console.log(JSON.stringify({
    status: "PASS",
    postgresExecutionMs: {
      completed5m: executionTime(completed),
      partial1m: executionTime(partial),
      replay60m: executionTime(replay),
    },
  }, null, 2));
} finally {
  await closeSqlForShutdown();
}
