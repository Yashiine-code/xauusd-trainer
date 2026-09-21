"""Configuration for the XAUUSD historical-data cleaning pipeline."""

from datetime import timedelta, timezone

SYMBOL = "XAUUSD"
TIMEFRAME = "1m"
SOURCE_NAME = "HistData"

# HistData documents all timestamps as fixed EST, without daylight-saving
# adjustments. This is therefore a fixed UTC-05:00 offset, not America/New_York.
SOURCE_TIMEZONE_NAME = "EST (fixed UTC-05:00, no DST)"
SOURCE_TIMEZONE = timezone(timedelta(hours=-5), name="EST")
OUTPUT_TIMEZONE_NAME = "UTC"
OUTPUT_TIMEZONE = timezone.utc
TIMEZONE_SOURCE_URL = "https://www.histdata.com/f-a-q/data-files-detailed-specification/"

SUSPICIOUS_1M_MOVE_PCT = 0.05
EXPECTED_LONG_GAP_MINUTES = 240
DAILY_BREAK_START_UTC_HOUR = 21
DAILY_BREAK_END_UTC_HOUR = 23

# Documentation only. The cleaner does not use contract size to change prices.
CONTRACT_SIZE = 100

OUTPUT_COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]
DB_OUTPUT_COLUMNS = ["symbol", *OUTPUT_COLUMNS]

