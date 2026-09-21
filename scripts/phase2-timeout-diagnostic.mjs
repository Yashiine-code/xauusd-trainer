// Narrow diagnostic: at most 3 resume, 3 Risk settlements, 3 Challenge-position restores.
// Setup calls create disposable state; they are not repeated performance tests.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const base = process.env.PHASE2_TEST_BASE_URL ?? "http://localhost:5173";
const supabase = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
const email = `phase2-e2e-${randomUUID()}@example.com`;
const password = `${randomBytes(24).toString("base64url")}aA1!`;
let userId;
let cookie = "";
let setupStep = "account";
const counts = { resume: 0, riskSettlement: 0, challengeRestore: 0 };

async function admin(method, path, body) {
  const response = await fetch(`${supabase}/auth/v1/admin/users${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Auth fixture ${method} ${response.status}`);
  return response.json().catch(() => ({}));
}
async function api(path, body, timeoutMs = 65000) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
  return { status: response.status, data, wallMs: Math.round(performance.now() - started) };
}
async function setup(path, body) {
  const response = await api(path, body, 30000);
  assert.equal(response.status, 200, `${setupStep} ${path} ${response.status}`);
  return response.data;
}
function sqlLabel(query) {
  const text = query.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ");
  if (text.includes("insert into trades")) return "TRADE_INSERT";
  if (text.includes("update training_sessions")) return "TRAINING_SESSION_UPDATE";
  if (text.includes("update sessions")) return "PRODUCT_SESSION_UPDATE";
  if (text.includes("from trades")) return "TRADE_READ";
  if (text.includes("from training_sessions")) return "TRAINING_SESSION_READ";
  if (text.includes("from sessions")) return "PRODUCT_SESSION_READ";
  if (text.startsWith("commit")) return "COMMIT";
  return null;
}
async function stats() {
  const rows = await db`select queryid::text as id, calls::bigint as calls, total_exec_time, query
    from pg_stat_statements where query ilike ${"%sessions%"} or query ilike ${"%trades%"} or query = ${"COMMIT"}`;
  return new Map(rows.filter((row) => sqlLabel(row.query)).map((row) => [row.id, {
    label: sqlLabel(row.query), calls: Number(row.calls), totalMs: Number(row.total_exec_time),
  }]));
}
function sqlDelta(before, after) {
  const grouped = new Map();
  for (const [id, current] of after) {
    const previous = before.get(id);
    const calls = current.calls - (previous?.calls ?? 0);
    if (calls <= 0) continue;
    const value = grouped.get(current.label) ?? { calls: 0, execMs: 0 };
    value.calls += calls;
    value.execMs += current.totalMs - (previous?.totalMs ?? 0);
    grouped.set(current.label, value);
  }
  return Object.fromEntries([...grouped].map(([label, value]) => [label, { calls: value.calls, serverExecMs: Number(value.execMs.toFixed(2)) }]));
}
async function probe(kind, path, body) {
  counts[kind]++;
  const before = await stats();
  const started = performance.now();
  let outcome;
  try { outcome = await api(path, body); }
  catch (error) { outcome = { status: "TIMEOUT_OR_NETWORK", wallMs: Math.round(performance.now() - started), code: error?.code ?? error?.name ?? "unknown" }; }
  const after = await stats();
  console.log(JSON.stringify({ probe: kind, number: counts[kind], status: outcome.status,
    clientWallMs: outcome.wallMs, code: outcome.code ?? null, serverSql: sqlDelta(before, after) }));
  if (outcome.status !== 200) throw new Error(`${kind} abnormal; stopping after first failure`);
  return outcome.data;
}
async function prepareRisk() {
  setupStep = "Risk product";
  const product = await setup("/api/sessions", { sessionMode: "RISK_TRAINING", startingBalance: 10000, riskPercent: 0.01 });
  setupStep = "Risk question";
  const question = await setup("/api/market", { action: "new", sessionMode: "RISK_TRAINING", productSessionId: product.sessionId });
  setupStep = "Risk buffer";
  const future = await setup("/api/market", { action: "buffer", token: question.token, minutes: 120 });
  assert.ok(future.candles.length);
  const entry = future.candles[0].open;
  const plan = { direction: "LONG", lotSize: 0.01, entry, stopLoss: entry - 0.01, takeProfit: entry + 0.01 };
  setupStep = "Risk submit";
  await setup("/api/market", { action: "submit", token: question.token, currentTime: question.currentTime, plan });
  setupStep = "Risk phase";
  const submitted = await setup("/api/sessions/events", { sessionId: product.sessionId, expectedVersion: question.productVersion, event: { type: "SUBMIT_TRADE", plan } });
  const replay = await setup("/api/sessions/events", { sessionId: product.sessionId, expectedVersion: submitted.version, event: { type: "REPLAY_READY" } });
  setupStep = "Risk result";
  const result = await setup("/api/market", { action: "reveal-result", token: question.token, minutes: 120 });
  assert.equal(result.revealed, true);
  return { sessionId: product.sessionId, trainingSessionId: question.token, expectedVersion: replay.version, operationId: randomUUID() };
}
async function prepareChallenge() {
  setupStep = "Challenge product";
  const product = await setup("/api/sessions", { sessionMode: "CHALLENGE", startingBalance: 10000 });
  setupStep = "Challenge question";
  const question = await setup("/api/market", { action: "new", sessionMode: "CHALLENGE", productSessionId: product.sessionId });
  const started = await setup("/api/sessions/events", { sessionId: product.sessionId, expectedVersion: question.productVersion, event: { type: "START", timestamp: question.currentTime } });
  const candles = await setup("/api/candles", { token: question.token, questionId: question.questionId, timeframe: "1m", start: question.currentTime - 120, end: question.currentTime });
  assert.ok(candles.candles.length);
  const price = candles.candles.at(-1).close;
  const position = { direction: "LONG", lotSize: 0.01, entryPrice: price, stopLoss: price - 10, takeProfit: price + 10,
    openedAt: question.currentTime, usedMargin: price * 0.01 * 100 / 2000, maxHigh: price, minLow: price };
  setupStep = "Challenge position";
  await setup("/api/market", { action: "challenge-open", token: question.token, currentTime: question.currentTime });
  await setup("/api/sessions/events", { sessionId: product.sessionId, expectedVersion: started.version, event: { type: "OPEN_POSITION", position } });
  return product.sessionId;
}

