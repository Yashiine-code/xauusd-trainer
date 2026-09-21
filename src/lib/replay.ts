import type { Candle, TradePlan, TradeResult } from "../types/market.ts";
import { evaluateTrade } from "./trading.ts";

const TERMINAL_STATUSES = new Set(["TAKE PROFIT", "STOP LOSS", "NOT FILLED", "DATA ENDED"]);

export type ReplayStepResolution = {
  releasedCandles: Candle[];
  replayCandles: Candle[];
  evaluation: TradeResult;
  terminal: boolean;
};

export type BufferedReplayResolution = ReplayStepResolution & {
  remainingBuffer: Candle[];
  consumedSteps: number;
  currentTime: number;
};

export function consumeReplayBuffer(input: {
  previousCandles: Candle[];
  buffer: Candle[];
  plan: TradePlan;
  currentTime: number;
  authorizedThrough: number;
  stepMinutes: number;
  pendingSteps: number;
  noMoreData: boolean;
}): BufferedReplayResolution | null {
  const stepSeconds = input.stepMinutes * 60;
  const availableSeconds = Math.max(0, input.authorizedThrough - input.currentTime);
  let consumedSteps = Math.min(input.pendingSteps, Math.floor(availableSeconds / stepSeconds));
  if (!consumedSteps && input.noMoreData && availableSeconds > 0 && input.pendingSteps > 0) consumedSteps = 1;
  if (!consumedSteps) return null;

  const targetTime = Math.min(
    input.currentTime + consumedSteps * stepSeconds,
    input.authorizedThrough,
  );
  const stepCandles = input.buffer.filter(
    (candle) => candle.timestamp > input.currentTime && candle.timestamp <= targetTime,
  );
  const resolved = resolveReplayStep(input.previousCandles, stepCandles, input.plan, input.noMoreData && targetTime >= input.authorizedThrough);
  const terminalTime = resolved.terminal
    ? resolved.releasedCandles.at(-1)?.timestamp ?? targetTime
    : targetTime;

  return {
    ...resolved,
    remainingBuffer: resolved.terminal
      ? []
      : input.buffer.filter((candle) => candle.timestamp > targetTime),
    consumedSteps,
    currentTime: terminalTime,
  };
}

/**
 * Resolves one visual replay step using the underlying one-minute candles.
 * If execution finishes inside the step, candles after the exact exit minute
 * are removed before anything is returned to the browser.
 */
export function resolveReplayStep(
  previousCandles: Candle[],
  stepCandles: Candle[],
  plan: TradePlan,
  finalize = false,
): ReplayStepResolution {
  const candidate = [...previousCandles, ...stepCandles];
  const evaluation = evaluateTrade(candidate, plan, candidate.length, finalize);
  const terminal = TERMINAL_STATUSES.has(evaluation.status);

  if (!terminal) {
    return { releasedCandles: stepCandles, replayCandles: candidate, evaluation, terminal };
  }

  const releasedCount = Math.max(0, evaluation.exitIndex - previousCandles.length + 1);
  const releasedCandles = stepCandles.slice(0, releasedCount);
  return {
    releasedCandles,
    replayCandles: candidate.slice(0, evaluation.exitIndex + 1),
    evaluation,
    terminal,
  };
}
