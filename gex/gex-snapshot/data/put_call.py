"""CBOE daily put/call ratios — scraped from the market statistics page."""

import logging
from datetime import date, timedelta

import pandas as pd

log = logging.getLogger(__name__)

_BASE_URL = "https://www.cboe.com/markets/us/options/market-statistics/daily/?dt={}"
_STORAGE_OPTIONS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
_MA_DAYS = 5

# Row label substrings → result key mapping (Table 0 of the page)
_ROW_MAP = {
    "TOTAL PUT/CALL":  "total_pc",
    "INDEX PUT/CALL":  "index_pc",
    "EQUITY PUT/CALL": "equity_pc",
    "SPX":             "spx_pc",
}


def _scrape_date(dt: date) -> dict | None:
    """Scrape P/C ratios for a single date. Returns None if no data (market closed)."""
    url = _BASE_URL.format(dt.isoformat())
    try:
        tables = pd.read_html(url, storage_options=_STORAGE_OPTIONS)
    except Exception as exc:
        log.debug("P/C scrape failed for %s: %s", dt, exc)
        return None

    # Table 0 is the ratios table: columns ["Ratios", "Value"]
    t0 = tables[0] if tables else None
    if t0 is None or t0.shape[1] < 2:
        return None

    t0.columns = ["label", "value"]
    t0["label"] = t0["label"].str.upper().str.strip()

    row = {}
    for substr, key in _ROW_MAP.items():
        match = t0[t0["label"].str.contains(substr, na=False)]
        if not match.empty:
            try:
                row[key] = round(float(match["value"].iloc[0]), 3)
            except (ValueError, TypeError):
                pass

    if not row:
        return None

    row["date"] = dt.isoformat()
    return row


def _last_n_trading_days(n: int) -> list[dict]:
    """
    Walk back through calendar days collecting up to n days with market data.
    Stops searching after 14 calendar days to avoid infinite loops on holidays.
    """
    results = []
    dt = date.today()
    for _ in range(14):
        if len(results) >= n:
            break
        data = _scrape_date(dt)
        if data:
            results.append(data)
        dt -= timedelta(days=1)
    return results


def fetch_put_call() -> dict:
    """
    Scrape CBOE daily market statistics page for put/call ratios and 5-day MAs.

    Returns:
        {
          "date":             "2026-06-03",
          "total_pc":         0.83,
          "index_pc":         1.02,
          "equity_pc":        0.49,
          "spx_pc":           1.22,
          "total_pc_5d_avg":  0.85,
          "equity_pc_5d_avg": 0.54,
          "sentiment":        "neutral",   # fearful / cautious / neutral / greedy
        }
    """
    days = _last_n_trading_days(_MA_DAYS)

    if not days:
        log.warning("P/C scrape: no data found for any recent trading day")
        return {}

    latest = days[0]
    result: dict = {
        "date":      latest["date"],
        "total_pc":  latest.get("total_pc"),
        "index_pc":  latest.get("index_pc"),
        "equity_pc": latest.get("equity_pc"),
        "spx_pc":    latest.get("spx_pc"),
    }

    # 5-day MAs from the collected days
    for key in ("total_pc", "equity_pc", "index_pc"):
        vals = [d[key] for d in days if key in d]
        if len(vals) >= 2:
            result[f"{key}_5d_avg"] = round(sum(vals) / len(vals), 3)

    # Sentiment keyed off equity P/C
    eq_pc = result.get("equity_pc")
    if eq_pc is not None:
        if eq_pc >= 0.80:
            result["sentiment"] = "fearful"
        elif eq_pc >= 0.65:
            result["sentiment"] = "cautious"
        elif eq_pc <= 0.40:
            result["sentiment"] = "greedy"
        else:
            result["sentiment"] = "neutral"

    log.info(
        "P/C (%s) equity: %s (5d: %s) | index: %s | total: %s | sentiment: %s",
        latest["date"],
        result.get("equity_pc", "?"),
        result.get("equity_pc_5d_avg", "?"),
        result.get("index_pc", "?"),
        result.get("total_pc", "?"),
        result.get("sentiment", "?"),
    )
    return result
