import {
  BROKER_SIMULATION_CONFIG,
  type BrokerSimulationConfig,
} from "../config/broker-simulation.ts";
import { calculateRequiredMarginForLot, resolveLeverage } from "./margin-engine.ts";

export type FixedRiskSizingResult = {
  targetRisk: number;
  riskDistance: number;
  rawLot: number;
  riskBasedLot: number;
  maxAffordableLot: number;
  actualLot: number;
  actualRisk: number;
  requiredMargin: number;
  marginLimited: boolean;
  error: string | null;
};

export function floorLotToStep(
  value: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const steps = Math.floor((value + Number.EPSILON) / config.lotStep);
  return Number((steps * config.lotStep).toFixed(8));
}

export function maxAffordableLot(
  entryPrice: number,
  freeMargin: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(freeMargin) || freeMargin <= 0) return 0;
  let maximumNotional = 0;
  let previousLimit = 0;
  for (const rule of config.leverageRules) {
    const affordableNotional = freeMargin * rule.leverage;
    const cappedNotional = rule.maxNotional === null
      ? affordableNotional
      : Math.min(affordableNotional, rule.maxNotional);
    if (cappedNotional > previousLimit) maximumNotional = Math.max(maximumNotional, cappedNotional);
    if (rule.maxNotional === null) break;
    previousLimit = rule.maxNotional;
  }
  return floorLotToStep(maximumNotional / (entryPrice * config.contractSize), config);
}

export function calculateFixedRiskAutoLot(input: {
  balance: number;
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
  freeMargin?: number;
  config?: BrokerSimulationConfig;
}): FixedRiskSizingResult {
  const config = input.config ?? BROKER_SIMULATION_CONFIG;
  const targetRisk = input.balance * input.riskPercent;
  const riskDistance = Math.abs(input.entryPrice - input.stopLoss);
  const rawLot = targetRisk > 0 && riskDistance > 0
    ? targetRisk / (riskDistance * config.contractSize)
    : 0;
  const riskBasedLot = floorLotToStep(rawLot, config);
  const affordableLot = maxAffordableLot(
    input.entryPrice,
    input.freeMargin ?? input.balance,
    config,
  );
  const actualLot = Math.min(riskBasedLot, affordableLot);
  const actualRisk = actualLot * riskDistance * config.contractSize;
  const requiredMargin = actualLot > 0
    ? calculateRequiredMarginForLot(input.entryPrice, actualLot, config)
    : 0;

  let error: string | null = null;
  if (!Number.isFinite(input.balance) || input.balance <= 0 || !Number.isFinite(input.riskPercent) || input.riskPercent <= 0) {
    error = "Balance and risk must be greater than zero.";
  } else if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    error = "Entry and stop loss must be different.";
  } else if (rawLot < config.minLot) {
    error = "Minimum lot would exceed selected risk.";
  } else if (affordableLot < config.minLot) {
    error = "Insufficient margin for the minimum lot.";
  }

  return {
    targetRisk,
    riskDistance,
    rawLot,
    riskBasedLot,
    maxAffordableLot: affordableLot,
    actualLot,
    actualRisk,
    requiredMargin,
    marginLimited: actualLot > 0 && actualLot < riskBasedLot,
    error,
  };
}

export function validateManualLot(
  lotSize: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): string | null {
  if (!Number.isFinite(lotSize) || lotSize < config.minLot) return `Minimum lot is ${config.minLot.toFixed(2)}.`;
  const stepped = floorLotToStep(lotSize, config);
  if (Math.abs(stepped - lotSize) > 1e-8) return `Lot size must use ${config.lotStep.toFixed(2)} steps.`;
  return null;
}

export function leverageForPosition(
  entryPrice: number,
  lotSize: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  return resolveLeverage(entryPrice * lotSize * config.contractSize, config);
}
