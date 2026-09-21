import type { Candle } from "../../types/market.ts";
import { measureDatabaseHttpRequest, type DatabaseDiagnostics } from "./diagnostics.ts";
import type {
  MarketDataBounds,
  MarketDataQuery,
  MarketDataService,
  QuestionCandidate,
  QuestionPoolService,
} from "./types.ts";

type RestCandleRow = {
  timestamp: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
};

type RestQuestionRow = {
  question_id: string;
  symbol: string;
  hidden_timestamp: string;
  future_available_until: string;
  quality_flag: string;
};

function toTimestamp(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

function toCandle(row: RestCandleRow): Candle {
  return {
    timestamp: toTimestamp(row.timestamp),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

export function hasSupabaseHttpConfiguration(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

class SupabaseRestClient {
  private readonly baseUrl: string;
  private readonly headers: HeadersInit;

  constructor() {
    const baseUrl = process.env.SUPABASE_URL;
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the HTTP database adapter.");
    }
    this.baseUrl = `${baseUrl.replace(/\/$/, "")}/rest/v1`;
    this.headers = { apikey: apiKey, Authorization: `Bearer ${apiKey}` };
  }

  async rows<T>(table: string, params: URLSearchParams, headers?: HeadersInit, diagnostics?: DatabaseDiagnostics): Promise<T[]> {
    return measureDatabaseHttpRequest(async () => {
      const response = await fetch(`${this.baseUrl}/${table}?${params}`, {
        headers: { ...this.headers, ...headers },
      });
      if (!response.ok) throw new Error(`Database HTTP query failed (${response.status}).`);
      return response.json() as Promise<T[]>;
    }, diagnostics);
  }

  async count(table: string, params: URLSearchParams, diagnostics?: DatabaseDiagnostics): Promise<number> {
    return measureDatabaseHttpRequest(async () => {
      const response = await fetch(`${this.baseUrl}/${table}?${params}`, {
        method: "HEAD",
        headers: { ...this.headers, Prefer: "count=exact" },
      });
      if (!response.ok) throw new Error(`Database HTTP count failed (${response.status}).`);
      const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
      return match ? Number(match[1]) : 0;
    }, diagnostics);
  }

  async pagedRows<T>(table: string, params: URLSearchParams, requestedLimit: number, diagnostics?: DatabaseDiagnostics): Promise<T[]> {
    const rows: T[] = [];
    const pageSize = Math.min(requestedLimit, 1_000);
    while (rows.length < requestedLimit) {
      const pageParams = new URLSearchParams(params);
      pageParams.set("limit", String(Math.min(pageSize, requestedLimit - rows.length)));
      pageParams.set("offset", String(rows.length));
      const page = await this.rows<T>(table, pageParams, undefined, diagnostics);
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }
}

const restGlobal = globalThis as typeof globalThis & {
  __marketSupabaseRestClient?: SupabaseRestClient;
  __marketQuestionCount?: number;
};

function getRestClient(): SupabaseRestClient {
  return restGlobal.__marketSupabaseRestClient ??= new SupabaseRestClient();
}

function candleParams(query: MarketDataQuery): URLSearchParams {
  const params = new URLSearchParams({
    select: "timestamp,open,high,low,close,volume",
    symbol: `eq.${query.symbol}`,
    timeframe: `eq.${query.timeframe}`,
    timestamp: `gte.${new Date(query.start * 1000).toISOString()}`,
    order: "timestamp.asc",
    limit: String(Math.min(Math.max(query.limit ?? 100_000, 1), 100_000)),
  });
  params.append("timestamp", `lte.${new Date(query.end * 1000).toISOString()}`);
  return params;
}

export class SupabaseRestMarketDataService implements MarketDataService {
  private readonly client = getRestClient();

  constructor(private readonly diagnostics?: DatabaseDiagnostics) {}

  async getCandles(query: MarketDataQuery): Promise<Candle[]> {
    const limit = Math.min(Math.max(query.limit ?? 100_000, 1), 100_000);
    const rows = await this.client.pagedRows<RestCandleRow>("market_candles", candleParams(query), limit, this.diagnostics);
    return rows.map(toCandle);
  }

  get1mRange(symbol: string, start: number, end: number, limit?: number): Promise<Candle[]> {
    return this.getCandles({ symbol, timeframe: "1m", start, end, limit });
  }

  async get1mAfter(symbol: string, afterTimestamp: number, limit: number): Promise<Candle[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 10_000);
    const params = new URLSearchParams({
      select: "timestamp,open,high,low,close,volume",
      symbol: `eq.${symbol}`,
      timeframe: "eq.1m",
      timestamp: `gt.${new Date(afterTimestamp * 1000).toISOString()}`,
      order: "timestamp.asc",
      limit: String(safeLimit),
    });
    const rows = await this.client.pagedRows<RestCandleRow>("market_candles", params, safeLimit, this.diagnostics);
    return rows.map(toCandle);
  }

  async getContext(symbol: string, hiddenTimestamp: number, candleCount: number): Promise<Candle[]> {
    const params = new URLSearchParams({
      select: "timestamp,open,high,low,close,volume",
      symbol: `eq.${symbol}`,
      timeframe: "eq.1m",
      timestamp: `lte.${new Date(hiddenTimestamp * 1000).toISOString()}`,
      order: "timestamp.desc",
      limit: String(Math.min(Math.max(candleCount, 1), 50_000)),
    });
    const rows = await this.client.pagedRows<RestCandleRow>("market_candles", params, Math.min(Math.max(candleCount, 1), 50_000), this.diagnostics);
    return rows.reverse().map(toCandle);
  }

  getReplayChunk(symbol: string, afterTimestamp: number, untilTimestamp: number): Promise<Candle[]> {
    return this.get1mRange(symbol, afterTimestamp + 1, untilTimestamp);
  }

  async getBounds(symbol: string): Promise<MarketDataBounds> {
    const base = {
      select: "timestamp",
      symbol: `eq.${symbol}`,
      timeframe: "eq.1m",
      limit: "1",
    };
    const [firstRows, lastRows, rowCount] = await Promise.all([
      this.client.rows<{ timestamp: string }>("market_candles", new URLSearchParams({ ...base, order: "timestamp.asc" }), undefined, this.diagnostics),
      this.client.rows<{ timestamp: string }>("market_candles", new URLSearchParams({ ...base, order: "timestamp.desc" }), undefined, this.diagnostics),
      this.client.count("market_candles", new URLSearchParams({ select: "timestamp", symbol: `eq.${symbol}`, timeframe: "eq.1m" }), this.diagnostics),
    ]);
    if (!firstRows[0] || !lastRows[0]) throw new Error(`No 1m candles found for ${symbol}.`);
    return {
      firstTimestamp: toTimestamp(firstRows[0].timestamp),
      lastTimestamp: toTimestamp(lastRows[0].timestamp),
      rowCount,
    };
  }
}

export class SupabaseRestQuestionPoolService implements QuestionPoolService {
  private readonly client = getRestClient();

  constructor(private readonly diagnostics?: DatabaseDiagnostics) {}

  async allocate(symbol: string): Promise<QuestionCandidate> {
    const filters = { symbol: `eq.${symbol}`, status: "eq.active" };
    const count = restGlobal.__marketQuestionCount ??= await this.client.count(
      "question_pool",
      new URLSearchParams({ select: "question_id", ...filters }),
      this.diagnostics,
    );
    if (!count) throw new Error(`No active question_pool rows found for ${symbol}.`);
    const offset = Math.floor(Math.random() * count);
    const [row] = await this.client.rows<RestQuestionRow>("question_pool", new URLSearchParams({
      select: "question_id,symbol,hidden_timestamp,future_available_until,quality_flag",
      ...filters,
      order: "hidden_timestamp.asc",
      limit: "1",
      offset: String(offset),
    }), undefined, this.diagnostics);
    if (!row) throw new Error(`No active question_pool rows found for ${symbol}.`);
    return {
      questionId: row.question_id,
      symbol: row.symbol,
      hiddenTimestamp: toTimestamp(row.hidden_timestamp),
      futureAvailableUntil: toTimestamp(row.future_available_until),
      qualityFlag: row.quality_flag,
    };
  }
}
