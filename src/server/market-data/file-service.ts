import compactRows from "../../../data/xauusd-1m.json";

import { aggregateCandles, TIMEFRAME_MINUTES } from "../../lib/candles";
import { MIN_FUTURE_MINUTES, MIN_HISTORY_MINUTES, pickQuestionIndex } from "../../lib/question";
import type { Candle, CompactCandle } from "../../types/market";
import type {
  MarketDataBounds,
  MarketDataQuery,
  MarketDataService,
  QuestionCandidate,
  QuestionPoolService,
} from "./types";

const SOURCE_SYMBOL = "XAUUSD";
const candles: Candle[] = (compactRows as CompactCandle[]).map(
  ([timestamp, open, high, low, close, volume]) => ({ timestamp, open, high, low, close, volume }),
);

function lowerBound(timestamp: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (candles[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return low;
}

function range(start: number, end: number, limit = Number.MAX_SAFE_INTEGER): Candle[] {
  const first = lowerBound(start);
  const result: Candle[] = [];
  for (let index = first; index < candles.length && result.length < limit; index += 1) {
    if (candles[index].timestamp > end) break;
    result.push(candles[index]);
  }
  return result;
}

export class FileMarketDataService implements MarketDataService {
  async getCandles(query: MarketDataQuery): Promise<Candle[]> {
    this.assertSymbol(query.symbol);
    const source = range(query.start, query.end);
    const aggregated = aggregateCandles(source, query.timeframe, query.end);
    return query.limit ? aggregated.slice(0, query.limit) : aggregated;
  }

  async get1mRange(symbol: string, start: number, end: number, limit?: number): Promise<Candle[]> {
    this.assertSymbol(symbol);
    return range(start, end, limit);
  }

  async get1mAfter(symbol: string, afterTimestamp: number, limit: number): Promise<Candle[]> {
    this.assertSymbol(symbol);
    const first = lowerBound(afterTimestamp + 1);
    return candles.slice(first, first + Math.min(Math.max(limit, 1), 10_000));
  }

  async getContext(symbol: string, hiddenTimestamp: number, candleCount: number): Promise<Candle[]> {
    this.assertSymbol(symbol);
    const hiddenIndex = Math.min(lowerBound(hiddenTimestamp), candles.length - 1);
    const endIndex = candles[hiddenIndex]?.timestamp === hiddenTimestamp ? hiddenIndex : hiddenIndex - 1;
    return candles.slice(Math.max(0, endIndex - candleCount + 1), endIndex + 1);
  }

  async getReplayChunk(symbol: string, afterTimestamp: number, untilTimestamp: number): Promise<Candle[]> {
    return this.get1mRange(symbol, afterTimestamp + 1, untilTimestamp);
  }

  async getBounds(symbol: string): Promise<MarketDataBounds> {
    this.assertSymbol(symbol);
    return {
      firstTimestamp: candles[0].timestamp,
      lastTimestamp: candles.at(-1)!.timestamp,
      rowCount: candles.length,
    };
  }

  private assertSymbol(symbol: string) {
    if (symbol !== SOURCE_SYMBOL) throw new Error(`Unsupported file-mode symbol: ${symbol}`);
  }
}

export class FileQuestionPoolService implements QuestionPoolService {
  async allocate(symbol: string): Promise<QuestionCandidate> {
    if (symbol !== SOURCE_SYMBOL) throw new Error(`Unsupported file-mode symbol: ${symbol}`);
    const index = pickQuestionIndex(candles);
    return {
      questionId: crypto.randomUUID(),
      symbol,
      hiddenTimestamp: candles[index].timestamp,
      futureAvailableUntil: candles[Math.min(candles.length - 1, index + MIN_FUTURE_MINUTES)].timestamp,
      qualityFlag: index >= MIN_HISTORY_MINUTES ? "demo-valid" : "demo-fallback",
    };
  }
}

export function getFileTimeframeMinutes() {
  return TIMEFRAME_MINUTES;
}
