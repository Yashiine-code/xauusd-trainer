#!/usr/bin/env python3
"""Build immutable 1m/3m/5m/15m/1H CSVs from the cleaned 1m authority."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data/processed/xauusd/xauusd_1m_all.csv"
DEFAULT_OUTPUT = ROOT / "data/aggregated/xauusd"
TIMEFRAMES = {"3m": 3, "5m": 5, "15m": 15, "1H": 60}
HEADER = ["timestamp", "open", "high", "low", "close", "volume"]


@dataclass
class Aggregate:
    timestamp: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_timestamp(value: str) -> datetime:
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if timestamp.tzinfo != timezone.utc:
        timestamp = timestamp.astimezone(timezone.utc)
    return timestamp


def format_timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bucket_start(timestamp: datetime, minutes: int) -> datetime:
    epoch = int(timestamp.timestamp())
    return datetime.fromtimestamp((epoch // (minutes * 60)) * minutes * 60, timezone.utc)


def write_aggregate(writer: csv.writer, candle: Aggregate) -> None:
    writer.writerow([
        format_timestamp(candle.timestamp),
        str(candle.open), str(candle.high), str(candle.low), str(candle.close), str(candle.volume),
    ])


def build(source: Path, output: Path, force: bool = False) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    source_hash = checksum(source)
    manifest_path = output / "manifest.json"
    targets = {name: output / f"xauusd_{name}.csv" for name in ["1m", *TIMEFRAMES]}
    if not force and manifest_path.exists() and all(path.exists() for path in targets.values()):
        existing = json.loads(manifest_path.read_text())
        if existing.get("source_sha256") == source_hash:
            logging.info("Outputs are current; source checksum is unchanged.")
            return existing

    temp_paths = {name: path.with_suffix(".csv.tmp") for name, path in targets.items() if name != "1m"}
    handles = {name: path.open("w", newline="") for name, path in temp_paths.items()}
    writers = {name: csv.writer(handles[name]) for name in handles}
    for writer in writers.values():
        writer.writerow(HEADER)

    active: dict[str, Aggregate] = {}
    counts = {"1m": 0, **{name: 0 for name in TIMEFRAMES}}
    first_timestamp = last_timestamp = None
    previous = None
    try:
        with source.open(newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames != HEADER:
                raise ValueError(f"Expected columns {HEADER}, found {reader.fieldnames}")
            for row_number, row in enumerate(reader, 2):
                timestamp = parse_timestamp(row["timestamp"])
                if previous is not None and timestamp <= previous:
                    raise ValueError(f"Source is not strictly ascending at row {row_number}")
                previous = timestamp
                first_timestamp = first_timestamp or timestamp
                last_timestamp = timestamp
                values = [Decimal(row[name]) for name in HEADER[1:]]
                open_, high, low, close, volume = values
                if min(open_, high, low, close) <= 0 or low > min(open_, close) or high < max(open_, close):
                    raise ValueError(f"Invalid OHLC at row {row_number}")
                counts["1m"] += 1
                for name, minutes in TIMEFRAMES.items():
                    bucket = bucket_start(timestamp, minutes)
                    current = active.get(name)
                    if current is None or current.timestamp != bucket:
                        if current is not None:
                            write_aggregate(writers[name], current)
                            counts[name] += 1
                        active[name] = Aggregate(bucket, open_, high, low, close, volume)
                    else:
                        current.high = max(current.high, high)
                        current.low = min(current.low, low)
                        current.close = close
                        current.volume += volume
                if counts["1m"] % 250_000 == 0:
                    logging.info("Processed %s source rows", f'{counts["1m"]:,}')
        for name, current in active.items():
            write_aggregate(writers[name], current)
            counts[name] += 1
    finally:
        for handle in handles.values():
            handle.close()

    source_copy = targets["1m"].with_suffix(".csv.tmp")
    shutil.copyfile(source, source_copy)
    source_copy.replace(targets["1m"])
    for name, path in temp_paths.items():
        path.replace(targets[name])

    try:
        source_label = str(source.relative_to(ROOT))
    except ValueError:
        source_label = str(source)
    manifest = {
        "symbol": "XAUUSD",
        "source": source_label,
        "source_sha256": source_hash,
        "timezone": "UTC",
        "first_timestamp": format_timestamp(first_timestamp),
        "last_timestamp": format_timestamp(last_timestamp),
        "rows": counts,
        "timeframes": ["1m", "3m", "5m", "15m", "1H"],
    }
    manifest_path.with_suffix(".json.tmp").write_text(json.dumps(manifest, indent=2) + "\n")
    manifest_path.with_suffix(".json.tmp").replace(manifest_path)
    logging.info("Aggregation complete: %s", counts)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(json.dumps(build(args.source.resolve(), args.output.resolve(), args.force), indent=2))


if __name__ == "__main__":
    main()
