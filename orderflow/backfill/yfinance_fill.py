"""
yfinance_fill.py — Fetch 1-minute OHLCV bars from yfinance and write to DuckDB.

yfinance symbol map:
  ES → ES=F
  NQ → NQ=F

Note: these are index/roll-adjusted approximations, not exact futures prices.
All backfilled bars are written with source='BACKFILL'.

If yfinance throws an unexpected error, the library likely needs to be
reinstalled (updating alone does not fix it):
  pip uninstall yfinance -y && pip install yfinance
Do NOT implement auto-reinstall here — fix it manually in the environment.

yfinance returns bars in the exchange timezone.  We convert everything to UTC
before writing to the store.

The GAP_LOOKBACK_DAYS limit (30 days) aligns with yfinance's 7-day limit for
1-minute data, so we handle partial availability gracefully.
"""

from __future__ import annotations

import datetime
import logging
from zoneinfo import ZoneInfo

import yfinance as yf

from ..config import INSTRUMENTS
from ..ingestion.session import classify
from ..ingestion.contracts import contract_from_config
from ..storage.ohlcv_store import OHLCVStore
from .gap_detector import Gap

logger = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")
UTC = datetime.timezone.utc

# yfinance 1-minute data is only available for ~7 days back
YFINANCE_MAX_LOOKBACK_DAYS = 7


def _yf_symbol(instrument: str) -> str:
    """Map instrument to yfinance ticker."""
    return INSTRUMENTS[instrument]["yfinance"]


def fetch_1m_bars(
    instrument: str,
    start: datetime.datetime,
    end: datetime.datetime,
) -> list[dict]:
    """
    Fetch 1-minute OHLCV bars from yfinance for the given UTC range.

    Returns a list of dicts matching the ohlcv_store schema.
    Returns empty list on any error (logged at WARNING level).

    Note: if yfinance consistently fails, uninstall and reinstall:
      pip uninstall yfinance -y && pip install yfinance
    """
    ticker_symbol = _yf_symbol(instrument)
    contract = contract_from_config(instrument)

    # yfinance wants naive datetimes in UTC or timestamps
    start_str = start.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")
    end_str   = end.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S")

    # Check if within yfinance's 1m lookback window
    now_utc = datetime.datetime.now(UTC)
    if (now_utc - start) > datetime.timedelta(days=YFINANCE_MAX_LOOKBACK_DAYS + 1):
        logger.warning(
            "yfinance: %s %s → %s is beyond 7-day limit for 1m data; skipping",
            instrument, start_str, end_str
        )
        return []

    logger.info(
        "yfinance: fetching %s (%s) from %s to %s",
        ticker_symbol, instrument, start_str, end_str
    )

    try:
        ticker = yf.Ticker(ticker_symbol)
        df = ticker.history(
            start=start_str,
            end=end_str,
            interval="1m",
            auto_adjust=True,
            prepost=True,
        )
    except Exception as exc:
        logger.warning(
            "yfinance: fetch failed for %s: %s "
            "(if persistent, reinstall: pip uninstall yfinance -y && pip install yfinance)",
            ticker_symbol, exc
        )
        return []

    if df is None or df.empty:
        logger.debug("yfinance: no data returned for %s %s → %s", instrument, start_str, end_str)
        return []

    rows: list[dict] = []
    for idx, row in df.iterrows():
        # idx is a pandas Timestamp; convert to tz-aware UTC datetime
        if hasattr(idx, "to_pydatetime"):
            ts = idx.to_pydatetime()
        else:
            ts = datetime.datetime.fromisoformat(str(idx))

        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=UTC)
        else:
            ts = ts.astimezone(UTC)

        # Skip rows with zero volume or NaN prices
        volume = int(row.get("Volume", 0) or 0)
        open_  = float(row.get("Open",  0) or 0)
        high   = float(row.get("High",  0) or 0)
        low    = float(row.get("Low",   0) or 0)
        close  = float(row.get("Close", 0) or 0)

        if open_ == 0 and close == 0:
            continue

        session_label = classify(ts)
        rows.append({
            "instrument": instrument,
            "contract":   contract,
            "timestamp":  ts,
            "open":       open_,
            "high":       high,
            "low":        low,
            "close":      close,
            "volume":     volume,
            "source":     "BACKFILL",
            "session":    session_label,
        })

    logger.info("yfinance: fetched %d bars for %s", len(rows), instrument)
    return rows


def fill_gap(
    gap: Gap,
    ohlcv_store: OHLCVStore,
) -> int:
    """
    Fetch bars for a single Gap and write them to ohlcv_store.

    Returns the number of bars written.
    """
    bars = fetch_1m_bars(gap.instrument, gap.start, gap.end)
    if not bars:
        return 0

    # Only keep bars whose timestamps are in the gap's missing set
    missing_set = set(gap.missing_timestamps)
    filtered = [b for b in bars if b["timestamp"] in missing_set]

    if filtered:
        try:
            ohlcv_store.insert_bars(filtered)
        except Exception as exc:
            logger.error(
                "yfinance: failed to write bars for %s %s: %s",
                gap.instrument, gap.date, exc
            )
            return 0

    logger.info(
        "backfill: %s %s %s — fetched %d, wrote %d bars",
        gap.instrument, gap.session, gap.date, len(bars), len(filtered)
    )
    return len(filtered)


async def backfill_gaps(
    gaps: list[Gap],
    ohlcv_store: OHLCVStore,
) -> dict[str, int]:
    """
    Backfill all gaps.  Processes gaps sequentially to avoid rate-limiting.

    Returns a summary dict: {instrument: total_bars_written}.
    """
    summary: dict[str, int] = {}

    for gap in gaps:
        count = fill_gap(gap, ohlcv_store)
        summary[gap.instrument] = summary.get(gap.instrument, 0) + count

    total = sum(summary.values())
    logger.info("backfill complete: %d total bars written — %s", total, summary)
    return summary
