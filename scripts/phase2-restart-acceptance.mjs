import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import postgres from "postgres";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = "http://localhost:5173";
const email = `phase2-e2e-${randomUUID()}@example.com`;
const password = `${randomBytes(24).toString("base64url")}aA1!`;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
let id, cookie = "";

async function admin(path, method, body) {
  const response = await fetch(`${url}/auth/v1/admin/${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Auth admin ${method} failed: ${response.status}`);
  return response.json().catch(() => ({}));
}
async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${path}: ${response.status} ${JSON.stringify(payload)}`);
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
  return payload;
}

try {
  id = (await admin("users", "POST", { email, password, email_confirm: true })).id;
  await api("/api/auth", { action: "signin", email, password });
  assert.equal((await sql`select access_status from public.users where user_id=${id}::uuid`)[0].access_status, "active");
  const product = await api("/api/sessions", { sessionMode: "RISK_TRAINING", startingBalance: 10000, riskPercent: 0.01 });
  const question = await api("/api/market", { action: "new", sessionMode: "RISK_TRAINING", productSessionId: product.sessionId });
  const original = await api("/api/sessions/resume", { sessionId: product.sessionId });
  assert.equal(original.market.token, question.token);
  console.log("RESTART_CHECKPOINT_READY");
  process.stdin.resume();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Restart confirmation timed out")), 180000);
    process.stdin.once("data", () => { clearTimeout(timeout); resolve(); });
  });
  process.stdin.pause();
  assert.equal((await fetch(base, { signal: AbortSignal.timeout(15000) })).status, 200);
  const restored = await api("/api/sessions/resume", { sessionId: product.sessionId });
  assert.equal(restored.market.token, question.token);
  assert.equal(restored.sessionId, product.sessionId);
  assert.equal(restored.version, original.version);
  assert.equal(restored.product.balance, original.product.balance);
  assert.equal(restored.market.runtimeMode, original.market.runtimeMode);
  console.log("RESTART_RESUME_PASS");
} catch (error) {
  console.log(JSON.stringify({ status: "RESTART_RESUME_FAIL", detail: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
  if (id) {
    const cleanup = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
    try {
      await cleanup.begin(async (tx) => {
        await tx`set local statement_timeout = '8s'`;
        await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
        await tx`update public.sessions set current_training_session_id=null where user_id=${id}::uuid`;
        await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
        await tx`delete from public.sessions where user_id=${id}::uuid`;
        await tx`delete from public.users where user_id=${id}::uuid`;
      });
      await admin(`users/${id}`, "DELETE");
      console.log("RESTART_TEST_CLEANUP_PASS");
    } catch (error) { console.log(JSON.stringify({ status: "RESTART_TEST_CLEANUP_FAIL", detail: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
    finally { await cleanup.end({ timeout: 2 }); }
  }
}
