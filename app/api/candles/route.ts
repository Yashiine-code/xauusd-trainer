import { getAuthorizedCandles, parseTimeframe } from "../../../src/server/market-data/access";
import { zhCN } from "../../../src/i18n/zh-CN";
import { getMarketDataAdapter, getMarketDataRequestContext, usesPersistentProductState } from "../../../src/server/market-data";
import { attachRefreshedCookies, getAuthenticatedUser } from "../../../src/server/auth";
import { phase2Enabled } from "../../../src/server/phase2-config";
import {
  databaseTimingHeaders,
  createDatabaseDiagnostics,
  snapshotDatabaseDiagnostics,
} from "../../../src/server/market-data/diagnostics.ts";
import {
  getServerSession,
  restoreServerSession,
  toActualTimestamp,
  toPublicCandles,
} from "../../../src/server/market-data/session-store";
import { getProductSession, getTrainingOwner, loadTrainingSession } from "../../../src/server/persistence/repository";
import { withPersistenceRequest } from "../../../src/server/persistence/request-scope";

async function post(request: Request) {
  const requestStarted = performance.now();
  const requestDiagnostics = createDatabaseDiagnostics();
  const databaseBefore = snapshotDatabaseDiagnostics(requestDiagnostics);
  let authenticated: Awaited<ReturnType<typeof getAuthenticatedUser>> = null;
  const json = (body: unknown, init?: ResponseInit) => {
    const headers = databaseTimingHeaders(databaseBefore, requestStarted, requestDiagnostics);
    headers.set("X-Market-Data-Adapter", getMarketDataAdapter());
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    return attachRefreshedCookies(Response.json(body, { ...init, headers }), authenticated?.refreshed);
  };
  if (phase2Enabled() && usesPersistentProductState()) {
    try { authenticated = await getAuthenticatedUser(request); }
    catch { return json({ error: "认证服务暂时不可用。" }, { status: 503 }); }
    if (!authenticated) return json({ error: "请先登录。" }, { status: 401 });
    if (authenticated.accessStatus !== "active") return json({ error: "账号访问权限已暂停。" }, { status: 403 });
  }
  try {
    const payload = (await request.json()) as {
      token?: string;
      questionId?: string;
      timeframe?: unknown;
      start?: number;
      end?: number;
      contextLimit?: number;
    };
    let session = payload.token ? getServerSession(payload.token) : undefined;
    if (phase2Enabled() && usesPersistentProductState() && payload.token && authenticated) {
      if (!session) {
        const owner = await getTrainingOwner(payload.token);
        if (owner?.userId === authenticated.user.id) {
          const persisted = await loadTrainingSession(payload.token);
          if (persisted && persisted.expiresAt > Date.now() / 1000) session = restoreServerSession({ ...persisted, ...owner });
        }
      }
      if (!session || session.userId !== authenticated.user.id) return json({ error: "训练会话不属于当前用户。" }, { status: 403 });
      const product = session.productSessionId ? await getProductSession(authenticated.user.id, session.productSessionId) : null;
      if (!product || product.status !== "active" || product.current_training_session_id !== session.token) return json({ error: "这道题目已不是当前会话。" }, { status: 409 });
    }
    if (!session) return json({ error: zhCN.api.sessionExpired }, { status: 410 });
    if (!payload.questionId || payload.questionId !== session.questionId) {
      return json({ error: zhCN.api.questionMismatch }, { status: 403 });
    }
    if (!Number.isFinite(payload.start) || !Number.isFinite(payload.end)) {
      return json({ error: zhCN.api.numericRangeRequired }, { status: 400 });
    }

    const timeframe = parseTimeframe(payload.timeframe);
    const start = toActualTimestamp(session, payload.start!);
    const end = toActualTimestamp(session, payload.end!);
    const maximumAllowedTime = Math.max(session.currentTime, session.deliveredThrough);
    const { market } = getMarketDataRequestContext(requestDiagnostics);
    const contextLimit = Number.isInteger(payload.contextLimit)
      ? Math.min(Math.max(payload.contextLimit!, 1), 20_000)
      : undefined;
    const candles = timeframe === "1m" && contextLimit
      ? (await market.getContext(session.symbol, Math.min(end, maximumAllowedTime), contextLimit))
          .filter((candle) => candle.timestamp >= start && candle.timestamp <= maximumAllowedTime)
      : await getAuthorizedCandles({
          service: market,
          symbol: session.symbol,
          timeframe,
          start,
          end,
          maximumAllowedTime,
        });
    return json({ candles: toPublicCandles(session, candles) });
  } catch (cause) {
    return json(
      { error: cause instanceof Error && !/^[\x00-\x7F]+$/.test(cause.message) ? cause.message : zhCN.api.candleQueryFailed },
      { status: 400 },
    );
  }
}

export function POST(request: Request) {
  return withPersistenceRequest(() => post(request));
}
