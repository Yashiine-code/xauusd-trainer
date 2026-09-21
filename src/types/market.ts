export type Timeframe = "1H" | "15m" | "5m" | "3m" | "1m";

export type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CompactCandle = [number, number, number, number, number, number];

export type Direction = "LONG" | "SHORT" | "PASS";
export type AppMode = "QUESTION" | "REPLAY" | "RESULT" | "REVIEW" | "CHALLENGE";

export type TradePlan = {
  direction: Direction;
  lotSize: number;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
};

export type TradeStatus =
  | "PENDING"
  | "FILLED"
  | "TAKE PROFIT"
  | "STOP LOSS"
  | "NOT FILLED"
  | "DATA ENDED"
  | "PASS";

export type TradeResult = {
  status: TradeStatus;
  direction: Direction;
  resultR: number;
  filledIndex: number | null;
  exitIndex: number;
  holdingMinutes: number;
  mfeR: number;
  maeR: number;
  exitPrice: number | null;
};

export type MarketSessionPayload = {
  token: string;
  questionId: string;
  questionNumber: number;
  defaultTimeframe: "1H";
  candles: Candle[];
  currentTime: number;
  isMock: boolean;
  noMoreData: boolean;
  sessionMode?: "RISK_TRAINING" | "CHALLENGE";
  productVersion?: number | null;
};

export type MarketAdvancePayload = {
  candles: Candle[];
  currentTime: number;
  noMoreData: boolean;
  tradeResult?: TradeResult;
};
