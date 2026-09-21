#!/usr/bin/env python3
"""Generate deterministic, prevalidated XAUUSD question candidates."""

from __future__ import annotations

import argparse
import csv
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data/processed/xauusd/xauusd_1m_all.csv"
DEFAULT_OUTPUT = ROOT / "data/aggregated/xauusd/question_pool.csv"
NAMESPACE = uuid.UUID("0f2a1961-c12e-4bda-aa09-92dfaf29bc95")


def parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def generate(source: Path, output: Path, history_rows: int, future_rows: int, stride: int, severe_gap_hours: int, max_future_span_hours: int) -> int:
    timestamps: list[tuple[str, int]] = []
    with source.open(newline="") as handle:
        for row in csv.DictReader(handle):
            timestamps.append((row["timestamp"], int(parse(row["timestamp"]).timestamp())))
    if len(timestamps) <= history_rows + future_rows:
        raise ValueError("Dataset is too short for the configured question window")

    severe_prefix = [0]
    threshold = severe_gap_hours * 60 * 60
    for index in range(1, len(timestamps)):
        severe_prefix.append(severe_prefix[-1] + int(timestamps[index][1] - timestamps[index - 1][1] > threshold))

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".csv.tmp")
    count = 0
    with temporary.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["question_id", "symbol", "hidden_timestamp", "future_available_until", "status", "quality_flag", "metadata"])
        for index in range(history_rows, len(timestamps) - future_rows, stride):
            window_start = index - history_rows + 1
            window_end = index + future_rows
            severe_gaps = severe_prefix[window_end] - severe_prefix[window_start]
            if severe_gaps:
                continue
            if timestamps[window_end][1] - timestamps[index][1] > max_future_span_hours * 60 * 60:
                continue
            hidden = timestamps[index][0]
            future = timestamps[window_end][0]
            question_id = uuid.uuid5(NAMESPACE, f"XAUUSD:{hidden}")
            metadata = json.dumps({
                "history_rows": history_rows,
                "future_rows": future_rows,
                "severe_gap_hours": severe_gap_hours,
                "max_future_span_hours": max_future_span_hours,
                "generator_version": 1,
            }, separators=(",", ":"))
            writer.writerow([question_id, "XAUUSD", hidden, future, "active", "verified", metadata])
            count += 1
    temporary.replace(output)
    logging.info("Generated %s validated questions at %s", f"{count:,}", output)
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--history-rows", type=int, default=10 * 24 * 60)
    parser.add_argument("--future-rows", type=int, default=12 * 60)
    parser.add_argument("--stride", type=int, default=60)
    parser.add_argument("--severe-gap-hours", type=int, default=72)
    parser.add_argument("--max-future-span-hours", type=int, default=24)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    generate(args.source.resolve(), args.output.resolve(), args.history_rows, args.future_rows, args.stride, args.severe_gap_hours, args.max_future_span_hours)


if __name__ == "__main__":
    main()
