import { attachRefreshedCookies, getAuthenticatedUser } from "../../../../src/server/auth";
import { getAuthorizedCandles } from "../../../../src/server/market-data/access";
import { getMarketDataRequestContext } from "../../../../src/server/market-data";
import { restoreServerSession, toActualTimestamp, toPublicCandles, toPublicTimestamp } from "../../../../src/server/market-data/session-store";
import { getResumeState } from "../../../../src/server/persistence/repository";
import { phase2Enabled } from "../../../../src/server/phase2-config";
import { createQuestionNumber } from "../../../../src/lib/question";
import { evaluateTrade } from "../../../../src/lib/trading";
import { saveTrainingSession } from "../../../../src/server/persistence/repository";
import { recordTiming, setTimingOperation, timedPhase, withPersistenceRequest } from "../../../../src/server/persistence/request-scope";

async function post(request: Request) {
  if (!phase2Enabled()) return Response.json({ error: "恢复功能未启用。" }, { status: 404 });
  let stage = "auth";
  let rebuildStarted = 0;
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth || auth.accessStatus !== "active") return Response.json({ error: "无权恢复会话。" }, { status: 403 });
    const { sessionId } = await request.json() as { sessionId?: string };
    if (!sessionId) return Response.json({ error: "缺少产品会话 ID。" }, { status: 400 });
    stage = "session_state";
    const state = await timedPhase("SESSION_AND_TRAINING_READ", () => getResumeState(auth.user.id, sessionId));
    if (!state || state.product.status !== "active" || !state.product.current_training_session_id) return Response.json({ error: "没有可恢复的当前题目。" }, { status: 404 });
    const { product, market } = state;
    if (product.snapshot.sessionMode === "CHALLENGE" && product.snapshot.phase === "SETUP" ||
        product.snapshot.sessionMode === "RISK_TRAINING" && product.version === 1 && product.snapshot.stats.questionsViewed === 0) {
      return Response.json({ error: "会话尚未完成初始化，请稍后重试或重新开始。" }, { status: 409 });
    }
    if (product.snapshot.sessionMode === "CHALLENGE" && product.snapshot.activePosition) setTimingOperation("challenge_position_restore");
    if (market.expiresAt <= Date.now() / 1000) return Response.json({ error: "当前题目已过期。" }, { status: 410 });
    const positionReadStarted = performance.now();
    const position = product.snapshot.sessionMode === "CHALLENGE" ? product.snapshot.activePosition : null;
    recordTiming("POSITION_TRADE_FROM_SESSION_SNAPSHOT", performance.now() - positionReadStarted);
    recordTiming("TRADE_SQL_READ", 0);
    const hiddenReadStarted = performance.now();
    const hiddenResult = market.hiddenResult;
    recordTiming("HIDDEN_RESULT_FROM_TRAINING_SESSION", performance.now() - hiddenReadStarted);
    const metadataStarted = performance.now();
    const marketTime = market.currentTime;
    const deliveredThrough = market.deliveredThrough;
    recordTiming("MARKET_METADATA_BOUNDARIES", performance.now() - metadataStarted);
    stage = "market_runtime";
    rebuildStarted = performance.now();
    const context = getMarketDataRequestContext();
    const onInitialTiming = (phase: "initial_1m_fetch" | "higher_timeframe_fetch" | "higher_timeframe_aggregation", milliseconds: number) => {
      const label = phase === "initial_1m_fetch" ? "INITIAL_1M_MARKET_FETCH" : phase === "higher_timeframe_fetch" ? "HIGHER_TIMEFRAME_FETCH" : "HIGHER_TIMEFRAME_AGGREGATION";
      recordTiming(label, milliseconds);
    };
    const initialPromise = timedPhase("INITIAL_MARKET_REBUILD", async () => {
      const input = {
        service: context.market, symbol: market.symbol, timeframe: "1H" as const,
        end: marketTime, maximumAllowedTime: marketTime, onTiming: onInitialTiming,
      };
      const recent = await getAuthorizedCandles({ ...input, start: marketTime - 28 * 24 * 60 * 60 });
      if (recent.length >= 240) return recent.slice(-240);
      const fallback = await getAuthorizedCandles({ ...input, start: marketTime - 90 * 24 * 60 * 60 });
      return fallback.slice(-240);
    });
    const fullReplayPromise = market.mode === "REPLAY" && market.plan && market.plan.direction !== "PASS" && market.replayStartedAt
      ? timedPhase("REPLAY_MARKET_REBUILD", () => context.market.getReplayChunk(market.symbol, market.replayStartedAt!, deliveredThrough))
      : Promise.resolve(null);
    const replayPromise = market.replayStartedAt && ["REPLAY", "RESULT", "REVIEW"].includes(market.mode)
      ? fullReplayPromise.then((fullReplay) => fullReplay
        ? fullReplay.filter((candle) => candle.timestamp <= marketTime)
        : timedPhase("REPLAY_CANDLES_REBUILD", () => context.market.getReplayChunk(market.symbol, market.replayStartedAt!, marketTime)))
      : Promise.resolve([]);
    stage = "market_data";
    const [initial, fullReplay, replay, positionCandles] = await Promise.all([
      initialPromise,
      fullReplayPromise,
      replayPromise,
      position
        ? timedPhase("CHALLENGE_POSITION_MARKET_REBUILD", () => context.market.get1mRange(market.symbol, toActualTimestamp(market, position.openedAt), marketTime))
        : Promise.resolve([]),
    ]);
    if (fullReplay) {
      market.replayCandles = fullReplay;
      if (!hiddenResult && market.plan) {
        const evaluation = evaluateTrade(fullReplay, market.plan, fullReplay.length, market.datasetEnded);
        if (["TAKE PROFIT", "STOP LOSS", "NOT FILLED", "DATA ENDED"].includes(evaluation.status)) {
          market.hiddenResult = evaluation;
          market.hiddenExitTimestamp = fullReplay[evaluation.exitIndex]?.timestamp ?? deliveredThrough;
          await timedPhase("HIDDEN_RESULT_WRITE", () => saveTrainingSession(product.session_id, market, false));
        }
      }
    }
    const runtimeStarted = performance.now();
    restoreServerSession({ ...market, userId: auth.user.id, productSessionId: product.session_id });
    recordTiming("MARKET_RUNTIME_RESTORE", performance.now() - runtimeStarted);
    recordTiming("MARKET_DATA_REBUILD", performance.now() - rebuildStarted);
    rebuildStarted = 0;
    const serializationStarted = performance.now();
    const response = Response.json({
      sessionId: product.session_id,
      version: product.version,
      product: product.snapshot,
      market: {
        token: market.token,
        questionId: market.questionId,
        questionNumber: createQuestionNumber(),
        defaultTimeframe: "1H",
        isMock: false,
        candles: toPublicCandles(market, initial.slice(-240)),
        currentTime: toPublicTimestamp(market, market.currentTime),
        authorizedThrough: toPublicTimestamp(market, market.deliveredThrough),
        replayCandles: toPublicCandles(market, replay),
        positionCandles: toPublicCandles(market, positionCandles),
        noMoreData: market.datasetEnded,
        sessionMode: market.sessionType,
        runtimeMode: market.mode,
        plan: market.plan ?? null,
        result: market.mode === "RESULT" || market.mode === "REVIEW" ? market.hiddenResult ?? null : null,
        exitTimestamp: market.mode === "RESULT" || market.mode === "REVIEW"
          ? market.hiddenExitTimestamp ? toPublicTimestamp(market, market.hiddenExitTimestamp) : null
          : null,
      },
    });
    recordTiming("RESPONSE_SERIALIZATION", performance.now() - serializationStarted);
    return attachRefreshedCookies(response, auth.refreshed);
  } catch (cause) {
    if (rebuildStarted) recordTiming("MARKET_DATA_REBUILD", performance.now() - rebuildStarted, "error");
    console.error("RESUME_FAILURE", JSON.stringify({ stage, code: cause && typeof cause === "object" && "code" in cause ? String(cause.code) : cause instanceof Error ? cause.name : "unknown" }));
    return Response.json({ error: "恢复会话失败。" }, { status: 503 });
  }
}

export function POST(request: Request) { return withPersistenceRequest(() => post(request), "resume_session"); }
