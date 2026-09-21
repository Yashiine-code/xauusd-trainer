import { aggregateCandles, expandCandles } from "../../lib/candles.ts";
import type { Candle, CompactCandle, Timeframe } from "../../types/market.ts";
import type { MarketDataBounds, MarketDataQuery, MarketDataService } from "./types.ts";

const MANIFEST_KEY = "xauusd/v1/manifest.json";
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const NATIVE_TIMEFRAMES = new Set<Timeframe>(["1m", "15m", "1H"]);

type R2ReadableObject = {
  body: ReadableStream;
  httpEtag?: string;
  size?: number;
  writeHttpMetadata?: (headers: Headers) => void;
};

export type R2MarketBucket = {
  get(key: string): Promise<R2ReadableObject | null>;
};

export type R2MarketCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

export type R2MarketDataDiagnostics = {
  cacheHits: number;
  cacheMisses: number;
  objectReads: number;
  bytesRead: number;
  errors: number;
};

type ManifestObject = {
  key: string;
  firstTimestamp: number;
  lastTimestamp: number;
  rowCount: number;
  bytes: number;
};

type MarketManifest = {
  version: number;
  symbol: string;
  format: "compact-json-v1";
  range: { start: number; endExclusive: number };
  timeframes: Record<"1m" | "15m" | "1H", {
    rows: number;
    bytes: number;
    objects: ManifestObject[];
  }>;
};

async function runtimeBucket(): Promise<R2MarketBucket> {
  const runtime = await import("cloudflare:workers");
  const bucket = (runtime.env as unknown as { MARKET_DATA_BUCKET?: R2MarketBucket }).MARKET_DATA_BUCKET;
  if (!bucket) throw new Error("MARKET_DATA_BUCKET R2 binding is required for MARKET_DATA_MODE=r2.");
  return bucket;
}

function runtimeCache(): R2MarketCache | undefined {
  const storage = globalThis.caches as CacheStorage & { default?: Cache };
  return storage?.default as unknown as R2MarketCache | undefined;
}

function emptyDiagnostics(): R2MarketDataDiagnostics {
  return { cacheHits: 0, cacheMisses: 0, objectReads: 0, bytesRead: 0, errors: 0 };
}

function cacheRequest(key: string): Request {
  return new Request(`https://market-data-cache.internal/${key}`);
}

function assertManifest(value: unknown): asserts value is MarketManifest {
  const candidate = value as Partial<MarketManifest> | null;
  if (!candidate || candidate.version !== 1 || candidate.symbol !== "XAUUSD" ||
      candidate.format !== "compact-json-v1" || !candidate.range || !candidate.timeframes?.["1m"]) {
    throw new Error("Invalid R2 market-data manifest.");
  }
}

export class R2MarketDataService implements MarketDataService {
  readonly diagnostics: R2MarketDataDiagnostics;
  private readonly bucket?: R2MarketBucket;
  private readonly cache?: R2MarketCache;
  private manifestPromise?: Promise<MarketManifest>;

  constructor(
    bucket?: R2MarketBucket,
    cache: R2MarketCache | undefined = runtimeCache(),
    diagnostics: R2MarketDataDiagnostics = emptyDiagnostics(),
  ) {
    this.bucket = bucket;
    this.cache = cache;
    this.diagnostics = diagnostics;
  }

  private async readJson<T>(key: string): Promise<T> {
    const request = cacheRequest(key);
    try {
      const cached = await this.cache?.match(request);
      if (cached) {
        this.diagnostics.cacheHits += 1;
        this.diagnostics.bytesRead += Number(cached.headers.get("Content-Length") ?? 0);
        return await cached.json() as T;
      }

      this.diagnostics.cacheMisses += 1;
      const object = await (this.bucket ?? await runtimeBucket()).get(key);
      this.diagnostics.objectReads += 1;
      if (!object) throw new Error(`R2 market object not found: ${key}`);
      const headers = new Headers({
        "Cache-Control": CACHE_CONTROL,
        "Content-Type": "application/json; charset=utf-8",
      });
      object.writeHttpMetadata?.(headers);
      if (object.httpEtag) headers.set("ETag", object.httpEtag);
      if (object.size !== undefined) headers.set("Content-Length", String(object.size));
      const response = new Response(object.body, { headers });
      const payload = await response.clone().json() as T;
      const measuredBytes = object.size ?? new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      this.diagnostics.bytesRead += measuredBytes;
      if (this.cache) await this.cache.put(request, response);
      return payload;
    } catch (cause) {
      this.diagnostics.errors += 1;
      throw cause;
    }
  }

