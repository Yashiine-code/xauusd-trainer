import assert from "node:assert/strict";
import test from "node:test";

import { createServerSession, getReplayReachedTimestamp, type ServerMarketSession } from "./session-store.ts";

test("replay reveal time starts where the trade was submitted after question advances", () => {
  const session = {
    hiddenTimestamp: 1_000,
    replayStartedAt: 1_300,
  } as ServerMarketSession;
  assert.equal(getReplayReachedTimestamp(session, 5), 1_600);
});

test("risk training and challenge create distinct server session types", () => {
  const base = { questionId: crypto.randomUUID(), symbol: "XAUUSD", hiddenTimestamp: 1_000, futureAvailableUntil: 2_000 };
  const risk = createServerSession({ ...base, sessionType: "RISK_TRAINING" });
  const challenge = createServerSession({ ...base, questionId: crypto.randomUUID(), sessionType: "CHALLENGE" });
  assert.equal(risk.sessionType, "RISK_TRAINING");
  assert.equal(risk.mode, "QUESTION");
  assert.equal(challenge.sessionType, "CHALLENGE");
  assert.equal(challenge.mode, "ACTIVE");
});
