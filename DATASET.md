# XAUUSD 1-minute historical dataset

## Data source

- Provider: HistData
- Format: MetaTrader M1 bar CSV (`date,time,open,high,low,close,volume`), normally without a header
- Price type: bid quote bars
- Source timezone: fixed Eastern Standard Time (UTC−05:00), without daylight-saving adjustments
- Timezone reference: https://www.histdata.com/f-a-q/data-files-detailed-specification/

## Dataset definition

- Symbol: `XAUUSD`
- Timeframe: 1 minute
- Output timezone: UTC
- Main columns: `timestamp,open,high,low,close,volume`
- PostgreSQL import columns: `symbol,timestamp,open,high,low,close,volume`
- Contract size reference: 100 troy ounces per standard lot. Contract size is metadata only and does not alter candle prices.

## Cleaning rules

1. Raw files are copied unchanged to `data/raw/xauusd/` and recorded by SHA-256.
2. Source timestamps are interpreted as fixed UTC−05:00 and converted to UTC by `normalize_timestamp()`.
3. Rows are sorted by timestamp ascending.
4. Exact timestamp duplicates retain the first row. Conflicting duplicates also retain the first row and are written to `data/reports/conflicting_duplicates.csv`.
5. Missing, non-finite, zero, or negative OHLC values are removed. Missing volume becomes zero.
6. Invalid OHLC relationships are removed and written to `data/reports/invalid_ohlc.csv`. Prices are never repaired.
7. Price values keep source precision. The pipeline does not round, smooth, interpolate, denoise, or replace prices.
8. Moves above the configured threshold are reported only when timestamps are exactly one minute apart; they are not removed.
9. Missing minutes are reported, never filled. Weekend, daily-break, and long-closure classifications are conservative and do not use a holiday calendar.

## Outputs

- Per-year CSV: `data/processed/xauusd/xauusd_<year>_1m.csv`
- Combined CSV: `data/processed/xauusd/xauusd_1m_all.csv`
- PostgreSQL import CSV: `data/processed/xauusd/xauusd_1m_db.csv`
- Optional Parquet: `data/processed/xauusd/xauusd_1m_all.parquet` when `pandas` and `pyarrow` are available
- Reports: `data/reports/`

## Known limitations

- HistData volume values may be zero or tick-volume-like and must not be interpreted as centralized exchange volume.
- No exchange holiday calendar is embedded. Long closures are retained and reported as unverified expected gaps.
- Coverage depends entirely on supplied files. Missing years or months are not synthesized.
- M1 OHLC data cannot resolve intrabar tick ordering when both a stop and target fall inside one candle.

## Running

```bash
python3 scripts/clean_xauusd.py
python3 scripts/clean_xauusd.py --year 2024  # updates only 2024 outputs/reports
python3 scripts/clean_xauusd.py --ingest-dir "/path/to/raw/downloads"
python3 scripts/clean_xauusd.py --ingest-file "/path/to/one.zip" --through 2026-04
```

Tests are compatible with pytest. If pytest is unavailable, the assertions can still be exercised by the repository's selected Python test runner after pytest is installed.
