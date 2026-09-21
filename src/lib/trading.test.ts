import assert from "node:assert/strict";
import test from "node:test";

import type { Candle, TradePlan } from "../types/market.ts";
import {
  calculatePlanFinancials,
  calculateRequiredMargin,
  calculateMae,
  calculateMfe,
  calculateRiskReward,
  calculateXauPnl,
  createDefaultTradePlan,
  evaluateTrade,
  normalizeLotSize,
  validateTrade,
} from "./trading.ts";

function candle(low: number, high: number, close = (low + high) / 2): Candle {
  return { timestamp: 0, open: close, high, low, close, volume: 0 };
}

const long: TradePlan = { direction: "LONG", lotSize: 0.05, entry: 100, stopLoss: 95, takeProfit: 110 };
const short: TradePlan = { direction: "SHORT", lotSize: 0.05, entry: 100, stopLoss: 105, takeProfit: 90 };

test("validates LONG and SHORT ordering and calculates RR", () => {
  assert.equal(validateTrade(long), null);
  assert.equal(validateTrade(short), null);
  assert.equal(calculateRiskReward(long), 2);
  assert.equal(calculateRiskReward(short), 2);
  assert.ok(validateTrade({ ...long, stopLoss: 101 }));
  assert.ok(validateTrade({ ...short, takeProfit: 101 }));
});

test("LONG fills then reaches take profit", () => {
  const result = evaluateTrade([candle(99, 102), candle(101, 111)], long, 2, true);
  assert.equal(result.status, "TAKE PROFIT");
  assert.equal(result.resultR, 2);
});

test("LONG fills then reaches stop loss", () => {
  const result = evaluateTrade([candle(99, 102), candle(94, 103)], long, 2, true);
  assert.equal(result.status, "STOP LOSS");
  assert.equal(result.resultR, -1);
});

test("SHORT fills then reaches take profit", () => {
  const result = evaluateTrade([candle(98, 101), candle(89, 99)], short, 2, true);
  assert.equal(result.status, "TAKE PROFIT");
  assert.equal(result.resultR, 2);
});

test("SHORT fills then reaches stop loss", () => {
  const result = evaluateTrade([candle(98, 101), candle(97, 106)], short, 2, true);
  assert.equal(result.status, "STOP LOSS");
  assert.equal(result.resultR, -1);
});

test("unreached entry becomes NOT FILLED", () => {
  assert.equal(evaluateTrade([candle(101, 104)], long, 1, true).status, "NOT FILLED");
  assert.equal(evaluateTrade([candle(96, 99)], short, 1, true).status, "NOT FILLED");
});

test("filled open trade becomes DATA ENDED using final close", () => {
  const longResult = evaluateTrade([candle(99, 103, 102.5)], long, 1, true);
  const shortResult = evaluateTrade([candle(97, 101, 98)], short, 1, true);
  assert.equal(longResult.status, "DATA ENDED");
  assert.equal(longResult.resultR, 0.5);
  assert.equal(shortResult.status, "DATA ENDED");
  assert.equal(shortResult.resultR, 0.4);
});

test("same candle TP + SL resolves to SL conservatively", () => {
  assert.equal(evaluateTrade([candle(94, 111)], long, 1, true).status, "STOP LOSS");
  assert.equal(evaluateTrade([candle(89, 106)], short, 1, true).status, "STOP LOSS");
});

test("MFE and MAE are calculated in R", () => {
  assert.equal(calculateMfe("LONG", 108, 98, 100, 5), 1.6);
  assert.equal(calculateMae("LONG", 108, 98, 100, 5), -0.4);
  assert.equal(calculateMfe("SHORT", 102, 92, 100, 5), 1.6);
  assert.equal(calculateMae("SHORT", 102, 92, 100, 5), -0.4);
});

test("XAUUSD PnL uses the shared 100 oz contract size", () => {
  assert.equal(calculateXauPnl("LONG", 4_384, 4_379, 0.01), -5);
  assert.equal(calculateXauPnl("LONG", 4_384, 4_394, 0.05), 50);
  assert.equal(calculateXauPnl("SHORT", 4_384, 4_389, 0.05), -25);
  assert.equal(calculateXauPnl("SHORT", 4_384, 4_374, 0.05), 50);
});

test("required margin uses fixed demo leverage 1:2000", () => {
  assert.equal(calculateRequiredMargin(4_384, 0.05), 10.96);
});

test("lot size is clamped to 0.01 and rounded to 0.01 steps", () => {
  assert.equal(normalizeLotSize(0), 0.01);
  assert.equal(normalizeLotSize(-1), 0.01);
  assert.equal(normalizeLotSize(0.001), 0.01);
  assert.equal(normalizeLotSize(0.056), 0.06);
});

test("lot changes scale risk and reward without moving prices", () => {
  const one = calculatePlanFinancials({ ...long, lotSize: 0.01 });
  const two = calculatePlanFinancials({ ...long, lotSize: 0.02 });
  assert.equal(two.riskUsd, one.riskUsd * 2);
  assert.equal(two.rewardUsd, one.rewardUsd * 2);
  assert.equal(two.requiredMargin, one.requiredMargin * 2);
});

test("default LONG and SHORT plans use the latest close with valid ordering", () => {
  const history = [candle(4_370, 4_390, 4_384), candle(4_375, 4_395, 4_388)];
  const defaultLong = createDefaultTradePlan(history, "LONG");
  const defaultShort = createDefaultTradePlan(history, "SHORT");
  assert.equal(defaultLong.entry, 4_388);
  assert.equal(defaultShort.entry, 4_388);
  assert.equal(validateTrade(defaultLong), null);
  assert.equal(validateTrade(defaultShort), null);
});
