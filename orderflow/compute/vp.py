"""
vp.py — Volume Profile: POC, VAH, VAL, and per-level rows.

Volume profile is computed from raw ticks (tick_store) when available.
Falls back to OHLCV data when tick data is unavailable for the window.

Value Area = 70% of total session volume centered on the POC.
  - VAH: the highest price level within the value area
  - VAL: the lowest price level within the value area
  - POC: price level with the most traded volume

All functions accept (instrument, start, end, session_filter) for consistency.
"""

from __future__ import annotations

import datetime
import logging
from dataclasses import dataclass, field
from typing import Any

from ..storage.tick_store import TickStore
from ..storage.ohlcv_store import OHLCVStore

logger = logging.getLogger(__name__)

VALUE_AREA_PCT = 0.70   # 70% of total volume defines the value area
TICK_SIZE = 0.25        # default price granularity (overridden per instrument if needed)


@dataclass
class VPRow:
    """A single price level in the volume profile."""
    price: float
    volume: int
    buy_vol: int = 0
    sell_vol: int = 0
    delta: int = 0
    is_poc: bool = False
    in_value_area: bool = False


@dataclass
class VPResult:
    """Full volume profile result."""
    instrument: str
    start: datetime.datetime
    end: datetime.datetime
    session: str | None
    poc: float              # point of control price
    vah: float              # value area high
    val: float              # value area low
    total_volume: int
    rows: list[VPRow] = field(default_factory=list)  # sorted by price ascending


def compute_vp(
    instrument: str,
    start: datetime.datetime,
    end: datetime.datetime,
    session_filter: str | None = None,
    tick_store: TickStore | None = None,
    ohlcv_store: OHLCVStore | None = None,
    tick_size: float = TICK_SIZE,
) -> VPResult:
    """
    Compute a volume profile for the given time window.

    Prefers raw ticks when tick_store is provided and has data.
    Falls back to OHLCV bars (volume distributed across bar range) when
    tick data is unavailable.

    Parameters
    ----------
    instrument:     'ES' or 'NQ'
    start:          window start (UTC, inclusive)
    end:            window end (UTC, exclusive)
    session_filter: optional session label filter
    tick_store:     TickStore instance (preferred source)
    ohlcv_store:    OHLCVStore instance (fallback source)
    tick_size:      price granularity for bucketing (default 0.25)
    """
    price_vol: dict[float, int] = {}
    price_buy: dict[float, int] = {}
    price_sell: dict[float, int] = {}

    # --- Try tick data first ---
    if tick_store is not None:
        ticks = tick_store.query_ticks(instrument, start, end, session_filter)
        if ticks:
            for tick in ticks:
                px = _snap(tick["price"], tick_size)
                sz = int(tick["size"])
                side = tick["side"]
                price_vol[px] = price_vol.get(px, 0) + sz
                if side == "B":
                    price_buy[px] = price_buy.get(px, 0) + sz
                elif side == "A":
                    price_sell[px] = price_sell.get(px, 0) + sz

    # --- Fallback: OHLCV bars ---
    if not price_vol and ohlcv_store is not None:
        bars = ohlcv_store.query_bars(instrument, start, end, session_filter)
        for bar in bars:
            hi = float(bar["high"])
            lo = float(bar["low"])
            vol = int(bar["volume"])
            if hi == lo:
                px = _snap(hi, tick_size)
                price_vol[px] = price_vol.get(px, 0) + vol
            else:
                # Distribute volume evenly across the bar's price levels
                levels = _price_levels(lo, hi, tick_size)
                if levels:
                    per_level = max(1, vol // len(levels))
                    for px in levels:
                        price_vol[px] = price_vol.get(px, 0) + per_level

    if not price_vol:
        # Return empty result
        return VPResult(
            instrument=instrument, start=start, end=end, session=session_filter,
            poc=0.0, vah=0.0, val=0.0, total_volume=0, rows=[]
        )

    # --- Build result ---
    total_volume = sum(price_vol.values())
    poc_px = max(price_vol, key=lambda px: price_vol[px])

    rows_sorted = sorted(price_vol.keys())
    poc_idx = rows_sorted.index(poc_px)

    # Expand outward from POC to capture 70% of volume
    value_vol = price_vol[poc_px]
    lo_idx = poc_idx
    hi_idx = poc_idx
    prices_in_va: set[float] = {poc_px}

    while value_vol < total_volume * VALUE_AREA_PCT:
        expand_up = (hi_idx + 1 < len(rows_sorted))
        expand_dn = (lo_idx - 1 >= 0)

        if not expand_up and not expand_dn:
            break

        vol_up = price_vol.get(rows_sorted[hi_idx + 1], 0) if expand_up else 0
        vol_dn = price_vol.get(rows_sorted[lo_idx - 1], 0) if expand_dn else 0

        if expand_up and (not expand_dn or vol_up >= vol_dn):
            hi_idx += 1
            px = rows_sorted[hi_idx]
        else:
            lo_idx -= 1
            px = rows_sorted[lo_idx]

        prices_in_va.add(px)
        value_vol += price_vol[px]

    vah = rows_sorted[hi_idx]
    val = rows_sorted[lo_idx]

    rows: list[VPRow] = []
    for px in rows_sorted:
        buy_v = price_buy.get(px, 0)
        sell_v = price_sell.get(px, 0)
        rows.append(VPRow(
            price=px,
            volume=price_vol[px],
            buy_vol=buy_v,
            sell_vol=sell_v,
            delta=buy_v - sell_v,
            is_poc=(px == poc_px),
            in_value_area=(px in prices_in_va),
        ))

    return VPResult(
        instrument=instrument,
        start=start,
        end=end,
        session=session_filter,
        poc=poc_px,
        vah=vah,
        val=val,
        total_volume=total_volume,
        rows=rows,
    )


# ── Helpers ──────────────────────────────────────────────────────────────────

def _snap(price: float, tick_size: float) -> float:
    """Snap a price to the nearest tick size."""
    return round(round(price / tick_size) * tick_size, 10)


def _price_levels(lo: float, hi: float, tick_size: float) -> list[float]:
    """Enumerate all tick-aligned price levels from lo to hi inclusive."""
    lo_s = _snap(lo, tick_size)
    hi_s = _snap(hi, tick_size)
    levels = []
    px = lo_s
    while px <= hi_s + 1e-9:
        levels.append(round(px, 10))
        px = round(px + tick_size, 10)
    return levels
