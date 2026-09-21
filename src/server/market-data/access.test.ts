import assert from "node:assert/strict";
import test from "node:test";

import type { Candle } from "../../types/market.ts";
import { getAuthorizedCandles } from "./access.ts";
import type { MarketDataQuery, MarketDataService } from "./types.ts";

const source: Candle[] = Array.from({ length: 60 }, (_, index) => ({
  timestamp: index * 60,
  open: 100,
  high: 100 + index,
  low: 90,
  close: 100 + index,
  volume: 1,
}));

const fakeService: MarketDataService = {
  async getCandles(query: MarketDataQuery) {
    const rows = source.filter((row) => row.timestamp >= query.start && row.timestamp <= query.end);
    if (query.timeframe === "1m") return rows;
    throw new Error("No completed aggregate expected in this fixture.");
  },
  async get1mRange(_symbol, start, end) {
    return source.filter((row) => row.timestamp >= start && row.timestamp <= end);
  },
  async get1mAfter(_symbol, afterTimestamp, limit) {
    return source.filter((candle) => candle.timestamp > afterTimestamp).slice(0, limit);
  },
  async getContext() { return []; },
  async getReplayChunk() { return []; },
  async getBounds() { return { firstTimestamp: 0, lastTimestamp: 59 * 60, rowCount: 60 }; },
};

test("future-data policy caps 1m rows at the server current_time", async () => {
  const rows = await getAuthorizedCandles({
    service: fakeService,
    symbol: "XAUUSD",
    timeframe: "1m",
    start: 0,
    end: 30 * 60,
    maximumAllowedTime: 10 * 60,
  });
  assert.equal(rows.length, 11);
  assert.equal(rows.at(-1)?.timestamp, 10 * 60);
});

test("partial 1H candle is built only from unlocked 1m rows", async () => {
  const [row] = await getAuthorizedCandles({
    service: fakeService,
    symbol: "XAUUSD",
    timeframe: "1H",
    start: 0,
    end: 59 * 60,
    maximumAllowedTime: 37 * 60,
  });
  assert.equal(row.timestamp, 0);
  assert.equal(row.high, 137);
  assert.equal(row.close, 137);
  assert.equal(row.volume, 38);
});
