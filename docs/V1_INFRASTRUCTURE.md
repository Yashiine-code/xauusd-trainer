# Production V1 market-data infrastructure

## Modes

The application keeps the working demo path while the production database is being provisioned:

- `MARKET_DATA_MODE=file` (default): reads the compact local demo dataset through `MarketDataService`.
- `MARKET_DATA_MODE=postgres`: range-queries pre-aggregated PostgreSQL candles and allocates from `question_pool`.

Production mode requires `DATABASE_URL`. Never expose that value through a client-prefixed environment variable.

Database transport is runtime-aware. Long-lived Node processes reuse one
process-level postgres.js pool. Cloudflare/Vinext request contexts must not
reuse socket-backed objects across requests: hosted Sites should provide
`SUPABASE_URL` and a server-only `SUPABASE_SERVICE_ROLE_KEY` to use PostgREST.
When only `DATABASE_URL` is available, the Cloudflare compatibility path uses
one request-scoped postgres.js client for all SQL in that API request (normally
through the Supabase transaction pooler). No query path calls `sql.end()`;
shutdown and verification scripts own teardown.

## Authoritative data and offline build

`data/processed/xauusd/xauusd_1m_all.csv` is the only authoritative input. Raw files are not used by the V1 application or importer.

```bash
npm run data:aggregate
npm run data:validate
```

The first command atomically generates `1m`, `3m`, `5m`, `15m`, and `1H` CSVs plus a deterministic, prevalidated question pool under `data/aggregated/xauusd/`. A source SHA-256 manifest makes unchanged reruns idempotent. OHLCV aggregation uses UTC epoch-aligned buckets:

- open: first 1m open
- high: maximum high
- low: minimum low
- close: last 1m close
- volume: sum

Question candidates use 14,400 prior 1m rows and 720 future rows only as an offline quality-validation window. That window is not a runtime market boundary. The question pool selects a historical starting point; rolling market delivery can continue until the real dataset ends. IDs are deterministic UUIDv5 values, so regeneration and import are safe.

## PostgreSQL

Generate or inspect migrations with `npm run db:generate`. Import with:

```bash
DATABASE_URL='postgresql://...' npm run db:import
```

The importer applies tracked Drizzle migrations, streams every generated CSV in bounded batches, reports progress, uses `ON CONFLICT` for repeatability, writes failures to `data/reports/postgres_import_failures.jsonl`, and verifies final database row counts. A single timeframe or incremental file can be imported with:

```bash
DATABASE_URL='postgresql://...' node scripts/import_market_data.mjs --timeframe 1m --file /path/to/increment.csv
```

The `market_candles` primary key is `(symbol, timeframe, timestamp)`. The same ordered lookup index supports range scans. `question_pool` has a unique `(symbol, hidden_timestamp)` key and an allocation index on `(symbol, status, hidden_timestamp)`.

## Request path and future-data policy

`MarketDataService` isolates storage from product logic. PostgreSQL requests always include symbol, timeframe, start, and end; no application request loads years of data.

Opening a question returns only metadata and about 240 default 1H candles. Timestamps are rebased to an anonymous public timeline; the real historical time stays in the server session. The browser then idle-prefetches 15m and 5m, fetches 3m/1m on first use, and caches every loaded timeframe per question. The next question's metadata and 1H context are prefetched independently.

`POST /api/candles` requires both the opaque session token and matching question ID. Its end range is capped by data already delivered to the rolling client buffer. The final higher-timeframe candle is rebuilt from authorized 1m rows, never read from a complete stored bucket.

Question and replay advancement share a client-side `MarketClock` and a bounded rolling 1m `MarketBuffer`. The initial buffer contains up to 1,440 rows. Falling below 360 rows schedules a non-blocking 1,440-row refill. All timeframes are incrementally aggregated from those same 1m rows, so a buffered Next Candle does not call an API or query Supabase.

Submit locks the current plan and switches to replay immediately. It reuses the existing buffer and performs no market-data query. Replay still scans every delivered 1m candle for fill, TP, and SL, stopping at the exact event timestamp. A 24-hour buffer is a cache window, not a question lifetime; delivery continues until the underlying historical dataset ends.

## Intentional phase boundary

The PostgreSQL schema includes minimal `training_sessions`, `users`, and `trades` foundations, but authentication and durable session/trade persistence are not wired in this phase. Runtime training sessions are still process-local. Before horizontal scaling, move this state into PostgreSQL and make allocation/session updates transactional. Redis, Kafka, Kubernetes, and microservices are intentionally absent.

The V1 product-mode layer is documented in `docs/V1_PRODUCT_MODES.md`. Both
product modes reuse this infrastructure and do not introduce a second market
clock, replay buffer, timeframe loader, or chart update pipeline.
