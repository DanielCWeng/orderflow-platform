"""
Volatility skew — implied volatility as a function of strike.

Skew tells you how the market prices tail risk across strikes.  A steep
negative skew (puts more expensive than calls on the same expiry) signals
strong demand for downside protection.  A flat or inverted skew is unusual
and often accompanies short-squeeze or melt-up dynamics.

What we compute
---------------
Per expiry, for each strike where we can solve IV from the bid/ask mid:

  atm_iv      — IV of the strike nearest to spot.

  skew_slope  — linear regression coefficient of IV on log-moneyness
                log(K / S).  Negative = normal negative skew (puts
                expensive); positive = call skew (unusual, squeeze risk).
                Units: IV per unit of log-moneyness.

  wing_spread — average IV of the put wing  (moneyness 0.90–0.97)
                minus average IV of the call wing (moneyness 1.03–1.10).
                Positive = puts are bid relative to calls (normal).
                Negative = calls are bid (unusual).
                None if fewer than 2 strikes fall in either wing.

  curve       — [{strike, iv, moneyness}, ...] sorted by strike.
                iv is expressed as a decimal (0.20 = 20% annualised).

NQ note
-------
NQ futures options use the Black-76 model (forward = spot for near-term
futures, no dividend/carry adjustment needed here).  After hours, bid/ask
are zero and IV cannot be solved, so NQ will return sparse or empty curves.
That is expected — the caller should check `strikes_solved` before using the
skew metrics.
"""

import logging
import math
from datetime import datetime, timezone

from compute.greeks import solve_iv

log = logging.getLogger(__name__)

# Moneyness bands for wing spread calculation
_PUT_WING  = (0.90, 0.97)  # OTM puts
_CALL_WING = (1.03, 1.10)  # OTM calls

# Minimum strikes needed before we attempt regression / wing spread
_MIN_STRIKES_FOR_STATS = 5


def _time_to_expiry(expiration_date: str) -> float | None:
    """Return time to expiry in years for a YYYY-MM-DD expiration date."""
    try:
        exp = datetime.strptime(expiration_date, "%Y-%m-%d").replace(
            hour=20, minute=0, tzinfo=timezone.utc  # CME / equity close ≈ 20:00 UTC
        )
        T = (exp - datetime.now(timezone.utc)).total_seconds() / (365.25 * 24 * 3600)
        return T if T > 0 else None
    except Exception:
        return None


def _linear_slope(xs: list[float], ys: list[float]) -> float | None:
    """OLS slope of y on x.  Returns None if fewer than 2 points."""
    n = len(xs)
    if n < 2:
        return None
    sx  = sum(xs)
    sy  = sum(ys)
    sxx = sum(x * x for x in xs)
    sxy = sum(x * y for x, y in zip(xs, ys))
    denom = n * sxx - sx * sx
    if abs(denom) < 1e-12:
        return None
    return (n * sxy - sx * sy) / denom


