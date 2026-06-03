"""
rest.py — FastAPI REST API for historical order flow data.

Endpoints:
  GET /health
  GET /vp?instrument=ES&from=...&to=...&session=RTH
  GET /ohlcv?instrument=ES&from=...&to=...&session=RTH&resolution=1m
  GET /footprint?instrument=ES&from=...&to=...
  GET /delta?instrument=ES&from=...&to=...

All datetime parameters are ISO 8601 strings (UTC assumed if no tz suffix).
The stores are injected via FastAPI dependency injection from main.py's
app state.

All query parameters that come from users are passed to parameterized queries
only — never interpolated into SQL strings.
"""

from __future__ import annotations

import datetime
import logging
from typing import Any, Optional

import asyncio
import os
import sys

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..compute.vp import compute_vp
from ..compute.delta import compute_cvd
from ..compute.footprint import compute_footprint, footprint_to_dict
from ..config import INSTRUMENTS

logger = logging.getLogger(__name__)

router = APIRouter()

UTC = datetime.timezone.utc

# ── Dependency helpers ────────────────────────────────────────────────────────

def get_tick_store(request: Request):
    store = getattr(request.app.state, "tick_store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="tick_store not initialised")
    return store


def get_ohlcv_store(request: Request):
    store = getattr(request.app.state, "ohlcv_store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="ohlcv_store not initialised")
    return store


def _parse_dt(s: str | None, param_name: str) -> datetime.datetime | None:
    """Parse an ISO datetime string; raise 400 on bad format."""
    if s is None:
        return None
    try:
        dt = datetime.datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid datetime for '{param_name}': {s!r}. "
                   f"Use ISO 8601 format, e.g. 2026-06-03T09:30:00Z"
        )


def _validate_instrument(instrument: str) -> str:
    inst = instrument.upper()
    if inst not in INSTRUMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown instrument '{instrument}'. "
                   f"Valid values: {list(INSTRUMENTS.keys())}"
        )
    return inst


def _default_window() -> tuple[datetime.datetime, datetime.datetime]:
    """Default to the last completed RTH session (today 09:30–16:00 ET)."""
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
    now_et = datetime.datetime.now(ET)
    today = now_et.date()
    start = datetime.datetime(today.year, today.month, today.day, 9, 30, tzinfo=ET)
    end   = datetime.datetime(today.year, today.month, today.day, 16, 0, tzinfo=ET)
    return start.astimezone(UTC), end.astimezone(UTC)


# ── Endpoints ─────────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    username: str
    password: str


@router.post("/connect")
async def connect(body: ConnectRequest, request: Request) -> dict:
    """
    Start IronBeam WebSocket clients using the supplied credentials.
    Called by the frontend after the user successfully logs in.
    Safe to call multiple times — already-running clients are left untouched.
    """
    clients = getattr(request.app.state, "ib_clients", [])
    if not clients:
        raise HTTPException(status_code=503, detail="IronBeam clients not initialised")

    tasks: list[asyncio.Task] = request.app.state.ib_tasks
    started = []

    for client in clients:
        if client.is_running:
            continue
        client.set_credentials(body.username, body.password)
        task = asyncio.create_task(
            client.run(),
            name=f"ironbeam-{client.instrument}",
        )
        tasks.append(task)
        started.append(client.instrument)
        logger.info("ironbeam: started %s via /connect", client.instrument)

    already_running = [c.instrument for c in clients if c.instrument not in started]
    return {
        "started": started,
        "already_running": already_running,
    }


@router.post("/gex/run")
async def run_gex_snapshot(request: Request) -> dict:
    """Run the GEX morning snapshot pipeline and write data/gex_levels.json."""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)
    )))
    gex_dir = os.path.join(project_root, "gex", "gex-snapshot")
    if not os.path.isdir(gex_dir):
        raise HTTPException(status_code=500, detail=f"GEX dir not found: {gex_dir}")

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "main.py",
            cwd=gex_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="GEX snapshot timed out (>120s)")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    if proc.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=stderr.decode(errors="replace")[-400:] or "GEX snapshot failed",
        )

    logger.info("gex snapshot complete")
    return {"status": "ok", "output": stdout.decode(errors="replace")[-800:]}


@router.get("/health")
async def health(request: Request) -> dict:
    """Health check — returns status and count of active WS subscribers."""
    from ..api.ws import subscriber_count
    return {
        "status": "ok",
        "instruments": list(INSTRUMENTS.keys()),
        "subscribers": {inst: subscriber_count(inst) for inst in INSTRUMENTS},
    }


