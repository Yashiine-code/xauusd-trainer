import { createQuestionNumber } from "../../../src/lib/question";
import { zhCN } from "../../../src/i18n/zh-CN";
import { evaluateTrade, validateTrade } from "../../../src/lib/trading";
import {
  getAuthorizedCandles,
  parseTimeframe,
} from "../../../src/server/market-data/access";
import {
  getMarketDataMode,
  getMarketDataAdapter,
  getMarketDataRequestContext,
  usesPersistentProductState,
  type MarketDataRequestContext,
} from "../../../src/server/market-data";
import {
  createServerSession,
  getReplayReachedTimestamp,
  getServerSession,
  restoreServerSession,
  toActualTimestamp,
  toPublicCandles,
  toPublicTimestamp,
  type ServerMarketSession,
} from "../../../src/server/market-data/session-store";
import type { TradePlan, TradeResult } from "../../../src/types/market";
import type { SessionMode } from "../../../src/types/product-modes";
import { attachRefreshedCookies, getAuthenticatedUser } from "../../../src/server/auth";
import { phase2Enabled } from "../../../src/server/phase2-config";
import { activateTrainingSession, getProductSession, getTrainingOwner, loadTrainingSession, saveTrainingSession } from "../../../src/server/persistence/repository";
import { withPersistenceRequest } from "../../../src/server/persistence/request-scope";
import {
  databaseTimingHeaders,
  createDatabaseDiagnostics,
  snapshotDatabaseDiagnostics,
} from "../../../src/server/market-data/diagnostics.ts";

const INITIAL_1H_BARS = 240;
const INITIAL_CONTEXT_LOOKBACK_SECONDS = 90 * 24 * 60 * 60;
const SYMBOL = "XAUUSD";
const MAX_MARKET_BUFFER_MINUTES = 24 * 60;
const REVEAL_FUTURE_SECONDS = 4 * 60 * 60;
const TERMINAL_TRADE_STATUSES = new Set(["TAKE PROFIT", "STOP LOSS", "NOT FILLED", "DATA ENDED"]);

function evaluateServerReplay(session: ServerMarketSession, candles: Awaited<ReturnType<MarketDataRequestContext["market"]["getReplayChunk"]>>) {
  if (session.mode !== "REPLAY" || !session.plan || session.plan.direction === "PASS" || session.hiddenResult) return;
  session.replayCandles = mergeServerCandles(session.replayCandles, candles);
  const evaluation = evaluateTrade(
    session.replayCandles,
    session.plan,
    session.replayCandles.length,
    session.datasetEnded,
  );
  if (!TERMINAL_TRADE_STATUSES.has(evaluation.status)) return;
  session.hiddenResult = evaluation;
  session.hiddenExitTimestamp = session.replayCandles[evaluation.exitIndex]?.timestamp ?? session.deliveredThrough;
}

