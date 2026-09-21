#!/usr/bin/env node

import { performance } from "node:perf_hooks";

const baseUrl = process.env.VERIFY_BASE_URL ?? "http://localhost:5174";
const measurements = [];

function timingValue(header, name) {
  const match = header?.match(new RegExp(`${name};dur=([0-9.]+)`));
  return match ? Number(match[1]) : 0;
}

async function post(label, path, body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  const totalMs = performance.now() - started;
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${payload.error ?? "unknown error"}`);
  const serverTiming = response.headers.get("server-timing");
  measurements.push({
    label,
    apiCount: 1,
    dbClientCreations: Number(response.headers.get("x-database-client-creations") ?? 0),
    dbQueryCount: Number(response.headers.get("x-database-query-count") ?? 0),
    browserLatencyMs: Number(totalMs.toFixed(2)),
    serverTotalMs: timingValue(serverTiming, "total"),
    databaseTimeMs: timingValue(serverTiming, "db"),
  });
  return payload;
}

const session = await post("First open", "/api/market", { action: "new" });
await post("Cold switch 15m", "/api/candles", {
  token: session.token,
  questionId: session.questionId,
  timeframe: "15m",
  start: session.currentTime - 30 * 24 * 60 * 60,
  end: session.currentTime,
});
await post("Cold switch 5m", "/api/candles", {
  token: session.token,
  questionId: session.questionId,
  timeframe: "5m",
  start: session.currentTime - 20 * 24 * 60 * 60,
  end: session.currentTime,
});
const advanced = await post("Next Candle 5m", "/api/market", {
  action: "advance",
  token: session.token,
  minutes: 5,
  timeframe: "5m",
  start: session.currentTime - 20 * 24 * 60 * 60,
});
const price = advanced.candles.at(-1)?.close;
if (!Number.isFinite(price)) throw new Error("Next Candle returned no closing price.");
await post("Submit Trade", "/api/market", {
  action: "submit",
  token: session.token,
  plan: { direction: "LONG", lotSize: 0.01, entry: price, stopLoss: price - 10, takeProfit: price + 20 },
});
await post("Replay step 5m", "/api/market", {
  action: "chunk",
  token: session.token,
  minutes: 5,
});
await post("Next Question", "/api/market", { action: "new" });

console.log(JSON.stringify({
  status: "PASS",
  apiCount: measurements.reduce((sum, row) => sum + row.apiCount, 0),
  measurements,
}, null, 2));
