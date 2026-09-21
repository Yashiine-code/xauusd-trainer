// Disposable cross-user acceptance test. Test accounts and their records are removed afterward.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const base = process.env.PHASE2_TEST_BASE_URL ?? "http://localhost:5173";
const authBase = `${process.env.SUPABASE_URL}/auth/v1`;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
const accounts = [];
let step = "setup";

async function admin(method, path, body) {
  const response = await fetch(`${authBase}/admin/${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Auth admin ${method} ${response.status}`);
  return response.json().catch(() => ({}));
}
async function api(path, body, cookie = "") {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})), cookies: response.headers.getSetCookie() };
}
async function ok(path, body, cookie) {
  const result = await api(path, body, cookie);
  assert.equal(result.status, 200, `${step}: ${path} ${result.status} ${JSON.stringify(result.payload)}`);
  return result.payload;
}
async function account() {
  const email = `phase2-e2e-${randomUUID()}@example.com`;
  const password = `${randomBytes(24).toString("base64url")}aA1!`;
  const created = await admin("POST", "users", { email, password, email_confirm: true });
  const item = { id: created.id, email, cookie: "" };
  accounts.push(item);
  const login = await api("/api/auth", { action: "signin", email, password });
  assert.equal(login.status, 200);
  item.cookie = login.cookies.map((header) => header.split(";")[0]).join("; ");
  assert.equal((await sql`select access_status from public.users where user_id=${item.id}::uuid`)[0].access_status, "active");
  return item;
}
function denied(result, marker) {
  assert.ok([403, 404].includes(result.status), `${step}: expected 403/404, received ${result.status}`);
  assert.ok(!JSON.stringify(result.payload).includes(marker), `${step}: cross-user trade leaked`);
  console.log(JSON.stringify({ step, status: result.status, leaked: false }));
}

try {
  const a = await account();
  const b = await account();
  step = "User B creates trade";
  const session = await ok("/api/sessions", { sessionMode: "CHALLENGE", startingBalance: 10000 }, b.cookie);
  const question = await ok("/api/market", { action: "new", sessionMode: "CHALLENGE", productSessionId: session.sessionId }, b.cookie);
  const started = await ok("/api/sessions/events", { sessionId: session.sessionId, expectedVersion: question.productVersion, event: { type: "START", timestamp: question.currentTime } }, b.cookie);
  const candles = await ok("/api/candles", { token: question.token, questionId: question.questionId, timeframe: "1m", start: question.currentTime - 120, end: question.currentTime }, b.cookie);
  const price = candles.candles.at(-1).close;
  const position = { direction: "LONG", lotSize: 0.01, entryPrice: price, stopLoss: price - 10, takeProfit: price + 10,
    openedAt: question.currentTime, usedMargin: price * 0.01 * 100 / 2000, maxHigh: price, minLow: price };
  await ok("/api/market", { action: "challenge-open", token: question.token, currentTime: question.currentTime }, b.cookie);
  const opened = await ok("/api/sessions/events", { sessionId: session.sessionId, expectedVersion: started.version, event: { type: "OPEN_POSITION", position } }, b.cookie);
  await ok("/api/sessions/settle", { sessionId: session.sessionId, trainingSessionId: question.token,
    expectedVersion: opened.version, operationId: randomUUID(), closedAt: question.currentTime, exitReason: "MANUAL_CLOSE" }, b.cookie);
  const trade = (await sql`select trade_id from public.trades where session_id=${session.sessionId}::uuid`)[0];
  assert.ok(trade?.trade_id);
  const marker = String(trade.trade_id);
  step = "User B reads own trade";
  const own = await ok("/api/sessions/resume", { sessionId: session.sessionId }, b.cookie);
  assert.equal(own.product.trades.length, 1);
  assert.equal(own.sessionId, session.sessionId);
  console.log(JSON.stringify({ step, status: "PASS", tradeCount: 1 }));

  step = "User A normal API request for B session/trade";
  denied(await api("/api/sessions/resume", { sessionId: session.sessionId }, a.cookie), marker);
  step = "User A substitutes B trade id";
  denied(await api("/api/sessions/settle", { sessionId: session.sessionId, trainingSessionId: question.token,
    tradeId: marker, expectedVersion: opened.version, operationId: randomUUID(), closedAt: question.currentTime }, a.cookie), marker);
  step = "User A substitutes B session id";
  denied(await api("/api/sessions/events", { sessionId: session.sessionId, expectedVersion: opened.version, event: { type: "END" } }, a.cookie), marker);
  step = "User A substitutes B training_session id";
  denied(await api("/api/market", { action: "advance", token: question.token, minutes: 5, timeframe: "5m", start: question.currentTime - 86400 }, a.cookie), marker);
  const aSession = await ok("/api/sessions", { sessionMode: "CHALLENGE", startingBalance: 10000 }, a.cookie);
  step = "User A mixes own session and B training_session id";
  denied(await api("/api/sessions/settle", { sessionId: aSession.sessionId, trainingSessionId: question.token,
    expectedVersion: aSession.version, operationId: randomUUID(), closedAt: question.currentTime }, a.cookie), marker);
  console.log("PHASE2_CROSS_USER_TRADE_ACCESS_PASS");
} catch (error) {
  console.error(JSON.stringify({ status: "PHASE2_CROSS_USER_TRADE_ACCESS_FAIL", step, detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
  for (const item of accounts.reverse()) {
    const cleanup = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
    try {
      await cleanup.begin(async (tx) => {
        await tx`set local statement_timeout = '8s'`;
        await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${item.id}::uuid)`;
        await tx`update public.sessions set current_training_session_id=null where user_id=${item.id}::uuid`;
        await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${item.id}::uuid)`;
        await tx`delete from public.sessions where user_id=${item.id}::uuid`;
        await tx`delete from public.users where user_id=${item.id}::uuid`;
      });
      await admin("DELETE", `users/${item.id}`);
      console.log("ACCESS_TEST_ACCOUNT_CLEANUP_PASS");
    } catch (error) {
      console.error(`ACCESS_TEST_ACCOUNT_CLEANUP_FAIL ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    } finally { await cleanup.end({ timeout: 2 }); }
  }
}
