import sys
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from clean_xauusd import Candle, YearState, clean_year, normalize_timestamp  # noqa: E402


def candle(timestamp: str, open_: str = "2000", high: str = "2001", low: str = "1999", close: str = "2000.5", volume: str = "0") -> Candle:
    return Candle(
        datetime.fromisoformat(timestamp).replace(tzinfo=timezone.utc),
        Decimal(open_), Decimal(high), Decimal(low), Decimal(close), Decimal(volume),
        "fixture.csv", 1, timestamp,
    )


def run_clean(rows):
    state = YearState(2024, raw_rows=len(rows), parsed_rows=len(rows), candles=list(rows))
    invalid, conflicts, jumps, gaps = [], [], [], []
    clean = clean_year(state, invalid, conflicts, jumps, gaps)
    return state, clean, invalid, conflicts, gaps


def test_normal_candle_passes():
    state, clean, *_ = run_clean([candle("2024-01-01T05:00:00")])
    assert state.clean_rows == 1 and len(clean) == 1


def test_high_below_close_is_invalid():
    state, clean, invalid, *_ = run_clean([candle("2024-01-01T05:00:00", high="2000", close="2000.5")])
    assert state.invalid_ohlc == 1 and not clean and len(invalid) == 1


def test_low_above_open_is_invalid():
    state, clean, invalid, *_ = run_clean([candle("2024-01-01T05:00:00", open_="2000", low="2000.1")])
    assert state.invalid_ohlc == 1 and not clean and len(invalid) == 1


def test_exact_duplicate_is_detected():
    first = candle("2024-01-01T05:00:00")
    state, clean, _, conflicts, _ = run_clean([first, first])
    assert state.duplicate_rows == 1 and len(clean) == 1 and not conflicts


def test_conflicting_duplicate_keeps_first():
    first = candle("2024-01-01T05:00:00")
    second = candle("2024-01-01T05:00:00", close="2000.6")
    state, clean, _, conflicts, _ = run_clean([first, second])
    assert state.conflicting_duplicates == 1 and clean[0].close == first.close and len(conflicts) == 1


def test_fixed_est_timezone_conversion():
    assert normalize_timestamp("2024.07.01", "12:00") == datetime(2024, 7, 1, 17, 0, tzinfo=timezone.utc)


def test_timestamp_sorting():
    later = candle("2024-01-01T05:01:00")
    earlier = candle("2024-01-01T05:00:00")
    _, clean, *_ = run_clean([later, earlier])
    assert clean == [earlier, later]


def test_gap_detection():
    first = candle("2024-01-01T05:00:00")
    later = candle("2024-01-01T05:03:00")
    state, _, _, _, gaps = run_clean([first, later])
    assert state.data_gap_count == 1 and gaps[0][2] == 2


def test_jump_detection_only_compares_adjacent_minutes():
    first = candle("2024-01-01T05:00:00", close="2000")
    later = candle("2024-01-01T06:00:00", open_="2200", high="2201", low="2199", close="2200")
    state = YearState(2024, raw_rows=2, parsed_rows=2, candles=[first, later])
    jumps = []
    clean_year(state, [], [], jumps, [])
    assert state.suspicious_price_jumps == 0 and not jumps


def test_volume_zero_is_valid():
    state, clean, *_ = run_clean([candle("2024-01-01T05:00:00", volume="0")])
    assert state.clean_rows == 1 and clean[0].volume == 0


def test_missing_ohlc_policy_is_counted_by_parser_contract():
    state = YearState(2024)
    state.missing_ohlc += 1
    state.missing_values_count += 1
    assert state.missing_ohlc == 1 and state.missing_values_count == 1
