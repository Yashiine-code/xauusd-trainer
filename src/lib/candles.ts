import type { Candle, CompactCandle, Timeframe } from "../types/market";

export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  "1H": 60,
  "15m": 15,
  "5m": 5,
  "3m": 3,
  "1m": 1,
};

export function expandCandles(rows: CompactCandle[]): Candle[] {
  return rows.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp,
    open,
    high,
    low,
    close,
    volume,
  }));
}

export function aggregateCandles(
  candles: Candle[],
  timeframe: Timeframe,
  cutoffTimestamp = Number.POSITIVE_INFINITY,
): Candle[] {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  if (minutes === 1) {
    return candles.filter((candle) => candle.timestamp <= cutoffTimestamp);
  }

  const bucketSeconds = minutes * 60;
  const result: Candle[] = [];

  for (const candle of candles) {
    if (candle.timestamp > cutoffTimestamp) break;
    const bucket = Math.floor(candle.timestamp / bucketSeconds) * bucketSeconds;
    const current = result.at(-1);

    if (!current || current.timestamp !== bucket) {
      result.push({ ...candle, timestamp: bucket });
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }

  return result;
}

export function generateMockCandles(count = 9_000): Candle[] {
  const candles: Candle[] = [];
  const start = 1_700_000_000;
  let close = 2_340;

  for (let index = 0; index < count; index += 1) {
    const wave = Math.sin(index / 43) * 0.42 + Math.sin(index / 211) * 0.25;
    const drift = Math.sin(index / 997) * 0.035;
    const open = close;
    close = Math.max(1, open + wave + drift);
    const spread = 0.42 + Math.abs(Math.sin(index * 0.71)) * 0.9;
    candles.push({
      timestamp: start + index * 60,
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread * 0.82,
      close,
      volume: 0,
    });
  }

  return candles;
}

