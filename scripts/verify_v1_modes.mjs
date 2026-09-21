#!/usr/bin/env node

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const baseUrl = process.env.VERIFY_BASE_URL ?? "http://localhost:5174";

async function post(body) {
  const response = await fetch(`${baseUrl}/api/market`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${body.action} failed (${response.status}): ${payload.error ?? "unknown error"}`);
  return payload;
}

const risk = await post({ action: "new", sessionMode: "RISK_TRAINING" });
assert.equal(risk.sessionMode, "RISK_TRAINING");
await post({
  action: "submit",
  token: risk.token,
  currentTime: risk.currentTime,
  plan: { direction: "PASS", lotSize: 0.01 },
});
const revealStarted = performance.now();
const reveal = await post({ action: "reveal", token: risk.token, start: risk.currentTime });
const revealMs = performance.now() - revealStarted;
assert.ok(reveal.currentTime <= risk.currentTime + 4 * 60 * 60);
assert.ok(reveal.candles.every((candle) => candle.timestamp <= risk.currentTime + 4 * 60 * 60));

const challenge = await post({ action: "new", sessionMode: "CHALLENGE" });
assert.equal(challenge.sessionMode, "CHALLENGE");
await post({ action: "buffer", token: challenge.token, minutes: 60 });
await post({ action: "challenge-open", token: challenge.token, currentTime: challenge.currentTime });
await post({ action: "challenge-close", token: challenge.token, currentTime: challenge.currentTime });
await post({ action: "challenge-end", token: challenge.token, currentTime: challenge.currentTime });

console.log(JSON.stringify({
  status: "PASS",
  revealLimitMinutes: Math.round((reveal.currentTime - risk.currentTime) / 60),
  revealCandleCount: reveal.candles.length,
  revealLatencyMs: Number(revealMs.toFixed(2)),
  challengeLifecycle: "PASS",
}, null, 2));

