#!/usr/bin/env python3
"""Build a bounded, immutable R2 market-data POC from the verified 1m CSV."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data/processed/xauusd/xauusd_2026_1m.csv"
DEFAULT_OUTPUT = ROOT / "data/r2-poc"
TIMEFRAMES = {"1m": 1, "15m": 15, "1H": 60}


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def compact_number(value: str) -> int | float:
    parsed = float(value)
    return int(parsed) if parsed.is_integer() else parsed


def aggregate(rows: list[list[int | float]], minutes: int) -> list[list[int | float]]:
    if minutes == 1:
        return rows
    seconds = minutes * 60
    result: list[list[int | float]] = []
    for timestamp, open_, high, low, close, volume in rows:
        bucket = int(timestamp) // seconds * seconds
        if not result or result[-1][0] != bucket:
            result.append([bucket, open_, high, low, close, volume])
        else:
            current = result[-1]
            current[2] = max(current[2], high)
            current[3] = min(current[3], low)
            current[4] = close
            current[5] += volume
    return result


def write_json(path: Path, value: object) -> tuple[int, str]:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return len(payload), hashlib.sha256(payload).hexdigest()


def build(source: Path, output: Path, start: datetime, end: datetime) -> dict:
    by_day: dict[str, list[list[int | float]]] = defaultdict(list)
    with source.open(newline="") as handle:
        for row in csv.DictReader(handle):
            timestamp = parse_timestamp(row["timestamp"])
            if timestamp < start or timestamp >= end:
                continue
            by_day[timestamp.strftime("%Y-%m-%d")].append([
                int(timestamp.timestamp()),
                compact_number(row["open"]),
                compact_number(row["high"]),
                compact_number(row["low"]),
                compact_number(row["close"]),
                compact_number(row["volume"]),
            ])

    if not by_day:
        raise ValueError("The selected POC range contains no candles.")

    manifest: dict[str, object] = {
        "version": 1,
        "symbol": "XAUUSD",
        "format": "compact-json-v1",
        "timezone": "UTC",
        "range": {"start": int(start.timestamp()), "endExclusive": int(end.timestamp())},
        "cacheControl": "public, max-age=31536000, immutable",
        "columns": ["timestamp", "open", "high", "low", "close", "volume"],
        "timeframes": {},
    }
    timeframe_manifest: dict[str, object] = {}
    for timeframe, minutes in TIMEFRAMES.items():
        objects = []
        total_rows = 0
        total_bytes = 0
        for day, source_rows in sorted(by_day.items()):
            rows = aggregate(source_rows, minutes)
            year, month, _ = day.split("-")
            key = f"xauusd/v1/{timeframe}/{year}/{month}/{day}.json"
            size, sha256 = write_json(output / key, rows)
            objects.append({
                "date": day,
                "key": key,
                "firstTimestamp": rows[0][0],
                "lastTimestamp": rows[-1][0],
                "rowCount": len(rows),
                "bytes": size,
                "sha256": sha256,
            })
            total_rows += len(rows)
            total_bytes += size
        timeframe_manifest[timeframe] = {
            "rows": total_rows,
            "bytes": total_bytes,
            "objects": objects,
        }
    manifest["timeframes"] = timeframe_manifest
    write_json(output / "xauusd/v1/manifest.json", manifest)
    return manifest


def utc_date(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--start", type=utc_date, default=utc_date("2026-01-01"))
    parser.add_argument("--end", type=utc_date, default=utc_date("2026-02-01"))
    args = parser.parse_args()
    manifest = build(args.source.resolve(), args.output.resolve(), args.start, args.end)
    summary = {
        timeframe: {"rows": value["rows"], "bytes": value["bytes"], "objects": len(value["objects"])}
        for timeframe, value in manifest["timeframes"].items()
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
