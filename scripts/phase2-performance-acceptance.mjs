import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";

const email = `phase2-e2e-${randomUUID()}@example.com`;
const password = `${randomBytes(24).toString("base64url")}aA1!`;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const url = process.env.SUPABASE_URL;
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 8, prepare: false, idle_timeout: 5 });
let id, cookie = "", sessionId, currentStep = "setup";
const metrics = [];
async function api(path, body) {
  const started = performance.now();
  const r = await fetch(`http://localhost:5173${path}`, {
    method: body ? "POST" : "GET",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  metrics.push({ path, status: r.status, duration: Math.round(performance.now() - started),
    adapterRequests: Number(r.headers.get("x-http-adapter-request-count") ?? 0) });
  assert.equal(r.status, 200, `${path}: ${r.status} ${JSON.stringify(data)}`);
  if (r.headers.getSetCookie().length) cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
  return data;
}
async function admin(method, path, body) {
  const r = await fetch(`${url}/auth/v1/admin/${path}`, { method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.ok(r.ok, `Auth admin ${method} ${r.status}`);
  return r.json().catch(() => ({}));
}
try {
  id = (await admin("POST", "users", { email, password, email_confirm: true })).id;
  await api("/api/auth", { action: "signin", email, password });
  assert.equal((await sql`select access_status from public.users where user_id=${id}::uuid`)[0].access_status, "active");
  sessionId = (await api("/api/sessions", { sessionMode: "RISK_TRAINING", startingBalance: 10000, riskPercent: 0.01 })).sessionId;
  const question = await api("/api/market", { action: "new", sessionMode: "RISK_TRAINING", productSessionId: sessionId });
  let now = question.currentTime;
  let totalAdvances = 0;
  await api("/api/market", { action: "buffer", token: question.token, minutes: 1440 });
  const selected = (process.env.PHASE2_PERF_TIMEFRAMES ?? "5m,15m,1H").split(",");
  for (const [timeframe, minutes] of [["5m", 5], ["15m", 15], ["1H", 60]].filter(([timeframe]) => selected.includes(String(timeframe)))) {
    if (timeframe === "1H") await api("/api/market", { action: "buffer", token: question.token, minutes: 1440 });
    const beforeClicks = (await sql`select ts.version as child_version,s.version as product_version from public.sessions s join public.training_sessions ts on ts.session_id=s.current_training_session_id where s.session_id=${sessionId}::uuid`)[0];
    for (let n = 0; n < 20; n++) {
      currentStep = `${timeframe} click ${n + 1}/20`;
      const result = await api("/api/market", { action: "advance", token: question.token,
        timeframe, minutes, start: now - 24 * 3600 });
      assert.ok(result.currentTime >= now);
      now = result.currentTime;
      totalAdvances++;
      if ((n + 1) % 5 === 0) console.log(JSON.stringify({ progress: currentStep }));
    }
    currentStep = `${timeframe} database write assertion`;
    const afterClicks = (await sql`select ts.version as child_version,s.version as product_version from public.sessions s join public.training_sessions ts on ts.session_id=s.current_training_session_id where s.session_id=${sessionId}::uuid`)[0];
    assert.deepEqual(afterClicks, beforeClicks, `Next Candle ${timeframe} must not write sessions`);
    console.log(JSON.stringify({ timeframe, clicks: 20, status: "PASS" }));
  }
  console.log(JSON.stringify({ nextCandleWrites: 0, advances: totalAdvances }));
  for (const timeframe of ["1H", "5m", "15m", "1m", "1H"]) {
    currentStep = `timeframe switch ${timeframe}`;
    const result = await api("/api/candles", { token: question.token, questionId: question.questionId,
      timeframe, start: now - 12 * 3600, end: now });
    assert.ok(Array.isArray(result.candles));
  }
  const worst = Math.max(...metrics.map((x) => x.duration));
  console.log(JSON.stringify({ timeframeSwitches: 5, requestCount: metrics.length,
    errors: metrics.filter((x) => x.status >= 400).length, worstLatencyMs: worst,
    maxAdapterRequestsPerCall: Math.max(...metrics.map((x) => x.adapterRequests)) }));
} catch (error) {
  console.log(JSON.stringify({ status: "PERFORMANCE_FAIL", step: currentStep, code: error?.code ?? null, detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
  if (id) {
    const cleanup = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 8, prepare: false, idle_timeout: 5 });
    try {
      await cleanup.begin(async (tx) => {
        await tx`set local statement_timeout = '8s'`;
        await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
        await tx`update public.sessions set current_training_session_id=null where user_id=${id}::uuid`;
        await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
        await tx`delete from public.sessions where user_id=${id}::uuid`;
        await tx`delete from public.users where user_id=${id}::uuid`;
      });
      await admin("DELETE", `users/${id}`);
      console.log("PERFORMANCE_TEST_CLEANUP_PASS");
    } catch (error) { console.log(JSON.stringify({ status: "PERFORMANCE_TEST_CLEANUP_FAIL", detail: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
    finally { await cleanup.end({ timeout: 2 }); }
  }
}
