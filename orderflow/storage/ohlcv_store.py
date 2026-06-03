"""
ohlcv_store.py — DuckDB-backed OHLCV bar storage with Parquet serialization.

Schema (table: ohlcv):
  instrument  TEXT          -- NQ, ES
  contract    TEXT          -- NQM26, ESM26
  timestamp   TIMESTAMPTZ   -- bar open time, UTC
  open        DOUBLE
  high        DOUBLE
  low         DOUBLE
  close       DOUBLE
  volume      INTEGER
  source      TEXT          -- LIVE or BACKFILL
  session     TEXT          -- RTH / PRE / POST / OVERNIGHT / MAINTENANCE

Parquet files are written to:
  {PARQUET_DIR}/{instrument}/{YYYY-MM-DD}.parquet

All SQL queries use parameterized form.
"""

from __future__ import annotations

import datetime
import logging
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from ..config import PARQUET_DIR

logger = logging.getLogger(__name__)

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS ohlcv (
    instrument  TEXT        NOT NULL,
    contract    TEXT        NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL,
    open        DOUBLE      NOT NULL,
    high        DOUBLE      NOT NULL,
    low         DOUBLE      NOT NULL,
    close       DOUBLE      NOT NULL,
    volume      INTEGER     NOT NULL,
    source      TEXT        NOT NULL,
    session     TEXT        NOT NULL,
    PRIMARY KEY (instrument, timestamp)
);
"""

CREATE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_ohlcv_instrument_ts
    ON ohlcv (instrument, timestamp);
"""

PARQUET_SCHEMA = pa.schema([
    ("instrument", pa.string()),
    ("contract",   pa.string()),
    ("timestamp",  pa.timestamp("us", tz="UTC")),
    ("open",       pa.float64()),
    ("high",       pa.float64()),
    ("low",        pa.float64()),
    ("close",      pa.float64()),
    ("volume",     pa.int64()),
    ("source",     pa.string()),
    ("session",    pa.string()),
])


