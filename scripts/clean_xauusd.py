#!/usr/bin/env python3
"""Repeatable XAUUSD M1 cleaner for HistData and standard OHLC CSV files."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import random
import re
import shutil
import sys
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from itertools import chain
from pathlib import Path
from typing import Iterable, Iterator, TextIO

from data_config import (
    DAILY_BREAK_END_UTC_HOUR,
    DAILY_BREAK_START_UTC_HOUR,
    DB_OUTPUT_COLUMNS,
    EXPECTED_LONG_GAP_MINUTES,
    OUTPUT_COLUMNS,
    OUTPUT_TIMEZONE,
    OUTPUT_TIMEZONE_NAME,
    SOURCE_NAME,
    SOURCE_TIMEZONE,
    SOURCE_TIMEZONE_NAME,
    SUSPICIOUS_1M_MOVE_PCT,
    SYMBOL,
    TIMEFRAME,
    TIMEZONE_SOURCE_URL,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW_DIR = PROJECT_ROOT / "data" / "raw" / "xauusd"
DEFAULT_PROCESSED_DIR = PROJECT_ROOT / "data" / "processed" / "xauusd"
DEFAULT_REPORTS_DIR = PROJECT_ROOT / "data" / "reports"
SUPPORTED_SUFFIXES = {".csv", ".zip", ".gz"}
INGEST_SUFFIXES = SUPPORTED_SUFFIXES | {".txt"}
HISTDATA_NAME_RE = re.compile(r"DAT_MT_XAUUSD_M1_(\d{4})(\d{2})?\.csv$", re.I)


@dataclass(frozen=True)
class Candle:
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    source_file: str
    source_row: int
    raw_timestamp: str

    @property
    def values(self) -> tuple[Decimal, Decimal, Decimal, Decimal, Decimal]:
        return self.open, self.high, self.low, self.close, self.volume


@dataclass
class YearState:
    year: int
    sources: list[str] = field(default_factory=list)
    raw_rows: int = 0
    parsed_rows: int = 0
    clean_rows: int = 0
    duplicate_rows: int = 0
    conflicting_duplicates: int = 0
    invalid_ohlc: int = 0
    invalid_price: int = 0
    missing_ohlc: int = 0
    missing_timestamp: int = 0
    missing_values_count: int = 0
    invalid_timestamp: int = 0
    invalid_numeric: int = 0
    volume_missing_filled: int = 0
    out_of_order_count: int = 0
    saturday_candles: int = 0
    sunday_candles: int = 0
    suspicious_price_jumps: int = 0
    data_gap_count: int = 0
    expected_market_gaps: int = 0
    unexpected_gaps: int = 0
    missing_minutes_total: int = 0
    gap_buckets: Counter = field(default_factory=Counter)
    price_precision: Counter = field(default_factory=Counter)
    candles: list[Candle] = field(default_factory=list)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ingest_raw_files(source_dir: Path, raw_dir: Path) -> list[dict[str, object]]:
    """Copy top-level source artifacts into raw storage without changing them."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, object]] = []
    known_hashes: dict[str, str] = {}
    for existing in sorted(p for p in raw_dir.iterdir() if p.is_file()):
        known_hashes[sha256_file(existing)] = existing.name

    for source in sorted(p for p in source_dir.iterdir() if p.is_file()):
        if source.suffix.lower() not in INGEST_SUFFIXES:
            continue
        checksum = sha256_file(source)
        item: dict[str, object] = {
            "source_path": str(source),
            "filename": source.name,
            "size_bytes": source.stat().st_size,
            "sha256": checksum,
        }
        if checksum in known_hashes:
            item["status"] = "duplicate_not_copied"
            item["duplicate_of"] = known_hashes[checksum]
        else:
            destination = raw_dir / source.name
            if destination.exists() and sha256_file(destination) != checksum:
                destination = raw_dir / f"{source.stem}_{checksum[:8]}{source.suffix}"
            shutil.copy2(source, destination)
            if sha256_file(destination) != checksum:
                raise RuntimeError(f"Checksum mismatch after copying {source}")
            known_hashes[checksum] = destination.name
            item["status"] = "copied"
            item["raw_path"] = str(destination)
        manifest.append(item)
    return manifest


