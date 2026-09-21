import { getAuthenticatedUser, attachRefreshedCookies } from "../../../src/server/auth";
import { createChallengeSession } from "../../../src/lib/sessions/challenge-session";
import { createRiskTrainingSession, reduceRiskTrainingSession } from "../../../src/lib/sessions/risk-training-session";
import { createProductSession, listProductSessions } from "../../../src/server/persistence/repository";
import { phase2Enabled } from "../../../src/server/phase2-config";
import { withPersistenceRequest } from "../../../src/server/persistence/request-scope";

async function active(request: Request) {
  if (!phase2Enabled()) return null;
  const auth = await getAuthenticatedUser(request);
  return auth?.accessStatus === "active" ? auth : null;
}

async function get(request: Request) {
  try {
    const auth = await active(request);
    if (!auth) return Response.json({ error: "请先登录，且账号不能处于暂停状态。" }, { status: 403 });
    const rows = await listProductSessions(auth.user.id);
    return attachRefreshedCookies(Response.json({ sessions: rows.map((row) => ({
      sessionId: row.session_id,
      sessionMode: row.session_mode,
      phase: row.phase,
      status: row.status,
      balance: Number(row.balance),
      version: row.version,
    })) }), auth.refreshed);
  } catch { return Response.json({ error: "读取会话失败。" }, { status: 503 }); }
}

async function post(request: Request) {
  try {
    const auth = await active(request);
    if (!auth) return Response.json({ error: "请先登录，且账号不能处于暂停状态。" }, { status: 403 });
    const body = await request.json() as { sessionMode?: string; startingBalance?: number; riskPercent?: number };
    const balance = body.startingBalance;
    if (!Number.isFinite(balance) || balance! < 100 || balance! > 1_000_000) return Response.json({ error: "起始资金无效。" }, { status: 400 });
    let snapshot;
    if (body.sessionMode === "RISK_TRAINING") {
      if (!Number.isFinite(body.riskPercent) || body.riskPercent! <= 0 || body.riskPercent! > 0.1) return Response.json({ error: "风险比例无效。" }, { status: 400 });
      snapshot = reduceRiskTrainingSession(createRiskTrainingSession(body.riskPercent!, balance), { type: "START" });
    } else if (body.sessionMode === "CHALLENGE") {
      snapshot = createChallengeSession(balance!);
    } else return Response.json({ error: "训练模式无效。" }, { status: 400 });
    const sessionId = await createProductSession(auth.user.id, snapshot);
    return attachRefreshedCookies(Response.json({ sessionId, version: 0 }), auth.refreshed);
  } catch { return Response.json({ error: "创建会话失败。" }, { status: 503 }); }
}

export function GET(request: Request) { return withPersistenceRequest(() => get(request)); }
export function POST(request: Request) { return withPersistenceRequest(() => post(request)); }
