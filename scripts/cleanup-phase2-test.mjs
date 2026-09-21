import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 8, prepare: false });
try {
  const targets = await sql`select id from auth.users where email like ${"phase2-e2e-%@example.com"}`;
  console.log(JSON.stringify({ temporaryTargets: targets.length }));
  for (const { id } of targets) {
    await sql.begin(async (tx) => {
      await tx`set local statement_timeout = '8s'`;
      await tx`delete from public.trades where session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
      console.log("temporary trades removed");
      await tx`update public.sessions set current_training_session_id=null where user_id=${id}::uuid`;
      console.log("temporary current child detached");
      await tx`delete from public.training_sessions where product_session_id in (select session_id from public.sessions where user_id=${id}::uuid)`;
      console.log("temporary child sessions removed");
      await tx`delete from public.sessions where user_id=${id}::uuid`;
      console.log("temporary product sessions removed");
      await tx`delete from public.users where user_id=${id}::uuid`;
      console.log("temporary profile removed");
    });
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Temporary Auth cleanup failed: ${response.status}`);
    console.log("temporary Auth account removed");
  }
} finally {
  await sql.end({ timeout: 2 });
}
