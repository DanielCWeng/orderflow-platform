"""
delta.py — Bar delta and Cumulative Volume Delta (CVD).

Definitions:
  delta   = sum(size where side='B') - sum(size where side='A')  per bar
  CVD     = running cumulative delta from session open

All functions accept (instrument, start, end, session_filter) for consistency.
"""

from __future__ import annotations

import datetime
import logging
from dataclasses import dataclass, field
from typing import Any

from ..storage.tick_store import TickStore

logger = logging.getLogger(__name__)

BAR_RESOLUTION_MINUTES = 1  # aggregate ticks into 1-minute bars


@dataclass
class DeltaBar:
    """Delta for a single bar."""
    timestamp: datetime.datetime   # bar open timestamp (UTC)
    buy_vol: int
    sell_vol: int
    unknown_vol: int
    delta: int                     # buy_vol - sell_vol
    cvd: float                     # running cumulative delta at close of this bar


def compute_delta(
    instrument: str,
    start: datetime.datetime,
    end: datetime.datetime,
    session_filter: str | None = None,
    tick_store: TickStore | None = None,
    bar_minutes: int = BAR_RESOLUTION_MINUTES,
) -> list[DeltaBar]:
    """
    Compute per-bar delta and running CVD from raw ticks.

    Parameters
    ----------
    instrument:     'ES' or 'NQ'
    start:          window start (UTC, inclusive)
    end:            window end (UTC, exclusive)
    session_filter: optional session label filter ('RTH', etc.)
    tick_store:     TickStore to query; returns empty list if None
    bar_minutes:    bar resolution in minutes (default 1)

    Returns a list of DeltaBar objects sorted by timestamp ascending.
    """
    if tick_store is None:
        return []

    ticks = tick_store.query_ticks(instrument, start, end, session_filter)
    if not ticks:
        return []

    # Bucket ticks into bars
    bar_buckets: dict[datetime.datetime, dict[str, int]] = {}
    step = datetime.timedelta(minutes=bar_minutes)

    for tick in ticks:
        ts = tick["timestamp"]
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=datetime.timezone.utc)

        # Floor to bar boundary
        bar_ts = _floor_to_bar(ts, bar_minutes)

        if bar_ts not in bar_buckets:
            bar_buckets[bar_ts] = {"B": 0, "A": 0, "U": 0}

        side = tick["side"]
        size = int(tick["size"])
        bar_buckets[bar_ts][side] = bar_buckets[bar_ts].get(side, 0) + size

    # Build ordered result with running CVD
    sorted_bars = sorted(bar_buckets.items())
    result: list[DeltaBar] = []
    cvd = 0.0

    for bar_ts, sides in sorted_bars:
        buy_v  = sides.get("B", 0)
        sell_v = sides.get("A", 0)
        unk_v  = sides.get("U", 0)
        delta  = buy_v - sell_v
        cvd   += delta

        result.append(DeltaBar(
            timestamp=bar_ts,
            buy_vol=buy_v,
            sell_vol=sell_v,
            unknown_vol=unk_v,
            delta=delta,
            cvd=cvd,
        ))

    return result


def compute_cvd(
    instrument: str,
    start: datetime.datetime,
    end: datetime.datetime,
    session_filter: str | None = None,
    tick_store: TickStore | None = None,
    bar_minutes: int = BAR_RESOLUTION_MINUTES,
) -> list[dict]:
    """
    Return CVD timeseries as a list of dicts for the REST API.

    Each dict: {timestamp, delta, cvd}
    """
    bars = compute_delta(
        instrument=instrument,
        start=start,
        end=end,
        session_filter=session_filter,
        tick_store=tick_store,
        bar_minutes=bar_minutes,
    )
    return [
        {
            "timestamp": b.timestamp.isoformat(),
            "delta": b.delta,
            "cvd": b.cvd,
            "buy_vol": b.buy_vol,
            "sell_vol": b.sell_vol,
        }
        for b in bars
    ]


def running_cvd_from_ticks(ticks: list[dict]) -> float:
    """
    Compute the current CVD from an in-memory list of tick dicts.
    Used by the live WS layer for real-time updates.

    Parameters
    ----------
    ticks: list of tick dicts with 'side' and 'size' keys

    Returns the sum of deltas across all ticks.
    """
    cvd = 0.0
    for tick in ticks:
        side = tick.get("side", "U")
        size = int(tick.get("size", 0))
        if side == "B":
            cvd += size
        elif side == "A":
            cvd -= size
    return cvd


# ── Helpers ──────────────────────────────────────────────────────────────────

def _floor_to_bar(ts: datetime.datetime, bar_minutes: int) -> datetime.datetime:
    """Floor a datetime to the nearest bar boundary."""
    total_seconds = int(ts.timestamp())
    bar_seconds = bar_minutes * 60
    floored = (total_seconds // bar_seconds) * bar_seconds
    return datetime.datetime.fromtimestamp(floored, tz=datetime.timezone.utc)
