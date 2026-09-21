#!/usr/bin/env python3
"""Normalize standard or HistData XAUUSD one-minute CSV into server-only compact JSON."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path


def resolve_input(raw_path: str) -> Path:
    path = Path(raw_path).expanduser().resolve()
    if path.is_dir():
        candidates = sorted(path.glob("*.csv"))
        if not candidates:
            raise FileNotFoundError(f"No CSV file found in {path}")
        return candidates[0]
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def parse_timestamp(value: str) -> int:
    normalized = value.strip()
    formats = (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y.%m.%d %H:%M:%S",
        "%Y.%m.%d %H:%M",
        "%Y%m%d %H%M%S",
    )
    for pattern in formats:
        try:
            return int(datetime.strptime(normalized, pattern).replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    raise ValueError(f"Unsupported timestamp: {value}")


def read_candles(path: Path) -> list[list[float | int]]:
    output: list[list[float | int]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.reader(source)
        first = next(reader, None)
        if first is None:
            return output

        has_header = first[0].strip().lower() in {"timestamp", "date", "datetime"}
        rows = reader if has_header else iter([first, *reader])

        for line_number, row in enumerate(rows, start=2 if has_header else 1):
            if not row or all(not cell.strip() for cell in row):
                continue
            try:
                if len(row) >= 7 and "." in row[0] and ":" in row[1]:
                    timestamp = parse_timestamp(f"{row[0]} {row[1]}")
                    values = row[2:7]
                else:
                    timestamp = parse_timestamp(row[0])
                    values = row[1:6]

                if len(values) < 4:
                    raise ValueError("not enough OHLC fields")
                open_price, high, low, close = (float(value) for value in values[:4])
                volume = float(values[4]) if len(values) >= 5 and values[4] else 0.0
                output.append([timestamp, open_price, high, low, close, volume])
            except (ValueError, IndexError) as error:
                raise ValueError(f"Invalid row {line_number} in {path}: {row}") from error

    output.sort(key=lambda candle: candle[0])
    # Some vendor files repeat an hour around daylight-saving transitions.
    # Keep the final record for a timestamp so chart time remains strictly ascending.
    unique_by_timestamp = {int(candle[0]): candle for candle in output}
    return [unique_by_timestamp[timestamp] for timestamp in sorted(unique_by_timestamp)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", default="data/xauusd_1m.csv")
    parser.add_argument("--output", default="data/xauusd-1m.json")
    args = parser.parse_args()

    source = resolve_input(args.input)
    destination = Path(args.output).expanduser().resolve()
    candles = read_candles(source)
    if len(candles) < 15_120:
        raise ValueError("Dataset needs at least 15,120 one-minute candles (10 days of history + 12h future).")

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(candles, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(candles):,} candles: {source} -> {destination}")


if __name__ == "__main__":
    main()
