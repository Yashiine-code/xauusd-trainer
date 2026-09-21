import csv
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from aggregate_market_data import build  # noqa: E402
from generate_question_pool import generate  # noqa: E402


class MarketPipelineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.csv"
        start = datetime(2024, 1, 1, tzinfo=timezone.utc)
        with self.source.open("w", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["timestamp", "open", "high", "low", "close", "volume"])
            for index in range(180):
                writer.writerow([
                    (start + timedelta(minutes=index)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    100 + index, 102 + index, 99 + index, 101 + index, 1,
                ])

    def tearDown(self):
        self.temp.cleanup()

    def test_all_timeframes_use_standard_ohlcv_boundaries(self):
        output = self.root / "aggregated"
        manifest = build(self.source, output)
        self.assertEqual(manifest["rows"], {"1m": 180, "3m": 60, "5m": 36, "15m": 12, "1H": 3})
        with (output / "xauusd_1H.csv").open(newline="") as handle:
            first = next(csv.DictReader(handle))
        self.assertEqual(first["open"], "100")
        self.assertEqual(first["high"], "161")
        self.assertEqual(first["low"], "99")
        self.assertEqual(first["close"], "160")
        self.assertEqual(first["volume"], "60")

    def test_question_pool_excludes_dataset_tail(self):
        output = self.root / "question_pool.csv"
        count = generate(self.source, output, history_rows=20, future_rows=10, stride=5, severe_gap_hours=72, max_future_span_hours=24)
        self.assertGreater(count, 0)
        with output.open(newline="") as handle:
            rows = list(csv.DictReader(handle))
        last_source = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=179)
        for row in rows:
            future = datetime.fromisoformat(row["future_available_until"].replace("Z", "+00:00"))
            self.assertLessEqual(future, last_source)
            self.assertEqual(json.loads(row["metadata"])["future_rows"], 10)


if __name__ == "__main__":
    unittest.main()
