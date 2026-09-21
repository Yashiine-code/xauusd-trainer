import type { Candle, Direction, TradePlan, TradeResult } from "../types/market";
import {
  DEFAULT_REWARD_RISK,
  DEFAULT_LEVERAGE,
  LOT_STEP,
  MIN_LOT,
  XAU_CONTRACT_SIZE,
} from "../config/trading.ts";

export function createDefaultTradePlan(
  visibleCandles: Candle[],
  direction: Exclude<Direction, "PASS">,
  lotSize = MIN_LOT,
): TradePlan {
  const last = visibleCandles.at(-1);
  if (!last) return { direction, lotSize: normalizeLotSize(lotSize) };

  const highest = Math.max(...visibleCandles.map((candle) => candle.high));
  const lowest = Math.min(...visibleCandles.map((candle) => candle.low));
  const visibleRange = Math.max(highest - lowest, last.close * 0.001);
  const riskDistance = roundPrice(Math.max(0.5, visibleRange * 0.08));
  const rewardDistance = roundPrice(riskDistance * DEFAULT_REWARD_RISK);
  const entry = roundPrice(last.close);

  return direction === "LONG"
    ? {
        direction,
        lotSize: normalizeLotSize(lotSize),
        entry,
        stopLoss: roundPrice(entry - riskDistance),
        takeProfit: roundPrice(entry + rewardDistance),
      }
    : {
        direction,
        lotSize: normalizeLotSize(lotSize),
        entry,
        stopLoss: roundPrice(entry + riskDistance),
        takeProfit: roundPrice(entry - rewardDistance),
      };
}

export function roundPrice(value: number): number {
  return Number(value.toFixed(2));
}

export function normalizeLotSize(value: number): number {
  if (!Number.isFinite(value)) return MIN_LOT;
  const stepped = Math.round(value / LOT_STEP) * LOT_STEP;
  return Math.max(MIN_LOT, Number(stepped.toFixed(2)));
}

export function calculateXauPnl(
  direction: Exclude<Direction, "PASS">,
  entry: number,
  exitPrice: number,
  lots: number,
): number {
  const priceMove = direction === "LONG" ? exitPrice - entry : entry - exitPrice;
  return priceMove * XAU_CONTRACT_SIZE * normalizeLotSize(lots);
}

export function calculateRequiredMargin(
  entry: number,
  lots: number,
  leverage = DEFAULT_LEVERAGE,
): number {
  if (!Number.isFinite(entry) || entry <= 0 || leverage <= 0) return 0;
  return (entry * XAU_CONTRACT_SIZE * normalizeLotSize(lots)) / leverage;
}

export function calculatePlanFinancials(plan: TradePlan) {
  if (
    plan.direction === "PASS" ||
    !Number.isFinite(plan.entry) ||
    !Number.isFinite(plan.stopLoss) ||
    !Number.isFinite(plan.takeProfit)
  ) {
    return { riskUsd: 0, rewardUsd: 0, requiredMargin: 0 };
  }

  return {
    riskUsd: calculateXauPnl(plan.direction, plan.entry!, plan.stopLoss!, plan.lotSize),
    rewardUsd: calculateXauPnl(plan.direction, plan.entry!, plan.takeProfit!, plan.lotSize),
    requiredMargin: calculateRequiredMargin(plan.entry!, plan.lotSize),
  };
}

export function validateTrade(plan: TradePlan): string | null {
  if (plan.direction === "PASS") return null;

  const { entry, stopLoss, takeProfit } = plan;
  if (![entry, stopLoss, takeProfit].every((value) => Number.isFinite(value))) {
    return "Enter valid prices for Entry, Stop Loss, and Take Profit.";
  }

  if (plan.direction === "LONG" && !(stopLoss! < entry! && entry! < takeProfit!)) {
    return "LONG requires Stop Loss < Entry < Take Profit.";
  }

  if (plan.direction === "SHORT" && !(takeProfit! < entry! && entry! < stopLoss!)) {
    return "SHORT requires Take Profit < Entry < Stop Loss.";
  }

  return null;
}

export function calculateRiskReward(plan: TradePlan): number | null {
  if (validateTrade(plan) || plan.direction === "PASS") return null;
  const entry = plan.entry!;
  const risk =
    plan.direction === "LONG" ? entry - plan.stopLoss! : plan.stopLoss! - entry;
  const reward =
    plan.direction === "LONG" ? plan.takeProfit! - entry : entry - plan.takeProfit!;
  return reward / risk;
}

/**
 * Conservative OHLC rule: when the same one-minute candle reaches both TP and SL,
 * Stop Loss always wins. Keep this function isolated so tick data can replace it.
 */
