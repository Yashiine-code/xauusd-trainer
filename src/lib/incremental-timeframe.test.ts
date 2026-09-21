import assert from "node:assert/strict";
import test from "node:test";

import type { Candle } from "../types/market.ts";
import { appendOneMinuteCandles } from "./incremental-timeframe.ts";

const minute = (timestamp: number, price: number): Candle => ({ timestamp, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 1 });

test("incremental aggregation updates a forming candle then appends a new bucket", () => {
  const result = appendOneMinuteCandles([], [minute(60, 100), minute(120, 105), minute(300, 110)], "5m", 10);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { timestamp: 0, open: 100, high: 107, low: 98, close: 106, volume: 2 });
  assert.equal(result[1].timestamp, 300);
});

test("incremental aggregation retains the configured rolling chart history", () => {
  const result = appendOneMinuteCandles([], [minute(60, 1), minute(120, 2), minute(180, 3)], "1m", 2);
  assert.deepEqual(result.map((row) => row.timestamp), [120, 180]);
});
