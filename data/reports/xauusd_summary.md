# XAUUSD 1-minute data quality summary

- Source: HistData MetaTrader M1 bar files
- Source timezone: EST (fixed UTC-05:00, no DST)
- Output timezone: UTC
- Raw rows inspected: 2,196,727
- Clean rows: 2,196,367
- Final validation: PASS
- Parquet: Parquet skipped: optional dependency unavailable (pandas)
- Missing full calendar years between first and last supplied year: none

## Per-year results

| Year | Raw | Clean | Removed/deduped | Duplicate | Conflicting | Invalid OHLC | Unexpected gaps | Suspicious jumps |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2020 | 354,351 | 354,291 | 60 | 60 | 0 | 0 | 81 | 0 |
| 2021 | 353,446 | 353,386 | 60 | 60 | 0 | 0 | 40 | 0 |
| 2022 | 354,628 | 354,568 | 60 | 60 | 0 | 0 | 71 | 0 |
| 2023 | 308,812 | 308,752 | 60 | 60 | 0 | 0 | 774 | 0 |
| 2024 | 355,652 | 355,592 | 60 | 60 | 0 | 0 | 68 | 0 |
| 2025 | 354,011 | 353,951 | 60 | 60 | 0 | 0 | 49 | 0 |
| 2026 | 115,827 | 115,827 | 0 | 0 | 0 | 0 | 22 | 0 |

## Important limitations

- HistData documents fixed EST without daylight-saving adjustments. The pipeline applies UTC−05:00 to UTC conversion for every source row.
- Gap classification is conservative. Weekend, standard daily-break patterns, and very long closures are marked expected; holiday calendars are not embedded, so long closures remain labelled `long_closure_or_holiday_unverified`.
- No missing candle is synthesized and no OHLC value is rounded, interpolated, smoothed, or replaced.
- HistData bar prices are bid quotes. Volume is retained as supplied and is not represented as exchange-traded volume.
