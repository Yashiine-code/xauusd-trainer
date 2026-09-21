import type { Candle, Timeframe } from "../../types/market";

export type MarketDataQuery = {
  symbol: string;
  timeframe: Timeframe;
  start: number;
  end: number;
  limit?: number;
};

export type MarketDataBounds = {
  firstTimestamp: number;
  lastTimestamp: number;
  rowCount: number;
};

export interface MarketDataService {
  getCandles(query: MarketDataQuery): Promise<Candle[]>;
  get1mRange(symbol: string, start: number, end: number, limit?: number): Promise<Candle[]>;
  get1mAfter(symbol: string, afterTimestamp: number, limit: number): Promise<Candle[]>;
  getContext(symbol: string, hiddenTimestamp: number, candleCount: number): Promise<Candle[]>;
  getReplayChunk(symbol: string, afterTimestamp: number, untilTimestamp: number): Promise<Candle[]>;
  getBounds(symbol: string): Promise<MarketDataBounds>;
}

export type QuestionCandidate = {
  questionId: string;
  symbol: string;
  hiddenTimestamp: number;
  futureAvailableUntil: number;
  qualityFlag: string;
};

export interface QuestionPoolService {
  allocate(symbol: string): Promise<QuestionCandidate>;
}
