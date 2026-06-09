"""GEX aggregation per strike, per instrument."""

import logging
import math
from datetime import datetime, timezone

from compute.greeks import (
    bs_gamma, black76_gamma,
    bs_vega, black76_vega,
    bs_vanna, black76_vanna,
    bs_charm, black76_charm,
    solve_iv,
)
from config import RISK_FREE_RATE

log = logging.getLogger(__name__)


def dte_status(dte: float | None) -> tuple[str, str | None]:
    """
    Classify a DTE value into a signal quality tier.

    Returns (status, message) where status is one of:
      "OK"      — 15+ DTE, full vanna/charm character, no note needed
      "NOTE"    — 8-14 DTE, front contract near expiry, still meaningful
      "WARN"    — < 8 DTE, gamma dominates, vanna/charm lose precision
      "MISSING" — no DTE data, vanna/charm unavailable
    """
    if dte is None:
        return "MISSING", "No DTE data — vanna/charm unavailable"
    if dte >= 15:
        return "OK", None
    if dte >= 8:
        return "NOTE", f"Front contract at {dte:.0f} DTE — short but meaningful"
    return "WARN", f"Front contract at {dte:.0f} DTE — gamma dominates, vanna/charm unreliable"


def _time_to_expiry_years(contract: dict) -> float | None:
    """Compute T in years from contract expiration to now."""
    now = datetime.now(timezone.utc)

    # Ironbeam: expiration_ts (unix ms)
    if "expiration_ts" in contract and contract["expiration_ts"]:
        exp_dt = datetime.fromtimestamp(
            int(contract["expiration_ts"]) / 1000, tz=timezone.utc
        )
    # Tradier: expiration_date (YYYY-MM-DD string) — assume 4pm ET close
    elif "expiration_date" in contract and contract["expiration_date"]:
        exp_date = datetime.strptime(contract["expiration_date"], "%Y-%m-%d")
        # Set to 20:00 UTC (4pm ET)
        exp_dt = exp_date.replace(hour=20, minute=0, tzinfo=timezone.utc)
    else:
        return None

    T = (exp_dt - now).total_seconds() / (365.25 * 24 * 3600)
    return T if T > 0 else None


def compute_contract_gex(
    contract: dict,
    spot: float,
    is_futures: bool = False,
) -> float | None:
    """
    Compute GEX for a single contract.

    Returns GEX value or None if IV can't be solved.
    """
    strike = contract["strike"]
    option_type = contract["option_type"]
    oi = contract["oi"]
    bid = contract["bid"]
    ask = contract["ask"]

    T = _time_to_expiry_years(contract)
    if T is None or T <= 0:
        return None

    mid = (bid + ask) / 2.0
    if mid <= 0:
        return None

    sigma = solve_iv(mid, spot, strike, T, option_type, is_futures=is_futures)
    if sigma is None:
        return None

    if is_futures:
        gamma = black76_gamma(spot, strike, T, RISK_FREE_RATE, sigma)
    else:
        gamma = bs_gamma(spot, strike, T, RISK_FREE_RATE, sigma)

    if math.isnan(gamma) or math.isinf(gamma):
        return None

    sign = 1.0 if option_type == "CALL" else -1.0
    gex = sign * gamma * oi * 100 * (spot ** 2) * 0.01

    return gex


def _dte_from_contract(contract: dict) -> float | None:
    """Return calendar days to expiry for a contract (positive = future)."""
    now = datetime.now(timezone.utc)
    if "expiration_ts" in contract and contract["expiration_ts"]:
        exp_dt = datetime.fromtimestamp(
            int(contract["expiration_ts"]) / 1000, tz=timezone.utc
        )
    elif "expiration_date" in contract and contract["expiration_date"]:
        exp_date = datetime.strptime(contract["expiration_date"], "%Y-%m-%d")
        exp_dt = exp_date.replace(hour=20, minute=0, tzinfo=timezone.utc)
    else:
        return None
    days = (exp_dt - now).total_seconds() / 86400
    return days if days > 0 else None


def _expiry_key(contract: dict) -> str | None:
    """Return a hashable string key that identifies the expiry of a contract."""
    if "expiration_ts" in contract and contract["expiration_ts"]:
        return str(contract["expiration_ts"])
    if "expiration_date" in contract and contract["expiration_date"]:
        return contract["expiration_date"]
    return None


def aggregate_gex(
    chain: list[dict],
    spot: float,
    is_futures: bool = False,
) -> tuple[dict[float, float], int]:
    """
    Compute per-strike aggregated GEX for a chain.

    Returns:
        (strike_gex_dict, skipped_count)
        strike_gex_dict: {strike: net_gex}
    """
    strike_gex: dict[float, float] = {}
    skipped = 0

    for contract in chain:
        gex = compute_contract_gex(contract, spot, is_futures=is_futures)
        if gex is None:
            skipped += 1
            continue
        k = contract["strike"]
        strike_gex[k] = strike_gex.get(k, 0.0) + gex

    return strike_gex, skipped


