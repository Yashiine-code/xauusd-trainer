import assert from "node:assert/strict";
import test from "node:test";

import type { Candle, TradePlan } from "../types/market.ts";
import { consumeReplayBuffer, resolveReplayStep } from "./replay.ts";

const plan: TradePlan = { direction: "LONG", lotSize: 0.01, entry: 100, stopLoss: 90, takeProfit: 120 };

function minute(index: number, low = 101, high = 105): Candle {
  return { timestamp: index * 60, open: 102, high, low, close: 102, volume: 0 };
}

test("15m visual step stops on an SL hit at minute 7", () => {
  const step = Array.from({ length: 15 }, (_, index) => minute(index + 1));
  step[1] = minute(2, 99, 103);
  step[6] = minute(7, 89, 104);

  const resolved = resolveReplayStep([], step, plan);
  assert.equal(resolved.evaluation.status, "STOP LOSS");
  assert.equal(resolved.releasedCandles.length, 7);
  assert.equal(resolved.releasedCandles.at(-1)?.timestamp, 7 * 60);
});

test("1H visual step stops on a TP hit at minute 23", () => {
  const step = Array.from({ length: 60 }, (_, index) => minute(index + 1));
  step[1] = minute(2, 99, 103);
  step[22] = minute(23, 105, 121);

  const resolved = resolveReplayStep([], step, plan);
  assert.equal(resolved.evaluation.status, "TAKE PROFIT");
  assert.equal(resolved.releasedCandles.length, 23);
  assert.equal(resolved.releasedCandles.at(-1)?.timestamp, 23 * 60);
});

test("buffered fast forward coalesces clicks but stops at the exact exit minute", () => {
  const buffer = Array.from({ length: 120 }, (_, index) => minute(index + 1));
  buffer[1] = minute(2, 99, 103);
  buffer[22] = minute(23, 105, 121);
  const resolved = consumeReplayBuffer({
    previousCandles: [],
    buffer,
    plan,
    currentTime: 0,
    authorizedThrough: 120 * 60,
    stepMinutes: 5,
    pendingSteps: 20,
    noMoreData: false,
  });
  assert.ok(resolved);
  assert.equal(resolved.terminal, true);
  assert.equal(resolved.currentTime, 23 * 60);
  assert.equal(resolved.replayCandles.length, 23);
  assert.equal(resolved.releasedCandles.at(-1)?.timestamp, 23 * 60);
});

test("buffered fast forward consumes twenty visual steps in one resolution", () => {
  const quietPlan: TradePlan = { direction: "LONG", lotSize: 0.01, entry: 100, stopLoss: 1, takeProfit: 1_000 };
  const buffer = Array.from({ length: 120 }, (_, index) => minute(index + 1));
  const resolved = consumeReplayBuffer({
    previousCandles: [],
    buffer,
    plan: quietPlan,
    currentTime: 0,
    authorizedThrough: 120 * 60,
    stepMinutes: 5,
    pendingSteps: 20,
    noMoreData: false,
  });
  assert.ok(resolved);
  assert.equal(resolved.terminal, false);
  assert.equal(resolved.consumedSteps, 20);
  assert.equal(resolved.currentTime, 100 * 60);
  assert.equal(resolved.replayCandles.length, 100);
  assert.equal(resolved.remainingBuffer.length, 20);
});

test("1H burst respects the authorized replay boundary", () => {
  const quietPlan: TradePlan = { direction: "LONG", lotSize: 0.01, entry: 102, stopLoss: 1, takeProfit: 1_000 };
  const buffer = Array.from({ length: 720 }, (_, index) => minute(index + 1));
  const resolved = consumeReplayBuffer({
    previousCandles: [],
    buffer,
    plan: quietPlan,
    currentTime: 0,
    authorizedThrough: 720 * 60,
    stepMinutes: 60,
    pendingSteps: 20,
    noMoreData: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.consumedSteps, 12);
  assert.equal(resolved.currentTime, 720 * 60);
  assert.equal(resolved.evaluation.status, "DATA ENDED");
});
