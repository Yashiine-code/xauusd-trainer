#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 5174;
const baseUrl = `http://localhost:${port}`;
const server = spawn(process.execPath, ["scripts/run-framework.mjs", "dev", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
for (const stream of [server.stdout, server.stderr]) {
  stream.on("data", (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
  });
}

async function waitForServer() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Development server exited with code ${server.exitCode}.`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for the development server.");
}

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned a non-JSON response with status ${response.status}.`);
  }
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${payload.error ?? "unknown error"}`);
  return payload;
}

async function postExpectStatus(path, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(response.status, expectedStatus);
  return response.json();
}

try {
  assert.equal(process.env.MARKET_DATA_MODE, "postgres");
  assert.ok(process.env.DATABASE_URL);
  await waitForServer();

  const session = await post("/api/market", { action: "new" });
  assert.equal(session.isMock, false);
  assert.equal(session.defaultTimeframe, "1H");
  assert.ok(typeof session.token === "string" && session.token.length > 0);
  assert.ok(typeof session.questionId === "string" && session.questionId.length > 0);
  assert.ok(Array.isArray(session.candles));
  assert.equal(session.candles.length, 240);
  assert.ok(session.candles.every((candle) => candle.timestamp <= session.currentTime));

  const rejectedReveal = await postExpectStatus("/api/market", {
    action: "reveal",
    token: session.token,
  }, 403);
  assert.ok(typeof rejectedReveal.error === "string");

  const requested = {
    "1H": { minimum: 240, lookback: 90 * 24 * 60 * 60 },
    "15m": { minimum: 500, lookback: 30 * 24 * 60 * 60 },
    "5m": { minimum: 1_000, lookback: 20 * 24 * 60 * 60 },
    "3m": { minimum: 1_000, lookback: 10 * 24 * 60 * 60 },
    "1m": { minimum: 1_000, lookback: 5 * 24 * 60 * 60 },
  };
  const result = {};
  for (const [timeframe, expectation] of Object.entries(requested)) {
    const payload = await post("/api/candles", {
      token: session.token,
      questionId: session.questionId,
      timeframe,
      start: session.currentTime - expectation.lookback,
      end: session.currentTime + 24 * 60 * 60,
    });
    assert.ok(Array.isArray(payload.candles));
    assert.ok(payload.candles.length >= expectation.minimum);
    assert.ok(payload.candles.every((candle) => candle.timestamp <= session.currentTime));
    result[timeframe] = { available: payload.candles.length, validated: expectation.minimum };
  }

  console.log(JSON.stringify({
    status: "PASS",
    postgresMode: true,
    sessionEndpoint: "PASS",
    candleEndpoint: result,
    futureProtection: "PASS",
    questionModeFutureBlocked: "PASS",
    revealBeforeResultRejected: "PASS",
  }, null, 2));
} catch (error) {
  const safeServerTail = serverOutput
    .split("\n")
    .filter((line) => !line.includes("DATABASE_URL"))
    .slice(-30)
    .join("\n");
  if (safeServerTail) console.error(safeServerTail);
  throw error;
} finally {
  server.kill("SIGTERM");
}
