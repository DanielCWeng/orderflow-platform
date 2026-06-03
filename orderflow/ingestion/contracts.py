"""
contracts.py — Active contract resolution and quarterly rollover schedule.

CME ES and NQ futures roll quarterly on the third Friday of the expiry month
(March, June, September, December).  The front-month contract code follows the
format: {root}{month_code}{2-digit year}, e.g. ESM26, NQU26.

Month codes:
  H = March
  M = June
  U = September
  Z = December
"""

from __future__ import annotations

import calendar
import datetime
from zoneinfo import ZoneInfo

from ..config import INSTRUMENTS

ET = ZoneInfo("America/New_York")

# Month code → month number
MONTH_CODES: dict[str, int] = {
    "H": 3,
    "M": 6,
    "U": 9,
    "Z": 12,
}

# Month number → month code
MONTH_TO_CODE: dict[int, str] = {v: k for k, v in MONTH_CODES.items()}

# Expiry months
EXPIRY_MONTHS = (3, 6, 9, 12)


def third_friday(year: int, month: int) -> datetime.date:
    """Return the date of the third Friday in a given year/month."""
    # Find the first day of the month and what weekday it is
    first_day = datetime.date(year, month, 1)
    # weekday(): Monday=0, Friday=4
    first_friday_offset = (4 - first_day.weekday()) % 7
    first_friday = first_day + datetime.timedelta(days=first_friday_offset)
    return first_friday + datetime.timedelta(weeks=2)


def next_roll_date(reference: datetime.date | None = None) -> datetime.date:
    """
    Return the next contract roll date (third Friday of the next expiry month)
    on or after the reference date.

    If reference is None, uses today (ET).
    """
    if reference is None:
        reference = datetime.datetime.now(ET).date()

    year = reference.year
    for month in EXPIRY_MONTHS:
        roll = third_friday(year, month)
        if roll >= reference:
            return roll
    # Wrap to next year
    return third_friday(year + 1, 3)


def active_contract(instrument: str, reference: datetime.date | None = None) -> str:
    """
    Resolve the active front-month contract code for an instrument on a given
    reference date.

    This function derives the contract code from the roll calendar rather than
    relying solely on the static config — the config value is the primary source
    but this function is used for validation and future-proofing.

    On or after the roll date, the contract flips to the next expiry month.
    """
    if reference is None:
        reference = datetime.datetime.now(ET).date()

    root = INSTRUMENTS[instrument]["contract"][:2]  # "ES" or "NQ"

    year = reference.year
    for month in EXPIRY_MONTHS:
        roll = third_friday(year, month)
        if reference < roll:
            # This expiry month is still the front month
            code = MONTH_TO_CODE[month]
            yy = str(year % 100).zfill(2)
            return f"{root}{code}{yy}"

    # Past December roll of this year → March of next year
    code = MONTH_TO_CODE[3]
    yy = str((year + 1) % 100).zfill(2)
    return f"{root}{code}{yy}"


def contract_from_config(instrument: str) -> str:
    """Return the contract string stored in config (e.g. 'ESM26')."""
    return INSTRUMENTS[instrument]["contract"]


def parse_contract(contract: str) -> tuple[str, int, int]:
    """
    Parse a contract string like 'ESM26' into (root, month, year).

    Returns:
        root  — 'ES' or 'NQ'
        month — numeric month (1-12)
        year  — 4-digit year (e.g. 2026)
    """
    root = contract[:2]
    month_code = contract[2]
    yy = int(contract[3:])
    month = MONTH_CODES[month_code]
    year = 2000 + yy
    return root, month, year


def expiry_date(contract: str) -> datetime.date:
    """Return the expiry date (third Friday) for a contract string."""
    _, month, year = parse_contract(contract)
    return third_friday(year, month)
