"""
config.py — Central configuration for the orderflow platform.
All instruments, paths, connection settings, and scheduler config live here.
"""

INSTRUMENTS = {
    "ES": {
        "contract": "ESM26",     # update each roll (next: ESU26 on third Friday of Jun 2026)
        "tick": 0.25,
        "yfinance": "ES=F",
        "symbol": "XCME:ES.M26",  # IronBeam format — update on roll
    },
    "NQ": {
        "contract": "NQM26",     # update each roll
        "tick": 0.25,
        "yfinance": "NQ=F",
        "symbol": "XCME:NQ.M26",  # IronBeam format — update on roll
    },
}

# Storage
DB_PATH = "data/orderflow.duckdb"
PARQUET_DIR = "data/parquet"

# IronBeam connection
MOCK = False  # flip to False for live IronBeam feed
IRONBEAM_DEMO_URL = "https://demo.ironbeamapi.com"
IRONBEAM_LIVE_URL = "https://live.ironbeamapi.com"
MOCK_URL = "http://localhost:8001"

# Credentials (populate via env vars in production)
import os
IRONBEAM_USERNAME = os.environ.get("IRONBEAM_USERNAME", "")
IRONBEAM_PASSWORD = os.environ.get("IRONBEAM_PASSWORD", "")

# FastAPI server
API_HOST = "0.0.0.0"
API_PORT = 8000

# APScheduler cron for pruner: 18:05 ET daily
PRUNER_CRON = "5 18 * * *"

# Retention windows
TICK_RETENTION_DAYS = 7
OHLCV_RETENTION_DAYS = 35

# Gap detection lookback
GAP_LOOKBACK_DAYS = 30