function mergeServerCandles(left: Awaited<ReturnType<MarketDataRequestContext["market"]["getReplayChunk"]>>, right: Awaited<ReturnType<MarketDataRequestContext["market"]["getReplayChunk"]>>) {
  const rows = new Map<number, (typeof left)[number]>();
  for (const candle of left) rows.set(candle.timestamp, candle);
  for (const candle of right) rows.set(candle.timestamp, candle);
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function createQuestionPayload(context: MarketDataRequestContext, sessionType: SessionMode, owner?: { userId: string; productSessionId: string }, makeCurrent = true, expectedVersion?: number) {
  const question = await context.questions.allocate(SYMBOL);
  const session = createServerSession({ ...question, sessionType, ...owner, durable: Boolean(owner) });
  const initial = await getAuthorizedCandles({
    service: context.market,
    symbol: question.symbol,
    timeframe: "1H",
    start: question.hiddenTimestamp - INITIAL_CONTEXT_LOOKBACK_SECONDS,
    end: question.hiddenTimestamp,
    maximumAllowedTime: question.hiddenTimestamp,
  });
  const candles = initial.slice(-INITIAL_1H_BARS);
  const productVersion = owner ? await saveTrainingSession(owner.productSessionId, session, makeCurrent, expectedVersion) : null;
  return {
    token: session.token,
    questionId: question.questionId,
    questionNumber: createQuestionNumber(),
    defaultTimeframe: "1H" as const,
    candles: toPublicCandles(session, candles),
    currentTime: toPublicTimestamp(session, session.currentTime),
    isMock: getMarketDataMode() === "file",
    noMoreData: false,
    sessionMode: sessionType,
    productVersion,
  };
}

async function releaseUntil(session: ServerMarketSession, requestedTime: number, context: MarketDataRequestContext) {
  const service = context.market;
  const targetTime = Math.min(requestedTime, session.deliveredThrough);
  const released = await service.getReplayChunk(session.symbol, session.currentTime, targetTime);
  session.currentTime = targetTime;
  return {
    candles: toPublicCandles(session, released),
    currentTime: toPublicTimestamp(session, targetTime),
    noMoreData: session.datasetEnded && targetTime >= session.deliveredThrough,
  };
}

async function persistMarketSession(session: ServerMarketSession) {
  if (phase2Enabled() && session.productSessionId) await saveTrainingSession(session.productSessionId, session, false);
}

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
    try {
      authenticated = await getAuthenticatedUser(request);
    } catch {
      return json({ error: "认证服务暂时不可用。" }, { status: 503 });
    }
    if (!authenticated) return json({ error: "请先登录。" }, { status: 401 });
    if (authenticated.accessStatus !== "active") return json({ error: "账号访问权限已暂停。" }, { status: 403 });
  }
  const payload = (await request.json()) as {
    action?: "new" | "prefetch" | "activate" | "advance" | "submit" | "chunk" | "buffer" | "resume-buffer" | "reveal-result" | "reveal" | "challenge-open" | "challenge-close" | "challenge-end";
    token?: string;
    productSessionId?: string;
    expectedVersion?: number;
    minutes?: number;
    timeframe?: unknown;
    start?: number;
    currentTime?: number;
    plan?: TradePlan;
    tradeResult?: TradeResult;
    sessionMode?: SessionMode;
  };
  let requestContext: MarketDataRequestContext | undefined;
  const database = () => requestContext ??= getMarketDataRequestContext(requestDiagnostics);

  if (payload.action === "new" || payload.action === "prefetch") {
    const sessionType = payload.sessionMode === "CHALLENGE" ? "CHALLENGE" : "RISK_TRAINING";
    if (phase2Enabled() && usesPersistentProductState()) {
      if (!payload.productSessionId || !authenticated) return json({ error: "缺少产品会话。" }, { status: 400 });
      const product = await getProductSession(authenticated.user.id, payload.productSessionId);
      if (!product || product.status !== "active" || product.session_mode !== sessionType) return json({ error: "产品会话不可用。" }, { status: 403 });
      if (payload.action === "new" && !Number.isInteger(payload.expectedVersion)) return json({ error: "缺少会话版本。" }, { status: 400 });
      try {
        return json(await createQuestionPayload(database(), sessionType, { userId: authenticated.user.id, productSessionId: product.session_id }, payload.action === "new", payload.expectedVersion));
      } catch (cause) {
        if (cause instanceof Error && cause.message === "Session version conflict.") return json({ code: "SESSION_CONFLICT", error: "会话状态发生冲突，请刷新恢复。" }, { status: 409 });
        throw cause;
      }
    }
    return json(await createQuestionPayload(database(), sessionType));
  }

  let session = payload.token ? getServerSession(payload.token) : undefined;
  if (phase2Enabled() && usesPersistentProductState() && payload.token && authenticated) {
    if (!session) {
      const owner = await getTrainingOwner(payload.token);
      if (owner?.userId === authenticated.user.id) {
        const persisted = await loadTrainingSession(payload.token);
        if (persisted && persisted.expiresAt > Date.now() / 1000) session = restoreServerSession({ ...persisted, ...owner });
      }
    }
    if (!session || session.userId !== authenticated.user.id || !session.productSessionId) return json({ error: "训练会话不属于当前用户。" }, { status: 403 });
    if (payload.action !== "activate") {
      const product = await getProductSession(authenticated.user.id, session.productSessionId);
      if (!product || product.status !== "active" || product.current_training_session_id !== session.token) return json({ error: "这道题目已不是当前会话。" }, { status: 409 });
    }
  }
  if (!session) {
    return json({ error: zhCN.api.sessionExpired }, { status: 410 });
  }

  if (payload.action === "activate") {
    if (!authenticated || !session.productSessionId) return json({ error: "无法激活题目。" }, { status: 403 });
    if (!Number.isInteger(payload.expectedVersion)) return json({ error: "缺少会话版本。" }, { status: 400 });
    let productVersion: number;
    try {
      productVersion = await activateTrainingSession(authenticated.user.id, session.productSessionId, session.token, payload.expectedVersion!);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "Session version conflict.") return json({ code: "SESSION_CONFLICT", error: "会话状态发生冲突，请刷新恢复。" }, { status: 409 });
      throw cause;
    }
    return json({ accepted: true, productVersion });
  }

  if (payload.action === "challenge-open" || payload.action === "challenge-close" || payload.action === "challenge-end") {
    if (session.sessionType !== "CHALLENGE") {
      return json({ error: zhCN.api.challengeActionNotAllowed }, { status: 409 });
    }
    if (!Number.isFinite(payload.currentTime)) {
      return json({ error: zhCN.api.challengeTimeRequired }, { status: 400 });
    }
    const actionTime = toActualTimestamp(session, payload.currentTime!);
    if (actionTime < session.hiddenTimestamp || actionTime > session.deliveredThrough) {
      return json({ error: zhCN.api.challengeTimeOutsideBuffer }, { status: 400 });
    }
    if (payload.action === "challenge-open") {
      if (session.mode !== "ACTIVE") return json({ error: zhCN.api.positionAlreadyActive }, { status: 409 });
      session.mode = "POSITION_OPEN";
    } else if (payload.action === "challenge-close") {
      if (session.mode !== "POSITION_OPEN") return json({ error: zhCN.api.noActivePosition }, { status: 409 });
      session.mode = "ACTIVE";
    } else {
      session.mode = "ENDED";
    }
    session.currentTime = actionTime;
    await persistMarketSession(session);
    return json({ accepted: true });
  }

  if (payload.action === "submit") {
    if (!payload.plan || validateTrade(payload.plan)) {
      return json({ error: zhCN.api.validPlanRequired }, { status: 400 });
    }
    if (session.mode !== "QUESTION") {
      return json({ error: zhCN.api.notAcceptingTrade }, { status: 409 });
    }
    if (Number.isFinite(payload.currentTime)) {
      const submittedAt = toActualTimestamp(session, payload.currentTime!);
      if (submittedAt < session.hiddenTimestamp || submittedAt > session.deliveredThrough) {
        return json({ error: zhCN.api.submissionOutsideBuffer }, { status: 400 });
      }
      session.currentTime = submittedAt;
    }
    if (payload.plan.direction === "PASS") {
      session.plan = payload.plan;
      session.hiddenResult = {
        status: "PASS",
        direction: "PASS",
        resultR: 0,
        filledIndex: null,
        exitIndex: 0,
        holdingMinutes: 0,
        mfeR: 0,
        maeR: 0,
        exitPrice: null,
      };
      session.hiddenExitTimestamp = session.currentTime;
      session.mode = "RESULT";
      await persistMarketSession(session);
      return json({ accepted: true });
    }
    session.plan = payload.plan;
    session.hiddenResult = undefined;
    session.hiddenExitTimestamp = undefined;
    session.replayStartedAt = session.currentTime;
    session.replayCandles = [];
    session.mode = "REPLAY";
    if (session.deliveredThrough > session.currentTime) {
      const prepared = await database().market.getReplayChunk(session.symbol, session.currentTime, session.deliveredThrough);
      evaluateServerReplay(session, prepared);
    }
    await persistMarketSession(session);
    return json({ accepted: true });
  }

  if (payload.action === "resume-buffer") {
    if (session.mode !== "QUESTION" && session.mode !== "REPLAY" && session.mode !== "ACTIVE" && session.mode !== "POSITION_OPEN") {
      return json({ error: zhCN.api.bufferInactive }, { status: 409 });
    }
    const authorizedEnd = Math.min(session.deliveredThrough, session.currentTime + MAX_MARKET_BUFFER_MINUTES * 60);
    const candles = authorizedEnd > session.currentTime
      ? await database().market.getReplayChunk(session.symbol, session.currentTime, authorizedEnd)
      : [];
    return json({
      candles: toPublicCandles(session, candles),
      authorizedThrough: toPublicTimestamp(session, authorizedEnd),
      noMoreData: session.datasetEnded,
    });
  }

  if (payload.action === "chunk" || payload.action === "buffer") {
    if (session.mode !== "QUESTION" && session.mode !== "REPLAY" && session.mode !== "ACTIVE" && session.mode !== "POSITION_OPEN") {
      return json({ error: zhCN.api.bufferInactive }, { status: 409 });
    }
    const maximumMinutes = payload.action === "buffer" ? MAX_MARKET_BUFFER_MINUTES : 60;
    if (!Number.isInteger(payload.minutes) || payload.minutes! < 1 || payload.minutes! > maximumMinutes) {
      return json({ error: `行情缓冲请求必须在 1 到 ${maximumMinutes} 分钟之间。` }, { status: 400 });
    }
    const chunk = await database().market.get1mAfter(
      session.symbol,
      session.deliveredThrough,
      payload.minutes!,
    );
    const chunkEnd = chunk.at(-1)?.timestamp ?? session.deliveredThrough;
    session.deliveredThrough = chunkEnd;
    session.datasetEnded = chunk.length < payload.minutes!;
    evaluateServerReplay(session, chunk);
    if (phase2Enabled() && session.productSessionId &&
        (session.datasetEnded || !session.lastCheckpointAt || Date.now() - session.lastCheckpointAt >= 30_000)) {
      await persistMarketSession(session);
      session.lastCheckpointAt = Date.now();
    }
    return json({
      candles: toPublicCandles(session, chunk),
      authorizedThrough: toPublicTimestamp(session, chunkEnd),
      noMoreData: session.datasetEnded,
    });
  }

  if (payload.action === "reveal-result") {
    if (session.mode !== "REPLAY") {
      return json({ error: zhCN.api.replayInactive }, { status: 409 });
    }
    if (payload.tradeResult && Number.isFinite(payload.currentTime)) {
      const terminalTime = toActualTimestamp(session, payload.currentTime!);
      if (!TERMINAL_TRADE_STATUSES.has(payload.tradeResult.status) || terminalTime > session.deliveredThrough) {
        return json({ error: zhCN.api.invalidReplayResult }, { status: 400 });
      }
      if (!session.hiddenResult || session.hiddenExitTimestamp !== terminalTime ||
          session.hiddenResult.status !== payload.tradeResult.status ||
          session.hiddenResult.exitPrice !== payload.tradeResult.exitPrice ||
          session.hiddenResult.resultR !== payload.tradeResult.resultR) {
        return json({ error: zhCN.api.replayResultMismatch }, { status: 409 });
      }
      session.currentTime = terminalTime;
      session.mode = "RESULT";
      await persistMarketSession(session);
      return json({ revealed: true, tradeResult: session.hiddenResult });
    }
    if (!session.hiddenResult || !session.hiddenExitTimestamp || !Number.isFinite(payload.minutes)) {
      return json({ error: zhCN.api.replayResultUnavailable }, { status: 409 });
    }
    const reachedTimestamp = getReplayReachedTimestamp(session, payload.minutes!);
    if (reachedTimestamp < session.hiddenExitTimestamp || reachedTimestamp > session.deliveredThrough) {
      return json({ revealed: false });
    }
    session.currentTime = session.hiddenExitTimestamp;
    session.mode = "RESULT";
    await persistMarketSession(session);
    return json({ revealed: true, tradeResult: session.hiddenResult });
  }

  if (payload.action === "reveal") {
    if (session.mode !== "RESULT") {
      return json({ error: zhCN.api.revealAfterResult }, { status: 403 });
    }
    const exitTimestamp = session.hiddenExitTimestamp ?? session.currentTime;
    const revealEnd = session.datasetEnded
      ? Math.min(exitTimestamp + REVEAL_FUTURE_SECONDS, session.deliveredThrough)
      : exitTimestamp + REVEAL_FUTURE_SECONDS;
    const requestedStart = Number.isFinite(payload.start)
      ? toActualTimestamp(session, payload.start!)
      : exitTimestamp;
    const revealStart = Math.max(exitTimestamp, Math.min(requestedStart, revealEnd));
    const revealed = revealEnd > revealStart
      ? await database().market.getReplayChunk(session.symbol, revealStart, revealEnd)
      : [];
    session.revealAuthorized = true;
    session.mode = "REVIEW";
    session.currentTime = revealEnd;
    session.deliveredThrough = Math.max(session.deliveredThrough, revealed.at(-1)?.timestamp ?? revealEnd);
    await persistMarketSession(session);
    return json({
      candles: toPublicCandles(session, revealed),
      currentTime: toPublicTimestamp(session, revealEnd),
      noMoreData: session.datasetEnded && revealEnd >= session.deliveredThrough,
    });
  }

  const requestedMinutes = payload.minutes;
  if (!Number.isInteger(requestedMinutes) || requestedMinutes! < 1 || requestedMinutes! > 60) {
    return json({ error: zhCN.api.invalidAdvance }, { status: 400 });
  }
  if (payload.action === "advance" && session.mode !== "QUESTION") {
    return json({ error: zhCN.api.advanceNotAllowed }, { status: 409 });
  }

  if (payload.action === "advance") {
    if (!Number.isFinite(payload.start)) {
      return json({ error: zhCN.api.contextStartRequired }, { status: 400 });
    }
    let timeframe;
    try {
      timeframe = parseTimeframe(payload.timeframe);
    } catch (cause) {
      return json({ error: cause instanceof Error && !/^[\x00-\x7F]+$/.test(cause.message) ? cause.message : zhCN.api.unsupportedTimeframe }, { status: 400 });
    }
    const targetTime = Math.min(session.currentTime + requestedMinutes! * 60, session.deliveredThrough);
    session.currentTime = targetTime;
    const candles = await getAuthorizedCandles({
      service: database().market,
      symbol: session.symbol,
      timeframe,
      start: toActualTimestamp(session, payload.start!),
      end: targetTime,
      maximumAllowedTime: targetTime,
    });
    return json({
      candles: toPublicCandles(session, candles),
      currentTime: toPublicTimestamp(session, targetTime),
      noMoreData: session.datasetEnded && targetTime >= session.deliveredThrough,
    });
  }

  return json(await releaseUntil(session, session.currentTime + requestedMinutes! * 60, database()));
}

export function POST(request: Request) {
  return withPersistenceRequest(() => post(request));
}
