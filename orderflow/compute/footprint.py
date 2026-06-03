"""
footprint.py — Footprint chart: bid/ask volume per price level per bar.

A footprint groups raw ticks by (bar_timestamp, price) to show how much
volume traded at each price level within each bar, split by aggressor side.

Result structure:
  FootprintBar
    timestamp: datetime          — bar open time
    levels: list[FootprintLevel] — sorted by price ascending
      price:    float
      bid_vol:  int              — sell-aggressor volume at this level
      ask_vol:  int              — buy-aggressor volume at this level
      delta:    int              — ask_vol - bid_vol
      unknown:  int              — unclassified volume

All functions accept (instrument, start, end, session_filter) for consistency.
"""

from __future__ import annotations

import datetime
import logging
from dataclasses import dataclass, field

from ..storage.tick_store import TickStore

logger = logging.getLogger(__name__)

BAR_RESOLUTION_MINUTES = 1
TICK_SIZE = 0.25


@dataclass
class FootprintLevel:
    """Single price level within a footprint bar."""
    price: float
    bid_vol: int    # sell-aggressor (side='A' hits bid)
    ask_vol: int    # buy-aggressor  (side='B' lifts ask)
    delta: int      # ask_vol - bid_vol
    unknown: int    # side='U'


@dataclass
class FootprintBar:
    """All price levels for a single bar."""
    timestamp: datetime.datetime
    levels: list[FootprintLevel] = field(default_factory=list)

    @property
    def total_volume(self) -> int:
        return sum(lv.bid_vol + lv.ask_vol + lv.unknown for lv in self.levels)

    @property
    def bar_delta(self) -> int:
        return sum(lv.delta for lv in self.levels)

    @property
    def poc_price(self) -> float | None:
        """Price level with the highest combined volume."""
        if not self.levels:
            return None
        return max(self.levels, key=lambda lv: lv.bid_vol + lv.ask_vol).price


def compute_footprint(
    instrument: str,
    start: datetime.datetime,
    end: datetime.datetime,
    session_filter: str | None = None,
    tick_store: TickStore | None = None,
    bar_minutes: int = BAR_RESOLUTION_MINUTES,
    tick_size: float = TICK_SIZE,
) -> list[FootprintBar]:
    """
    Compute footprint bars from raw ticks.

    Parameters
    ----------
    instrument:     'ES' or 'NQ'
    start:          window start (UTC, inclusive)
    end:            window end (UTC, exclusive)
    session_filter: optional session label filter
    tick_store:     TickStore; returns empty list if None
    bar_minutes:    bar resolution in minutes (default 1)
    tick_size:      price snapping granularity (default 0.25)

    Returns a list of FootprintBar objects sorted by timestamp ascending.
    """
    if tick_store is None:
        return []

    ticks = tick_store.query_ticks(instrument, start, end, session_filter)
    if not ticks:
        return []

    # Structure: {bar_ts: {price: {bid, ask, unknown}}}
    bars: dict[datetime.datetime, dict[float, dict[str, int]]] = {}

    for tick in ticks:
        ts = tick["timestamp"]
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=datetime.timezone.utc)

        bar_ts = _floor_to_bar(ts, bar_minutes)
        px = _snap(float(tick["price"]), tick_size)
        sz = int(tick["size"])
        side = tick["side"]

        if bar_ts not in bars:
            bars[bar_ts] = {}
        if px not in bars[bar_ts]:
            bars[bar_ts][px] = {"bid": 0, "ask": 0, "unknown": 0}

        if side == "B":
            bars[bar_ts][px]["ask"] += sz   # buyer-initiated hits ask
        elif side == "A":
            bars[bar_ts][px]["bid"] += sz   # seller-initiated hits bid
        else:
            bars[bar_ts][px]["unknown"] += sz

    result: list[FootprintBar] = []
    for bar_ts in sorted(bars):
        levels: list[FootprintLevel] = []
        for px in sorted(bars[bar_ts]):
            d = bars[bar_ts][px]
            bid_v = d["bid"]
            ask_v = d["ask"]
            unk_v = d["unknown"]
            levels.append(FootprintLevel(
                price=px,
                bid_vol=bid_v,
                ask_vol=ask_v,
                delta=ask_v - bid_v,
                unknown=unk_v,
            ))
        result.append(FootprintBar(timestamp=bar_ts, levels=levels))

    return result


def footprint_to_dict(bar: FootprintBar) -> dict:
    """Serialise a FootprintBar to a JSON-friendly dict."""
    return {
        "timestamp": bar.timestamp.isoformat(),
        "total_volume": bar.total_volume,
        "bar_delta": bar.bar_delta,
        "poc_price": bar.poc_price,
        "levels": [
            {
                "price":    lv.price,
                "bid_vol":  lv.bid_vol,
                "ask_vol":  lv.ask_vol,
                "delta":    lv.delta,
                "unknown":  lv.unknown,
            }
            for lv in bar.levels
        ],
    }


# ── Helpers ──────────────────────────────────────────────────────────────────

def _snap(price: float, tick_size: float) -> float:
    return round(round(price / tick_size) * tick_size, 10)


def _floor_to_bar(ts: datetime.datetime, bar_minutes: int) -> datetime.datetime:
    total_seconds = int(ts.timestamp())
    bar_seconds = bar_minutes * 60
    floored = (total_seconds // bar_seconds) * bar_seconds
    return datetime.datetime.fromtimestamp(floored, tz=datetime.timezone.utc)