  private loadManifest(): Promise<MarketManifest> {
    return this.manifestPromise ??= this.readJson<unknown>(MANIFEST_KEY).then((value) => {
      assertManifest(value);
      return value;
    });
  }

  private async compactRange(timeframe: "1m" | "15m" | "1H", start: number, end: number): Promise<CompactCandle[]> {
    const manifest = await this.loadManifest();
    const selected = manifest.timeframes[timeframe].objects.filter(
      (object) => object.lastTimestamp >= start && object.firstTimestamp <= end,
    );
    const chunks = await Promise.all(selected.map((object) => this.readJson<CompactCandle[]>(object.key)));
    return chunks.flat().filter((row) => row[0] >= start && row[0] <= end);
  }

  async getCandles(query: MarketDataQuery): Promise<Candle[]> {
    this.assertSymbol(query.symbol);
    const limit = Math.min(Math.max(query.limit ?? 100_000, 1), 100_000);
    if (NATIVE_TIMEFRAMES.has(query.timeframe)) {
      return expandCandles(await this.compactRange(query.timeframe as "1m" | "15m" | "1H", query.start, query.end)).slice(0, limit);
    }
    const source = expandCandles(await this.compactRange("1m", query.start, query.end));
    return aggregateCandles(source, query.timeframe, query.end).slice(0, limit);
  }

  get1mRange(symbol: string, start: number, end: number, limit?: number): Promise<Candle[]> {
    return this.getCandles({ symbol, timeframe: "1m", start, end, limit });
  }

  async get1mAfter(symbol: string, afterTimestamp: number, limit: number): Promise<Candle[]> {
    this.assertSymbol(symbol);
    const manifest = await this.loadManifest();
    const safeLimit = Math.min(Math.max(limit, 1), 10_000);
    const rows: CompactCandle[] = [];
    const objects = manifest.timeframes["1m"].objects.filter((object) => object.lastTimestamp > afterTimestamp);
    for (const object of objects) {
      const chunk = await this.readJson<CompactCandle[]>(object.key);
      rows.push(...chunk.filter((row) => row[0] > afterTimestamp));
      if (rows.length >= safeLimit) break;
    }
    return expandCandles(rows.slice(0, safeLimit));
  }

  async getContext(symbol: string, hiddenTimestamp: number, candleCount: number): Promise<Candle[]> {
    this.assertSymbol(symbol);
    const manifest = await this.loadManifest();
    const safeCount = Math.min(Math.max(candleCount, 1), 50_000);
    const rows: CompactCandle[] = [];
    const objects = manifest.timeframes["1m"].objects
      .filter((object) => object.firstTimestamp <= hiddenTimestamp)
      .reverse();
    for (const object of objects) {
      const chunk = await this.readJson<CompactCandle[]>(object.key);
      rows.unshift(...chunk.filter((row) => row[0] <= hiddenTimestamp));
      if (rows.length >= safeCount) break;
    }
    return expandCandles(rows.slice(-safeCount));
  }

  getReplayChunk(symbol: string, afterTimestamp: number, untilTimestamp: number): Promise<Candle[]> {
    return this.get1mRange(symbol, afterTimestamp + 1, untilTimestamp);
  }

  async getBounds(symbol: string): Promise<MarketDataBounds> {
    this.assertSymbol(symbol);
    const manifest = await this.loadManifest();
    const objects = manifest.timeframes["1m"].objects;
    if (!objects.length) throw new Error(`No 1m candles found for ${symbol}.`);
    return {
      firstTimestamp: objects[0].firstTimestamp,
      lastTimestamp: objects.at(-1)!.lastTimestamp,
      rowCount: manifest.timeframes["1m"].rows,
    };
  }

  private assertSymbol(symbol: string): void {
    if (symbol !== "XAUUSD") throw new Error(`Unsupported R2 symbol: ${symbol}`);
  }
}
