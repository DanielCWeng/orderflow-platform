"""
pruner.py — Scheduled data pruning.

Rules:
  - Raw ticks: delete where timestamp < now() - 7 days
  - OHLCV bars: delete where timestamp < now() - 35 days
  - Run at 18:05 ET daily (never during RTH)
  - Guard: abort if current session is RTH

The Pruner is driven by APScheduler (AsyncIOScheduler).  The PRUNER_CRON
constant in config.py sets the schedule.
"""

from __future__ import annotations

import datetime
import logging
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from ..config import (
    PRUNER_CRON,
    TICK_RETENTION_DAYS,
    OHLCV_RETENTION_DAYS,
)
from ..ingestion.session import classify
from .tick_store import TickStore
from .ohlcv_store import OHLCVStore

logger = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")


class Pruner:
    """
    Runs data pruning on a cron schedule using APScheduler.

    Usage:
        pruner = Pruner(tick_store, ohlcv_store)
        pruner.start()    # registers job with the scheduler
        # ... later ...
        pruner.stop()
    """

    def __init__(self, tick_store: TickStore, ohlcv_store: OHLCVStore) -> None:
        self._tick_store = tick_store
        self._ohlcv_store = ohlcv_store
        self._scheduler = AsyncIOScheduler(timezone="America/New_York")

    def start(self) -> None:
        """Register the pruning job and start the scheduler."""
        # Parse cron string: "5 18 * * *"
        parts = PRUNER_CRON.split()
        minute, hour = parts[0], parts[1]

        self._scheduler.add_job(
            self._run_prune,
            CronTrigger(
                hour=int(hour),
                minute=int(minute),
                timezone="America/New_York",
            ),
            id="pruner",
            replace_existing=True,
        )
        self._scheduler.start()
        logger.info("pruner: scheduled at cron '%s' (ET)", PRUNER_CRON)

    def stop(self) -> None:
        """Shut down the scheduler."""
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    async def _run_prune(self) -> None:
        """
        Prune old data.  Aborts if the current session is RTH.
        """
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        session = classify(now_utc)

        if session == "RTH":
            logger.warning("pruner: skipping — currently in RTH session")
            return

        logger.info("pruner: starting prune run (session=%s)", session)

        tick_cutoff = now_utc - datetime.timedelta(days=TICK_RETENTION_DAYS)
        ohlcv_cutoff = now_utc - datetime.timedelta(days=OHLCV_RETENTION_DAYS)

        try:
            tick_deleted = self._tick_store.delete_before(tick_cutoff)
            logger.info("pruner: deleted %d ticks older than %s", tick_deleted, tick_cutoff.date())
        except Exception as exc:
            logger.error("pruner: tick prune failed: %s", exc)

        try:
            ohlcv_deleted = self._ohlcv_store.delete_before(ohlcv_cutoff)
            logger.info("pruner: deleted %d OHLCV bars older than %s", ohlcv_deleted, ohlcv_cutoff.date())
        except Exception as exc:
            logger.error("pruner: ohlcv prune failed: %s", exc)

    async def run_now(self) -> None:
        """Manually trigger the prune job (for testing or forced runs)."""
        await self._run_prune()