@router.get("/ohlcv")
async def get_ohlcv(
    request: Request,
    instrument: str = Query(..., description="ES or NQ"),
    from_: Optional[str] = Query(None, alias="from", description="ISO datetime"),
    to:    Optional[str] = Query(None, description="ISO datetime"),
    session: Optional[str] = Query(None, description="RTH / PRE / POST / OVERNIGHT"),
    resolution: str = Query("1m", description="Bar resolution (1m only for now)"),
    ohlcv_store=Depends(get_ohlcv_store),
) -> JSONResponse:
    """Return OHLCV bars for an instrument in a time window."""
    inst = _validate_instrument(instrument)
    start, end = _resolve_window(from_, to)

    bars = ohlcv_store.query_bars(inst, start, end, session)

    # Serialise timestamps
    result = []
    for b in bars:
        b = dict(b)
        if hasattr(b.get("timestamp"), "isoformat"):
            b["timestamp"] = b["timestamp"].isoformat()
        result.append(b)

    return JSONResponse(content={"instrument": inst, "count": len(result), "bars": result})


@router.get("/vp")
async def get_vp(
    request: Request,
    instrument: str = Query(..., description="ES or NQ"),
    from_: Optional[str] = Query(None, alias="from"),
    to:    Optional[str] = Query(None),
    session: Optional[str] = Query(None, description="RTH / PRE / POST / OVERNIGHT"),
    tick_store=Depends(get_tick_store),
    ohlcv_store=Depends(get_ohlcv_store),
) -> JSONResponse:
    """Return volume profile (POC, VAH, VAL, per-level rows) for a time window."""
    inst = _validate_instrument(instrument)
    start, end = _resolve_window(from_, to)

    vp = compute_vp(
        instrument=inst,
        start=start,
        end=end,
        session_filter=session,
        tick_store=tick_store,
        ohlcv_store=ohlcv_store,
    )

    rows = [
        {
            "price": r.price,
            "volume": r.volume,
            "buy_vol": r.buy_vol,
            "sell_vol": r.sell_vol,
            "delta": r.delta,
            "is_poc": r.is_poc,
            "in_value_area": r.in_value_area,
        }
        for r in vp.rows
    ]

    return JSONResponse(content={
        "instrument": inst,
        "session": vp.session,
        "poc": vp.poc,
        "vah": vp.vah,
        "val": vp.val,
        "total_volume": vp.total_volume,
        "rows": rows,
    })


@router.get("/delta")
async def get_delta(
    request: Request,
    instrument: str = Query(..., description="ES or NQ"),
    from_: Optional[str] = Query(None, alias="from"),
    to:    Optional[str] = Query(None),
    session: Optional[str] = Query(None),
    tick_store=Depends(get_tick_store),
) -> JSONResponse:
    """Return per-bar delta and CVD for a time window."""
    inst = _validate_instrument(instrument)
    start, end = _resolve_window(from_, to)

    bars = compute_cvd(
        instrument=inst,
        start=start,
        end=end,
        session_filter=session,
        tick_store=tick_store,
    )

    return JSONResponse(content={
        "instrument": inst,
        "count": len(bars),
        "bars": bars,
    })


@router.get("/footprint")
async def get_footprint(
    request: Request,
    instrument: str = Query(..., description="ES or NQ"),
    from_: Optional[str] = Query(None, alias="from"),
    to:    Optional[str] = Query(None),
    session: Optional[str] = Query(None),
    tick_store=Depends(get_tick_store),
) -> JSONResponse:
    """Return footprint bars (bid/ask volume per price level per bar)."""
    inst = _validate_instrument(instrument)
    start, end = _resolve_window(from_, to)

    fp_bars = compute_footprint(
        instrument=inst,
        start=start,
        end=end,
        session_filter=session,
        tick_store=tick_store,
    )

    return JSONResponse(content={
        "instrument": inst,
        "count": len(fp_bars),
        "bars": [footprint_to_dict(b) for b in fp_bars],
    })


# ── Internal helpers ─────────────────────────────────────────────────────────

def _resolve_window(
    from_str: str | None,
    to_str:   str | None,
) -> tuple[datetime.datetime, datetime.datetime]:
    """Parse from/to strings or fall back to today's RTH window."""
    if from_str or to_str:
        start = _parse_dt(from_str, "from") or datetime.datetime.now(UTC) - datetime.timedelta(hours=8)
        end   = _parse_dt(to_str, "to")   or datetime.datetime.now(UTC)
    else:
        start, end = _default_window()

    if start >= end:
        raise HTTPException(
            status_code=400,
            detail=f"'from' ({start.isoformat()}) must be before 'to' ({end.isoformat()})"
        )
    return start, end