export function resolveExitInCandle(
  direction: Exclude<Direction, "PASS">,
  candle: Candle,
  stopLoss: number,
  takeProfit: number,
): "STOP LOSS" | "TAKE PROFIT" | null {
  const touchesStop =
    direction === "LONG" ? candle.low <= stopLoss : candle.high >= stopLoss;
  const touchesTarget =
    direction === "LONG" ? candle.high >= takeProfit : candle.low <= takeProfit;

  if (touchesStop) return "STOP LOSS";
  if (touchesTarget) return "TAKE PROFIT";
  return null;
}

export function evaluateTrade(
  futureCandles: Candle[],
  plan: TradePlan,
  observedCount = futureCandles.length,
  finalize = false,
): TradeResult {
  const candles = futureCandles.slice(0, observedCount);
  const lastIndex = Math.max(0, candles.length - 1);

  if (plan.direction === "PASS") {
    return {
      status: finalize ? "PASS" : "PENDING",
      direction: "PASS",
      resultR: 0,
      filledIndex: null,
      exitIndex: lastIndex,
      holdingMinutes: 0,
      mfeR: 0,
      maeR: 0,
      exitPrice: null,
    };
  }

  if (validateTrade(plan)) {
    throw new Error("Cannot evaluate an invalid trade plan.");
  }

  const entry = plan.entry!;
  const stopLoss = plan.stopLoss!;
  const takeProfit = plan.takeProfit!;
  const risk =
    plan.direction === "LONG" ? entry - stopLoss : stopLoss - entry;

  let filledIndex: number | null = null;
  let maxHigh = Number.NEGATIVE_INFINITY;
  let minLow = Number.POSITIVE_INFINITY;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (filledIndex === null) {
      if (!(candle.low <= entry && entry <= candle.high)) continue;
      filledIndex = index;
    }

    maxHigh = Math.max(maxHigh, candle.high);
    minLow = Math.min(minLow, candle.low);
    const exit = resolveExitInCandle(plan.direction, candle, stopLoss, takeProfit);

    if (exit) {
      const resultR = exit === "STOP LOSS" ? -1 : calculateRiskReward(plan)!;
      return createResult(
        plan.direction,
        exit,
        resultR,
        filledIndex,
        index,
        maxHigh,
        minLow,
        entry,
        risk,
        exit === "STOP LOSS" ? stopLoss : takeProfit,
      );
    }
  }

  if (!finalize) {
    return {
      status: filledIndex === null ? "PENDING" : "FILLED",
      direction: plan.direction,
      resultR: 0,
      filledIndex,
      exitIndex: lastIndex,
      holdingMinutes: filledIndex === null ? 0 : Math.max(0, lastIndex - filledIndex),
      mfeR: filledIndex === null ? 0 : calculateMfe(plan.direction, maxHigh, minLow, entry, risk),
      maeR: filledIndex === null ? 0 : calculateMae(plan.direction, maxHigh, minLow, entry, risk),
      exitPrice: null,
    };
  }

  if (filledIndex === null) {
    return {
      status: "NOT FILLED",
      direction: plan.direction,
      resultR: 0,
      filledIndex: null,
      exitIndex: lastIndex,
      holdingMinutes: 0,
      mfeR: 0,
      maeR: 0,
      exitPrice: null,
    };
  }

  const lastClose = candles.at(-1)!.close;
  const resultR =
    plan.direction === "LONG"
      ? (lastClose - entry) / risk
      : (entry - lastClose) / risk;

  return createResult(
    plan.direction,
    "DATA ENDED",
    resultR,
    filledIndex,
    lastIndex,
    maxHigh,
    minLow,
    entry,
    risk,
    lastClose,
  );
}

function createResult(
  direction: Exclude<Direction, "PASS">,
  status: "TAKE PROFIT" | "STOP LOSS" | "DATA ENDED",
  resultR: number,
  filledIndex: number,
  exitIndex: number,
  maxHigh: number,
  minLow: number,
  entry: number,
  risk: number,
  exitPrice: number,
): TradeResult {
  return {
    status,
    direction,
    resultR,
    filledIndex,
    exitIndex,
    holdingMinutes: Math.max(0, exitIndex - filledIndex),
    mfeR: calculateMfe(direction, maxHigh, minLow, entry, risk),
    maeR: calculateMae(direction, maxHigh, minLow, entry, risk),
    exitPrice,
  };
}

export function calculateMfe(
  direction: Exclude<Direction, "PASS">,
  maxHigh: number,
  minLow: number,
  entry: number,
  risk: number,
): number {
  return direction === "LONG" ? (maxHigh - entry) / risk : (entry - minLow) / risk;
}

export function calculateMae(
  direction: Exclude<Direction, "PASS">,
  maxHigh: number,
  minLow: number,
  entry: number,
  risk: number,
): number {
  return direction === "LONG" ? (minLow - entry) / risk : (entry - maxHigh) / risk;
}
