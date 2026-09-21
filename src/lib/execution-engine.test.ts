import assert from "node:assert/strict";
import test from "node:test";

import type { Candle } from "../types/market.ts";
import type { ActivePosition } from "../types/product-modes.ts";
import { createAccountState } from "./margin-engine.ts";
import { executePositionCandle } from "./execution-engine.ts";

const position: ActivePosition = {
  direction: "LONG",
  lotSize: 0.05,
  entryPrice: 100,
  stopLoss: 95,
  takeProfit: 110,
  openedAt: 0,
  usedMargin: 2.5,
  maxHigh: 100,
  minLow: 100,
};

function candle(low: number, high: number, close = 100): Candle {
  return { timestamp: 60, open: 100, low, high, close, volume: 0 };
}

test("shared position engine resolves same-minute SL before TP", () => {
  const result = executePositionCandle(position, createAccountState(1_000), candle(94, 111));
  assert.equal(result.exitReason, "SL");
  assert.equal(result.exitPrice, 95);
});

test("shared position engine resolves take profit at exact configured price", () => {
  const result = executePositionCandle(position, createAccountState(1_000), candle(99, 111));
  assert.equal(result.exitReason, "TP");
  assert.equal(result.exitPrice, 110);
});

test("shared position engine marks an open position without closing it", () => {
  const result = executePositionCandle(position, createAccountState(1_000), candle(99, 105, 103));
  assert.equal(result.exitReason, null);
  assert.ok(Math.abs(result.account.floatingPnl - 15) < 1e-8);
});
