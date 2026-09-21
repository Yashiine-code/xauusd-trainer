import assert from "node:assert/strict";
import test from "node:test";

import { MarketClock } from "./market-clock.ts";

test("market clock preserves all twenty queued visual steps", () => {
  const clock = new MarketClock(0);
  for (let index = 0; index < 20; index += 1) clock.enqueue(1);
  const advance = clock.preview(15, 24 * 60 * 60, false);
  assert.ok(advance);
  assert.equal(advance.consumedSteps, 20);
  assert.equal(advance.targetTime, 300 * 60);
  clock.commit(advance);
  assert.equal(clock.pendingSteps, 0);
  assert.equal(clock.currentTime, 300 * 60);
});

test("market clock allows one final partial visual step only at dataset end", () => {
  const clock = new MarketClock(0);
  clock.enqueue(20);
  assert.equal(clock.preview(60, 30 * 60, false), null);
  const advance = clock.preview(60, 30 * 60, true);
  assert.ok(advance);
  assert.equal(advance.consumedSteps, 1);
  assert.equal(advance.targetTime, 30 * 60);
  assert.equal(advance.reachedDatasetEnd, true);
});
