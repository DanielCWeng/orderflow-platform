"""Fetch NQ futures options chain from Barchart (no login required)."""

import logging
import re
import urllib.parse
from datetime import date, timedelta

import requests

from config import MONEYNESS_MIN, MONEYNESS_MAX, NQ_CONTRACT

log = logging.getLogger(__name__)

_BASE = "https://www.barchart.com"
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# CME month-letter → month number
_MONTH_CODES = {
    "F": 1, "G": 2, "H": 3, "J": 4, "K": 5, "M": 6,
    "N": 7, "Q": 8, "U": 9, "V": 10, "X": 11, "Z": 12,
}


def _init_session(contract: str) -> requests.Session:
    """Load the Barchart options page to obtain session cookies."""
    session = requests.Session()
    session.get(
        f"{_BASE}/futures/quotes/{contract}/options?futuresOptionsView=merged",
        headers={"User-Agent": _UA},
        timeout=30,
    )
    return session


def _headers(session: requests.Session) -> dict:
    xsrf = urllib.parse.unquote(session.cookies.get("XSRF-TOKEN", ""))
    return {
        "User-Agent": _UA,
        "Referer": f"{_BASE}/futures/quotes/{NQ_CONTRACT}/options",
        "X-XSRF-TOKEN": xsrf,
        "Accept": "application/json",
    }


def contract_expiration_date(contract: str) -> str:
    """
    Derive the last trading day for a CME NQ contract from its symbol.

    NQ options last trading day = Thursday before the 3rd Friday of the
    contract month (which is when the underlying futures also expire).

    e.g. NQM26 → June 2026 → 3rd Friday = Jun 19 → last trading = Jun 18
    """
    m = re.match(r"^[A-Z]+([FGHJKMNQUVXZ])(\d{1,2})$", contract)
    if not m:
        return (date.today() + timedelta(days=30)).strftime("%Y-%m-%d")

    month = _MONTH_CODES[m.group(1)]
    year = 2000 + int(m.group(2))

    first_day = date(year, month, 1)
    days_to_first_friday = (4 - first_day.weekday()) % 7
    third_friday = first_day + timedelta(days=days_to_first_friday + 14)
    last_trading_day = third_friday - timedelta(days=1)  # Thursday
    return last_trading_day.strftime("%Y-%m-%d")


def _get_spot(session: requests.Session, contract: str) -> float | None:
    """Return the mid-price of the NQ front-month futures contract."""
    try:
        resp = session.get(
            f"{_BASE}/proxies/core-api/v1/quotes/get",
            params={
                "symbols": contract,
                "fields": "lastPrice,bidPrice,askPrice",
                "raw": 1,
            },
            headers=_headers(session),
            timeout=15,
        )
        resp.raise_for_status()
        items = resp.json().get("data", [])
        if items:
            raw = items[0].get("raw", {})
            bid = float(raw.get("bidPrice") or 0)
            ask = float(raw.get("askPrice") or 0)
            if bid > 0 and ask > 0:
                return (bid + ask) / 2.0
            last = float(raw.get("lastPrice") or 0)
            return last or None
    except Exception as exc:
        log.warning("Failed to get NQ spot: %s", exc)
    return None


def _fetch_raw_chain(session: requests.Session, contract: str) -> dict:
    """Return the raw Barchart API response for the futures options chain."""
    resp = session.get(
        f"{_BASE}/proxies/core-api/v1/quotes/get",
        params={
            "symbol": contract,
            "list": "futures.options",
            # gamma is pre-computed by Barchart on their volatility-greeks page.
            # We fetch it here so compute_contract_gex can skip the IV solve
            # entirely — critical after hours when bid/ask are zero.
            "fields": "strike,bidPrice,askPrice,openInterest,optionType,longSymbol,gamma",
            "meta": "field.shortName,field.type",
            "groupBy": "optionType",
            "orderBy": "strike",
            "orderDir": "asc",
            "raw": 1,
            "limit": 1000,
        },
        headers=_headers(session),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_nq_options(contract: str | None = None) -> tuple[list[dict], float | None]:
    """
    Fetch the NQ futures options chain from Barchart.

    Returns (chain, spot) where chain is a list of normalised contract dicts
    compatible with compute/gex.py.
    """
    contract = contract or NQ_CONTRACT

    log.info("Initialising Barchart session for %s...", contract)
    session = _init_session(contract)

    log.info("Fetching NQ spot price...")
    spot = _get_spot(session, contract)
    if spot:
        log.info("NQ spot: %.2f", spot)
    else:
        log.warning("NQ spot unavailable")

    expiration_date = contract_expiration_date(contract)
    log.info("Derived expiration date: %s", expiration_date)

    log.info("Fetching NQ options chain from Barchart...")
    payload = _fetch_raw_chain(session, contract)
    raw_data = payload.get("data", {})
    total = payload.get("total", 0)
    log.info("Raw chain: %d total records", total)

    chain: list[dict] = []
    skipped = 0

    for option_type, key in [("CALL", "Call"), ("PUT", "Put")]:
        rows = raw_data.get(key, []) if isinstance(raw_data, dict) else []
        for row in rows:
            raw = row.get("raw", {})
            strike = float(raw.get("strike") or 0)
            oi = int(raw.get("openInterest") or 0)
            bid = float(raw.get("bidPrice") or 0)
            ask = float(raw.get("askPrice") or 0)

            if oi <= 0:
                skipped += 1
                continue

            if spot and not (MONEYNESS_MIN * spot <= strike <= MONEYNESS_MAX * spot):
                skipped += 1
                continue

            # gamma: Barchart pre-computes this on the volatility-greeks endpoint.
            # None means the field wasn't returned; compute_contract_gex falls
            # back to IV solving in that case.
            gamma = raw.get("gamma")
            gamma = float(gamma) if gamma is not None else None

            chain.append({
                "symbol":          str(raw.get("longSymbol", "")),
                "strike":          strike,
                "option_type":     option_type,
                "expiration_date": expiration_date,
                "oi":              oi,
                "bid":             bid,
                "ask":             ask,
                "gamma":           gamma,
                "underlying":      contract,
            })

    log.info(
        "NQ chain: %d contracts (skipped %d — zero-OI or outside %.0f%%–%.0f%% moneyness)",
        len(chain), skipped,
        MONEYNESS_MIN * 100, MONEYNESS_MAX * 100,
    )
    return chain, spot
