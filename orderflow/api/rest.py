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

from ..ingestion.session import classify
from ..ingestion.contracts import contract_from_config

logger = logging.getLogger(__name__)

router = APIRouter()

UTC = datetime.timezone.utc
_EPOCH = datetime.datetime(1970, 1, 1, tzinfo=UTC)


def _epoch_ms_to_dt(ms: int) -> datetime.datetime:
    """Convert epoch milliseconds to UTC datetime. Safe on Windows (no fromtimestamp)."""
    return _EPOCH + datetime.timedelta(milliseconds=ms)


def _epoch_s_to_dt(s: int) -> datetime.datetime:
    """Convert epoch seconds to UTC datetime. Safe on Windows (no fromtimestamp).
    Auto-detects milliseconds (>10 digits) and converts to seconds."""
    if s > 9_999_999_999:
        s = s // 1000
    return _EPOCH + datetime.timedelta(seconds=s)


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


class IngestTicksRequest(BaseModel):
    instrument: str
    trades: list[dict]  # raw IronBeam tr format: [{p, sz, td, st}, ...]


class IngestBarsRequest(BaseModel):
    instrument: str
    bars: list[dict]  # raw IronBeam ti format: [{t, o, h, l, c, v}, ...]


@router.post("/ingest/ticks")
async def ingest_ticks(
    body: IngestTicksRequest,
    tick_store=Depends(get_tick_store),
) -> dict:
    """Receive raw trade frames from the browser and write to DuckDB tick store."""
    inst = _validate_instrument(body.instrument)
    contract = contract_from_config(inst)
    now_utc = datetime.datetime.now(UTC)
    rows: list[dict] = []

    for t in body.trades:
        price = float(t.get("p", 0))
        size  = int(t.get("sz", 0))
        if not price or not size:
            continue
        td    = t.get("td", 0)
        st_raw = int(t.get("st", now_utc.timestamp() * 1000))
        st_ms  = st_raw if st_raw > 9_999_999_999 else st_raw * 1000  # normalise s → ms
        ts     = _epoch_ms_to_dt(st_ms)
        side  = "B" if (td == 1 or td == "BUY") else ("A" if (td == 2 or td == "SELL") else "U")
        rows.append({
            "instrument": inst,
            "contract":   contract,
            "timestamp":  ts,
            "price":      price,
            "size":       size,
            "side":       side,
            "session":    classify(ts),
        })

    if rows:
        tick_store.insert_ticks(rows)

    return {"written": len(rows)}


@router.post("/ingest/bars")
async def ingest_bars(
    body: IngestBarsRequest,
    ohlcv_store=Depends(get_ohlcv_store),
) -> dict:
    """Receive completed bar frames from the browser and write to DuckDB ohlcv store."""
    inst = _validate_instrument(body.instrument)
    contract = contract_from_config(inst)
    written = 0

    for bar in body.bars:
        t_s = int(bar.get("t", 0))
        if not t_s:
            continue
        ts = _epoch_s_to_dt(t_s)
        ohlcv_store.upsert_bar({
            "instrument": inst,
            "contract":   contract,
            "timestamp":  ts,
            "open":       float(bar.get("o", 0)),
            "high":       float(bar.get("h", 0)),
            "low":        float(bar.get("l", 0)),
            "close":      float(bar.get("c", 0)),
            "volume":     int(bar.get("v", 0)),
            "source":     "LIVE",
            "session":    classify(ts),
        })
        written += 1

    return {"written": written}


# NOTE: /connect and the IronBeam client below are NOT part of the normal data flow.
# The browser (data-live.js) connects to IronBeam directly and forwards data via
# POST /ingest/ticks and POST /ingest/bars.  /connect is kept for standalone
# backend testing only — do not call it while the frontend is running.
@router.post("/connect")
async def connect(body: ConnectRequest, request: Request) -> dict:
    """
    Start IronBeam WebSocket clients using the supplied credentials.
    TEST ONLY — not used in normal operation (frontend handles the IronBeam connection).
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


@router.post("/backfill/run")
async def run_backfill(request: Request) -> dict:
    """Detect gaps and backfill via yfinance. Returns bars written per instrument."""
    from ..backfill.gap_detector import find_gaps
    from ..backfill.yfinance_fill import backfill_gaps

    ohlcv_store = getattr(request.app.state, "ohlcv_store", None)
    if ohlcv_store is None:
        raise HTTPException(status_code=503, detail="ohlcv_store not initialised")

    try:
        gaps = find_gaps(ohlcv_store)
        logger.info("backfill/run: found %d gap blocks", len(gaps))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"gap detection failed: {exc}")

    if not gaps:
        return {"status": "ok", "gaps": 0, "bars_written": {}}

    try:
        summary = await backfill_gaps(gaps, ohlcv_store)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"backfill failed: {exc}")

    return {"status": "ok", "gaps": len(gaps), "bars_written": summary}


@router.get("/data/status")
async def data_status(
    request: Request,
    ohlcv_store=Depends(get_ohlcv_store),
) -> JSONResponse:
    """
    Return a compact coverage summary: bar counts per instrument per date,
    split by source (LIVE vs BACKFILL).  Useful for checking what's in DuckDB
    without reading logs.

    Example response:
      {
        "ES": {
          "total_bars": 1234,
          "oldest": "2026-05-29T09:30:00+00:00",
          "newest": "2026-06-05T15:59:00+00:00",
          "by_date": [
            {"date": "2026-06-05", "bars": 390, "live": 80, "backfill": 310}
          ]
        }
      }
    """
    result = {}
    for inst in INSTRUMENTS:
        rel = ohlcv_store._conn.execute(
            """
            SELECT
                CAST(timestamp AS DATE)  AS date,
                COUNT(*)                 AS bars,
                SUM(CASE WHEN source = 'LIVE'     THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN source = 'BACKFILL' THEN 1 ELSE 0 END) AS backfill
            FROM ohlcv
            WHERE instrument = ?
            GROUP BY 1
            ORDER BY 1 DESC
            """,
            [inst],
        )
        rows = rel.fetchall()

        if not rows:
            result[inst] = {"total_bars": 0, "oldest": None, "newest": None, "by_date": []}
            continue

        by_date = [
            {"date": str(r[0]), "bars": r[1], "live": r[2], "backfill": r[3]}
            for r in rows
        ]
        total = sum(r["bars"] for r in by_date)

        oldest_ts = ohlcv_store._conn.execute(
            "SELECT MIN(timestamp) FROM ohlcv WHERE instrument = ?", [inst]
        ).fetchone()[0]
        newest_ts = ohlcv_store._conn.execute(
            "SELECT MAX(timestamp) FROM ohlcv WHERE instrument = ?", [inst]
        ).fetchone()[0]

        result[inst] = {
            "total_bars": total,
            "oldest": oldest_ts.isoformat() if oldest_ts else None,
            "newest": newest_ts.isoformat() if newest_ts else None,
            "by_date": by_date,
        }

    return JSONResponse(content=result)


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
