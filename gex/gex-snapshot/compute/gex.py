"""GEX aggregation per strike, per instrument."""

import logging
import math
from datetime import datetime, timezone

from compute.greeks import bs_gamma, black76_gamma, solve_iv
from config import RISK_FREE_RATE

log = logging.getLogger(__name__)


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
