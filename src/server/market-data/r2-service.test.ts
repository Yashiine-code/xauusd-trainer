import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { getAuthorizedCandles } from "./access.ts";
import { R2MarketDataService, type R2MarketBucket, type R2MarketCache } from "./r2-service.ts";

const fixtureRoot = path.resolve("data/r2-poc");

class FixtureBucket implements R2MarketBucket {
  reads = 0;

  async get(key: string) {
    try {
      const payload = await readFile(path.join(fixtureRoot, key));
      this.reads += 1;
      return {
        body: new Response(payload).body!,
        size: payload.byteLength,
        httpEtag: `"fixture-${payload.byteLength}"`,
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }
}

class MemoryCache implements R2MarketCache {
  private readonly values = new Map<string, Response>();

  async match(request: Request) {
    return this.values.get(request.url)?.clone();
  }

  async put(request: Request, response: Response) {
    this.values.set(request.url, response.clone());
  }
}

test("R2 adapter reads compact daily chunks and reuses edge cache", async () => {
  const cache = new MemoryCache();
  const firstBucket = new FixtureBucket();
  const first = new R2MarketDataService(firstBucket, cache);
  const start = Date.parse("2026-01-14T00:00:00Z") / 1000;
  const end = Date.parse("2026-01-14T23:59:59Z") / 1000;
  const cold = await first.get1mRange("XAUUSD", start, end);

  assert.equal(cold.length, 1_380);
  assert.equal(first.diagnostics.objectReads, 2);
  assert.equal(first.diagnostics.cacheMisses, 2);

  const secondBucket = new FixtureBucket();
  const second = new R2MarketDataService(secondBucket, cache);
  const warm = await second.get1mRange("XAUUSD", start, end);
  assert.deepEqual(warm, cold);
  assert.equal(secondBucket.reads, 0);
  assert.equal(second.diagnostics.cacheHits, 2);
});

test("R2 adapter keeps future candles behind server authorization", async () => {
  const service = new R2MarketDataService(new FixtureBucket(), new MemoryCache());
  const start = Date.parse("2026-01-14T00:00:00Z") / 1000;
  const allowed = Date.parse("2026-01-14T12:34:00Z") / 1000;
  const candles = await getAuthorizedCandles({
    service,
    symbol: "XAUUSD",
    timeframe: "1H",
    start,
    end: Date.parse("2026-01-14T23:00:00Z") / 1000,
    maximumAllowedTime: allowed,
  });

  assert.ok(candles.length > 0);
  assert.ok(candles.every((candle) => candle.timestamp <= allowed));
  assert.equal(candles.at(-1)?.timestamp, Date.parse("2026-01-14T12:00:00Z") / 1000);
});

test("R2 adapter preserves bounded replay and context methods", async () => {
  const service = new R2MarketDataService(new FixtureBucket(), new MemoryCache());
  const timestamp = Date.parse("2026-01-20T12:00:00Z") / 1000;
  const after = await service.get1mAfter("XAUUSD", timestamp, 24);
  const context = await service.getContext("XAUUSD", timestamp, 240);

  assert.equal(after.length, 24);
  assert.ok(after[0].timestamp > timestamp);
  assert.equal(context.length, 240);
  assert.ok(context.at(-1)!.timestamp <= timestamp);
});
