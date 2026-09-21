import assert from "node:assert/strict";
import test from "node:test";

import type { Candle } from "../types/market.ts";
import { MarketBuffer } from "./market-buffer.ts";

const minute = (index: number): Candle => ({ timestamp: index * 60, open: index, high: index, low: index, close: index, volume: 1 });

test("rolling buffer deduplicates refills and consumes only released candles", () => {
  const buffer = new MarketBuffer(0);
  buffer.append([minute(1), minute(2), minute(3)], 180, false);
  buffer.append([minute(3), minute(4)], 240, false);
  assert.equal(buffer.size, 4);
  assert.deepEqual(buffer.takeThrough(120).map((row) => row.timestamp), [60, 120]);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.authorizedThrough, 240);
});

test("rolling buffer end is a dataset signal, not a cache-window limit", () => {
  const buffer = new MarketBuffer(0);
  buffer.append([minute(1)], 60, false);
  assert.equal(buffer.datasetEnded, false);
  buffer.append([], 60, true);
  assert.equal(buffer.datasetEnded, true);
});

test("rolling buffer retains released 1m history for local timeframe rebuilding", () => {
  const buffer = new MarketBuffer(120);
  buffer.seedReleased([minute(0), minute(1), minute(2)]);
  buffer.append([minute(3), minute(4)], 240, false);
  buffer.discardThrough(180);
  assert.deepEqual(
    buffer.releasedSnapshot(180).map((row) => row.timestamp),
    [0, 60, 120, 180],
  );
  assert.equal(buffer.size, 1);
});
