import assert from "node:assert/strict";
import test from "node:test";

import type { ActivePosition, ClosedTrade } from "../types/product-modes.ts";
import { createChallengeSession, reduceChallengeSession } from "./sessions/challenge-session.ts";
import { createRiskTrainingSession, reduceRiskTrainingSession } from "./sessions/risk-training-session.ts";

test("risk training follows question, preparing, replay, result and review states", () => {
  let session = createRiskTrainingSession(0.02);
  session = reduceRiskTrainingSession(session, { type: "START" });
  session = reduceRiskTrainingSession(session, { type: "QUESTION_READY" });
  session = reduceRiskTrainingSession(session, {
    type: "SUBMIT_TRADE",
    plan: { direction: "LONG", lotSize: 0.05, entry: 100, stopLoss: 95, takeProfit: 110 },
  });
  assert.equal(session.phase, "PREPARING_REPLAY");
  session = reduceRiskTrainingSession(session, { type: "REPLAY_READY" });
  session = reduceRiskTrainingSession(session, {
    type: "TRADE_RESULT",
    pnl: 40,
    result: { status: "TAKE PROFIT", direction: "LONG", resultR: 2, filledIndex: 0, exitIndex: 10, holdingMinutes: 10, mfeR: 2, maeR: -0.2, exitPrice: 110 },
  });
  assert.equal(session.phase, "RESULT");
  assert.equal(session.balance, 1_040);
  session = reduceRiskTrainingSession(session, { type: "REVEAL_FUTURE" });
  assert.equal(session.phase, "REVIEW");
});

test("risk pass changes counts but not balance or trade count", () => {
  let session = reduceRiskTrainingSession(createRiskTrainingSession(0.02), { type: "START" });
  session = reduceRiskTrainingSession(session, { type: "QUESTION_READY" });
  session = reduceRiskTrainingSession(session, { type: "PASS" });
  assert.equal(session.balance, 1_000);
  assert.equal(session.stats.questionsViewed, 1);
  assert.equal(session.stats.passCount, 1);
  assert.equal(session.stats.trades, 0);
});

test("challenge permits sequential positions but never two active positions", () => {
  const position: ActivePosition = { direction: "LONG", lotSize: 0.01, entryPrice: 100, openedAt: 0, usedMargin: 1, maxHigh: 100, minLow: 100 };
  let session = reduceChallengeSession(createChallengeSession(100), { type: "START", timestamp: 0 });
  session = reduceChallengeSession(session, { type: "OPEN_POSITION", position });
  const duplicate = reduceChallengeSession(session, { type: "OPEN_POSITION", position: { ...position, direction: "SHORT" } });
  assert.deepEqual(duplicate.activePosition, position);
  const trade: ClosedTrade = { direction: "LONG", lotSize: 0.01, entryPrice: 100, exitPrice: 110, openedAt: 0, closedAt: 600, pnl: 10, resultR: null, mfeR: null, maeR: null, exitReason: "MANUAL_CLOSE" };
  session = reduceChallengeSession(session, { type: "CLOSE_POSITION", trade });
  assert.equal(session.phase, "ACTIVE");
  assert.equal(session.account.balance, 110);
  session = reduceChallengeSession(session, { type: "OPEN_POSITION", position: { ...position, openedAt: 600 } });
  assert.equal(session.phase, "POSITION_OPEN");
  assert.equal(session.stats.totalTrades, 1);
});

