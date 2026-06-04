"""QQQ top holdings cache — refreshed monthly for earnings impact calc."""

import json
import logging
import os
from datetime import datetime, timezone

import yfinance as yf

log = logging.getLogger(__name__)

_CACHE_FILE = os.path.join(os.path.dirname(__file__), "..", "output", "qqq_weights.json")
_TOP_N = 25


def _cache_is_current(data: dict) -> bool:
    refreshed = data.get("refreshed_at", "")
    if not refreshed:
        return False
    if refreshed[:7] != datetime.now(timezone.utc).strftime("%Y-%m"):
        return False
    if not data.get("holdings"):  # reject empty cache from a failed run
        return False
    return True


def _load_cache() -> dict | None:
    try:
        with open(_CACHE_FILE) as f:
            data = json.load(f)
        if _cache_is_current(data):
            return data
    except Exception:
        pass
    return None


def _fetch_holdings() -> list[dict]:
    holdings = []
    try:
        df = yf.Ticker("QQQ").funds_data.top_holdings  # Symbol index, Name + Holding Percent cols
        if df is not None and not df.empty:
            for symbol, row in df.head(_TOP_N).iterrows():
                holdings.append({
                    "ticker":     str(symbol),
                    "name":       str(row.get("Name", "")),
                    "weight_pct": round(float(row.get("Holding Percent", 0)) * 100, 3),
                })
    except Exception as exc:
        log.warning("QQQ top_holdings unavailable: %s", exc)
    return holdings


def get_qqq_weights() -> dict:
    """
    Return QQQ top holdings, using a monthly-refreshed cache.

    Returns:
        {
          "refreshed_at": "2026-06-04T08:00:00Z",
          "holdings": [
            {"ticker": "MSFT", "name": "Microsoft Corp", "weight_pct": 8.912},
            ...
          ]
        }
    """
    cached = _load_cache()
    if cached:
        log.info("QQQ weights: using cache (refreshed %s)", cached.get("refreshed_at", "?"))
        return cached

    log.info("QQQ weights: cache stale or missing — fetching from yfinance")
    holdings = _fetch_holdings()

    if not holdings:
        raise RuntimeError(
            "QQQ weights fetch returned 0 holdings — earnings impact calc will break. "
            "Check yfinance Ticker('QQQ').funds_data.top_holdings."
        )

    data = {
        "refreshed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "holdings": holdings,
    }
    try:
        os.makedirs(os.path.dirname(_CACHE_FILE), exist_ok=True)
        with open(_CACHE_FILE, "w") as f:
            json.dump(data, f, indent=2)
        log.info("QQQ weights cached: %d holdings → %s", len(holdings), _CACHE_FILE)
    except Exception as exc:
        log.warning("Failed to write QQQ weights cache: %s", exc)
    return data
