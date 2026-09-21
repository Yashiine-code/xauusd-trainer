import assert from "node:assert/strict";
import test from "node:test";

import { BROKER_SIMULATION_CONFIG } from "../config/broker-simulation.ts";
import type { ActivePosition } from "../types/product-modes.ts";
import {
  calculateRequiredMarginForLot,
  createAccountState,
  isStopOut,
  markAccountToMarket,
  settleAccount,
} from "./margin-engine.ts";

const position: ActivePosition = {
  direction: "LONG",
  lotSize: 0.05,
  entryPrice: 4_384,
  stopLoss: 4_380,
  takeProfit: 4_392,
  openedAt: 0,
  usedMargin: 10.96,
  maxHigh: 4_384,
  minLow: 4_384,
};

test("margin uses configured contract size and leverage tier", () => {
  assert.equal(calculateRequiredMarginForLot(4_384, 0.05), 10.96);
});

test("account engine calculates floating pnl, equity, free margin and margin level", () => {
  const marked = markAccountToMarket(createAccountState(1_000), position, 4_386);
  assert.equal(marked.floatingPnl, 10);
  assert.equal(marked.equity, 1_010);
  assert.equal(marked.usedMargin, 10.96);
  assert.equal(marked.freeMargin, 999.04);
  assert.ok((marked.marginLevel ?? 0) > 9_000);
});

test("no open position displays no margin level", () => {
  const account = markAccountToMarket(createAccountState(1_000), null, 4_386);
  assert.equal(account.marginLevel, null);
});

test("settlement clamps negative balances and tracks drawdown", () => {
  const settled = settleAccount(createAccountState(100), -150);
  assert.equal(settled.balance, 0);
  assert.equal(settled.maxDrawdown, 100);
});

test("stop out threshold is controlled by broker config", () => {
  const account = { ...createAccountState(100), usedMargin: 100, equity: 19, freeMargin: -81, marginLevel: 19 };
  assert.equal(isStopOut(account, BROKER_SIMULATION_CONFIG), true);
});

