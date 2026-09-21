#!/usr/bin/env python3
"""Validate aggregate outputs and deterministic random buckets against cleaned 1m."""

from __future__ import annotations

import argparse
import csv
import json
import random
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data/processed/xauusd/xauusd_1m_all.csv"
OUTPUT = ROOT / "data/aggregated/xauusd"
TIMEFRAMES = {"3m": 3, "5m": 5, "15m": 15, "1H": 60}


def epoch(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=100)
    args = parser.parse_args()
    manifest = json.loads((OUTPUT / "manifest.json").read_text())
    source_rows = manifest["rows"]["1m"]
    rng = random.Random(20260917)
    sample_indices = set(rng.sample(range(source_rows), min(args.samples, source_rows)))
    sampled_timestamps = []
    with SOURCE.open(newline="") as handle:
        for index, row in enumerate(csv.DictReader(handle)):
            if index in sample_indices:
                sampled_timestamps.append(epoch(row["timestamp"]))

    expected = {name: {} for name in TIMEFRAMES}
    selected_buckets = {
        name: {(timestamp // (minutes * 60)) * minutes * 60 for timestamp in sampled_timestamps}
        for name, minutes in TIMEFRAMES.items()
    }
    with SOURCE.open(newline="") as handle:
        for row in csv.DictReader(handle):
            timestamp = epoch(row["timestamp"])
            values = tuple(Decimal(row[key]) for key in ["open", "high", "low", "close", "volume"])
            for name, minutes in TIMEFRAMES.items():
                bucket = (timestamp // (minutes * 60)) * minutes * 60
                if bucket not in selected_buckets[name]:
                    continue
                current = expected[name].get(bucket)
                if current is None:
                    expected[name][bucket] = list(values)
                else:
                    current[1] = max(current[1], values[1])
                    current[2] = min(current[2], values[2])
                    current[3] = values[3]
                    current[4] += values[4]

    checked = defaultdict(int)
    for name in TIMEFRAMES:
        with (OUTPUT / f"xauusd_{name}.csv").open(newline="") as handle:
            for row in csv.DictReader(handle):
                bucket = epoch(row["timestamp"])
                if bucket not in expected[name]:
                    continue
                actual = [Decimal(row[key]) for key in ["open", "high", "low", "close", "volume"]]
                if actual != expected[name][bucket]:
                    raise AssertionError(f"{name} mismatch at {row['timestamp']}: {actual} != {expected[name][bucket]}")
                checked[name] += 1
        if checked[name] != len(expected[name]):
            raise AssertionError(f"{name}: checked {checked[name]} of {len(expected[name])} sampled buckets")
    print(json.dumps({"status": "PASS", "sampled_1m_rows": len(sampled_timestamps), "checked_buckets": checked}, default=dict))


if __name__ == "__main__":
    main()
