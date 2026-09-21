// Create/clean one disposable active UI-test account; never use a real user.
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const base = `${process.env.SUPABASE_URL}/auth/v1/admin/users`;
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 8, idle_timeout: 5 });
async function admin(method, path, body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Auth admin ${method} ${response.status}`);
  return response.json().catch(() => ({}));
}
try {
  if (process.argv[2] === "create") {
    const email = `phase2-e2e-${randomUUID()}@example.com`;
    const password = `${randomBytes(24).toString("base64url")}aA1!`;
    const { id } = await admin("POST", "", { email, password, email_confirm: true });
    await sql`insert into public.users (user_id) values (${id}::uuid) on conflict (user_id) do nothing`;
    console.log(JSON.stringify({ id, email, password }));
  } else if (process.argv[2] === "cleanup" && /^[0-9a-f-]{36}$/.test(process.argv[3] ?? "")) {
    const id = process.argv[3];
    const rows = await sql`select email from auth.users where id=${id}::uuid`;
    if (!rows[0]?.email?.startsWith("phase2-e2e-") || !rows[0].email.endsWith("@example.com")) throw new Error("Not a disposable test account.");
    await sql.begin(async (tx) => {
      await tx`set local statement_timeout = '8s'`;
      await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
      await tx`update public.sessions set current_training_session_id=null where user_id=${id}::uuid`;
      await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
      await tx`delete from public.sessions where user_id=${id}::uuid`;
      await tx`delete from public.users where user_id=${id}::uuid`;
    });
    await admin("DELETE", `/${id}`);
    console.log("BROWSER_FIXTURE_CLEANUP_PASS");
  } else throw new Error("Usage: create | cleanup <test user UUID>");
} finally { await sql.end({ timeout: 2 }); }
