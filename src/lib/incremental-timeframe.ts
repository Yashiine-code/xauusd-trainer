import { TIMEFRAME_MINUTES } from "./candles.ts";
import type { Candle, Timeframe } from "../types/market.ts";

export function appendOneMinuteCandles(
  existing: Candle[],
  oneMinuteCandles: Candle[],
  timeframe: Timeframe,
  maximumBars: number,
): Candle[] {
  if (!oneMinuteCandles.length) return existing;
  const next = existing.slice();
  const bucketSeconds = TIMEFRAME_MINUTES[timeframe] * 60;

  for (const minute of oneMinuteCandles) {
    const bucket = timeframe === "1m"
      ? minute.timestamp
      : Math.floor(minute.timestamp / bucketSeconds) * bucketSeconds;
    const last = next.at(-1);
    if (!last || bucket > last.timestamp) {
      next.push({ ...minute, timestamp: bucket });
      continue;
    }
    if (bucket !== last.timestamp) continue;
    next[next.length - 1] = {
      timestamp: last.timestamp,
      open: last.open,
      high: Math.max(last.high, minute.high),
      low: Math.min(last.low, minute.low),
      close: minute.close,
      volume: last.volume + minute.volume,
    };
  }

  return next.length > maximumBars ? next.slice(-maximumBars) : next;
}
