# R2 MARKET DATA POC REPORT

## FORMAT

**选择：compact JSON v1（无字段名的 candle tuple）**

每根 candle 为 `[timestamp, open, high, low, close, volume]`。对象本身不重复列名，manifest 记录版本、列顺序、时间范围、对象 key、行数、字节数和 SHA-256。

选择原因：浏览器和 Worker 原生 `JSON.parse` 解码快；不新增 MessagePack/Arrow/WASM 依赖；对象可直接设置长期 immutable 缓存；按 manifest 可在读取前定位必要对象。二进制、MessagePack 和 Arrow 可以进一步减小尺寸，但会增加 POC 依赖、浏览器解码和排障复杂度，目前不值得。

## CHUNK STRATEGY

**选择：daily**

| 方案 | 1m 优点 | 1m 缺点 | 结论 |
| --- | --- | --- | --- |
| Daily | 单交易日约 67–70 KB；24h refill 通常只需 2 个对象；最小化无关数据读取 | 90 天 1H 查询对象数偏多 | POC 选择 |
| Weekly | 请求数更少 | 24h refill 会多读最多约一周 1m 数据 | 不选 |
| Monthly | 请求最少 | 1m 单月约 1.47 MB，短范围严重 over-fetch | 不选 |

POC 对 1m、15m、1H 均使用 UTC daily chunk，以保持规则单一。全量迁移前可再评估“1m daily、15m/1H monthly”的混合方案，但本轮不扩大范围。

对象布局：

```text
xauusd/v1/manifest.json
xauusd/v1/1m/2026/01/2026-01-14.json
xauusd/v1/15m/2026/01/2026-01-14.json
xauusd/v1/1H/2026/01/2026-01-14.json
```

## POC RANGE

2026-01-01 00:00:00 UTC 至 2026-02-01 00:00:00 UTC（end exclusive）。

- 1m：28,827 rows，1,470,067 bytes，26 objects
- 15m：1,922 rows，98,024 bytes，26 objects
- 1H：481 rows，24,544 bytes，26 objects
- manifest：1 object
- 总计：79 objects，磁盘约 1.8 MB

## R2 BUCKET

计划 bucket：`xauusd-market-data`；Worker binding：`MARKET_DATA_BUCKET`。

**状态：BLOCKED / 尚未创建和上传。** Cloudflare API 返回错误 10042，账户尚未启用 R2。Dashboard 的下一步是添加 R2 自动续订订阅；当前显示 $0 due now、$0 monthly（超出免费额度后计费）。该财务确认未自动执行。

生产 `wrangler.jsonc` 和生产 `MARKET_DATA_MODE=postgres` 未改变。单独提供 `wrangler.r2-poc.jsonc`，避免把 POC 路径直接上线。

## POSTGRES VS R2

每类记录 3 次，数值为均值。Postgres 是现有远程数据库真实查询；R2 MISS/HIT 是本地对象读取 + Worker Cache API 等价模型，只衡量 chunk 查找、JSON 解码、裁剪、序列化成本，**不是 Cloudflare 网络实测**。因此不能把本地 R2 毫秒数当作线上结论。

### Initial load（240×1H + 240×1m seed）

- Postgres：server 1,214.55 ms；browser-total model 1,215.40 ms；2 queries；0 errors
- R2 MISS local model：server 14.38 ms；browser-total model 14.75 ms；16 MISS / 16 object reads；0 errors
- R2 HIT local model：server 0.87 ms；browser-total model 1.21 ms；16 HIT / 0 object reads；0 errors

### 24h buffer refill（1,440×1m）

- Postgres：server 1,180.25 ms；browser-total model 1,182.29 ms；1 query；0 errors
- R2 MISS local model：server 6.85 ms；browser-total model 8.44 ms；3 MISS / 3 object reads；0 errors
- R2 HIT local model：server 0.99 ms；browser-total model 2.18 ms；3 HIT / 0 object reads；0 errors

### Timeframe switch（15m two-day window + 1H ten-day window）

- Postgres：server 848.30 ms；browser-total model 849.11 ms；2 queries；0 errors
- R2 MISS local model：server 2.65 ms；browser-total model 3.12 ms；14 MISS / 14 object reads；0 errors
- R2 HIT local model：server 1.08 ms；browser-total model 1.53 ms；14 HIT / 0 object reads；0 errors

### Payload size

| Request | Browser/API payload | R2 chunk bytes read |
| --- | ---: | ---: |
| Initial load | 48,016 B | 102,375 B |
| 24h refill | 144,012 B | 158,772 B |
| Timeframe switch | 35,811 B | 41,423 B |

API payload is the same for both adapters because `MarketDataService` returns the existing candle shape. R2 origin bytes include manifest and whole immutable daily objects. SQL/TCP client creation and Postgres range queries are zero inside the R2 market adapter; question allocation and session persistence intentionally remain database-backed.

## CACHE

R2 object responses use `Cache-Control: public, max-age=31536000, immutable`, stable versioned keys, ETag where available, and `caches.default`. Cache HIT skips `R2Bucket.get`; MISS reads the private binding and populates edge cache. Cloudflare documents that Cache API behavior requires a custom domain or route; a `workers.dev` deployment alone cannot validate the CDN HIT result. A dedicated non-production custom route is therefore required for the live POC.

## Hidden future protection: PASS

- R2 bucket remains private; the browser never receives an object URL or signed full-day object.
- `/api/candles` continues to cap ranges at the server session's `maximumAllowedTime`.
- The final higher-timeframe candle is still rebuilt from authorized 1m candles only.
- Daily objects may contain future candles internally, but only the Worker reads/caches them; API responses are cropped and session-relative before reaching the browser.
- Automated tests verify that a request ending after the authorized time returns no future candle.

Future Reveal architecture (design only):

```text
Reveal click
  -> protected Worker endpoint
  -> authenticate user + verify session ownership/version/phase == RESULT
  -> read only the required private R2 daily object(s)
  -> crop to exitTimestamp ... exitTimestamp+4H
  -> translate to public session timestamps
  -> return one response and advance phase to REVIEW
```

No future object is prefetched or exposed to browser DevTools before authorization.

## MarketDataService compatibility: PASS

`R2MarketDataService` implements the existing interface: `getCandles`, `get1mRange`, `get1mAfter`, `getContext`, `getReplayChunk`, and `getBounds`. `MARKET_DATA_MODE=postgres` remains available; `MARKET_DATA_MODE=r2` selects the new adapter. `question_pool` remains on Postgres/Supabase and is lazy so a pure R2 market read does not create a SQL client.

## RECOMMEND FULL MIGRATION: NO

The local model strongly indicates a benefit, especially after cache HIT, but the success criteria require a real R2/CDN MISS/HIT comparison. Because R2 is not enabled and no custom-route edge cache test could be run, the evidence is not yet sufficient to recommend a full migration. Do not migrate 2020–2026 or delete `market_candles` yet.

Required decision gate: enable the R2 subscription, create `xauusd-market-data`, upload only this 2026-01 POC, deploy on a dedicated non-production custom route, rerun the same 3×3 measurements, then change the recommendation only if live HIT/MISS and hidden-future checks pass.

Cloudflare references: [R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [R2 Cache API example and custom-route requirement](https://developers.cloudflare.com/r2/examples/cache-api/).
