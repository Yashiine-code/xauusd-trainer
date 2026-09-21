#!/usr/bin/env node
import postgres from "postgres";

const [baseUrl, userId, email, password] = process.argv.slice(2);
if (!baseUrl || !userId || !email || !password) throw new Error("Usage: <baseUrl> <userId> <email> <password>");
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, connect_timeout: 10 });
const productSessionId = crypto.randomUUID();
const trainingSessionId = crypto.randomUUID();
const tradeId = crypto.randomUUID();
const now = new Date();
const future = new Date(now.getTime() + 4 * 60 * 60 * 1000);

try {
  const [question] = await sql`select question_id from question_pool where status='active' order by created_at limit 1`;
  if (!question) throw new Error("No active question.");
  await sql.begin(async (tx) => {
    await tx`insert into sessions (session_id,user_id,session_mode,phase,starting_balance,balance,risk_percent,statistics,snapshot,version)
      values (${productSessionId}::uuid,${userId}::uuid,'RISK_TRAINING','RESULT',1000,980,0.02,'{}'::jsonb,'{}'::jsonb,7)`;
    await tx`insert into training_sessions (session_id,product_session_id,question_id,session_type,runtime_mode,"current_time",hidden_timestamp,future_available_until,delivered_through,public_offset_seconds,dataset_ended,plan,hidden_result,hidden_exit_timestamp,mode,reveal_authorized_at,expires_at,version)
      values (${trainingSessionId}::uuid,${productSessionId}::uuid,${question.question_id}::uuid,'RISK_TRAINING','REVIEW',${future},${now},${future},${future},0,false,'{"direction":"LONG"}'::jsonb,'{"status":"STOP LOSS"}'::jsonb,${now},'REVIEW',now(),${new Date(future.getTime()+86400000)},11)`;
    await tx`update sessions set current_training_session_id=${trainingSessionId}::uuid where session_id=${productSessionId}::uuid`;
    await tx`insert into trades (trade_id,training_session_id,session_id,direction,lot_size,entry_price,exit_price,stop_loss,take_profit,opened_at,closed_at,exit_reason,pnl,result_r,mfe_r,mae_r,holding_minutes)
      values (${tradeId}::uuid,${trainingSessionId}::uuid,${productSessionId}::uuid,'LONG',0.1,2400,2390,2390,2420,${new Date(now.getTime()-3600000)},${now},'STOP_LOSS',-100,-1,0.4,-1,60)`;
  });

  const login = await fetch(`${baseUrl}/api/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "signin", email, password }) });
  if (!login.ok) throw new Error(`Login failed ${login.status}`);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const png = new Blob([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxL7WQAAAABJRU5ErkJggg==", "base64")], { type: "image/png" });
  const form = () => {
    const data = new FormData();
    data.set("image", png, "chart.png"); data.set("thumbnail", png, "thumb.png");
    data.set("productSessionId", productSessionId); data.set("trainingSessionId", trainingSessionId);
    data.set("timeframe", "15m"); data.set("revealStartTime", String(Math.floor(now.getTime()/1000)));
    data.set("revealEndTime", String(Math.floor(future.getTime()/1000)));
    return data;
  };
  const firstStarted = performance.now();
  const firstResponse = await fetch(`${baseUrl}/api/wrong-book`, { method: "POST", headers: { cookie }, body: form() });
  const first = await firstResponse.json();
  if (!firstResponse.ok) throw new Error(`First save failed ${firstResponse.status}: ${JSON.stringify(first)}`);
  const firstWallMs = performance.now() - firstStarted;
  const secondResponse = await fetch(`${baseUrl}/api/wrong-book`, { method: "POST", headers: { cookie }, body: form() });
  const second = await secondResponse.json();
  if (!secondResponse.ok || !second.duplicate) throw new Error("Duplicate save was not idempotent.");
  const [assertion] = await sql`
    select (select count(*)::int from wrong_book_entries where user_id=${userId}::uuid and training_session_id=${trainingSessionId}::uuid and trade_id=${tradeId}::uuid) as entry_count,
      (select version from sessions where session_id=${productSessionId}::uuid) as product_version,
      (select version from training_sessions where session_id=${trainingSessionId}::uuid) as training_version`;
  if (assertion.entry_count !== 1 || assertion.product_version !== 7 || assertion.training_version !== 11) throw new Error(`Isolation assertion failed: ${JSON.stringify(assertion)}`);
  const list = await fetch(`${baseUrl}/api/wrong-book?page=1`, { headers: { cookie } });
  const listPayload = await list.json();
  if (!list.ok || listPayload.pageSize !== 20 || !listPayload.entries.some((entry) => entry.id === first.entry.id)) throw new Error("Paginated list failed.");
  const updated = await fetch(`${baseUrl}/api/wrong-book/${first.entry.id}`, { method: "PATCH", headers: { cookie, "Content-Type": "application/json" }, body: JSON.stringify({ note: "acceptance", tags: ["入场过早"] }) });
  if (!updated.ok) throw new Error("Review update failed.");
  console.log(JSON.stringify({ status: "PASS", entryId: first.entry.id, duplicate: second.duplicate, count: assertion.entry_count, productVersion: assertion.product_version, trainingVersion: assertion.training_version, firstWallMs: Number(firstWallMs.toFixed(2)), serverTimings: first.timings }));
} finally {
  await sql.end({ timeout: 2 });
}
