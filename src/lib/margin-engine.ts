import {
  BROKER_SIMULATION_CONFIG,
  type BrokerSimulationConfig,
} from "../config/broker-simulation.ts";
import type { AccountState, ActivePosition } from "../types/product-modes.ts";

export function resolveLeverage(
  notional: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  const rule = config.leverageRules.find((candidate) => candidate.maxNotional === null || notional <= candidate.maxNotional);
  return rule?.leverage ?? config.leverageRules.at(-1)?.leverage ?? 1;
}

export function calculateRequiredMarginForLot(
  entryPrice: number,
  lotSize: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  if (![entryPrice, lotSize].every(Number.isFinite) || entryPrice <= 0 || lotSize <= 0) return 0;
  const notional = entryPrice * lotSize * config.contractSize;
  return notional / resolveLeverage(notional, config);
}

export function calculatePositionPnl(
  position: Pick<ActivePosition, "direction" | "entryPrice" | "lotSize">,
  currentPrice: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): number {
  const priceMove = position.direction === "LONG"
    ? currentPrice - position.entryPrice
    : position.entryPrice - currentPrice;
  return priceMove * position.lotSize * config.contractSize;
}

export function createAccountState(startingBalance: number): AccountState {
  const balance = Math.max(0, startingBalance);
  return {
    balance,
    equity: balance,
    floatingPnl: 0,
    usedMargin: 0,
    freeMargin: balance,
    marginLevel: null,
    peakBalance: balance,
    maxDrawdown: 0,
  };
}

export function markAccountToMarket(
  account: AccountState,
  position: ActivePosition | null,
  currentPrice: number,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): AccountState {
  const floatingPnl = position ? calculatePositionPnl(position, currentPrice, config) : 0;
  const usedMargin = position?.usedMargin ?? 0;
  const equity = account.balance + floatingPnl;
  const freeMargin = equity - usedMargin;
  return {
    ...account,
    equity,
    floatingPnl,
    usedMargin,
    freeMargin,
    marginLevel: usedMargin > 0 ? (equity / usedMargin) * 100 : null,
  };
}

export function settleAccount(account: AccountState, pnl: number): AccountState {
  const balance = Math.max(0, account.balance + pnl);
  const peakBalance = Math.max(account.peakBalance, balance);
  const drawdown = peakBalance > 0 ? ((peakBalance - balance) / peakBalance) * 100 : 0;
  return {
    balance,
    equity: balance,
    floatingPnl: 0,
    usedMargin: 0,
    freeMargin: balance,
    marginLevel: null,
    peakBalance,
    maxDrawdown: Math.max(account.maxDrawdown, drawdown),
  };
}

export function hasSufficientMargin(requiredMargin: number, freeMargin: number): boolean {
  return requiredMargin > 0 && requiredMargin <= freeMargin + 1e-8;
}

export function isMarginCall(
  account: AccountState,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): boolean {
  return account.marginLevel !== null && account.marginLevel <= config.marginCallLevel;
}

export function isStopOut(
  account: AccountState,
  config: BrokerSimulationConfig = BROKER_SIMULATION_CONFIG,
): boolean {
  return account.marginLevel !== null && account.marginLevel <= config.stopOutLevel;
}

