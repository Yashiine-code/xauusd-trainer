import assert from "node:assert/strict";
import test from "node:test";

import { calculateFixedRiskAutoLot, floorLotToStep, validateManualLot } from "./position-sizing.ts";

test("fixed-risk sizing uses balance risk and XAUUSD contract size", () => {
  const sizing = calculateFixedRiskAutoLot({
    balance: 1_000,
    riskPercent: 0.02,
    entryPrice: 4_384,
    stopLoss: 4_380,
  });
  assert.equal(sizing.targetRisk, 20);
  assert.equal(sizing.riskBasedLot, 0.05);
  assert.equal(sizing.actualLot, 0.05);
  assert.equal(sizing.actualRisk, 20);
  assert.equal(sizing.error, null);
});

test("fixed-risk lot always rounds down and never exceeds selected risk", () => {
  const sizing = calculateFixedRiskAutoLot({
    balance: 1_000,
    riskPercent: 0.02,
    entryPrice: 100,
    stopLoss: 96.3,
  });
  assert.equal(floorLotToStep(0.059), 0.05);
  assert.equal(sizing.riskBasedLot, 0.05);
  assert.ok(sizing.actualRisk <= sizing.targetRisk);
});

test("minimum lot is rejected when it would exceed selected risk", () => {
  const sizing = calculateFixedRiskAutoLot({
    balance: 100,
    riskPercent: 0.01,
    entryPrice: 4_384,
    stopLoss: 4_380,
  });
  assert.equal(sizing.riskBasedLot, 0);
  assert.equal(sizing.error, "Minimum lot would exceed selected risk.");
});

test("fixed-risk lot is capped down by available margin", () => {
  const sizing = calculateFixedRiskAutoLot({
    balance: 1_000,
    riskPercent: 0.02,
    entryPrice: 4_384,
    stopLoss: 4_380,
    freeMargin: 5,
  });
  assert.equal(sizing.riskBasedLot, 0.05);
  assert.equal(sizing.maxAffordableLot, 0.02);
  assert.equal(sizing.actualLot, 0.02);
  assert.equal(sizing.marginLimited, true);
});

test("manual lot policy requires exact configured steps", () => {
  assert.equal(validateManualLot(0.01), null);
  assert.equal(validateManualLot(0.05), null);
  assert.match(validateManualLot(0.055) ?? "", /0.01 steps/);
});

