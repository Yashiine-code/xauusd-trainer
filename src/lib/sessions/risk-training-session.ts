import type { TradePlan, TradeResult } from "../../types/market.ts";
import type { RiskTrainingSession, SessionEndReason } from "../../types/product-modes.ts";
import {
  createRiskTrainingStats,
  recordRiskPass,
  recordRiskQuestion,
  recordRiskTrade,
} from "../session-statistics.ts";

export type RiskTrainingEvent =
  | { type: "START" }
  | { type: "QUESTION_READY" }
  | { type: "PASS" }
  | { type: "SUBMIT_TRADE"; plan: TradePlan }
  | { type: "REPLAY_READY" }
  | { type: "TRADE_RESULT"; result: TradeResult; pnl: number }
  | { type: "REVEAL_FUTURE" }
  | { type: "NEXT_QUESTION" }
  | { type: "END"; reason?: SessionEndReason };

export function createRiskTrainingSession(
  riskPercent: number,
  startingBalance = 1_000,
): RiskTrainingSession {
  return {
    sessionMode: "RISK_TRAINING",
    phase: "SETUP",
    startingBalance,
    balance: startingBalance,
    riskPercent,
    activePlan: null,
    latestResult: null,
    stats: createRiskTrainingStats(startingBalance),
  };
}

export function reduceRiskTrainingSession(
  session: RiskTrainingSession,
  event: RiskTrainingEvent,
): RiskTrainingSession {
  switch (event.type) {
    case "START":
      if (session.phase !== "SETUP") return session;
      return { ...session, phase: "QUESTION" };
    case "QUESTION_READY":
      if (session.phase !== "QUESTION") return session;
      return { ...session, stats: recordRiskQuestion(session.stats) };
    case "PASS":
      if (session.phase !== "QUESTION") return session;
      return {
        ...session,
        phase: "QUESTION",
        activePlan: null,
        latestResult: null,
        stats: recordRiskPass(session.stats),
      };
    case "SUBMIT_TRADE":
      if (session.phase !== "QUESTION" || event.plan.direction === "PASS") return session;
      return { ...session, phase: "PREPARING_REPLAY", activePlan: event.plan, latestResult: null };
    case "REPLAY_READY":
      if (session.phase !== "PREPARING_REPLAY") return session;
      return { ...session, phase: "REPLAY" };
    case "TRADE_RESULT": {
      if (session.phase !== "REPLAY") return session;
      const balance = Math.max(0, session.balance + event.pnl);
      return {
        ...session,
        phase: "RESULT",
        balance,
        latestResult: event.result,
        stats: recordRiskTrade(session.stats, event.result, event.pnl, balance),
      };
    }
    case "REVEAL_FUTURE":
      if (session.phase !== "RESULT") return session;
      return { ...session, phase: "REVIEW" };
    case "NEXT_QUESTION":
      if (session.phase !== "RESULT" && session.phase !== "REVIEW") return session;
      return { ...session, phase: "QUESTION", activePlan: null, latestResult: null };
    case "END":
      if (session.phase === "ENDED") return session;
      return { ...session, phase: "ENDED", endedReason: event.reason ?? "USER_ENDED" };
  }
}