class OHLCVStore:
    """
    DuckDB OHLCV store with Parquet mirroring.

    upsert_bar() writes to DuckDB and also appends/rewrites the daily
    Parquet partition for that bar's date.
    """

    def __init__(self, db_path: str, parquet_dir: str = PARQUET_DIR) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = duckdb.connect(db_path)
        self._parquet_dir = Path(parquet_dir)
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

    def upsert_bar(self, row: dict[str, Any]) -> None:
        """
        Insert or replace a single OHLCV bar.  Uses INSERT OR REPLACE
        semantics on the (instrument, timestamp) primary key.
        """
        ts = _to_ts(row["timestamp"])
        self._conn.execute(
            """
            INSERT OR REPLACE INTO ohlcv
                (instrument, contract, timestamp, open, high, low, close,
                 volume, source, session)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                row["instrument"],
                row["contract"],
                ts,
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                int(row["volume"]),
                row["source"],
                row["session"],
            ],
        )
        self._write_parquet(row["instrument"], ts.date())

    def insert_bars(self, rows: list[dict[str, Any]]) -> None:
        """
        Bulk-insert bars (e.g., backfill).  Uses INSERT OR REPLACE.
        Groups Parquet writes by date to avoid redundant rewrites.
        """
        if not rows:
            return

        params = [
            (
                r["instrument"],
                r["contract"],
                _to_ts(r["timestamp"]),
                float(r["open"]),
                float(r["high"]),
                float(r["low"]),
                float(r["close"]),
                int(r["volume"]),
                r["source"],
                r["session"],
            )
            for r in rows
        ]

        self._conn.executemany(
            """
            INSERT OR REPLACE INTO ohlcv
                (instrument, contract, timestamp, open, high, low, close,
                 volume, source, session)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            params,
        )

        # Rewrite Parquet for affected dates
        affected: set[tuple[str, datetime.date]] = set()
        for r in rows:
            ts = _to_ts(r["timestamp"])
            affected.add((r["instrument"], ts.date()))
        for instrument, date in affected:
            self._write_parquet(instrument, date)

    # ------------------------------------------------------------------ #
    #  Reads                                                              #
    # ------------------------------------------------------------------ #

    def query_bars(
        self,
        instrument: str,
        start: datetime.datetime,
        end: datetime.datetime,
        session_filter: str | None = None,
        resolution: str = "1m",
    ) -> list[dict[str, Any]]:
        """
        Return OHLCV bars for an instrument in [start, end).

        resolution: '1m' returns raw 1-minute bars.  Other values are not
                    yet aggregated server-side — callers can post-aggregate.
        """
        if session_filter:
            rel = self._conn.execute(
                """
                SELECT instrument, contract, timestamp, open, high, low,
                       close, volume, source, session
                FROM ohlcv
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
                SELECT instrument, contract, timestamp, open, high, low,
                       close, volume, source, session
                FROM ohlcv
                WHERE instrument = ?
                  AND timestamp >= ?
                  AND timestamp <  ?
                ORDER BY timestamp
                """,
                [instrument, _to_ts(start), _to_ts(end)],
            )

        cols = [d[0] for d in rel.description]
        return [dict(zip(cols, row)) for row in rel.fetchall()]

    def existing_timestamps(
        self,
        instrument: str,
        start: datetime.datetime,
        end: datetime.datetime,
        session_filter: str | None = None,
    ) -> set[datetime.datetime]:
        """
        Return the set of bar timestamps already stored, used by gap_detector.
        """
        if session_filter:
            rel = self._conn.execute(
                """
                SELECT timestamp FROM ohlcv
                WHERE instrument = ?
                  AND timestamp >= ?
                  AND timestamp <  ?
                  AND session   =  ?
                """,
                [instrument, _to_ts(start), _to_ts(end), session_filter],
            )
        else:
            rel = self._conn.execute(
                """
                SELECT timestamp FROM ohlcv
                WHERE instrument = ?
                  AND timestamp >= ?
                  AND timestamp <  ?
                """,
                [instrument, _to_ts(start), _to_ts(end)],
            )

        result = set()
        for (ts,) in rel.fetchall():
            result.add(_normalise_ts(ts))
        return result

    def latest_bar_ts(self, instrument: str) -> datetime.datetime | None:
        """Return the most recent bar timestamp for an instrument."""
        rel = self._conn.execute(
            "SELECT MAX(timestamp) FROM ohlcv WHERE instrument = ?",
            [instrument],
        )
        row = rel.fetchone()
        if row and row[0] is not None:
            return _normalise_ts(row[0])
        return None

    # ------------------------------------------------------------------ #
    #  Parquet                                                            #
    # ------------------------------------------------------------------ #

    def _write_parquet(self, instrument: str, date: datetime.date) -> None:
        """
        Rewrite the Parquet partition for a given instrument + date by
        reading all matching rows from DuckDB and writing them atomically.
        """
        try:
            rel = self._conn.execute(
                """
                SELECT instrument, contract, timestamp, open, high, low,
                       close, volume, source, session
                FROM ohlcv
                WHERE instrument = ?
                  AND CAST(timestamp AS DATE) = ?
                ORDER BY timestamp
                """,
                [instrument, str(date)],
            )
            rows = rel.fetchall()
            if not rows:
                return

            cols = [d[0] for d in rel.description]
            col_data: dict[str, list] = {c: [] for c in cols}
            for row in rows:
                for c, v in zip(cols, row):
                    col_data[c].append(v)

            # Normalise timestamps to UTC datetime objects
            ts_list = [
                _normalise_ts(t).replace(tzinfo=None)  # PyArrow UTC tz handles tz separately
                for t in col_data["timestamp"]
            ]
            col_data["timestamp"] = ts_list

            table = pa.table(col_data, schema=PARQUET_SCHEMA)

            out_dir = self._parquet_dir / instrument
            out_dir.mkdir(parents=True, exist_ok=True)
            out_path = out_dir / f"{date.isoformat()}.parquet"
            pq.write_table(table, str(out_path), compression="snappy")
            logger.debug("parquet: wrote %d rows → %s", len(rows), out_path)

        except Exception as exc:
            logger.error("parquet write failed (%s %s): %s", instrument, date, exc)

    # ------------------------------------------------------------------ #
    #  Pruning helper (called by Pruner)                                  #
    # ------------------------------------------------------------------ #

    def delete_before(self, cutoff: datetime.datetime) -> int:
        """Delete bars older than cutoff. Returns rows deleted."""
        self._conn.execute(
            "DELETE FROM ohlcv WHERE timestamp < ?", [_to_ts(cutoff)]
        )
        rel = self._conn.execute("SELECT changes()")
        count = rel.fetchone()[0]
        logger.info("ohlcv_store: pruned %d rows before %s", count, cutoff)
        return count

    # ------------------------------------------------------------------ #
    #  Lifecycle                                                          #
    # ------------------------------------------------------------------ #

    def close(self) -> None:
        self._conn.close()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _to_ts(ts: Any) -> datetime.datetime:
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
    if isinstance(ts, datetime.datetime):
        if ts.tzinfo is None:
            return ts.replace(tzinfo=datetime.timezone.utc)
        return ts
    return _to_ts(str(ts))
