"""Fetch NQ futures options chain from the IronBeam API."""

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from config import IRONBEAM_BASE_URL, IRONBEAM_USERNAME, IRONBEAM_API_KEY

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _batch(lst, n=10):
    """Yield successive n-sized chunks from lst."""
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def _auth() -> str:
    """Authenticate and return a bearer token."""
    resp = requests.post(
        f"{IRONBEAM_BASE_URL}/auth",
        json={"username": IRONBEAM_USERNAME, "apikey": IRONBEAM_API_KEY},
        timeout=15,
    )
    resp.raise_for_status()
    token = resp.json().get("token")
    if not token:
        raise RuntimeError(f"IronBeam auth failed: {resp.text}")
    return token


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


# ---------------------------------------------------------------------------
# Data fetchers
# ---------------------------------------------------------------------------

def _search_options(token: str, symbol: str = "NQ") -> list[str]:
    """Return list of exchSym identifiers for NQ options."""
    resp = requests.get(
        f"{IRONBEAM_BASE_URL}/info/searchSymbolOptions",
        params={"symbol": symbol},
        headers=_headers(token),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    # data is expected to be a list of objects with an 'exchSym' field
    if isinstance(data, list):
        return [item["exchSym"] for item in data if "exchSym" in item]
    # Some responses nest under a key
    if isinstance(data, dict):
        items = data.get("results", data.get("symbols", []))
        return [item["exchSym"] for item in items if "exchSym" in item]
    return []


def _fetch_definitions(token: str, symbols: list[str]) -> dict:
    """Fetch security definitions in batches of 10. Returns {exchSym: def_dict}."""
    result = {}
    for batch in _batch(symbols):
        resp = requests.get(
            f"{IRONBEAM_BASE_URL}/info/security/definitions",
            params={"symbols": ",".join(batch)},
            headers=_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data if isinstance(data, list) else data.get("results", [])
        for item in items:
            sym = item.get("exchSym") or item.get("symbol")
            if sym:
                result[sym] = item
    return result


def _fetch_quotes_batch(token: str, batch: list[str]) -> dict:
    """Fetch quotes for a single batch. Returns {exchSym: quote_dict}."""
    resp = requests.get(
        f"{IRONBEAM_BASE_URL}/market/quotes",
        params={"symbols": ",".join(batch)},
        headers=_headers(token),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    items = data if isinstance(data, list) else data.get("results", [])
    out = {}
    for item in items:
        sym = item.get("exchSym") or item.get("symbol")
        if sym:
            out[sym] = item
    return out


def _fetch_quotes_parallel(token: str, symbols: list[str]) -> dict:
    """Fetch quotes for all symbols using ThreadPoolExecutor."""
    result = {}
    batches = list(_batch(symbols))
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(_fetch_quotes_batch, token, b): b for b in batches}
        for fut in as_completed(futures):
            try:
                result.update(fut.result())
            except Exception as exc:
                log.warning("Quote batch failed: %s", exc)
    return result


def get_nq_spot(token: str, underlying_symbol: str) -> float | None:
    """Get current NQ futures price (mid of bid/ask)."""
    try:
        resp = requests.get(
            f"{IRONBEAM_BASE_URL}/market/quotes",
            params={"symbols": underlying_symbol},
            headers=_headers(token),
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        items = data if isinstance(data, list) else data.get("results", [])
        if items:
            q = items[0]
            bid = float(q.get("b", 0))
            ask = float(q.get("a", 0))
            if bid > 0 and ask > 0:
                return (bid + ask) / 2.0
            # fallback to last price
            return float(q.get("l", q.get("last", 0))) or None
    except Exception as exc:
        log.warning("Failed to get NQ spot: %s", exc)
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fetch_nq_options() -> tuple[list[dict], float | None]:
    """
    Fetch full NQ futures options chain.

    Returns:
        (chain, spot) where chain is a list of normalised contract dicts
        and spot is the current NQ futures mid-price (or None).
    """
    log.info("Authenticating with IronBeam...")
    token = _auth()

    log.info("Searching NQ option symbols...")
    all_syms = _search_options(token)
    log.info("Found %d option symbols", len(all_syms))

    if not all_syms:
        return [], None

    log.info("Fetching security definitions...")
    defs = _fetch_definitions(token, all_syms)
    log.info("Got definitions for %d symbols", len(defs))

    # Filter to front two expiration cycles (next 30 days)
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms + 30 * 24 * 3600 * 1000

    eligible_syms = []
    for sym, d in defs.items():
        exp = d.get("expirationTime")
        if exp is None:
            continue
        exp_int = int(exp)
        if exp_int <= now_ms or exp_int > cutoff_ms:
            continue
        eligible_syms.append(sym)

    # Find the two nearest expiration dates
    exp_dates = sorted(set(int(defs[s]["expirationTime"]) for s in eligible_syms))
    if len(exp_dates) > 2:
        exp_dates = exp_dates[:2]
    exp_set = set(exp_dates)
    eligible_syms = [s for s in eligible_syms if int(defs[s]["expirationTime"]) in exp_set]

    log.info("Filtered to %d symbols in front 2 expiry cycles", len(eligible_syms))

    if not eligible_syms:
        return [], None

    log.info("Fetching quotes (parallel)...")
    quotes = _fetch_quotes_parallel(token, eligible_syms)
    log.info("Got quotes for %d symbols", len(quotes))

    # Determine underlying symbol for spot price
    underlying = None
    for s in eligible_syms:
        u = defs[s].get("underlyingSymbol")
        if u:
            underlying = u
            break

    spot = get_nq_spot(token, underlying) if underlying else None

    # Merge into normalised chain
    chain = []
    skipped = 0
    for sym in eligible_syms:
        d = defs.get(sym, {})
        q = quotes.get(sym, {})

        oi = int(q.get("oi", 0))
        bid = float(q.get("b", 0))
        ask = float(q.get("a", 0))

        if oi <= 0:
            skipped += 1
            continue

        chain.append({
            "symbol": sym,
            "strike": float(d.get("strikePrice", 0)),
            "option_type": str(d.get("optionType", "")).upper(),  # CALL / PUT
            "expiration_ts": int(d.get("expirationTime", 0)),
            "oi": oi,
            "bid": bid,
            "ask": ask,
            "underlying": d.get("underlyingSymbol", ""),
        })

    log.info("NQ chain: %d contracts (skipped %d zero-OI)", len(chain), skipped)
    return chain, spot
