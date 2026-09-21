import type { Direction, TradePlan, TradeResult } from "./market.ts";

export type SessionMode = "RISK_TRAINING" | "CHALLENGE";

export type RiskTrainingPhase =
  | "SETUP"
  | "QUESTION"
  | "PREPARING_REPLAY"
  | "REPLAY"
  | "RESULT"
  | "REVIEW"
  | "ENDED";

export type ChallengePhase = "SETUP" | "ACTIVE" | "POSITION_OPEN" | "ENDED" | "BLOWN";

export type PositionExitReason = "TP" | "SL" | "MANUAL_CLOSE" | "STOP_OUT" | "DATASET_END";
export type SessionEndReason = "USER_ENDED" | "BLOWN" | "DATASET_END";

export type AccountState = {
  balance: number;
  equity: number;
  floatingPnl: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number | null;
  peakBalance: number;
  maxDrawdown: number;
};

export type ActivePosition = {
  direction: Exclude<Direction, "PASS">;
  lotSize: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
  usedMargin: number;
  maxHigh: number;
  minLow: number;
};

export type ClosedTrade = {
  direction: Exclude<Direction, "PASS">;
  lotSize: number;
  entryPrice: number;
  exitPrice: number;
  openedAt: number;
  closedAt: number;
  pnl: number;
  resultR: number | null;
  mfeR: number | null;
  maeR: number | null;
  exitReason: PositionExitReason;
};

export type RiskTrainingStats = {
  questionsViewed: number;
  passCount: number;
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  netR: number;
  peakBalance: number;
  maxDrawdown: number;
  currentLosingStreak: number;
  longestLosingStreak: number;
  totalMfeR: number;
  totalMaeR: number;
};

export type RiskTrainingSession = {
  sessionMode: "RISK_TRAINING";
  phase: RiskTrainingPhase;
  startingBalance: number;
  balance: number;
  riskPercent: number;
  activePlan: TradePlan | null;
  latestResult: TradeResult | null;
  stats: RiskTrainingStats;
  endedReason?: SessionEndReason;
};

export type ChallengeStats = {
  totalTrades: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  largestWin: number;
  largestLoss: number;
  currentWinStreak: number;
  longestWinStreak: number;
  currentLossStreak: number;
  longestLossStreak: number;
  totalHoldingMinutes: number;
  exitCounts: Record<PositionExitReason, number>;
};

export type ChallengeSession = {
  sessionMode: "CHALLENGE";
  phase: ChallengePhase;
  startingBalance: number;
  account: AccountState;
  activePosition: ActivePosition | null;
  trades: ClosedTrade[];
  stats: ChallengeStats;
  startedAt: number | null;
  currentTime: number | null;
  endedReason?: SessionEndReason;
};

