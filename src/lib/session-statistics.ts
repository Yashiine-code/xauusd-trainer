import type {
  ChallengeStats,
  ClosedTrade,
  PositionExitReason,
  RiskTrainingStats,
} from "../types/product-modes.ts";
import type { TradeResult } from "../types/market.ts";

export function createRiskTrainingStats(startingBalance: number): RiskTrainingStats {
  return {
    questionsViewed: 0,
    passCount: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    netR: 0,
    peakBalance: startingBalance,
    maxDrawdown: 0,
    currentLosingStreak: 0,
    longestLosingStreak: 0,
    totalMfeR: 0,
    totalMaeR: 0,
  };
}

export function recordRiskQuestion(stats: RiskTrainingStats): RiskTrainingStats {
  return { ...stats, questionsViewed: stats.questionsViewed + 1 };
}

export function recordRiskPass(stats: RiskTrainingStats): RiskTrainingStats {
  return { ...stats, passCount: stats.passCount + 1 };
}

export function recordRiskTrade(
  stats: RiskTrainingStats,
  result: TradeResult,
  pnl: number,
  balanceAfter: number,
): RiskTrainingStats {
  const won = pnl > 0;
  const lost = pnl < 0;
  const peakBalance = Math.max(stats.peakBalance, balanceAfter);
  const drawdown = peakBalance > 0 ? ((peakBalance - balanceAfter) / peakBalance) * 100 : 0;
  const losingStreak = lost ? stats.currentLosingStreak + 1 : 0;
  return {
    ...stats,
    trades: stats.trades + 1,
    wins: stats.wins + (won ? 1 : 0),
    losses: stats.losses + (lost ? 1 : 0),
    netPnl: stats.netPnl + pnl,
    netR: stats.netR + result.resultR,
    peakBalance,
    maxDrawdown: Math.max(stats.maxDrawdown, drawdown),
    currentLosingStreak: losingStreak,
    longestLosingStreak: Math.max(stats.longestLosingStreak, losingStreak),
    totalMfeR: stats.totalMfeR + result.mfeR,
    totalMaeR: stats.totalMaeR + result.maeR,
  };
}

const EXIT_REASONS: PositionExitReason[] = ["TP", "SL", "MANUAL_CLOSE", "STOP_OUT", "DATASET_END"];

export function createChallengeStats(): ChallengeStats {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    grossProfit: 0,
    grossLoss: 0,
    largestWin: 0,
    largestLoss: 0,
    currentWinStreak: 0,
    longestWinStreak: 0,
    currentLossStreak: 0,
    longestLossStreak: 0,
    totalHoldingMinutes: 0,
    exitCounts: Object.fromEntries(EXIT_REASONS.map((reason) => [reason, 0])) as Record<PositionExitReason, number>,
  };
}

export function recordChallengeTrade(stats: ChallengeStats, trade: ClosedTrade): ChallengeStats {
  const won = trade.pnl > 0;
  const lost = trade.pnl < 0;
  const winStreak = won ? stats.currentWinStreak + 1 : 0;
  const lossStreak = lost ? stats.currentLossStreak + 1 : 0;
  return {
    ...stats,
    totalTrades: stats.totalTrades + 1,
    wins: stats.wins + (won ? 1 : 0),
    losses: stats.losses + (lost ? 1 : 0),
    grossProfit: stats.grossProfit + Math.max(0, trade.pnl),
    grossLoss: stats.grossLoss + Math.min(0, trade.pnl),
    largestWin: Math.max(stats.largestWin, trade.pnl),
    largestLoss: Math.min(stats.largestLoss, trade.pnl),
    currentWinStreak: winStreak,
    longestWinStreak: Math.max(stats.longestWinStreak, winStreak),
    currentLossStreak: lossStreak,
    longestLossStreak: Math.max(stats.longestLossStreak, lossStreak),
    totalHoldingMinutes: stats.totalHoldingMinutes + Math.max(0, trade.closedAt - trade.openedAt) / 60,
    exitCounts: { ...stats.exitCounts, [trade.exitReason]: stats.exitCounts[trade.exitReason] + 1 },
  };
}

export function profitFactor(stats: ChallengeStats): number | null {
  return stats.grossLoss < 0 ? stats.grossProfit / Math.abs(stats.grossLoss) : null;
}

