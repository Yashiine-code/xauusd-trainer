import assert from "node:assert/strict";
import test from "node:test";

import type { Candle } from "../types/market.ts";
import { aggregateCandles, TIMEFRAME_MINUTES } from "./candles.ts";

const candles: Candle[] = Array.from({ length: 61 }, (_, index) => ({
  timestamp: index * 60,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100.5 + index,
  volume: 0,
}));

test("Next Candle timeframe steps map to the requested global clock increments", () => {
  assert.deepEqual(TIMEFRAME_MINUTES, { "1H": 60, "15m": 15, "5m": 5, "3m": 3, "1m": 1 });
});

test("aggregation never includes a one-minute candle beyond current_time", () => {
  const cutoff = 15 * 60;
  for (const timeframe of Object.keys(TIMEFRAME_MINUTES) as (keyof typeof TIMEFRAME_MINUTES)[]) {
    const visible = aggregateCandles(candles, timeframe, cutoff);
    assert.ok(visible.length > 0);
    assert.ok(visible.every((candle) => candle.timestamp <= cutoff));
  }
  assert.equal(aggregateCandles(candles, "1m", cutoff).length, 16);
});

test("1H aggregation builds a forming candle only through 14:37", () => {
  const start = 14 * 60 * 60;
  const hour = Array.from({ length: 60 }, (_, index): Candle => ({
    timestamp: start + index * 60,
    open: 100,
    high: 100 + index,
    low: 90,
    close: 100 + index,
    volume: 0,
  }));
  const [forming] = aggregateCandles(hour, "1H", start + 37 * 60);
  assert.equal(forming.timestamp, start);
  assert.equal(forming.high, 137);
  assert.equal(forming.close, 137);
});
