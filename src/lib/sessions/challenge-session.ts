import type {
  ActivePosition,
  ChallengeSession,
  ClosedTrade,
  SessionEndReason,
} from "../../types/product-modes.ts";
import { createAccountState, settleAccount } from "../margin-engine.ts";
import { createChallengeStats, recordChallengeTrade } from "../session-statistics.ts";

export type ChallengeEvent =
  | { type: "START"; timestamp: number }
  | { type: "MARKET_TIME"; timestamp: number }
  | { type: "OPEN_POSITION"; position: ActivePosition }
  | { type: "CLOSE_POSITION"; trade: ClosedTrade }
  | { type: "END"; reason?: SessionEndReason };

export function createChallengeSession(startingBalance: number): ChallengeSession {
  return {
    sessionMode: "CHALLENGE",
    phase: "SETUP",
    startingBalance,
    account: createAccountState(startingBalance),
    activePosition: null,
    trades: [],
    stats: createChallengeStats(),
    startedAt: null,
    currentTime: null,
  };
}

export function reduceChallengeSession(
  session: ChallengeSession,
  event: ChallengeEvent,
): ChallengeSession {
  switch (event.type) {
    case "START":
      if (session.phase !== "SETUP") return session;
      return { ...session, phase: "ACTIVE", startedAt: event.timestamp, currentTime: event.timestamp };
    case "MARKET_TIME":
      if (session.phase !== "ACTIVE" && session.phase !== "POSITION_OPEN") return session;
      return { ...session, currentTime: event.timestamp };
    case "OPEN_POSITION":
      if (session.phase !== "ACTIVE" || session.activePosition) return session;
      return { ...session, phase: "POSITION_OPEN", activePosition: event.position };
    case "CLOSE_POSITION": {
      if (session.phase !== "POSITION_OPEN" || !session.activePosition) return session;
      const account = settleAccount(session.account, event.trade.pnl);
      const blown = account.balance <= 0;
      return {
        ...session,
        phase: blown ? "BLOWN" : "ACTIVE",
        account,
        activePosition: null,
        trades: [...session.trades, event.trade],
        stats: recordChallengeTrade(session.stats, event.trade),
        currentTime: event.trade.closedAt,
        endedReason: blown ? "BLOWN" : session.endedReason,
      };
    }
    case "END": {
      if (session.phase === "ENDED" || session.phase === "BLOWN") return session;
      const reason = event.reason ?? "USER_ENDED";
      return {
        ...session,
        phase: reason === "BLOWN" ? "BLOWN" : "ENDED",
        endedReason: reason,
      };
    }
  }
}

