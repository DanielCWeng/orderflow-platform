"""Black-Scholes and Black-76 gamma computation with IV solver."""

import math
import logging

import numpy as np
from scipy.stats import norm
from scipy.optimize import brentq

from config import RISK_FREE_RATE

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pricing functions
# ---------------------------------------------------------------------------

def _bs_call_price(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes call price."""
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return S * norm.cdf(d1) - K * math.exp(-r * T) * norm.cdf(d2)


def _bs_put_price(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes put price."""
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return K * math.exp(-r * T) * norm.cdf(-d2) - S * norm.cdf(-d1)


def _black76_call_price(F: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-76 call price for futures options."""
    d1 = (math.log(F / K) + 0.5 * sigma**2 * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return math.exp(-r * T) * (F * norm.cdf(d1) - K * norm.cdf(d2))


def _black76_put_price(F: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-76 put price for futures options."""
    d1 = (math.log(F / K) + 0.5 * sigma**2 * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return math.exp(-r * T) * (K * norm.cdf(-d2) - F * norm.cdf(-d1))


# ---------------------------------------------------------------------------
# Gamma functions
# ---------------------------------------------------------------------------

def bs_gamma(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes gamma for equity options (QQQ, NDX)."""
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    return norm.pdf(d1) / (S * sigma * math.sqrt(T))


def black76_gamma(F: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-76 gamma for futures options (NQ)."""
    d1 = (math.log(F / K) + 0.5 * sigma**2 * T) / (sigma * math.sqrt(T))
    return math.exp(-r * T) * norm.pdf(d1) / (F * sigma * math.sqrt(T))


# ---------------------------------------------------------------------------
# IV solver
# ---------------------------------------------------------------------------

def solve_iv(
    market_mid: float,
    spot: float,
    strike: float,
    T: float,
    option_type: str,
    is_futures: bool = False,
    r: float = RISK_FREE_RATE,
) -> float | None:
    """
    Solve for implied volatility using Brent's method.

    Returns sigma or None if unsolvable.
    """
    if market_mid <= 0 or T <= 0 or spot <= 0 or strike <= 0:
        return None

    if is_futures:
        price_fn = _black76_call_price if option_type == "CALL" else _black76_put_price
    else:
        price_fn = _bs_call_price if option_type == "CALL" else _bs_put_price

    def objective(sigma):
        return price_fn(spot, strike, T, r, sigma) - market_mid

    try:
        # Check if bounds bracket a root
        lo = objective(0.001)
        hi = objective(10.0)
        if lo * hi > 0:
            return None
        return brentq(objective, 0.001, 10.0, xtol=1e-6, maxiter=100)
    except (ValueError, RuntimeError):
        return None