def aggregate_vanna(
    chain: list[dict],
    spot: float,
    is_futures: bool = False,
) -> tuple[dict[float, float], list[float], int]:
    """
    Compute per-strike aggregated vanna exposure.

    Aggregates across ALL expirations in the 15–25 DTE window (same pattern
    as GEX aggregation across the full chain).  Falls back to the expiry
    closest to 20 DTE if no expiry lands in the window.

    Exposure formula: sign × vanna × OI × 100 × spot × 0.01
      (sign = +1 for calls, −1 for puts; dealer-short-call convention)

    Returns:
        (strike_vanna_dict, [dte, ...] of included expirations, skipped_count)
    """
    # --- group contracts by expiry ---
    by_expiry: dict[str, list[dict]] = {}
    for c in chain:
        key = _expiry_key(c)
        if key:
            by_expiry.setdefault(key, []).append(c)

    if not by_expiry:
        return {}, [], 0

    # --- find all expirations in the 15-25 DTE window ---
    in_window: list[tuple[float, list[dict]]] = []  # (dte, contracts)
    for key, contracts in by_expiry.items():
        dte = _dte_from_contract(contracts[0])
        if dte is not None and 15 <= dte <= 25:
            in_window.append((dte, contracts))

    if not in_window:
        # fallback: expiry closest to 20 DTE
        # (not a data quality failure — likely a front contract near expiry)
        log.debug(
            "No expiry in 15-25 DTE window for vanna — falling back to nearest to 20 DTE"
        )
        fallback = []
        for key, contracts in by_expiry.items():
            dte = _dte_from_contract(contracts[0])
            if dte and dte > 0:
                fallback.append((abs(dte - 20), dte, contracts))
        if not fallback:
            return {}, [], 0
        fallback.sort()
        _, dte, contracts = fallback[0]
        in_window = [(dte, contracts)]

    included_dtes = sorted(dte for dte, _ in in_window)
    log.info(
        "Vanna: aggregating %d expir%s in 15-25 DTE window: %s",
        len(in_window),
        "y" if len(in_window) == 1 else "ies",
        [f"{d:.1f}" for d in included_dtes],
    )

    # --- compute per-strike vanna exposure across all included expirations ---
    strike_vanna: dict[float, float] = {}
    skipped = 0

    for _dte, contracts in in_window:
        for c in contracts:
            T = _time_to_expiry_years(c)
            if not T:
                skipped += 1
                continue
            mid = (c["bid"] + c["ask"]) / 2.0
            if mid <= 0:
                skipped += 1
                continue
            sigma = solve_iv(mid, spot, c["strike"], T, c["option_type"], is_futures=is_futures)
            if sigma is None:
                skipped += 1
                continue

            vanna_fn = black76_vanna if is_futures else bs_vanna
            vanna = vanna_fn(spot, c["strike"], T, RISK_FREE_RATE, sigma)

            if math.isnan(vanna) or math.isinf(vanna):
                skipped += 1
                continue

            sign = 1.0 if c["option_type"] == "CALL" else -1.0
            k = c["strike"]
            strike_vanna[k] = (
                strike_vanna.get(k, 0.0) + sign * vanna * c["oi"] * 100 * spot * 0.01
            )

    return strike_vanna, included_dtes, skipped


def aggregate_charm(
    chain: list[dict],
    spot: float,
    is_futures: bool = False,
) -> tuple[dict[float, float], int]:
    """
    Compute per-strike aggregated charm exposure using the full chain.

    Two weeklies are intentional: near-term charm is intense but short-lived;
    the second weekly shows how the exposure shifts as the front week expires.

    Exposure formula:
      Futures (Black-76): charm(option_type) × OI × 100   [sign embedded in formula]
      Equity  (BS):       sign × charm × OI × 100

    Returns:
        (strike_charm_dict, skipped_count)
    """
    strike_charm: dict[float, float] = {}
    skipped = 0

    for c in chain:
        T = _time_to_expiry_years(c)
        if not T:
            skipped += 1
            continue
        mid = (c["bid"] + c["ask"]) / 2.0
        if mid <= 0:
            skipped += 1
            continue
        option_type = c["option_type"]
        sigma = solve_iv(mid, spot, c["strike"], T, option_type, is_futures=is_futures)
        if sigma is None:
            skipped += 1
            continue

        if is_futures:
            charm = black76_charm(spot, c["strike"], T, RISK_FREE_RATE, sigma, option_type)
        else:
            sign = 1.0 if option_type == "CALL" else -1.0
            charm = sign * bs_charm(spot, c["strike"], T, RISK_FREE_RATE, sigma)

        if math.isnan(charm) or math.isinf(charm):
            skipped += 1
            continue

        k = c["strike"]
        strike_charm[k] = strike_charm.get(k, 0.0) + charm * c["oi"] * 100

    return strike_charm, skipped
