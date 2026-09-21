import { attachRefreshedCookies, getAuthenticatedUser } from "../../../../src/server/auth";
import { getServerSession, restoreServerSession, toActualTimestamp } from "../../../../src/server/market-data/session-store";
import { getProductSession, loadTrainingSession, saveTrainingCheckpoint } from "../../../../src/server/persistence/repository";
import { phase2Enabled } from "../../../../src/server/phase2-config";
import { withPersistenceRequest } from "../../../../src/server/persistence/request-scope";

async function post(request: Request) {
  if (!phase2Enabled()) return Response.json({ error: "检查点未启用。" }, { status: 404 });
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth || auth.accessStatus !== "active") return Response.json({ error: "无权保存检查点。" }, { status: 403 });
    const body = await request.json() as { sessionId?: string; token?: string; currentTime?: number };
    if (!body.sessionId || !body.token || !Number.isFinite(body.currentTime)) return Response.json({ error: "检查点数据无效。" }, { status: 400 });
    const product = await getProductSession(auth.user.id, body.sessionId);
    if (!product || product.status !== "active" || product.current_training_session_id !== body.token) return Response.json({ error: "当前题目不匹配。" }, { status: 403 });
    let market = getServerSession(body.token);
    if (!market) {
      const stored = await loadTrainingSession(body.token);
      if (!stored) return Response.json({ error: "题目不存在。" }, { status: 404 });
      market = restoreServerSession({ ...stored, userId: auth.user.id, productSessionId: product.session_id });
    }
    if (market.userId !== auth.user.id || market.productSessionId !== product.session_id) return Response.json({ error: "题目不属于当前用户。" }, { status: 403 });
    if (!["QUESTION", "REPLAY", "ACTIVE", "POSITION_OPEN"].includes(market.mode)) return Response.json({ saved: false, reason: "boundary-only" });
    const actualTime = toActualTimestamp(market, body.currentTime!);
    if (actualTime < market.currentTime || actualTime > market.deliveredThrough) return Response.json({ error: "检查点超出已授权行情。" }, { status: 409 });
    const now = Date.now();
    if (market.lastCheckpointAt && now - market.lastCheckpointAt < 30_000) return Response.json({ saved: false, reason: "rate-limited" });
    const version = await saveTrainingCheckpoint(product.session_id, market.token, actualTime);
    if (version === null) return Response.json({ saved: false, reason: "superseded" });
    market.currentTime = actualTime;
    market.lastCheckpointAt = now;
    return attachRefreshedCookies(Response.json({ saved: true, version }), auth.refreshed);
  } catch { return Response.json({ error: "保存检查点失败。" }, { status: 503 }); }
}

export function POST(request: Request) { return withPersistenceRequest(() => post(request)); }
