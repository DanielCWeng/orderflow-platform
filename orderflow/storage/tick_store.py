"""
tick_store.py — DuckDB-backed raw tick storage.

Schema (table: ticks):
  instrument  TEXT          -- NQ, ES
  contract    TEXT          -- NQM26, ESM26
  timestamp   TIMESTAMPTZ   -- UTC
  price       DOUBLE
  size        INTEGER
  side        TEXT          -- B / A / U
  session     TEXT          -- RTH / PRE / POST / OVERNIGHT / MAINTENANCE

All queries use parameterized form to prevent SQL injection.
"""

from __future__ import annotations

import datetime
import logging
from pathlib import Path
from typing import Any

import duckdb

logger = logging.getLogger(__name__)

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS ticks (
    instrument  TEXT        NOT NULL,
    contract    TEXT        NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL,
    price       DOUBLE      NOT NULL,
    size        INTEGER     NOT NULL,
    side        TEXT        NOT NULL,
    session     TEXT        NOT NULL
);
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ticks_instrument_ts
    ON ticks (instrument, timestamp);
"""


class TickStore:
    """
    Thread-safe (single-writer) DuckDB tick store.

    DuckDB itself serialises concurrent writes on the same connection, so
    we keep a single connection and rely on it for serialisation.  For
    multi-process deployments the connection should be wrapped with a lock.
    """

    def __init__(self, db_path: str) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = duckdb.connect(db_path)
        self._ensure_schema()

    # ------------------------------------------------------------------ #
    #  Schema                                                             #
    # ------------------------------------------------------------------ #

    def _ensure_schema(self) -> None:
        self._conn.execute(CREATE_TABLE_SQL)
        self._conn.execute(CREATE_INDEX_SQL)

    # ------------------------------------------------------------------ #
    #  Writes                                                             #
    # ------------------------------------------------------------------ #

    def insert_ticks(self, rows: list[dict[str, Any]]) -> None:
        """
        Insert a batch of tick rows.

        Each dict must have keys: instrument, contract, timestamp, price,
        size, side, session.  timestamp may be a datetime or ISO string.
        """
        if not rows:
            return

        params = [
            (
                r["instrument"],
                r["contract"],
                _to_ts(r["timestamp"]),
                float(r["price"]),
                int(r["size"]),
                r["side"],
                r["session"],
            )
            for r in rows
        ]

        self._conn.executemany(
            """
            INSERT INTO ticks
                (instrument, contract, timestamp, price, size, side, session)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            params,
        )

    # ------------------------------------------------------------------ #
    #  Reads                                                              #
    # ------------------------------------------------------------------ #

    def query_ticks(
        self,
        instrument: str,
        start: datetime.datetime,
        end: datetime.datetime,
        session_filter: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        Return ticks for an instrument in [start, end).
        Optionally filter by session label.
        """
        if session_filter:
            rel = self._conn.execute(
                """
                SELECT instrument, contract, timestamp, price, size, side, session
                FROM ticks
                WHERE instrument = ?
                  AND timestamp >= ?
                  AND timestamp <  ?
                  AND session   =  ?
                ORDER BY timestamp
                """,
                [instrument, _to_ts(start), _to_ts(end), session_filter],
            )
        else:
            rel = self._conn.execute(
                """
                SELECT instrument, contract, timestamp, price, size, side, session
                FROM ticks
                WHERE instrument = ?
                  AND timestamp >= ?
                  AND timestamp <  ?
                ORDER BY timestamp
                """,
                [instrument, _to_ts(start), _to_ts(end)],
            )

        cols = [d[0] for d in rel.description]
        return [dict(zip(cols, row)) for row in rel.fetchall()]

    def latest_tick_ts(self, instrument: str) -> datetime.datetime | None:
        """Return the most recent tick timestamp for an instrument."""
        rel = self._conn.execute(
            "SELECT MAX(timestamp) FROM ticks WHERE instrument = ?",
            [instrument],
        )
        row = rel.fetchone()
        if row and row[0] is not None:
            return _normalise_ts(row[0])
        return None

    def count(self, instrument: str | None = None) -> int:
        """Row count, optionally filtered to a single instrument."""
        if instrument:
            rel = self._conn.execute(
                "SELECT COUNT(*) FROM ticks WHERE instrument = ?", [instrument]
            )
        else:
            rel = self._conn.execute("SELECT COUNT(*) FROM ticks")
        return rel.fetchone()[0]

    # ------------------------------------------------------------------ #
    #  Pruning helper (called by Pruner)                                  #
    # ------------------------------------------------------------------ #

    def delete_before(self, cutoff: datetime.datetime) -> int:
        """Delete ticks older than cutoff. Returns rows deleted."""
        result = self._conn.execute(
            "DELETE FROM ticks WHERE timestamp < ?", [_to_ts(cutoff)]
        )
        # DuckDB returns rowcount via changes()
        rel = self._conn.execute("SELECT changes()")
        count = rel.fetchone()[0]
        logger.info("tick_store: pruned %d rows before %s", count, cutoff)
        return count

    # ------------------------------------------------------------------ #
    #  Lifecycle                                                          #
    # ------------------------------------------------------------------ #

    def close(self) -> None:
        self._conn.close()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _to_ts(ts: Any) -> datetime.datetime:
    """Normalise various timestamp representations to a tz-aware datetime."""
    if isinstance(ts, datetime.datetime):
        if ts.tzinfo is None:
            return ts.replace(tzinfo=datetime.timezone.utc)
        return ts
    if isinstance(ts, str):
        dt = datetime.datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=datetime.timezone.utc)
        return dt
    raise TypeError(f"Cannot convert {type(ts)} to timestamp")


def _normalise_ts(ts: Any) -> datetime.datetime:
    """Handle DuckDB's various timestamp return types."""
    if isinstance(ts, datetime.datetime):
        if ts.tzinfo is None:
            return ts.replace(tzinfo=datetime.timezone.utc)
        return ts
    # DuckDB may return a string in some builds
    return _to_ts(str(ts))
