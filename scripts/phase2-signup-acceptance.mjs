// Exactly one public signup attempt; never repeatedly trigger mail delivery.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const email = `phase2-e2e-${randomUUID()}@example.com`;
const password = `${randomBytes(24).toString("base64url")}aA1!`;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 8, prepare: false });
let id;
async function api(body, cookie = "") {
  const response = await fetch("http://localhost:5173/api/auth", {
    method: body ? "POST" : "GET", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, payload: await response.json().catch(() => ({})), cookies: response.headers.getSetCookie() };
}
async function admin(method, path, body) {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `Auth admin ${method} ${response.status}`);
  return response.json().catch(() => ({}));
}
try {
  const signup = await api({ action: "signup", email, password });
  if (signup.status === 429) {
    console.log(JSON.stringify({ signup: "EXTERNAL_MAIL_RATE_LIMIT", status: 429, attempts: 1 }));
    process.exitCode = 2;
  } else {
    assert.equal(signup.status, 200, `Signup ${signup.status}`);
    assert.equal(signup.payload.needsConfirmation, true);
    const rows = await sql`select id from auth.users where email=${email}`;
    id = rows[0]?.id;
    assert.ok(id);
    const beforeConfirmation = await api({ action: "signin", email, password });
    assert.equal(beforeConfirmation.status, 401);
    await admin("PUT", `/${id}`, { email_confirm: true });
    const login = await api({ action: "signin", email, password });
    assert.equal(login.status, 200);
    assert.equal(login.payload.accessStatus, "active");
    const cookie = login.cookies.map((header) => header.split(";")[0]).join("; ");
    assert.equal((await api(undefined, cookie)).status, 200);
    await sql`update public.users set access_status=${"suspended"}::access_status where user_id=${id}::uuid`;
    assert.equal((await api(undefined, cookie)).payload.accessStatus, "suspended");
    const logout = await api({ action: "signout" }, cookie);
    assert.equal(logout.status, 200);
    console.log(JSON.stringify({ signup: "PASS", confirmation: "PASS_ADMIN_CONFIRMED", login: "PASS", persistentLogin: "PASS", suspended: "PASS", logout: "PASS", signupRequests: 1 }));
  }
} catch (error) {
  console.error(JSON.stringify({ signup: "FAIL", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  if (id) {
    try {
      await sql`delete from public.users where user_id=${id}::uuid`;
      await admin("DELETE", `/${id}`);
      console.log("SIGNUP_TEST_ACCOUNT_CLEANUP_PASS");
    } catch (error) {
      console.error(`SIGNUP_TEST_ACCOUNT_CLEANUP_FAIL ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  await sql.end({ timeout: 2 });
}
