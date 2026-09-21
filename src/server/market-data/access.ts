import { aggregateCandles, TIMEFRAME_MINUTES } from "../../lib/candles.ts";
import type { Candle, Timeframe } from "../../types/market.ts";
import type { MarketDataService } from "./types.ts";

const VALID_TIMEFRAMES = new Set<Timeframe>(["1m", "3m", "5m", "15m", "1H"]);
export const MAX_CANDLES_PER_REQUEST = 20_000;

export function parseTimeframe(value: unknown): Timeframe {
  if (typeof value !== "string" || !VALID_TIMEFRAMES.has(value as Timeframe)) {
    throw new Error("Unsupported timeframe.");
  }
  return value as Timeframe;
}

/**
 * Returns only candles authorized by the server clock. The final higher-timeframe
 * candle is rebuilt from unlocked 1m rows so a stored full bucket can never leak.
 */
export async function getAuthorizedCandles(input: {
  service: MarketDataService;
  symbol: string;
  timeframe: Timeframe;
  start: number;
  end: number;
  maximumAllowedTime: number;
  onTiming?: (phase: "initial_1m_fetch" | "higher_timeframe_fetch" | "higher_timeframe_aggregation", milliseconds: number) => void;
}): Promise<Candle[]> {
  const { service, symbol, timeframe, start, maximumAllowedTime } = input;
  const end = Math.min(input.end, maximumAllowedTime);
  if (![start, end, maximumAllowedTime].every(Number.isFinite) || start > end) return [];
  const measure = async <T>(phase: "initial_1m_fetch" | "higher_timeframe_fetch", operation: () => Promise<T>): Promise<T> => {
    if (!input.onTiming) return operation();
    const started = performance.now();
    try { return await operation(); }
    finally { input.onTiming(phase, performance.now() - started); }
  };

  if (timeframe === "1m") {
    return measure("initial_1m_fetch", () => service.get1mRange(symbol, start, end, MAX_CANDLES_PER_REQUEST));
  }

  const bucketSeconds = TIMEFRAME_MINUTES[timeframe] * 60;
  const lastBucketStart = Math.floor(end / bucketSeconds) * bucketSeconds;
  const completeEnd = lastBucketStart - 1;
  const completedRequest = completeEnd >= start
    ? measure("higher_timeframe_fetch", () => service.getCandles({
        symbol,
        timeframe,
        start,
        end: completeEnd,
        limit: MAX_CANDLES_PER_REQUEST,
      }))
    : Promise.resolve([]);
  const partialRequest = measure("initial_1m_fetch", () => service.get1mRange(
    symbol,
    Math.max(start, lastBucketStart),
    end,
    bucketSeconds / 60,
  ));
  const [completed, partialSource] = await Promise.all([completedRequest, partialRequest]);
  const aggregationStarted = performance.now();
  const partial = aggregateCandles(partialSource, timeframe, end);
  input.onTiming?.("higher_timeframe_aggregation", performance.now() - aggregationStarted);
  return [...completed, ...partial].slice(0, MAX_CANDLES_PER_REQUEST);
}
