"""Fetch QQQ and NDX equity options chains from the Tradier API."""

import logging
from datetime import datetime, timedelta

import requests

from config import TRADIER_BASE_URL, TRADIER_API_TOKEN

log = logging.getLogger(__name__)


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {TRADIER_API_TOKEN}",
        "Accept": "application/json",
    }


def _next_expirations(count: int = 2) -> list[str]:
    """Return the next `count` weekly expiration dates (Fridays) as YYYY-MM-DD strings.

    If today is a Friday (and market hasn't closed yet), include today as 0DTE.
    """
    today = datetime.utcnow().date()
    exps = []
    # Check if today is Friday — include as 0DTE
    if today.weekday() == 4:
        exps.append(today.strftime("%Y-%m-%d"))

    d = today
    while len(exps) < count:
        # Move to next day
        d += timedelta(days=1)
        if d.weekday() == 4:  # Friday
            exps.append(d.strftime("%Y-%m-%d"))

    return exps


def _fetch_chain(symbol: str, expiration: str) -> list[dict]:
    """Fetch a single options chain for symbol + expiration from Tradier."""
    resp = requests.get(
        f"{TRADIER_BASE_URL}/markets/options/chains",
        params={
            "symbol": symbol,
            "expiration": expiration,
            "greeks": "false",
        },
        headers=_headers(),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    # Tradier nests under options.option
    options = data.get("options")
    if not options:
        return []
    items = options.get("option", [])
    if isinstance(items, dict):
        items = [items]

    return items


def _get_spot(symbol: str) -> float | None:
    """Get current spot price from Tradier quotes."""
    try:
        resp = requests.get(
            f"{TRADIER_BASE_URL}/markets/quotes",
            params={"symbols": symbol},
            headers=_headers(),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        quotes = data.get("quotes", {})
        quote = quotes.get("quote", {})
        if isinstance(quote, list):
            quote = quote[0]
        last = quote.get("last")
        if last is not None:
            return float(last)
        bid = float(quote.get("bid", 0))
        ask = float(quote.get("ask", 0))
        if bid > 0 and ask > 0:
            return (bid + ask) / 2.0
    except Exception as exc:
        log.warning("Failed to get %s spot: %s", symbol, exc)
    return None


def fetch_equity_options(symbol: str) -> tuple[list[dict], float | None]:
    """
    Fetch options chain for an equity symbol (QQQ or NDX).

    Fetches the two nearest weekly expirations. Returns (chain, spot).
    """
    expirations = _next_expirations(2)
    log.info("Fetching %s chains for expirations: %s", symbol, expirations)

    spot = _get_spot(symbol)
    log.info("%s spot: %s", symbol, spot)

    chain = []
    skipped = 0

    # Sequential to avoid Tradier rate limits
    for exp in expirations:
        try:
            items = _fetch_chain(symbol, exp)
        except Exception as exc:
            log.warning("Failed to fetch %s chain for %s: %s", symbol, exp, exc)
            continue

        for item in items:
            oi = int(item.get("open_interest", 0))
            bid = float(item.get("bid", 0) or 0)
            ask = float(item.get("ask", 0) or 0)

            if oi <= 0:
                skipped += 1
                continue

            option_type = str(item.get("option_type", "")).upper()
            if option_type == "CALL" or option_type == "PUT":
                pass
            else:
                # Tradier uses lowercase "call"/"put"
                option_type = option_type.upper()

            chain.append({
                "symbol": item.get("symbol", ""),
                "strike": float(item.get("strike", 0)),
                "option_type": option_type,
                "expiration_date": item.get("expiration_date", exp),
                "oi": oi,
                "bid": bid,
                "ask": ask,
                "underlying": symbol,
            })

    log.info("%s chain: %d contracts (skipped %d zero-OI)", symbol, len(chain), skipped)
    return chain, spot
