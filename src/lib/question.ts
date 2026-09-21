import type { Candle } from "../types/market";

export const MIN_HISTORY_MINUTES = 10 * 24 * 60;
export const MIN_FUTURE_MINUTES = 12 * 60;

export function pickQuestionIndex(candles: Candle[], random = Math.random): number {
  const minIndex = Math.min(MIN_HISTORY_MINUTES, Math.max(0, candles.length - 1));
  const latestAllowedTime = candles.at(-1)!.timestamp - MIN_FUTURE_MINUTES * 60;
  let maxIndex = candles.length - 1;
  while (maxIndex > 0 && candles[maxIndex].timestamp > latestAllowedTime) maxIndex -= 1;

  if (maxIndex <= minIndex) {
    throw new Error("The dataset needs at least 10 days of history and 12 hours of future data.");
  }

  return minIndex + Math.floor(random() * (maxIndex - minIndex + 1));
}

export function createQuestionNumber(): number {
  return Math.floor(100 + Math.random() * 900);
}
