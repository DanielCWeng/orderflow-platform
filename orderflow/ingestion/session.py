"""
session.py — Session classification for US futures (NQ / ES).

Session schedule (US/Eastern, applies to both instruments):
  overnight:    18:00 prior day  → 09:30 current day
  pre-market:   09:00            → 09:30
  RTH:          09:30            → 16:00
  post-market:  16:00            → 18:00
  maintenance:  17:00            → 18:00  (within post-market window, precedence)

Note: pre-market is a sub-window of overnight for detection purposes; it is
classified independently because the spec lists it separately and some
analytics differentiate the two.

The maintenance window (17:00–18:00 ET) overlaps with post-market; it takes
precedence when both conditions would match.
"""

from __future__ import annotations

import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")


def classify(ts: datetime.datetime) -> str:
    """
    Classify a UTC (or tz-aware) datetime into a session string.

    Returns one of: 'RTH', 'PRE', 'POST', 'OVERNIGHT', 'MAINTENANCE'

    The ts argument may be tz-aware (any zone) or tz-naive (treated as UTC).
    """
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=datetime.timezone.utc)

    et: datetime.datetime = ts.astimezone(ET)
    t = et.time()

    t_0900 = datetime.time(9, 0)
    t_0930 = datetime.time(9, 30)
    t_1600 = datetime.time(16, 0)
    t_1700 = datetime.time(17, 0)
    t_1800 = datetime.time(18, 0)

    # Maintenance takes precedence over post-market (same window, stricter label)
    if t_1700 <= t < t_1800:
        return "MAINTENANCE"

    if t_0930 <= t < t_1600:
        return "RTH"

    if t_0900 <= t < t_0930:
        return "PRE"

    if t_1600 <= t < t_1700:
        return "POST"

    # Everything else: overnight (18:00–09:00 ET spans midnight)
    return "OVERNIGHT"


def session_ranges_for_date(
    date: datetime.date,
) -> list[tuple[str, datetime.datetime, datetime.datetime]]:
    """
    Return a list of (session, start_utc, end_utc) tuples for a given
    calendar date (ET), covering every non-maintenance session window that
    would normally produce bars for that trading day.

    Used by gap_detector to enumerate expected bar timestamps.

    Sessions returned (in order):
      OVERNIGHT  — 18:00 prior day ET → 09:00 current day ET
      PRE        — 09:00             → 09:30
      RTH        — 09:30             → 16:00
      POST       — 16:00             → 17:00  (excluding maintenance)

    Maintenance (17:00–18:00) is intentionally omitted per spec.
    """
    def _et(d: datetime.date, hour: int, minute: int) -> datetime.datetime:
        return datetime.datetime(d.year, d.month, d.day, hour, minute,
                                 tzinfo=ET).astimezone(datetime.timezone.utc)

    prior = date - datetime.timedelta(days=1)

    overnight_start = _et(prior, 18, 0)
    overnight_end   = _et(date,   9, 0)
    pre_start       = _et(date,   9, 0)
    pre_end         = _et(date,   9, 30)
    rth_start       = _et(date,   9, 30)
    rth_end         = _et(date,  16, 0)
    post_start      = _et(date,  16, 0)
    post_end        = _et(date,  17, 0)   # end before maintenance window

    return [
        ("OVERNIGHT", overnight_start, overnight_end),
        ("PRE",       pre_start,       pre_end),
        ("RTH",       rth_start,       rth_end),
        ("POST",      post_start,      post_end),
    ]


def expected_bar_timestamps(
    date: datetime.date,
    resolution_minutes: int = 1,
    sessions: list[str] | None = None,
) -> list[datetime.datetime]:
    """
    Enumerate every expected bar open timestamp (UTC) for a given ET date.

    Parameters
    ----------
    date:               ET calendar date
    resolution_minutes: bar size in minutes (default 1)
    sessions:           filter to these session labels; None = all sessions

    Returns UTC datetimes for bar opens, sorted ascending.
    """
    if sessions is None:
        sessions = ["OVERNIGHT", "PRE", "RTH", "POST"]

    step = datetime.timedelta(minutes=resolution_minutes)
    results: list[datetime.datetime] = []

    for session, start, end in session_ranges_for_date(date):
        if session not in sessions:
            continue
        t = start
        while t < end:
            results.append(t)
            t += step

    return sorted(results)
