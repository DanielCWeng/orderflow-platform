"""
gap_detector.py — Detect missing OHLCV bars vs expected session schedule.

A "gap" is any expected 1-minute bar timestamp that is absent from the
ohlcv table for a given instrument.

Rules:
  - Look back up to GAP_LOOKBACK_DAYS calendar days from today (ET).
  - Only check RTH, PRE, and POST sessions.
  - Skip the maintenance window entirely.
  - Compare expected bar timestamps against bars actually stored in DuckDB.
  - Return gaps grouped by (instrument, session, date) for efficient backfill.

Only sessions with at least one missing bar are returned.
"""

from __future__ import annotations

import datetime
import logging
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo

from ..config import INSTRUMENTS, GAP_LOOKBACK_DAYS
from ..ingestion.session import expected_bar_timestamps
from ..storage.ohlcv_store import OHLCVStore

logger = logging.getLogger(__name__)

ET = ZoneInfo("America/New_York")

# Sessions to check (maintenance is intentionally excluded)
CHECK_SESSIONS = ["RTH", "PRE", "POST"]


@dataclass
class Gap:
    """Represents a contiguous block of missing bars for one instrument+session+date."""
    instrument: str
    session: str
    date: datetime.date
    missing_timestamps: list[datetime.datetime] = field(default_factory=list)

    @property
    def start(self) -> datetime.datetime:
        return self.missing_timestamps[0]

    @property
    def end(self) -> datetime.datetime:
        """One minute past the last missing bar (exclusive end for fetch range)."""
        return self.missing_timestamps[-1] + datetime.timedelta(minutes=1)

    def __repr__(self) -> str:
        return (
            f"Gap({self.instrument} {self.session} {self.date} "
            f"count={len(self.missing_timestamps)} "
            f"[{self.start.isoformat()} → {self.end.isoformat()}])"
        )


class GapDetector:
    """
    Detects missing OHLCV bars for all configured instruments.

    Parameters
    ----------
    ohlcv_store : OHLCVStore
        The store to query for existing bars.
    lookback_days : int
        How many calendar days back to check (default from config).
    """

    def __init__(
        self,
        ohlcv_store: OHLCVStore,
        lookback_days: int = GAP_LOOKBACK_DAYS,
    ) -> None:
        self._store = ohlcv_store
        self._lookback_days = lookback_days

    def detect(self, instruments: list[str] | None = None) -> list[Gap]:
        """
        Run gap detection for the given instruments (default: all configured).

        Returns a list of Gap objects sorted by (instrument, date, session).
        """
        if instruments is None:
            instruments = list(INSTRUMENTS.keys())

        today_et = datetime.datetime.now(ET).date()
        gaps: list[Gap] = []

        for instrument in instruments:
            for days_back in range(1, self._lookback_days + 1):
                date = today_et - datetime.timedelta(days=days_back)

                # Skip weekends — futures close Saturday morning and reopen Sunday
                # (simplified: skip Saturday and Sunday completely for gap detection)
                if date.weekday() in (5, 6):  # Saturday=5, Sunday=6
                    continue

                date_gaps = self._check_date(instrument, date)
                gaps.extend(date_gaps)

        gaps.sort(key=lambda g: (g.instrument, g.date, g.session))
        logger.info(
            "gap_detector: found %d gap blocks across %s",
            len(gaps), instruments
        )
        return gaps

    def _check_date(self, instrument: str, date: datetime.date) -> list[Gap]:
        """Check all sessions for a single instrument+date."""
        result: list[Gap] = []

        # Build the full window for this date so we can query existing bars once
        session_ranges = []
        for session in CHECK_SESSIONS:
            expected = expected_bar_timestamps(date, resolution_minutes=1,
                                               sessions=[session])
            if expected:
                session_ranges.append((session, expected))

        if not session_ranges:
            return result

        # Query the full day's bars in one shot (spans overnight into next day)
        day_start = min(ts for _, tss in session_ranges for ts in tss)
        day_end   = max(ts for _, tss in session_ranges for ts in tss) + datetime.timedelta(minutes=1)

        existing = self._store.existing_timestamps(instrument, day_start, day_end)

        for session, expected_ts in session_ranges:
            missing = [ts for ts in expected_ts if ts not in existing]
            if not missing:
                continue

            gap = Gap(
                instrument=instrument,
                session=session,
                date=date,
                missing_timestamps=sorted(missing),
            )
            result.append(gap)
            logger.debug("gap: %r", gap)

        return result


def find_gaps(
    ohlcv_store: OHLCVStore,
    instruments: list[str] | None = None,
    lookback_days: int = GAP_LOOKBACK_DAYS,
) -> list[Gap]:
    """
    Convenience function: instantiate GapDetector and run detection.

    Parameters
    ----------
    ohlcv_store:   store to check
    instruments:   instruments to check; None = all from config
    lookback_days: how far back to look

    Returns list of Gap objects.
    """
    detector = GapDetector(ohlcv_store, lookback_days)
    return detector.detect(instruments)
