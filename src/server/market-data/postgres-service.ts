import {
  getSql,
  type SqlClient,
} from "../../../db/index.ts";
import type { Candle } from "../../types/market.ts";
import { measureDatabaseQuery, type DatabaseDiagnostics } from "./diagnostics.ts";
import type {
  MarketDataBounds,
  MarketDataQuery,
  MarketDataService,
  QuestionCandidate,
  QuestionPoolService,
} from "./types.ts";

type CandleRow = {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

function toCandle(row: CandleRow): Candle {
  return {
    timestamp: Math.floor(row.timestamp.getTime() / 1000),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

export class PostgresMarketDataService implements MarketDataService {
  private readonly sql: SqlClient;

  constructor(sql: SqlClient = getSql(), private readonly diagnostics?: DatabaseDiagnostics) {
    this.sql = sql;
  }

  private query<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> {
    return measureDatabaseQuery(() => operation(this.sql), this.diagnostics);
  }

  async getCandles(query: MarketDataQuery): Promise<Candle[]> {
    const limit = Math.min(Math.max(query.limit ?? 100_000, 1), 100_000);
    const rows = await this.query((sql) => sql<CandleRow[]>`
        select timestamp, open, high, low, close, volume
        from market_candles
        where symbol = ${query.symbol}
          and timeframe = ${query.timeframe}
          and timestamp >= ${new Date(query.start * 1000)}
          and timestamp <= ${new Date(query.end * 1000)}
        order by timestamp asc
        limit ${limit}
      `);
    return rows.map(toCandle);
  }

  get1mRange(symbol: string, start: number, end: number, limit?: number): Promise<Candle[]> {
    return this.getCandles({ symbol, timeframe: "1m", start, end, limit });
  }

  async get1mAfter(symbol: string, afterTimestamp: number, limit: number): Promise<Candle[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 10_000);
    const rows = await this.query((sql) => sql<CandleRow[]>`
        select timestamp, open, high, low, close, volume
        from market_candles
        where symbol = ${symbol}
          and timeframe = '1m'
          and timestamp > ${new Date(afterTimestamp * 1000)}
        order by timestamp asc
        limit ${safeLimit}
      `);
    return rows.map(toCandle);
  }

  async getContext(symbol: string, hiddenTimestamp: number, candleCount: number): Promise<Candle[]> {
    const safeCount = Math.min(Math.max(candleCount, 1), 50_000);
    const rows = await this.query((sql) => sql<CandleRow[]>`
        select timestamp, open, high, low, close, volume
        from market_candles
        where symbol = ${symbol}
          and timeframe = '1m'
          and timestamp <= ${new Date(hiddenTimestamp * 1000)}
        order by timestamp desc
        limit ${safeCount}
      `);
    return rows.reverse().map(toCandle);
  }

  getReplayChunk(symbol: string, afterTimestamp: number, untilTimestamp: number): Promise<Candle[]> {
    return this.get1mRange(symbol, afterTimestamp + 1, untilTimestamp);
  }

  async getBounds(symbol: string): Promise<MarketDataBounds> {
    const [row] = await this.query((sql) => sql<{ first_timestamp: Date; last_timestamp: Date; row_count: string }[]>`
        select min(timestamp) as first_timestamp,
               max(timestamp) as last_timestamp,
               count(*)::text as row_count
        from market_candles
        where symbol = ${symbol} and timeframe = '1m'
      `);
    if (!row?.first_timestamp || !row.last_timestamp) throw new Error(`No 1m candles found for ${symbol}.`);
    return {
      firstTimestamp: Math.floor(row.first_timestamp.getTime() / 1000),
      lastTimestamp: Math.floor(row.last_timestamp.getTime() / 1000),
      rowCount: Number(row.row_count),
    };
  }
}

export class PostgresQuestionPoolService implements QuestionPoolService {
  private readonly sql: SqlClient;

  constructor(sql: SqlClient = getSql(), private readonly diagnostics?: DatabaseDiagnostics) {
    this.sql = sql;
  }

  private query<T>(operation: (sql: SqlClient) => Promise<T>): Promise<T> {
    return measureDatabaseQuery(() => operation(this.sql), this.diagnostics);
  }

  async allocate(symbol: string): Promise<QuestionCandidate> {
    const [row] = await this.query((sql) => sql<{
      question_id: string;
      symbol: string;
      hidden_timestamp: Date;
      future_available_until: Date;
      quality_flag: string;
    }[]>`
        select question_id, symbol, hidden_timestamp, future_available_until, quality_flag
        from question_pool
        where symbol = ${symbol} and status = 'active'
        order by random()
        limit 1
      `);
    if (!row) throw new Error(`No active question_pool rows found for ${symbol}.`);
    return {
      questionId: row.question_id,
      symbol: row.symbol,
      hiddenTimestamp: Math.floor(row.hidden_timestamp.getTime() / 1000),
      futureAvailableUntil: Math.floor(row.future_available_until.getTime() / 1000),
      qualityFlag: row.quality_flag,
    };
  }
}