try {
  userId = (await admin("POST", "", { email, password, email_confirm: true })).id;
  const login = await api("/api/auth", { action: "signin", email, password });
  assert.equal(login.status, 200);
  assert.equal(login.data.accessStatus, "active");
  const firstRisk = await prepareRisk();
  for (let index = 0; index < 3; index++) await probe("resume", "/api/sessions/resume", { sessionId: firstRisk.sessionId });
  await probe("riskSettlement", "/api/sessions/settle", firstRisk);
  for (let index = 1; index < 3; index++) await probe("riskSettlement", "/api/sessions/settle", await prepareRisk());
  const challengeSessionId = await prepareChallenge();
  for (let index = 0; index < 3; index++) await probe("challengeRestore", "/api/sessions/resume", { sessionId: challengeSessionId });
  console.log(JSON.stringify({ diagnostic: "COMPLETE", counts }));
} catch (error) {
  console.error(JSON.stringify({ diagnostic: "STOPPED", setupStep, counts, cause: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 2 });
  if (userId) {
    const cleanup = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 8, prepare: false });
    try {
      await cleanup.begin(async (tx) => {
        await tx`set local statement_timeout = '8s'`;
        await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${userId}::uuid)`;
        await tx`update public.sessions set current_training_session_id=null where user_id=${userId}::uuid`;
        await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${userId}::uuid)`;
        await tx`delete from public.sessions where user_id=${userId}::uuid`;
        await tx`delete from public.users where user_id=${userId}::uuid`;
      });
      await admin("DELETE", `/${userId}`);
      console.log("DIAGNOSTIC_FIXTURE_CLEANUP_PASS");
    } catch (error) {
      console.error(`DIAGNOSTIC_FIXTURE_CLEANUP_FAIL ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally { await cleanup.end({ timeout: 2 }); }
  }
}
