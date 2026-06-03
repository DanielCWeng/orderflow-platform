"""
main.py — Orderflow platform startup sequence.

Startup order (per spec):
  1. Load config, resolve active contracts for NQ and ES
  2. Connect DuckDB, create tables if not exist
  3. Run gap_detector against expected session schedule
  4. For each gap: fetch yfinance 1-min, write to OHLCV store with source=BACKFILL
  5. Start pruner scheduler (runs at 18:05 ET daily)
  6. Connect IronBeam WebSocket for both instruments
  7. Start FastAPI server

Run with:
    python -m orderflow.main
or:
    uvicorn orderflow.main:app
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import (
    DB_PATH,
    PARQUET_DIR,
    API_HOST,
    API_PORT,
    INSTRUMENTS,
)
from .ingestion.contracts import active_contract, contract_from_config
from .storage.tick_store import TickStore
from .storage.ohlcv_store import OHLCVStore
from .storage.pruner import Pruner
from .backfill.gap_detector import find_gaps
from .backfill.yfinance_fill import backfill_gaps
from .ingestion.ironbeam import build_clients
from .api.rest import router as rest_router
from .api.ws import router as ws_router, push_tick

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Ensure data directories exist ─────────────────────────────────────────────

Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
Path(PARQUET_DIR).mkdir(parents=True, exist_ok=True)


# ── Lifespan (FastAPI startup / shutdown) ─────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Full startup sequence, then yield for request handling, then clean shutdown.
    """

    # ── Step 1: Config and contract resolution ────────────────────────────────
    logger.info("=== orderflow platform starting ===")
    for inst in INSTRUMENTS:
        configured = contract_from_config(inst)
        computed   = active_contract(inst)
        if configured != computed:
            logger.warning(
                "Contract mismatch for %s: config=%s, computed=%s — "
                "update config.py if contract has rolled",
                inst, configured, computed
            )
        else:
            logger.info("contract: %s → %s", inst, configured)

    # ── Step 2: Connect DuckDB, create tables ─────────────────────────────────
    logger.info("connecting DuckDB at %s", DB_PATH)
    tick_store  = TickStore(DB_PATH)
    ohlcv_store = OHLCVStore(DB_PATH, PARQUET_DIR)

    # Attach to app state for dependency injection in REST handlers
    app.state.tick_store  = tick_store
    app.state.ohlcv_store = ohlcv_store

    # ── Step 3: Gap detection ─────────────────────────────────────────────────
    logger.info("running gap detection...")
    try:
        gaps = find_gaps(ohlcv_store)
        logger.info("gap_detector: found %d gap blocks", len(gaps))
    except Exception as exc:
        logger.error("gap_detector failed: %s", exc)
        gaps = []

    # ── Step 4: Backfill gaps via yfinance ────────────────────────────────────
    if gaps:
        logger.info("backfilling %d gap blocks via yfinance...", len(gaps))
        try:
            summary = await backfill_gaps(gaps, ohlcv_store)
            logger.info("backfill complete: %s", summary)
        except Exception as exc:
            logger.error("backfill failed: %s", exc)
    else:
        logger.info("no gaps to backfill")

    # ── Step 5: Start pruner scheduler ────────────────────────────────────────
    pruner = Pruner(tick_store, ohlcv_store)
    try:
        pruner.start()
        logger.info("pruner: scheduler started")
    except Exception as exc:
        logger.error("pruner failed to start: %s", exc)

    # ── Step 6: Build IronBeam clients — started on POST /connect ────────────
    clients = build_clients(
        tick_store=tick_store,
        ohlcv_store=ohlcv_store,
        push_tick_fn=push_tick,
    )
    app.state.ib_clients = clients
    app.state.ib_tasks   = []
    logger.info("ironbeam: %d client(s) ready — waiting for POST /connect", len(clients))

    # ── Step 7: FastAPI server is started by uvicorn (we're inside lifespan) ──
    logger.info("=== startup complete — API listening on %s:%d ===", API_HOST, API_PORT)

    # Yield — FastAPI handles requests here
    yield

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("shutting down...")

    for client in app.state.ib_clients:
        await client.stop()

    for task in app.state.ib_tasks:
        task.cancel()
        try:
            await asyncio.wait_for(task, timeout=5.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    pruner.stop()
    tick_store.close()
    ohlcv_store.close()
    logger.info("shutdown complete")


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="Orderflow Platform",
    description="Real-time NQ/ES futures order flow data platform",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(rest_router)
app.include_router(ws_router)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    """Run the platform using uvicorn."""
    uvicorn.run(
        "orderflow.main:app",
        host=API_HOST,
        port=API_PORT,
        log_level="info",
        reload=False,
        loop="asyncio",
    )


if __name__ == "__main__":
    main()
