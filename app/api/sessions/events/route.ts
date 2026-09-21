import { attachRefreshedCookies, getAuthenticatedUser } from "../../../../src/server/auth";
import { reduceChallengeSession, type ChallengeEvent } from "../../../../src/lib/sessions/challenge-session";
import { reduceRiskTrainingSession, type RiskTrainingEvent } from "../../../../src/lib/sessions/risk-training-session";
import { getProductSession, loadTrainingSession, updateProductSnapshot } from "../../../../src/server/persistence/repository";
import { toActualTimestamp } from "../../../../src/server/market-data/session-store";
import { getMarketDataRequestContext } from "../../../../src/server/market-data";
import { validateManualLot } from "../../../../src/lib/position-sizing";
import { calculateRequiredMarginForLot, hasSufficientMargin, markAccountToMarket } from "../../../../src/lib/margin-engine";
import type { ChallengeSession } from "../../../../src/types/product-modes";
import { phase2Enabled } from "../../../../src/server/phase2-config";
import { withPersistenceRequest } from "../../../../src/server/persistence/request-scope";
import type { TradePlan } from "../../../../src/types/market";

function sameTradePlan(stored: TradePlan | undefined, submitted: TradePlan | undefined): boolean {
  return Boolean(stored && submitted && stored.direction === submitted.direction &&
    stored.lotSize === submitted.lotSize && stored.entry === submitted.entry &&
    stored.stopLoss === submitted.stopLoss && stored.takeProfit === submitted.takeProfit);
}

async function post(request: Request) {
  if (!phase2Enabled()) return Response.json({ error: "会话持久化未启用。" }, { status: 404 });
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth || auth.accessStatus !== "active") return Response.json({ error: "无权操作会话。" }, { status: 403 });
    const body = await request.json() as { sessionId?: string; expectedVersion?: number; event?: RiskTrainingEvent | ChallengeEvent };
    if (!body.sessionId || !Number.isInteger(body.expectedVersion) || !body.event) return Response.json({ error: "会话事件无效。" }, { status: 400 });
    const row = await getProductSession(auth.user.id, body.sessionId);
    if (!row || row.status !== "active") return Response.json({ error: "产品会话不可用。" }, { status: 403 });
    if (row.version !== body.expectedVersion) return Response.json({ code: "SESSION_CONFLICT", error: "会话状态发生冲突，请刷新恢复。" }, { status: 409 });
    const child = row.current_training_session_id ? await loadTrainingSession(row.current_training_session_id) : null;
    if (!child) return Response.json({ error: "当前题目不存在。" }, { status: 409 });
    const allowedRisk = new Set(["QUESTION_READY", "PASS", "SUBMIT_TRADE", "REPLAY_READY", "REVEAL_FUTURE", "NEXT_QUESTION", "END"]);
    const allowedChallenge = new Set(["START", "OPEN_POSITION", "END"]);
    let snapshot;
    if (row.session_mode === "RISK_TRAINING") {
      if (!allowedRisk.has(body.event.type)) return Response.json({ error: "该事件必须通过交易结算接口。" }, { status: 400 });
      if (body.event.type === "PASS" && (child.mode !== "RESULT" || child.plan?.direction !== "PASS")) return Response.json({ error: "PASS 尚未提交。" }, { status: 409 });
      if (body.event.type === "SUBMIT_TRADE" && (child.mode !== "REPLAY" || !sameTradePlan(child.plan, (body.event as RiskTrainingEvent & { plan?: TradePlan }).plan))) return Response.json({ error: "交易计划与当前题目不符。" }, { status: 409 });
      if (body.event.type === "REPLAY_READY" && child.mode !== "REPLAY") return Response.json({ error: "回放尚未准备好。" }, { status: 409 });
      if (body.event.type === "REVEAL_FUTURE" && child.mode !== "REVIEW") return Response.json({ error: "未来行情尚未授权。" }, { status: 409 });
      snapshot = reduceRiskTrainingSession(row.snapshot as Extract<typeof row.snapshot, { sessionMode: "RISK_TRAINING" }>, body.event as RiskTrainingEvent);
    } else {
      if (!allowedChallenge.has(body.event.type)) return Response.json({ error: "该事件必须通过交易结算接口。" }, { status: 400 });
      let challengeEvent = body.event as ChallengeEvent;
      if (body.event.type === "OPEN_POSITION") {
        const challenge = row.snapshot as ChallengeSession;
        const position = (body.event as ChallengeEvent & { position?: ChallengeSession["activePosition"] }).position;
        const invalidStop = position?.stopLoss !== undefined && (position?.direction === "LONG" ? position.stopLoss >= position.entryPrice : position.stopLoss <= position.entryPrice);
        const invalidTarget = position?.takeProfit !== undefined && (position?.direction === "LONG" ? position.takeProfit <= position.entryPrice : position.takeProfit >= position.entryPrice);
        if (child.mode !== "POSITION_OPEN" || !position || !Number.isFinite(position.openedAt) || !Number.isFinite(position.entryPrice) ||
            validateManualLot(position.lotSize) || invalidStop || invalidTarget) {
          return Response.json({ error: "持仓参数无效。" }, { status: 409 });
        }
        const actualTime = toActualTimestamp(child, position.openedAt);
        if (actualTime < child.hiddenTimestamp || actualTime > child.deliveredThrough || !hasSufficientMargin(calculateRequiredMarginForLot(position.entryPrice, position.lotSize), challenge.account.freeMargin)) return Response.json({ error: "开仓超出授权行情或可用保证金。" }, { status: 409 });
        const candles = await getMarketDataRequestContext().market.get1mRange(child.symbol, actualTime, actualTime);
        if (candles.length !== 1 || Math.abs(candles[0].close - position.entryPrice) > 0.000001) return Response.json({ error: "开仓价格与行情不符。" }, { status: 409 });
        challengeEvent = { type: "OPEN_POSITION", position: {
          ...position, usedMargin: calculateRequiredMarginForLot(position.entryPrice, position.lotSize),
          maxHigh: position.entryPrice, minLow: position.entryPrice,
        } };
      }
      snapshot = reduceChallengeSession(row.snapshot as Extract<typeof row.snapshot, { sessionMode: "CHALLENGE" }>, challengeEvent);
      if (challengeEvent.type === "OPEN_POSITION" && snapshot.activePosition) {
        snapshot = { ...snapshot, account: markAccountToMarket(snapshot.account, snapshot.activePosition, snapshot.activePosition.entryPrice) };
      }
    }
    if (snapshot === row.snapshot) return Response.json({ error: "当前阶段不接受该事件。" }, { status: 409 });
    const version = await updateProductSnapshot(auth.user.id, row.session_id, row.version, snapshot);
    return attachRefreshedCookies(Response.json({ version }), auth.refreshed);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "Session version conflict.") return Response.json({ code: "SESSION_CONFLICT", error: "会话状态发生冲突，请刷新恢复。" }, { status: 409 });
    return Response.json({ error: "保存会话事件失败。" }, { status: 503 });
  }
}

export function POST(request: Request) { return withPersistenceRequest(() => post(request)); }
