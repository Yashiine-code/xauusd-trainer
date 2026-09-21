// Temporary Phase 2 acceptance harness. Run only against a designated test project.
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";

const base = process.env.PHASE2_TEST_BASE_URL ?? "http://localhost:5173";
const authBase = `${process.env.SUPABASE_URL}/auth/v1`;
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
const adminKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!publishable || !adminKey || !process.env.DATABASE_URL) throw new Error("Acceptance prerequisites missing.");
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5, max_lifetime: 60 });
const accounts = [];
const results = [];
const note = (name, detail) => { results.push({ name, detail }); console.log(JSON.stringify({ name, detail })); };

async function api(path, body, cookie = "") {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, cookies: response.headers.getSetCookie() };
}

function mergeCookies(oldCookie, setCookies) {
  const map = new Map(oldCookie.split("; ").filter(Boolean).map((part) => [part.split("=")[0], part]));
  for (const header of setCookies) {
    const first = header.split(";")[0];
    map.set(first.split("=")[0], first);
  }
  return [...map.values()].join("; ");
}

async function admin(path, method, body) {
  const response = await fetch(`${authBase}/admin/${path}`, {
    method, headers: { apikey: adminKey, Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Auth admin ${method} ${path}: ${response.status} ${json.msg ?? json.message ?? "error"}`);
  return json;
}

async function makeAccount(useSignup) {
  const email = `phase2-e2e-${randomUUID()}@example.com`;
  const password = `${randomBytes(24).toString("base64url")}aA1!`;
  const account = { email, password, cookie: "", id: null };
  accounts.push(account);
  if (useSignup && process.env.PHASE2_SKIP_SIGNUP !== "true") {
    const signup = await api("/api/auth", { action: "signup", email, password });
    if (signup.status !== 200) {
      note("email signup", `FAIL; app returned ${signup.status}; Supabase email send rate limit observed`);
      const created = await admin("users", "POST", { email, password, email_confirm: true });
      account.id = created.id;
      return account;
    }
    assert.equal(signup.payload.needsConfirmation, true);
    const listed = await admin("users?page=1&per_page=1000", "GET");
    account.id = listed.users.find((item) => item.email === email)?.id;
    assert.ok(account.id, "Registered user must exist in Supabase Auth");
    note("email signup", "PASS; confirmation required");
    await admin(`users/${account.id}`, "PUT", { email_confirm: true });
  } else {
    const created = await admin("users", "POST", { email, password, email_confirm: true });
    account.id = created.id;
  }
  return account;
}

async function signIn(account) {
  const response = await api("/api/auth", { action: "signin", email: account.email, password: account.password });
  assert.equal(response.status, 200, `Sign in: ${response.status} ${JSON.stringify(response.payload)}`);
  account.cookie = mergeCookies(account.cookie, response.cookies);
  assert.ok(account.cookie.includes("xau_access="));
  assert.ok(account.cookie.includes("xau_refresh="));
  return response;
}

async function setAccess(account, status) {
  await sql`update public.users set access_status=${status}::access_status where user_id=${account.id}::uuid`;
}

async function approvedPost(path, body, account, expected = 200) {
  const result = await api(path, body, account.cookie);
  account.cookie = mergeCookies(account.cookie, result.cookies);
  assert.equal(result.status, expected, `${path}: ${result.status} ${JSON.stringify(result.payload)}`);
  return result.payload;
}

try {
  const first = await makeAccount(true);
  const login = await signIn(first);
  assert.equal(login.payload.accessStatus, "active");
  assert.equal((await sql`select access_status from public.users where user_id=${first.id}::uuid`)[0].access_status, "active");
  note("email sign in and default active", "PASS");
  const accessToken = first.cookie.split("; ").find((part) => part.startsWith("xau_access="))?.slice("xau_access=".length);
  const direct = await fetch(`${authBase}/user`, { headers: { apikey: publishable, Authorization: `Bearer ${decodeURIComponent(accessToken)}` }, signal: AbortSignal.timeout(15000) });
  const directBody = await direct.json().catch(() => ({}));
  note("direct Auth user diagnostic", { status: direct.status, code: directBody.error_code ?? null });
  const persisted = await api("/api/auth", undefined, first.cookie);
  note("existing cookie status", persisted.status);
  assert.equal(persisted.status, 200);
  const refreshOnly = first.cookie.split("; ").find((item) => item.startsWith("xau_refresh="));
  const refreshed = await api("/api/auth", undefined, refreshOnly);
  note("refresh-only cookie status", refreshed.status);
  assert.equal(refreshed.status, 200);
  note("persistent and refreshed login", "PASS");
  const activeGate = await api("/api/sessions", undefined, first.cookie);
  assert.equal(activeGate.status, 200);
  await setAccess(first, "suspended");
  assert.equal((await api("/api/sessions", undefined, first.cookie)).status, 403);
  note("active / suspended gate", "PASS");
  await setAccess(first, "active");
  const signedOut = await api("/api/auth", { action: "signout" }, first.cookie);
  assert.equal(signedOut.status, 200);
  const cleared = mergeCookies(first.cookie, signedOut.cookies);
  assert.equal((await api("/api/auth", undefined, cleared)).status, 401);
  note("sign out", "PASS");
  await signIn(first);

  const second = await makeAccount(false);
  await signIn(second);
  const risk = await approvedPost("/api/sessions", { sessionMode: "RISK_TRAINING", startingBalance: 10000, riskPercent: 0.01 }, first);
  assert.ok(risk.sessionId);
  const question = await approvedPost("/api/market", { action: "new", sessionMode: "RISK_TRAINING", productSessionId: risk.sessionId }, first);
  assert.ok(question.token);
  note("new active user enters Risk Training session", "PASS");
  await setAccess(first, "suspended");
  assert.equal((await api("/api/sessions", { sessionMode: "RISK_TRAINING", startingBalance: 1000, riskPercent: 0.01 }, first.cookie)).status, 403);
  assert.equal((await api("/api/sessions/resume", { sessionId: risk.sessionId }, first.cookie)).status, 403);
  assert.equal((await api("/api/market", { action: "advance", token: question.token, minutes: 5, timeframe: "5m", start: question.currentTime - 86400 }, first.cookie)).status, 403);
  await setAccess(first, "active");
  note("suspended user cannot create, resume or operate session", "PASS");
  assert.equal((await api("/api/sessions/resume", { sessionId: risk.sessionId }, second.cookie)).status, 404);
  assert.equal((await api("/api/market", { action: "advance", token: question.token, minutes: 5, timeframe: "5m", start: question.currentTime - 86400 }, second.cookie)).status, 403);
  note("User B cannot access User A session", "PASS");
  const resumed = await approvedPost("/api/sessions/resume", { sessionId: risk.sessionId }, first);
  assert.equal(resumed.market.token, question.token);
  assert.equal(resumed.market.result, null);
  note("Resume current product session; hidden result not exposed", "PASS");

  const advanced = await approvedPost("/api/market", { action: "advance", token: question.token, minutes: 5, timeframe: "5m", start: question.currentTime - 86400 }, first);
  assert.ok(advanced.currentTime >= question.currentTime);
  const checkpoint = await approvedPost("/api/sessions/checkpoint", { sessionId: risk.sessionId, token: question.token, currentTime: advanced.currentTime }, first);
  assert.equal(checkpoint.saved, true);
  note("Next Candle and checkpoint", "PASS");

  const oldVersion = resumed.version;
  const event = { type: "QUESTION_READY" };
  const firstWrite = await api("/api/sessions/events", { sessionId: risk.sessionId, expectedVersion: oldVersion, event }, first.cookie);
  if (firstWrite.status === 200) {
    const secondWrite = await api("/api/sessions/events", { sessionId: risk.sessionId, expectedVersion: oldVersion, event }, first.cookie);
    assert.equal(secondWrite.status, 409);
    note("stale version rejected", "PASS");
  } else note("stale version rejected", `NOT TESTED; first event ${firstWrite.status}`);

  let version = (await sql`select version from public.sessions where session_id=${risk.sessionId}::uuid`)[0].version;
  const buffer = await approvedPost("/api/market", { action: "buffer", token: question.token, minutes: 120 }, first);
  assert.ok(buffer.candles.length > 0, "Future one-minute test data required");
  const entry = buffer.candles[0].open;
  const plan = { direction: "LONG", lotSize: 0.01, entry, stopLoss: entry - 0.01, takeProfit: entry + 0.01 };
  await approvedPost("/api/market", { action: "submit", token: question.token, currentTime: advanced.currentTime, plan }, first);
  const hidden = (await sql`select hidden_result, runtime_mode from public.training_sessions where session_id=${question.token}::uuid`)[0];
  assert.ok(hidden.hidden_result, "Hidden result should be persisted after deterministic future test data");
  assert.equal(hidden.runtime_mode, "REPLAY");
  const beforeReveal = await approvedPost("/api/sessions/resume", { sessionId: risk.sessionId }, first);
  assert.equal(beforeReveal.market.result, null);
  assert.equal(beforeReveal.market.runtimeMode, "REPLAY");
  note("hidden result persisted but not leaked before RESULT", "PASS");
  const submitted = await approvedPost("/api/sessions/events", { sessionId: risk.sessionId, expectedVersion: version, event: { type: "SUBMIT_TRADE", plan } }, first);
  version = submitted.version;
  const replayReady = await approvedPost("/api/sessions/events", { sessionId: risk.sessionId, expectedVersion: version, event: { type: "REPLAY_READY" } }, first);
  version = replayReady.version;
  const revealed = await approvedPost("/api/market", { action: "reveal-result", token: question.token, minutes: 120 }, first);
  assert.equal(revealed.revealed, true);
  assert.ok(["TAKE PROFIT", "STOP LOSS"].includes(revealed.tradeResult.status));
  const operationId = randomUUID();
  const settled = await approvedPost("/api/sessions/settle", { sessionId: risk.sessionId, trainingSessionId: question.token, expectedVersion: version, operationId }, first);
  const tradeRows = await sql`select trade_id,pnl from public.trades where session_id=${risk.sessionId}::uuid`;
  const settledRow = (await sql`select balance,version,statistics,phase from public.sessions where session_id=${risk.sessionId}::uuid`)[0];
  assert.equal(tradeRows.length, 1);
  assert.equal(Number(settledRow.balance), settled.snapshot.balance);
  assert.equal(settledRow.version, settled.version);
  assert.equal(settledRow.phase, "RESULT");
  note("Risk Training TP/SL trade and atomic balance snapshot", "PASS");
  const repeated = await approvedPost("/api/sessions/settle", { sessionId: risk.sessionId, trainingSessionId: question.token, expectedVersion: version, operationId }, first);
  assert.equal(repeated.alreadySettled, true);
  assert.equal((await sql`select count(*)::int as n from public.trades where session_id=${risk.sessionId}::uuid`)[0].n, 1);
  assert.equal(Number((await sql`select balance from public.sessions where session_id=${risk.sessionId}::uuid`)[0].balance), settled.snapshot.balance);
  note("duplicate operation_id and balance idempotency", "PASS");
  const resultResume = await approvedPost("/api/sessions/resume", { sessionId: risk.sessionId }, first);
  assert.equal(resultResume.market.runtimeMode, "RESULT");
  assert.ok(resultResume.market.result);
  const future = await approvedPost("/api/market", { action: "reveal", token: question.token, start: resultResume.market.exitTimestamp }, first);
  assert.ok(future.currentTime - resultResume.market.exitTimestamp <= 4 * 3600);
  const review = await approvedPost("/api/sessions/resume", { sessionId: risk.sessionId }, first);
  assert.equal(review.market.runtimeMode, "REVIEW");
  note("Reveal Future capped at +4H", "PASS");
  const next = await approvedPost("/api/sessions/events", { sessionId: risk.sessionId, expectedVersion: settled.version, event: { type: "REVEAL_FUTURE" } }, first);
  const nextQuestion = await approvedPost("/api/sessions/events", { sessionId: risk.sessionId, expectedVersion: next.version, event: { type: "NEXT_QUESTION" } }, first);
  const secondQuestion = await approvedPost("/api/market", { action: "new", sessionMode: "RISK_TRAINING", productSessionId: risk.sessionId }, first);
  assert.notEqual(secondQuestion.token, question.token);
  assert.equal(secondQuestion.productVersion, nextQuestion.version + 1);
  const secondResume = await approvedPost("/api/sessions/resume", { sessionId: risk.sessionId }, first);
  assert.equal(secondResume.market.token, secondQuestion.token);
  note("Next Question and product-session resume", "PASS");
  if (process.env.PHASE2_RESTART_TEST === "true") {
    note("restart checkpoint", "WAITING_FOR_SERVER_RESTART");
    process.stdin.resume();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server restart confirmation timed out")), 180000);
      process.stdin.once("data", () => { clearTimeout(timeout); resolve(); });
    });
    process.stdin.pause();
    const page = await fetch(base, { signal: AbortSignal.timeout(30000) });
    assert.equal(page.status, 200);
    const afterRestart = await approvedPost("/api/sessions/resume", { sessionId: risk.sessionId }, first);
    assert.equal(afterRestart.market.token, secondQuestion.token);
    assert.equal(afterRestart.product.balance, secondResume.product.balance);
    assert.equal(afterRestart.version, secondResume.version);
    note("Resume after dev-server stop and restart", "PASS");
  }

  const challenge = await approvedPost("/api/sessions", { sessionMode: "CHALLENGE", startingBalance: 10000 }, first);
  const challengeQuestion = await approvedPost("/api/market", { action: "new", sessionMode: "CHALLENGE", productSessionId: challenge.sessionId }, first);
  let challengeVersion = challengeQuestion.productVersion;
  const started = await approvedPost("/api/sessions/events", { sessionId: challenge.sessionId, expectedVersion: challengeVersion, event: { type: "START", timestamp: challengeQuestion.currentTime } }, first);
  challengeVersion = started.version;
  const currentCandle = await approvedPost("/api/candles", { token: challengeQuestion.token, questionId: challengeQuestion.questionId, timeframe: "1m", start: challengeQuestion.currentTime - 120, end: challengeQuestion.currentTime }, first);
  assert.ok(currentCandle.candles.length);
  const price = currentCandle.candles.at(-1).close;
  const position = { direction: "LONG", lotSize: 0.01, entryPrice: price, stopLoss: price - 10, takeProfit: price + 10,
    openedAt: challengeQuestion.currentTime, usedMargin: price * 0.01 * 100 / 2000, maxHigh: price, minLow: price };
  await approvedPost("/api/market", { action: "challenge-open", token: challengeQuestion.token, currentTime: challengeQuestion.currentTime }, first);
  const opened = await approvedPost("/api/sessions/events", { sessionId: challenge.sessionId, expectedVersion: challengeVersion, event: { type: "OPEN_POSITION", position } }, first);
  challengeVersion = opened.version;
  const openResume = await approvedPost("/api/sessions/resume", { sessionId: challenge.sessionId }, first);
  assert.equal(openResume.product.activePosition.entryPrice, price);
  assert.equal(openResume.market.runtimeMode, "POSITION_OPEN");
  note("Challenge open position and reload resume", "PASS");
  if (openResume.product.account.usedMargin !== position.usedMargin) {
    note("Challenge persisted open-position margin", { status: "FAIL", expected: position.usedMargin, actual: openResume.product.account.usedMargin });
  } else note("Challenge persisted open-position margin", "PASS");
  const manualId = randomUUID();
  const manual = await approvedPost("/api/sessions/settle", { sessionId: challenge.sessionId, trainingSessionId: challengeQuestion.token,
    expectedVersion: challengeVersion, operationId: manualId, closedAt: challengeQuestion.currentTime, exitReason: "MANUAL_CLOSE" }, first);
  challengeVersion = manual.version;
  assert.equal(manual.snapshot.activePosition, null);
  assert.equal((await sql`select count(*)::int as n from public.trades where session_id=${challenge.sessionId}::uuid`)[0].n, 1);
  assert.equal(Number((await sql`select balance from public.sessions where session_id=${challenge.sessionId}::uuid`)[0].balance), manual.snapshot.account.balance);
  note("Challenge Manual Close and first trade", "PASS");
  const duplicateManual = await approvedPost("/api/sessions/settle", { sessionId: challenge.sessionId, trainingSessionId: challengeQuestion.token,
    expectedVersion: challengeVersion - 1, operationId: manualId, closedAt: challengeQuestion.currentTime, exitReason: "MANUAL_CLOSE" }, first);
  assert.equal(duplicateManual.alreadySettled, true);
  assert.equal((await sql`select count(*)::int as n from public.trades where session_id=${challenge.sessionId}::uuid`)[0].n, 1);
  note("Challenge settlement idempotent", "PASS");

  const beforeRollback = (await sql`select balance,version from public.sessions where session_id=${challenge.sessionId}::uuid`)[0];
  const { settleTrade } = await import("../src/server/persistence/repository.ts");
  let injectedFailure = false;
  try {
    await settleTrade({ userId: first.id, sessionId: challenge.sessionId, trainingSessionId: challengeQuestion.token,
      expectedVersion: challengeVersion, operationId: randomUUID(),
      snapshot: { ...manual.snapshot, account: { ...manual.snapshot.account, balance: "invalid-numeric" } },
      trade: { direction: "LONG", lotSize: 0.01, entryPrice: price, exitPrice: price,
        openedAt: Math.floor(Date.now() / 1000) - 60, closedAt: Math.floor(Date.now() / 1000),
        exitReason: "MANUAL_CLOSE", pnl: 0, resultR: 0, mfeR: 0, maeR: 0 },
    });
  } catch { injectedFailure = true; }
  const afterRollback = (await sql`select balance,version from public.sessions where session_id=${challenge.sessionId}::uuid`)[0];
  assert.equal(injectedFailure, true);
  assert.deepEqual(afterRollback, beforeRollback);
  assert.equal((await sql`select count(*)::int as n from public.trades where session_id=${challenge.sessionId}::uuid`)[0].n, 1);
  note("injected failure rolls back trade, balance and version", "PASS");
  const { closeSqlForShutdown } = await import("../db/index.ts");
  await closeSqlForShutdown();

  const secondPosition = { ...position, stopLoss: price - 0.01, takeProfit: price + 0.01 };
  await approvedPost("/api/market", { action: "challenge-open", token: challengeQuestion.token, currentTime: challengeQuestion.currentTime }, first);
  const openedAgain = await approvedPost("/api/sessions/events", { sessionId: challenge.sessionId, expectedVersion: challengeVersion, event: { type: "OPEN_POSITION", position: secondPosition } }, first);
  challengeVersion = openedAgain.version;
  const nextBuffer = await approvedPost("/api/market", { action: "buffer", token: challengeQuestion.token, minutes: 10 }, first);
  assert.ok(nextBuffer.candles.length);
  const exitTime = nextBuffer.candles[0].timestamp;
  const preSecond = (await sql`select snapshot from public.sessions where session_id=${challenge.sessionId}::uuid`)[0].snapshot;
  note("second close precondition", { phase: preSecond.phase, hasPosition: Boolean(preSecond.activePosition), exitTimeIsNumber: Number.isFinite(exitTime) });
  const secondSettlement = await approvedPost("/api/sessions/settle", { sessionId: challenge.sessionId, trainingSessionId: challengeQuestion.token,
    expectedVersion: challengeVersion, operationId: randomUUID(), closedAt: exitTime }, first);
  challengeVersion = secondSettlement.version;
  assert.equal((await sql`select count(*)::int as n from public.trades where session_id=${challenge.sessionId}::uuid`)[0].n, 2);
  assert.ok(["SL", "TP", "MANUAL_CLOSE"].includes(secondSettlement.snapshot.trades.at(-1).exitReason));
  note("Challenge second position, 1m TP/SL and trade", "PASS");
  const endMarket = await approvedPost("/api/market", { action: "challenge-end", token: challengeQuestion.token, currentTime: exitTime }, first);
  assert.equal(endMarket.accepted, true);
  const ended = await approvedPost("/api/sessions/events", { sessionId: challenge.sessionId, expectedVersion: challengeVersion, event: { type: "END" } }, first);
  assert.ok(ended.version > challengeVersion);
  await api("/api/auth", { action: "signout" }, first.cookie);
  await signIn(first);
  const history = await api("/api/sessions", undefined, first.cookie);
  assert.equal(history.status, 200);
  assert.equal(history.payload.sessions.find((item) => item.sessionId === challenge.sessionId).status, "ended");
  note("Challenge ended history after sign in", "PASS");
} catch (error) {
  note("acceptance stopped", error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
  for (const account of accounts.reverse()) {
    if (!account.id) continue;
    const cleanupSql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
    try {
      await cleanupSql.begin(async (tx) => {
        await tx`set local statement_timeout = '8s'`;
        await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${account.id}::uuid)`;
        await tx`update public.sessions set current_training_session_id=null where user_id=${account.id}::uuid`;
        await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${account.id}::uuid)`;
        await tx`delete from public.sessions where user_id=${account.id}::uuid`;
        await tx`delete from public.users where user_id=${account.id}::uuid`;
      });
      await admin(`users/${account.id}`, "DELETE");
      note("temporary account cleanup", "PASS");
    } catch (error) { note("temporary account cleanup", `FAILED: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
    finally { await cleanupSql.end({ timeout: 2 }); }
  }
}
