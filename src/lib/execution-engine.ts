import {
  BROKER_SIMULATION_CONFIG,
  type BrokerSimulationConfig,
} from "../config/broker-simulation.ts";
import type { Candle } from "../types/market.ts";
import type { AccountState, ActivePosition, PositionExitReason } from "../types/product-modes.ts";
import { calculatePositionPnl, isStopOut, markAccountToMarket } from "./margin-engine.ts";

export type PositionExecution = {
  position: ActivePosition;
  account: AccountState;
  exitReason: PositionExitReason | null;
  exitPrice: number | null;
};

/**
 * Shared one-minute position execution. Same-candle ambiguity remains
 * conservative: SL wins over TP, then stop-out is evaluated at the close.
 */
export function executePositionCandle(
  position: ActivePosition,
  account: AccountState,
  candle: Candle,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): PositionExecution {
  const nextPosition = {
    ...position,
    maxHigh: Math.max(position.maxHigh, candle.high),
    minLow: Math.min(position.minLow, candle.low),
  };
  const touchesStop = position.stopLoss !== undefined && (
    position.direction === "LONG" ? candle.low <= position.stopLoss : candle.high >= position.stopLoss
  );
  if (touchesStop) {
    return { position: nextPosition, account, exitReason: "SL", exitPrice: position.stopLoss! };
  }
  const touchesTarget = position.takeProfit !== undefined && (
    position.direction === "LONG" ? candle.high >= position.takeProfit : candle.low <= position.takeProfit
  );
  if (touchesTarget) {
    return { position: nextPosition, account, exitReason: "TP", exitPrice: position.takeProfit! };
  }

  const marked = markAccountToMarket(account, nextPosition, candle.close, config);
  if (isStopOut(marked, config)) {
    return { position: nextPosition, account: marked, exitReason: "STOP_OUT", exitPrice: candle.close };
  }
  return { position: nextPosition, account: marked, exitReason: null, exitPrice: null };
}

export function calculatePositionRiskR(position: ActivePosition, exitPrice: number): number | null {
  if (position.stopLoss === undefined) return null;
  const riskDistance = Math.abs(position.entryPrice - position.stopLoss);
  if (riskDistance <= 0) return null;
  const move = position.direction === "LONG"
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice;
  return move / riskDistance;
}

export function calculatePositionExcursions(position: ActivePosition): { mfeR: number | null; maeR: number | null } {
  if (position.stopLoss === undefined) return { mfeR: null, maeR: null };
  const riskDistance = Math.abs(position.entryPrice - position.stopLoss);
  if (riskDistance <= 0) return { mfeR: null, maeR: null };
  if (position.direction === "LONG") {
    return {
      mfeR: (position.maxHigh - position.entryPrice) / riskDistance,
      maeR: (position.minLow - position.entryPrice) / riskDistance,
    };
  }
  return {
    mfeR: (position.entryPrice - position.minLow) / riskDistance,
    maeR: (position.entryPrice - position.maxHigh) / riskDistance,
  };
}

export function closePositionPnl(
  position: ActivePosition,
  exitPrice: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  return calculatePositionPnl(position, exitPrice, config);
}

