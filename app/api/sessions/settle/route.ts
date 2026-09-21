import { attachRefreshedCookies, getAuthenticatedUser } from "../../../../src/server/auth";
import { getMarketDataRequestContext } from "../../../../src/server/market-data";
import { getServerSession, restoreServerSession, toActualTimestamp } from "../../../../src/server/market-data/session-store";
import { createAccountState } from "../../../../src/lib/margin-engine";
import { calculatePositionExcursions, calculatePositionRiskR, closePositionPnl, executePositionCandle } from "../../../../src/lib/execution-engine";
import { reduceChallengeSession } from "../../../../src/lib/sessions/challenge-session";
import { reduceRiskTrainingSession } from "../../../../src/lib/sessions/risk-training-session";
import { calculateXauPnl } from "../../../../src/lib/trading";
import { findTradeOperation, getProductSession, loadTrainingSession, settleTrade, type ProductSnapshot, type TradeRecordInput } from "../../../../src/server/persistence/repository";
import { phase2Enabled } from "../../../../src/server/phase2-config";
import { setTimingOperation, timedPhase, withPersistenceRequest } from "../../../../src/server/persistence/request-scope";
import type { ChallengeSession, ClosedTrade, RiskTrainingSession } from "../../../../src/types/product-modes";

async function post(request: Request) {
  if (!phase2Enabled()) return Response.json({ error: "交易持久化未启用。" }, { status: 404 });
  let stage = "auth";
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth || auth.accessStatus !== "active") return Response.json({ error: "无权结算交易。" }, { status: 403 });
    const body = await request.json() as { sessionId?: string; trainingSessionId?: string; expectedVersion?: number; operationId?: string; closedAt?: number; exitReason?: string };
    if (!body.sessionId || !body.trainingSessionId || !body.operationId || !Number.isInteger(body.expectedVersion)) return Response.json({ error: "结算请求无效。" }, { status: 400 });
    stage = "product_session";
    const product = await timedPhase("PRODUCT_SESSION_READ", () => getProductSession(auth.user.id, body.sessionId!));
    if (!product || product.current_training_session_id !== body.trainingSessionId) return Response.json({ error: "交易会话不匹配。" }, { status: 403 });
    setTimingOperation(product.session_mode === "RISK_TRAINING" ? "risk_settlement" : "challenge_settlement");
    stage = "trade_read";
    if (await timedPhase("TRADE_READ", () => findTradeOperation(auth.user.id, body.sessionId!, body.operationId!))) return attachRefreshedCookies(Response.json({ version: product.version, snapshot: product.snapshot, alreadySettled: true }), auth.refreshed);
    if (product.status !== "active") return Response.json({ error: "产品会话已结束。" }, { status: 409 });
    stage = "training_session";
    const storedChild = await timedPhase("TRAINING_SESSION_READ", () => loadTrainingSession(body.trainingSessionId!));
    if (!storedChild) return Response.json({ error: "当前题目不存在。" }, { status: 404 });
    const market = getServerSession(body.trainingSessionId) ?? restoreServerSession({ ...storedChild, userId: auth.user.id, productSessionId: product.session_id });
    let snapshot: ProductSnapshot;
    let trade: TradeRecordInput;

    if (product.session_mode === "RISK_TRAINING") {
      const plan = market.plan;
      const result = market.hiddenResult;
      if (market.mode !== "RESULT" || !plan || plan.direction === "PASS" || !result || !market.hiddenExitTimestamp) return Response.json({ error: "尚未产生可结算的交易结果。" }, { status: 409 });
      const risk = product.snapshot as RiskTrainingSession;
      if (risk.phase !== "REPLAY") return Response.json({ error: "训练阶段不允许结算。" }, { status: 409 });
      const pnl = plan.entry !== undefined && result.exitPrice !== null ? calculateXauPnl(plan.direction, plan.entry, result.exitPrice, plan.lotSize) : 0;
      snapshot = reduceRiskTrainingSession(risk, { type: "TRADE_RESULT", result, pnl });
      trade = {
        direction: plan.direction, lotSize: plan.lotSize, entryPrice: plan.entry ?? null,
        exitPrice: result.exitPrice, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit,
        openedAt: market.hiddenExitTimestamp - result.holdingMinutes * 60,
        closedAt: market.hiddenExitTimestamp,
        exitReason: result.status.replace(/ /g, "_"), pnl, resultR: result.resultR,
        mfeR: result.mfeR, maeR: result.maeR,
      };
    } else {
      const challenge = product.snapshot as ChallengeSession;
      const position = challenge.activePosition;
      if (challenge.phase !== "POSITION_OPEN" || !position || !Number.isFinite(body.closedAt)) return Response.json({ error: "没有可平仓的持仓。" }, { status: 409 });
      const actualOpenedAt = toActualTimestamp(market, position.openedAt);
      const actualClosedAt = toActualTimestamp(market, body.closedAt!);
      if (actualClosedAt < actualOpenedAt || actualClosedAt > market.deliveredThrough) return Response.json({ error: "平仓时间超出已授权行情。" }, { status: 400 });
      stage = "market_rebuild";
      const candles = await timedPhase("CHALLENGE_POSITION_MARKET_REBUILD", () => getMarketDataRequestContext().market.get1mRange(market.symbol, actualOpenedAt, actualClosedAt));
      if (!candles.length || candles.at(-1)!.timestamp !== actualClosedAt) return Response.json({ error: "平仓行情缺失。" }, { status: 409 });
      let workingPosition = position;
      let workingAccount = createAccountState(challenge.account.balance);
      let reason: ClosedTrade["exitReason"] = "MANUAL_CLOSE";
      let exitPrice = candles.at(-1)!.close;
      for (const candle of candles) {
        if (candle.timestamp <= actualOpenedAt) continue;
        const execution = executePositionCandle(workingPosition, workingAccount, candle);
        workingPosition = execution.position;
        workingAccount = execution.account;
        if (!execution.exitReason || execution.exitPrice === null) continue;
        if (candle.timestamp !== actualClosedAt) return Response.json({ error: "持仓已在更早的 K 线自动平仓。" }, { status: 409 });
        reason = execution.exitReason;
        exitPrice = execution.exitPrice;
        break;
      }
      if (reason === "MANUAL_CLOSE" && body.exitReason === "DATASET_END" && market.datasetEnded) reason = "DATASET_END";
      if (body.exitReason && reason !== body.exitReason) return Response.json({ error: "平仓原因与服务端计算不符。" }, { status: 409 });
      const excursions = calculatePositionExcursions(workingPosition);
      const publicTrade: ClosedTrade = {
        direction: position.direction, lotSize: position.lotSize, entryPrice: position.entryPrice,
        exitPrice, openedAt: position.openedAt, closedAt: body.closedAt!,
        pnl: closePositionPnl(workingPosition, exitPrice), resultR: calculatePositionRiskR(workingPosition, exitPrice),
        mfeR: excursions.mfeR, maeR: excursions.maeR, exitReason: reason,
      };
      snapshot = reduceChallengeSession(challenge, { type: "CLOSE_POSITION", trade: publicTrade });
      trade = { ...publicTrade, openedAt: actualOpenedAt, closedAt: actualClosedAt,
        stopLoss: position.stopLoss, takeProfit: position.takeProfit };
    }

    stage = "transaction";
    const version = await timedPhase("SETTLEMENT_TRANSACTION", () => settleTrade({
      userId: auth.user.id, sessionId: product.session_id, trainingSessionId: body.trainingSessionId!,
      expectedVersion: body.expectedVersion!, operationId: body.operationId!, snapshot, trade,
    }));
    if (product.session_mode === "CHALLENGE") {
      market.mode = snapshot.phase === "BLOWN" ? "BLOWN" : "ACTIVE";
      market.currentTime = trade.closedAt;
    }
    return attachRefreshedCookies(Response.json({ version, snapshot }), auth.refreshed);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Session version conflict.") return Response.json({ code: "SESSION_CONFLICT", error: "会话状态发生冲突，请刷新恢复。" }, { status: 409 });
    console.error("SETTLEMENT_FAILURE", JSON.stringify({ stage, code: cause && typeof cause === "object" && "code" in cause ? String(cause.code) : cause instanceof Error ? cause.name : "unknown" }));
    return Response.json({ error: "交易结算失败，未写入部分结果。" }, { status: 503 });
  }
}

export function POST(request: Request) { return withPersistenceRequest(() => post(request), "settlement"); }
