"""Black-Scholes and Black-76 greeks: gamma, vega, vanna, charm, IV solver."""

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
# Vega functions
# ---------------------------------------------------------------------------

def bs_vega(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes vega (dPrice/dSigma). Same for calls and puts."""
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    return S * norm.pdf(d1) * math.sqrt(T)


def black76_vega(F: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-76 vega for futures options. Same for calls and puts."""
    d1 = (math.log(F / K) + 0.5 * sigma**2 * T) / (sigma * math.sqrt(T))
    return math.exp(-r * T) * F * norm.pdf(d1) * math.sqrt(T)


# ---------------------------------------------------------------------------
# Vanna functions  (dDelta/dSigma = dVega/dSpot)
# ---------------------------------------------------------------------------

def bs_vanna(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes vanna. Same for calls and puts; apply dealer sign externally."""
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return -norm.pdf(d1) * d2 / sigma


def black76_vanna(F: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-76 vanna for futures options. Same for calls and puts."""
    d1 = (math.log(F / K) + 0.5 * sigma**2 * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return -math.exp(-r * T) * norm.pdf(d1) * d2 / sigma


# ---------------------------------------------------------------------------
# Charm functions  (-dDelta/dT)
# ---------------------------------------------------------------------------

def bs_charm(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """
    Black-Scholes charm (-dDelta/dT, per year).
    Identical magnitude for calls and puts — apply dealer sign externally.
    """
    d1 = (math.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    return -norm.pdf(d1) * (2 * r * T - d2 * sigma * math.sqrt(T)) / (
        2 * sigma * T * math.sqrt(T)
    )


def black76_charm(
    F: float, K: float, T: float, r: float, sigma: float, option_type: str = "CALL"
) -> float:
    """
    Black-76 charm (-dDelta/dT, per year).

    Unlike BS, the discount factor means the call and put formulas differ by a
    small r·N() term, so option_type is required.  The returned value is already
    signed for dealer exposure (positive for calls, negative for puts).

      Charm_call = e^(-rT) · [r·N(d1)  + N'(d1)·d2/(2T)]
      Charm_put  = −e^(-rT) · [r·N(-d1) + N'(d1)·d2/(2T)]
    """
    d1 = (math.log(F / K) + 0.5 * sigma**2 * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    disc = math.exp(-r * T)
    shared = norm.pdf(d1) * d2 / (2 * T)
    if option_type == "CALL":
        return disc * (r * norm.cdf(d1) + shared)
    else:
        return -disc * (r * norm.cdf(-d1) + shared)


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