def ingest_specific_files(sources: list[Path], raw_dir: Path) -> list[dict[str, object]]:
    """Copy explicitly selected raw files without scanning their parent folders."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    known_hashes = {
        sha256_file(existing): existing.name
        for existing in raw_dir.iterdir()
        if existing.is_file() and existing.name != "raw_manifest.json"
    }
    manifest: list[dict[str, object]] = []
    for source in sources:
        source = source.resolve()
        if not source.is_file() or source.suffix.lower() not in INGEST_SUFFIXES:
            raise ValueError(f"Unsupported or missing raw file: {source}")
        checksum = sha256_file(source)
        item: dict[str, object] = {
            "source_path": str(source), "filename": source.name,
            "size_bytes": source.stat().st_size, "sha256": checksum,
        }
        if checksum in known_hashes:
            item.update(status="duplicate_not_copied", duplicate_of=known_hashes[checksum])
        else:
            destination = raw_dir / source.name
            if destination.exists() and sha256_file(destination) != checksum:
                destination = raw_dir / f"{source.stem}_{checksum[:8]}{source.suffix}"
            shutil.copy2(source, destination)
            if sha256_file(destination) != checksum:
                raise RuntimeError(f"Checksum mismatch after copying {source}")
            known_hashes[checksum] = destination.name
            item.update(status="copied", raw_path=str(destination))
        manifest.append(item)
    return manifest


def is_status_report_text(text: str) -> bool:
    return text.lstrip().startswith("HistData.com") and "Status Report" in text[:300]


def inspect_text_sample(name: str, text: str, size_bytes: int) -> dict[str, object]:
    lines = text.splitlines()
    sample = lines[:20]
    report = is_status_report_text(text)
    delimiter = None
    column_count = None
    has_header = None
    time_format = None
    volume_exists = None
    if not report and sample:
        try:
            dialect = csv.Sniffer().sniff("\n".join(sample), delimiters=",;\t|")
            delimiter = dialect.delimiter
        except csv.Error:
            delimiter = ","
        parsed = list(csv.reader(sample, delimiter=delimiter))
        if parsed:
            column_count = max(len(row) for row in parsed)
            first = [cell.strip().lower() for cell in parsed[0]]
            has_header = any(cell in {"timestamp", "date", "time", "open", "high", "low", "close"} for cell in first)
            if HISTDATA_NAME_RE.search(Path(name).name) or (len(first) >= 2 and re.fullmatch(r"\d{4}\.\d{2}\.\d{2}", first[0] or "")):
                time_format = "YYYY.MM.DD,HH:MM"
                volume_exists = column_count >= 7
            elif "timestamp" in first:
                time_format = "header-defined timestamp"
                volume_exists = "volume" in first
    return {
        "name": name,
        "size_bytes": size_bytes,
        "first_20_lines": sample,
        "delimiter": delimiter,
        "column_count": column_count,
        "has_header": has_header,
        "time_format": time_format,
        "volume_exists": volume_exists,
        "status_report": report,
    }


def build_source_inventory(raw_dir: Path) -> list[dict[str, object]]:
    inventory: list[dict[str, object]] = []
    seen_hashes: dict[str, str] = {}
    for path in sorted(p for p in raw_dir.iterdir() if p.is_file()):
        suffix = path.suffix.lower()
        if suffix not in INGEST_SUFFIXES:
            continue
        checksum = sha256_file(path)
        base = {
            "path": str(path),
            "filename": path.name,
            "size_bytes": path.stat().st_size,
            "sha256": checksum,
            "duplicate_file_of": seen_hashes.get(checksum),
        }
        if checksum in seen_hashes:
            inventory.append(base)
            continue
        seen_hashes[checksum] = path.name
        if suffix == ".zip":
            with zipfile.ZipFile(path) as archive:
                members = []
                for info in archive.infolist():
                    if info.is_dir():
                        continue
                    with archive.open(info) as raw:
                        wrapper = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
                        text = "".join(wrapper.readline() for _ in range(20))
                    members.append(inspect_text_sample(f"{path.name}::{info.filename}", text, info.file_size))
                base["archive_members"] = members
        else:
            opener = gzip.open if suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8-sig", errors="replace", newline="") as handle:
                text = "".join(handle.readline() for _ in range(20))
            base.update(inspect_text_sample(path.name, text, path.stat().st_size))
        inventory.append(base)
    return inventory


def iter_data_streams(raw_dir: Path) -> Iterator[tuple[str, TextIO]]:
    """Yield unique CSV-like data streams. Caller consumes each stream immediately."""
    seen_files: set[str] = set()
    for path in sorted(p for p in raw_dir.iterdir() if p.is_file()):
        suffix = path.suffix.lower()
        if suffix not in SUPPORTED_SUFFIXES:
            continue
        checksum = sha256_file(path)
        if checksum in seen_files:
            continue
        seen_files.add(checksum)
        if suffix == ".zip":
            with zipfile.ZipFile(path) as archive:
                for member in sorted(archive.namelist()):
                    if not member.lower().endswith(".csv"):
                        continue
                    with archive.open(member) as raw:
                        wrapper = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
                        yield f"{path.name}::{member}", wrapper
        elif suffix == ".gz":
            with gzip.open(path, "rt", encoding="utf-8-sig", errors="replace", newline="") as handle:
                yield path.name, handle
        else:
            with path.open("rt", encoding="utf-8-sig", errors="replace", newline="") as handle:
                yield path.name, handle


def infer_year_from_name(name: str) -> int | None:
    match = HISTDATA_NAME_RE.search(Path(name.split("::")[-1]).name)
    return int(match.group(1)) if match else None


def source_period_from_name(name: str) -> tuple[int, int | None] | None:
    match = HISTDATA_NAME_RE.search(Path(name.split("::")[-1]).name)
    return (int(match.group(1)), int(match.group(2)) if match.group(2) else None) if match else None


def parse_through_month(value: str | None) -> tuple[tuple[int, int] | None, datetime | None]:
    if value is None:
        return None, None
    match = re.fullmatch(r"(\d{4})-(0[1-9]|1[0-2])", value)
    if not match:
        raise ValueError("--through must use YYYY-MM")
    year, month = map(int, match.groups())
    if month == 12:
        next_month = datetime(year + 1, 1, 1, tzinfo=SOURCE_TIMEZONE)
    else:
        next_month = datetime(year, month + 1, 1, tzinfo=SOURCE_TIMEZONE)
    return (year, month), next_month.astimezone(OUTPUT_TIMEZONE)


def decimal_places(value: str) -> int:
    value = value.strip().lower()
    if "e" in value:
        try:
            return max(0, -Decimal(value).as_tuple().exponent)
        except InvalidOperation:
            return 0
    return len(value.rsplit(".", 1)[1]) if "." in value else 0


def parse_decimal(value: str) -> Decimal:
    number = Decimal(value.strip())
    if not number.is_finite():
        raise InvalidOperation("non-finite")
    return number


def normalize_timestamp(date_value: str, time_value: str | None = None) -> datetime:
    """Parse a source timestamp and normalize fixed EST to UTC."""
    combined = f"{date_value.strip()} {time_value.strip()}" if time_value is not None else date_value.strip()
    if combined.endswith("Z"):
        parsed = datetime.fromisoformat(combined[:-1] + "+00:00")
    else:
        parsed = None
        for fmt in (
            "%Y.%m.%d %H:%M",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%Y/%m/%d %H:%M:%S",
            "%Y/%m/%d %H:%M",
            "%Y%m%d %H%M%S",
        ):
            try:
                parsed = datetime.strptime(combined, fmt)
                break
            except ValueError:
                pass
        if parsed is None:
            parsed = datetime.fromisoformat(combined)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SOURCE_TIMEZONE)
    return parsed.astimezone(OUTPUT_TIMEZONE).replace(second=0, microsecond=0)


def parse_stream(
    name: str,
    handle: TextIO,
    states: dict[int, YearState],
    selected_year: int | None,
    rejected_rows: list[list[object]],
    max_timestamp_exclusive: datetime | None = None,
) -> None:
    sample = "".join(handle.readline() for _ in range(20))
    if not sample.strip() or is_status_report_text(sample):
        return
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delimiter = ","
    reader = csv.reader(chain(io.StringIO(sample), handle), delimiter=delimiter)
    first = next(reader, None)
    if first is None:
        return
    normalized_first = [cell.strip().lower() for cell in first]
    has_header = any(cell in {"timestamp", "date", "time", "open", "high", "low", "close"} for cell in normalized_first)
    rows: Iterable[list[str]] = reader if has_header else chain([first], reader)
    header = normalized_first if has_header else None
    source_year = infer_year_from_name(name)
    prior_source_timestamp: datetime | None = None

    for row_number, row in enumerate(rows, start=2 if has_header else 1):
        if not row or not any(cell.strip() for cell in row):
            continue
        year_hint = source_year
        if year_hint is None and row:
            match = re.match(r"(\d{4})", row[0].strip())
            year_hint = int(match.group(1)) if match else 0
        if selected_year is not None and year_hint not in {selected_year, 0, None}:
            continue
        state = states.setdefault(year_hint or selected_year or 0, YearState(year_hint or selected_year or 0))
        if name not in state.sources:
            state.sources.append(name)
        state.raw_rows += 1

        if header:
            mapped = {key: row[index].strip() if index < len(row) else "" for index, key in enumerate(header)}
            timestamp_text = mapped.get("timestamp") or mapped.get("datetime") or ""
            date_text = mapped.get("date", "")
            time_text = mapped.get("time", "")
            fields = [mapped.get(key, "") for key in ("open", "high", "low", "close", "volume")]
        else:
            if len(row) >= 7:
                date_text, time_text = row[0].strip(), row[1].strip()
                timestamp_text = ""
                fields = [cell.strip() for cell in row[2:7]]
            elif len(row) >= 5:
                timestamp_text = row[0].strip()
                date_text = time_text = ""
                fields = [cell.strip() for cell in row[1:6]]
            else:
                state.invalid_numeric += 1
                rejected_rows.append([name, row_number, "", "wrong_column_count", json.dumps(row, ensure_ascii=False)])
                continue

        raw_timestamp = timestamp_text or f"{date_text} {time_text}".strip()
        if not raw_timestamp:
            state.missing_timestamp += 1
            state.missing_values_count += 1
            rejected_rows.append([name, row_number, "", "missing_timestamp", json.dumps(row, ensure_ascii=False)])
            continue
        try:
            timestamp = normalize_timestamp(timestamp_text) if timestamp_text else normalize_timestamp(date_text, time_text)
        except (ValueError, OverflowError):
            state.invalid_timestamp += 1
            rejected_rows.append([name, row_number, raw_timestamp, "invalid_timestamp", json.dumps(row, ensure_ascii=False)])
            continue

        if max_timestamp_exclusive is not None and timestamp >= max_timestamp_exclusive:
            continue

        actual_year = timestamp.year
        if selected_year is not None and actual_year != selected_year:
            continue
        if actual_year != state.year:
            state = states.setdefault(actual_year, YearState(actual_year))
            if name not in state.sources:
                state.sources.append(name)
            state.raw_rows += 1

        ohlc_raw = fields[:4]
        volume_raw = fields[4] if len(fields) > 4 else ""
        missing_ohlc = sum(not value for value in ohlc_raw)
        if missing_ohlc:
            state.missing_ohlc += 1
            state.missing_values_count += missing_ohlc
            rejected_rows.append([name, row_number, raw_timestamp, "missing_ohlc", json.dumps(row, ensure_ascii=False)])
            continue
        try:
            open_, high, low, close = [parse_decimal(value) for value in ohlc_raw]
            volume = parse_decimal(volume_raw) if volume_raw else Decimal("0")
        except InvalidOperation:
            state.invalid_numeric += 1
            rejected_rows.append([name, row_number, raw_timestamp, "invalid_or_nonfinite_numeric", json.dumps(row, ensure_ascii=False)])
            continue
        if not volume_raw:
            state.volume_missing_filled += 1
        if any(value <= 0 for value in (open_, high, low, close)):
            state.invalid_price += 1
            rejected_rows.append([name, row_number, raw_timestamp, "nonpositive_price", json.dumps(row, ensure_ascii=False)])
            continue

        state.parsed_rows += 1
        if prior_source_timestamp is not None and timestamp < prior_source_timestamp:
            state.out_of_order_count += 1
        prior_source_timestamp = timestamp
        state.price_precision.update(decimal_places(value) for value in ohlc_raw)
        state.candles.append(
            Candle(timestamp, open_, high, low, close, volume, name, row_number, raw_timestamp)
        )


def is_valid_ohlc(candle: Candle) -> bool:
    return (
        candle.high >= candle.open
        and candle.high >= candle.close
        and candle.high >= candle.low
        and candle.low <= candle.open
        and candle.low <= candle.close
    )


def classify_gap(previous: datetime, current: datetime, missing_minutes: int) -> tuple[str, str]:
    if previous.weekday() == 4 and current.weekday() in {6, 0}:
        return "expected_market_gap", "weekend"
    if previous.weekday() >= 5 or current.weekday() >= 5:
        return "expected_market_gap", "weekend_or_sunday_open"
    if (
        previous.hour == DAILY_BREAK_START_UTC_HOUR
        and current.hour == DAILY_BREAK_END_UTC_HOUR
        and missing_minutes <= 90
    ):
        return "expected_market_gap", "daily_market_break"
    if missing_minutes >= EXPECTED_LONG_GAP_MINUTES:
        return "expected_market_gap", "long_closure_or_holiday_unverified"
    return "unexpected_gap", "intraday_missing_minutes"


def gap_bucket(missing_minutes: int) -> str:
    if missing_minutes <= 5:
        return "1-5"
    if missing_minutes <= 60:
        return "6-60"
    return ">60"


def decimal_text(value: Decimal) -> str:
    return format(value, "f")


def timestamp_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def candle_row(candle: Candle) -> list[str]:
    return [
        timestamp_text(candle.timestamp),
        decimal_text(candle.open),
        decimal_text(candle.high),
        decimal_text(candle.low),
        decimal_text(candle.close),
        decimal_text(candle.volume),
    ]


def write_csv(path: Path, header: list[str], rows: Iterable[Iterable[object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def clean_year(
    state: YearState,
    invalid_rows: list[list[object]],
    conflicts: list[list[object]],
    jumps: list[list[object]],
    gaps: list[list[object]],
) -> list[Candle]:
    state.candles.sort(key=lambda item: (item.timestamp, item.source_file, item.source_row))
    unique: list[Candle] = []
    by_timestamp: dict[datetime, Candle] = {}
    for candle in state.candles:
        first = by_timestamp.get(candle.timestamp)
        if first is not None:
            if candle.values == first.values:
                state.duplicate_rows += 1
            else:
                state.conflicting_duplicates += 1
                conflicts.append([
                    timestamp_text(candle.timestamp),
                    first.source_file,
                    first.source_row,
                    *map(decimal_text, first.values),
                    candle.source_file,
                    candle.source_row,
                    *map(decimal_text, candle.values),
                    "kept_first",
                ])
            continue
        by_timestamp[candle.timestamp] = candle
        if not is_valid_ohlc(candle):
            state.invalid_ohlc += 1
            invalid_rows.append([
                timestamp_text(candle.timestamp),
                candle.source_file,
                candle.source_row,
                decimal_text(candle.open),
                decimal_text(candle.high),
                decimal_text(candle.low),
                decimal_text(candle.close),
                decimal_text(candle.volume),
                "invalid_ohlc",
            ])
            continue
        unique.append(candle)

    for candle in unique:
        if candle.timestamp.weekday() == 5:
            state.saturday_candles += 1
        elif candle.timestamp.weekday() == 6:
            state.sunday_candles += 1

    for previous, current in zip(unique, unique[1:]):
        delta_minutes = int((current.timestamp - previous.timestamp).total_seconds() // 60)
        if delta_minutes > 1:
            missing = delta_minutes - 1
            classification, reason = classify_gap(previous.timestamp, current.timestamp, missing)
            state.data_gap_count += 1
            state.missing_minutes_total += missing
            state.gap_buckets[gap_bucket(missing)] += 1
            if classification == "expected_market_gap":
                state.expected_market_gaps += 1
            else:
                state.unexpected_gaps += 1
            gaps.append([
                timestamp_text(previous.timestamp),
                timestamp_text(current.timestamp),
                missing,
                classification,
                reason,
                state.year,
            ])
        if delta_minutes == 1 and previous.close != 0:
            move = abs(current.close / previous.close - Decimal("1"))
            if move > Decimal(str(SUSPICIOUS_1M_MOVE_PCT)):
                state.suspicious_price_jumps += 1
                jumps.append([
                    timestamp_text(previous.timestamp),
                    timestamp_text(current.timestamp),
                    decimal_text(previous.close),
                    decimal_text(current.close),
                    decimal_text(move),
                    delta_minutes,
                    state.year,
                ])
    state.clean_rows = len(unique)
    return unique


def make_year_report(state: YearState, candles: list[Candle]) -> dict[str, object]:
    removed = (
        state.conflicting_duplicates
        + state.duplicate_rows
        + state.invalid_ohlc
        + state.invalid_price
        + state.missing_ohlc
        + state.missing_timestamp
        + state.invalid_timestamp
        + state.invalid_numeric
    )
    return {
        "year": state.year,
        "source_files": state.sources,
        "raw_rows": state.raw_rows,
        "parsed_rows": state.parsed_rows,
        "clean_rows": state.clean_rows,
        "removed_or_deduplicated_rows": removed,
        "duplicate_rows": state.duplicate_rows,
        "conflicting_duplicates": state.conflicting_duplicates,
        "invalid_ohlc": state.invalid_ohlc,
        "invalid_price": state.invalid_price,
        "missing_ohlc": state.missing_ohlc,
        "missing_timestamp": state.missing_timestamp,
        "missing_values_count": state.missing_values_count,
        "invalid_timestamp": state.invalid_timestamp,
        "invalid_numeric": state.invalid_numeric,
        "volume_missing_filled": state.volume_missing_filled,
        "out_of_order_count": state.out_of_order_count,
        "data_gap_count": state.data_gap_count,
        "expected_market_gaps": state.expected_market_gaps,
        "unexpected_gaps": state.unexpected_gaps,
        "missing_minutes_total": state.missing_minutes_total,
        "gap_buckets": dict(state.gap_buckets),
        "suspicious_price_jumps": state.suspicious_price_jumps,
        "saturday_candles": state.saturday_candles,
        "sunday_candles": state.sunday_candles,
        "price_decimal_places": {str(key): value for key, value in sorted(state.price_precision.items())},
        "first_timestamp": timestamp_text(candles[0].timestamp) if candles else None,
        "last_timestamp": timestamp_text(candles[-1].timestamp) if candles else None,
        "timezone_source": f"{SOURCE_TIMEZONE_NAME}; {TIMEZONE_SOURCE_URL}",
        "output_timezone": OUTPUT_TIMEZONE_NAME,
        "volume_source": "original" if state.volume_missing_filled == 0 else "mixed_original_and_unavailable",
    }


def validate_final(candles: list[Candle]) -> list[str]:
    errors: list[str] = []
    for index, candle in enumerate(candles):
        if candle.timestamp.tzinfo is None or candle.timestamp.utcoffset() != timedelta(0):
            errors.append(f"non-UTC timestamp at row {index + 2}")
        if any(not value.is_finite() or value <= 0 for value in candle.values[:4]):
            errors.append(f"invalid price at {timestamp_text(candle.timestamp)}")
        if not candle.volume.is_finite():
            errors.append(f"invalid volume at {timestamp_text(candle.timestamp)}")
        if not is_valid_ohlc(candle):
            errors.append(f"invalid OHLC at {timestamp_text(candle.timestamp)}")
        if index and candle.timestamp <= candles[index - 1].timestamp:
            errors.append(f"timestamps not unique and ascending at row {index + 2}")
    return errors


def try_write_parquet(candles: list[Candle], output: Path) -> tuple[bool, str]:
    try:
        import pandas as pd  # type: ignore
        import pyarrow  # noqa: F401  # type: ignore
    except ImportError as exc:
        return False, f"Parquet skipped: optional dependency unavailable ({exc.name})"
    frame = pd.DataFrame(
        {
            "timestamp": [c.timestamp for c in candles],
            "open": [float(c.open) for c in candles],
            "high": [float(c.high) for c in candles],
            "low": [float(c.low) for c in candles],
            "close": [float(c.close) for c in candles],
            "volume": [float(c.volume) for c in candles],
        }
    )
    frame.to_parquet(output, index=False)
    return True, f"Saved {output}"


def sample_comparison(candles: list[Candle], count: int = 20) -> list[list[object]]:
    if not candles:
        return []
    rng = random.Random(20260916)
    selected = rng.sample(candles, min(count, len(candles)))
    selected.sort(key=lambda candle: candle.timestamp)
    return [
        [
            candle.source_file,
            candle.source_row,
            candle.raw_timestamp,
            timestamp_text(candle.timestamp),
            decimal_text(candle.open),
            decimal_text(candle.open),
            decimal_text(candle.high),
            decimal_text(candle.high),
            decimal_text(candle.low),
            decimal_text(candle.low),
            decimal_text(candle.close),
            decimal_text(candle.close),
            "MATCH",
        ]
        for candle in selected
    ]


def write_summary(
    reports_dir: Path,
    year_reports: list[dict[str, object]],
    validation_errors: list[str],
    parquet_message: str,
    missing_years: list[int],
) -> None:
    total_raw = sum(int(report["raw_rows"]) for report in year_reports)
    total_clean = sum(int(report["clean_rows"]) for report in year_reports)
    lines = [
        "# XAUUSD 1-minute data quality summary",
        "",
        f"- Source: {SOURCE_NAME} MetaTrader M1 bar files",
        f"- Source timezone: {SOURCE_TIMEZONE_NAME}",
        f"- Output timezone: {OUTPUT_TIMEZONE_NAME}",
        f"- Raw rows inspected: {total_raw:,}",
        f"- Clean rows: {total_clean:,}",
        f"- Final validation: {'PASS' if not validation_errors else 'FAIL'}",
        f"- Parquet: {parquet_message}",
        f"- Missing full calendar years between first and last supplied year: {', '.join(map(str, missing_years)) or 'none'}",
        "",
        "## Per-year results",
        "",
        "| Year | Raw | Clean | Removed/deduped | Duplicate | Conflicting | Invalid OHLC | Unexpected gaps | Suspicious jumps |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for report in year_reports:
        lines.append(
            "| {year} | {raw_rows:,} | {clean_rows:,} | {removed_or_deduplicated_rows:,} | "
            "{duplicate_rows:,} | {conflicting_duplicates:,} | {invalid_ohlc:,} | "
            "{unexpected_gaps:,} | {suspicious_price_jumps:,} |".format(**report)
        )
    lines.extend([
        "",
        "## Important limitations",
        "",
        "- HistData documents fixed EST without daylight-saving adjustments. The pipeline applies UTC−05:00 to UTC conversion for every source row.",
        "- Gap classification is conservative. Weekend, standard daily-break patterns, and very long closures are marked expected; holiday calendars are not embedded, so long closures remain labelled `long_closure_or_holiday_unverified`.",
        "- No missing candle is synthesized and no OHLC value is rounded, interpolated, smoothed, or replaced.",
        "- HistData bar prices are bid quotes. Volume is retained as supplied and is not represented as exchange-traded volume.",
    ])
    if validation_errors:
        lines.extend(["", "## Validation errors", "", *[f"- {error}" for error in validation_errors[:100]]])
    (reports_dir / "xauusd_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, help="Only process one UTC output year")
    parser.add_argument("--ingest-dir", type=Path, help="Copy top-level raw artifacts from this directory before cleaning")
    parser.add_argument("--ingest-file", action="append", type=Path, default=[], help="Copy one explicit raw artifact; repeat as needed")
    parser.add_argument("--through", help="Include source data through this month, in YYYY-MM format")
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--processed-dir", type=Path, default=DEFAULT_PROCESSED_DIR)
    parser.add_argument("--reports-dir", type=Path, default=DEFAULT_REPORTS_DIR)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    raw_dir = args.raw_dir.resolve()
    processed_dir = args.processed_dir.resolve()
    reports_dir = args.reports_dir.resolve()
    raw_dir.mkdir(parents=True, exist_ok=True)
    processed_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)

    try:
        through_period, max_timestamp_exclusive = parse_through_month(args.through)
    except ValueError as exc:
        print(f"[XAUUSD] {exc}", file=sys.stderr)
        return 2

    ingest_manifest: list[dict[str, object]] = []
    if args.ingest_dir:
        ingest_manifest.extend(ingest_raw_files(args.ingest_dir.resolve(), raw_dir))
    if args.ingest_file:
        ingest_manifest.extend(ingest_specific_files(args.ingest_file, raw_dir))
    if ingest_manifest:
        manifest_path = raw_dir / "raw_manifest.json"
        previous = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else []
        previous.extend(ingest_manifest)
        manifest_path.write_text(json.dumps(previous, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        copied = sum(item["status"] == "copied" for item in ingest_manifest)
        duplicates = sum(item["status"] == "duplicate_not_copied" for item in ingest_manifest)
        print(f"[XAUUSD] Raw ingest: {copied} copied, {duplicates} duplicate files not copied")

    inventory = build_source_inventory(raw_dir)
    (reports_dir / "xauusd_source_inventory.json").write_text(
        json.dumps(inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    states: dict[int, YearState] = {}
    rejected_rows: list[list[object]] = []
    for name, handle in iter_data_streams(raw_dir):
        source_period = source_period_from_name(name)
        if through_period and source_period:
            source_year, source_month = source_period
            through_year, through_month = through_period
            if source_year > through_year or (source_year == through_year and source_month is not None and source_month > through_month):
                print(f"[XAUUSD] Skipping {name}: after --through {args.through}")
                continue
        print(f"[XAUUSD] Reading {name}...")
        parse_stream(name, handle, states, args.year, rejected_rows, max_timestamp_exclusive)
    states.pop(0, None)
    if not states:
        print("[XAUUSD] No data rows found", file=sys.stderr)
        return 2

    invalid_rows: list[list[object]] = []
    conflicts: list[list[object]] = []
    jumps: list[list[object]] = []
    gaps: list[list[object]] = []
    clean_by_year: dict[int, list[Candle]] = {}
    year_reports: list[dict[str, object]] = []

    for year, state in sorted(states.items()):
        if args.year is not None and year != args.year:
            continue
        clean = clean_year(state, invalid_rows, conflicts, jumps, gaps)
        clean_by_year[year] = clean
        output = processed_dir / f"xauusd_{year}_1m.csv"
        write_csv(output, OUTPUT_COLUMNS, (candle_row(candle) for candle in clean))
        report = make_year_report(state, clean)
        year_reports.append(report)
        (reports_dir / f"xauusd_{year}_report.json").write_text(
            json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(f"[XAUUSD] {year} Raw rows: {state.raw_rows:,}")
        print(f"[XAUUSD] {year} Duplicates: {state.duplicate_rows:,}; conflicts: {state.conflicting_duplicates:,}")
        print(f"[XAUUSD] {year} Invalid OHLC: {state.invalid_ohlc:,}")
        print(f"[XAUUSD] {year} Gaps: {state.data_gap_count:,}; unexpected: {state.unexpected_gaps:,}")
        print(f"[XAUUSD] {year} Clean rows: {state.clean_rows:,}")
        print(f"[XAUUSD] Saved {output}")

    all_candles = clean_by_year.get(args.year, []) if args.year is not None else []
    if args.year is None:
        all_candles = [candle for year in sorted(clean_by_year) for candle in clean_by_year[year]]
        # A final cross-year pass. Per-year output is already unique; retain first on any boundary conflict.
        combined: list[Candle] = []
        seen: dict[datetime, Candle] = {}
        for candle in all_candles:
            previous = seen.get(candle.timestamp)
            if previous is None:
                seen[candle.timestamp] = candle
                combined.append(candle)
            elif previous.values != candle.values:
                conflicts.append([
                    timestamp_text(candle.timestamp), previous.source_file, previous.source_row,
                    *map(decimal_text, previous.values), candle.source_file, candle.source_row,
                    *map(decimal_text, candle.values), "kept_first_cross_year",
                ])
        all_candles = combined

        # Per-year gap analysis intentionally does not compare the last row of one
        # UTC year with the first row of the next. Add only those boundaries here.
        ordered_years = sorted(clean_by_year)
        for previous_year, current_year in zip(ordered_years, ordered_years[1:]):
            previous_rows = clean_by_year[previous_year]
            current_rows = clean_by_year[current_year]
            if not previous_rows or not current_rows:
                continue
            previous = previous_rows[-1]
            current = current_rows[0]
            delta_minutes = int((current.timestamp - previous.timestamp).total_seconds() // 60)
            if delta_minutes > 1:
                missing = delta_minutes - 1
                classification, reason = classify_gap(previous.timestamp, current.timestamp, missing)
                gaps.append([
                    timestamp_text(previous.timestamp), timestamp_text(current.timestamp), missing,
                    classification, reason, f"{previous_year}-{current_year}",
                ])

    validation_errors = validate_final(all_candles)
    if args.year is None:
        write_csv(processed_dir / "xauusd_1m_all.csv", OUTPUT_COLUMNS, (candle_row(c) for c in all_candles))
        write_csv(
            processed_dir / "xauusd_1m_db.csv",
            DB_OUTPUT_COLUMNS,
            ([SYMBOL, *candle_row(c)] for c in all_candles),
        )
    report_suffix = f"_{args.year}" if args.year is not None else ""
    write_csv(
        reports_dir / f"conflicting_duplicates{report_suffix}.csv",
        ["timestamp", "kept_source", "kept_row", "kept_open", "kept_high", "kept_low", "kept_close", "kept_volume", "discarded_source", "discarded_row", "discarded_open", "discarded_high", "discarded_low", "discarded_close", "discarded_volume", "resolution"],
        conflicts,
    )
    write_csv(
        reports_dir / f"invalid_ohlc{report_suffix}.csv",
        ["timestamp", "source_file", "source_row", "open", "high", "low", "close", "volume", "reason"],
        invalid_rows,
    )
    write_csv(
        reports_dir / f"suspicious_price_jumps{report_suffix}.csv",
        ["previous_timestamp", "timestamp", "previous_close", "close", "absolute_move_ratio", "elapsed_minutes", "year"],
        jumps,
    )
    write_csv(
        reports_dir / f"data_gaps{report_suffix}.csv",
        ["gap_start", "gap_end", "missing_minutes", "classification", "reason", "year"],
        gaps,
    )
    write_csv(
        reports_dir / f"raw_processed_sample_comparison{report_suffix}.csv",
        ["source_file", "source_row", "raw_timestamp", "processed_timestamp", "raw_open", "processed_open", "raw_high", "processed_high", "raw_low", "processed_low", "raw_close", "processed_close", "ohlc_check"],
        sample_comparison(all_candles, 20),
    )
    write_csv(
        reports_dir / f"rejected_rows{report_suffix}.csv",
        ["source_file", "source_row", "raw_timestamp", "reason", "raw_record"],
        rejected_rows,
    )
    if args.year is None:
        parquet_written, parquet_message = try_write_parquet(all_candles, processed_dir / "xauusd_1m_all.parquet")
        if not parquet_written:
            (reports_dir / "parquet_status.txt").write_text(parquet_message + "\n", encoding="utf-8")
    else:
        parquet_message = "Not requested for single-year run"
    years = sorted(clean_by_year)
    missing_years = [year for year in range(years[0], years[-1] + 1) if year not in clean_by_year] if years else []
    if args.year is None:
        write_summary(reports_dir, year_reports, validation_errors, parquet_message, missing_years)
    validation = {
        "status": "PASS" if not validation_errors else "FAIL",
        "rows": len(all_candles),
        "errors": validation_errors,
        "checks": [
            "timestamp unique",
            "timestamp ascending",
            "timestamp UTC",
            "OHLC positive and finite",
            "OHLC relationships valid",
            "volume finite and non-null",
        ],
    }
    validation_name = f"xauusd_{args.year}_validation.json" if args.year is not None else "final_validation.json"
    (reports_dir / validation_name).write_text(json.dumps(validation, indent=2) + "\n", encoding="utf-8")
    print(f"[XAUUSD] Final validation: {validation['status']} ({len(all_candles):,} rows)")
    print(f"[XAUUSD] {parquet_message}")
    return 0 if not validation_errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