def _compute_expiry_skew(
    contracts: list[dict],
    spot: float,
    is_futures: bool,
    rfr: float,
) -> dict:
    """
    Compute IV curve and summary metrics for a single expiry.

    Returns a dict with keys: curve, atm_iv, skew_slope, wing_spread,
    strikes_solved, dte.
    """
    if not contracts:
        return {}

    T = _time_to_expiry(contracts[0]["expiration_date"])
    if T is None:
        return {}

    dte = T * 365.25

    # --- solve IV per strike (use the mid-price, prefer calls for ATM) ---
    # We compute one IV per strike by taking whichever option type gives a
    # valid solve.  Calls are preferred near/above spot; puts below.
    iv_by_strike: dict[float, float] = {}

    for c in contracts:
        mid = (c["bid"] + c["ask"]) / 2.0
        if mid <= 0:
            continue  # no quote (e.g. NQ after hours)

        iv = solve_iv(mid, spot, c["strike"], T, c["option_type"], is_futures=is_futures)
        if iv is None or math.isnan(iv) or iv <= 0:
            continue

        strike = c["strike"]
        # Keep the first valid IV per strike; for duplicate strikes (call +
        # put at same level), the call is slightly more liquid near ATM.
        if strike not in iv_by_strike:
            iv_by_strike[strike] = iv

    if not iv_by_strike:
        return {"dte": dte, "strikes_solved": 0}

    strikes_solved = len(iv_by_strike)

    # --- ATM IV: strike nearest spot ---
    atm_iv = min(iv_by_strike.items(), key=lambda x: abs(x[0] - spot))[1]

    # --- summary stats require enough strikes ---
    skew_slope = None
    wing_spread = None

    if strikes_solved >= _MIN_STRIKES_FOR_STATS:
        # Skew slope: regress IV on log(K/S)
        log_m = [math.log(k / spot) for k in iv_by_strike]
        ivs   = list(iv_by_strike.values())
        skew_slope = _linear_slope(log_m, ivs)
        if skew_slope is not None:
            skew_slope = round(skew_slope, 4)

        # Wing spread: put wing avg IV minus call wing avg IV
        put_ivs  = [v for k, v in iv_by_strike.items() if _PUT_WING[0]  <= k / spot <= _PUT_WING[1]]
        call_ivs = [v for k, v in iv_by_strike.items() if _CALL_WING[0] <= k / spot <= _CALL_WING[1]]
        if len(put_ivs) >= 2 and len(call_ivs) >= 2:
            wing_spread = round(
                sum(put_ivs) / len(put_ivs) - sum(call_ivs) / len(call_ivs), 4
            )

    return {
        "dte":            round(dte, 1),
        "strikes_solved": strikes_solved,
        "atm_iv":         round(atm_iv, 4),
        "skew_slope":     skew_slope,
        "wing_spread":    wing_spread,
    }


def compute_vol_skew(
    chain: list[dict],
    spot: float,
    is_futures: bool = False,
    rfr: float = 0.05,
) -> dict:
    """
    Compute per-expiry volatility skew for the full chain.

    Args:
        chain:      list of contract dicts (strike, option_type, bid, ask,
                    expiration_date, oi)
        spot:       current underlying price
        is_futures: True for Black-76 (NQ), False for Black-Scholes (QQQ/NDX)
        rfr:        risk-free rate (annualised decimal)

    Returns:
        {
          "front":     "YYYY-MM-DD",  # nearest expiry with solved IVs
          "by_expiry": {
            "YYYY-MM-DD": {
              "dte":            float,
              "strikes_solved": int,
              "atm_iv":         float,   # decimal, e.g. 0.18 = 18%
              "skew_slope":     float,   # negative = normal put skew
              "wing_spread":    float,   # put wing minus call wing
              "curve":          [{strike, iv, moneyness}, ...]
            },
            ...
          }
        }
        Empty dict if no IVs could be solved (e.g. after-hours NQ).
    """
    # --- group by expiry ---
    by_expiry: dict[str, list[dict]] = {}
    for c in chain:
        exp = c.get("expiration_date")
        if exp:
            by_expiry.setdefault(str(exp), []).append(c)

    if not by_expiry:
        return {}

    results: dict[str, dict] = {}
    for exp, contracts in by_expiry.items():
        skew = _compute_expiry_skew(contracts, spot, is_futures, rfr)
        if skew.get("strikes_solved", 0) > 0:
            results[exp] = skew
            log.info(
                "Skew %s: %d strikes solved | ATM IV %.1f%% | slope %.3f | wing spread %s",
                exp,
                skew["strikes_solved"],
                (skew.get("atm_iv") or 0) * 100,
                skew.get("skew_slope") or 0,
                f"{skew['wing_spread']:.4f}" if skew.get("wing_spread") is not None else "N/A",
            )
        else:
            log.debug("Skew %s: no IVs solved (likely after-hours or zero mid)", exp)

    if not results:
        return {}

    front = min(results.keys())
    return {"front": front, "by_expiry": results}
