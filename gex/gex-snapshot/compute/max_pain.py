"""
Max pain calculation.

Max pain (maximum pain theory) is the strike price at which the total
intrinsic loss to option writers is minimised at expiry.  The idea is that
dealers and market makers who are net short options have a hedging incentive
to keep spot near this strike as expiry approaches, making it a gravitational
level in the final few DTE.

Formula
-------
For each candidate strike K, total pain to all option writers if spot = K:

    pain(K) = Σ_{calls with strike < K}  (K − strike) × OI   [ITM calls]
            + Σ_{puts  with strike > K}  (strike − K) × OI   [ITM puts]

The contract multiplier ($20/pt for NQ futures, 100 shares for QQQ/NDX) is
constant across strikes, so it scales the whole pain curve uniformly and does
not change which K is the minimum.  We omit it so this function works for any
instrument without config coupling.

Grouping
--------
We compute max pain per expiry so you can compare term structure.  The front
expiry (nearest date) is surfaced as the primary result because pin pressure
from expiry hedging is strongest there.
"""

import logging
from datetime import date

log = logging.getLogger(__name__)


def compute_max_pain(chain: list[dict]) -> dict:
    """
    Compute max pain for each expiry in the chain.

    Args:
        chain: list of contract dicts with keys:
               strike, option_type ("CALL"/"PUT"), oi, expiration_date

    Returns:
        {
          "strike":    float,        # max pain strike of the front (nearest) expiry
          "expiry":    "YYYY-MM-DD", # that expiry
          "by_expiry": {             # full term structure
            "YYYY-MM-DD": float,
            ...
          }
        }
        Empty dict if the chain has no usable data.
    """
    # --- group contracts by expiry date ---
    by_expiry: dict[str, list[dict]] = {}
    for c in chain:
        exp = c.get("expiration_date")
        if not exp:
            continue
        by_expiry.setdefault(str(exp), []).append(c)

    if not by_expiry:
        return {}

    results: dict[str, float] = {}

    for exp, contracts in by_expiry.items():
        calls = [c for c in contracts if c["option_type"] == "CALL"]
        puts  = [c for c in contracts if c["option_type"] == "PUT"]

        # Need both sides and enough strikes to be meaningful
        all_strikes = sorted(set(c["strike"] for c in contracts))
        if len(all_strikes) < 5:
            log.debug("max_pain: skipping %s — only %d strikes", exp, len(all_strikes))
            continue

        min_pain: float | None = None
        best_strike: float | None = None

        for k in all_strikes:
            # ITM call pain: call writers owe intrinsic on every call with strike < k
            call_pain = sum((k - c["strike"]) * c["oi"] for c in calls if c["strike"] < k)
            # ITM put pain: put writers owe intrinsic on every put with strike > k
            put_pain  = sum((c["strike"] - k) * c["oi"] for c in puts  if c["strike"] > k)
            total = call_pain + put_pain

            if min_pain is None or total < min_pain:
                min_pain = total
                best_strike = k

        if best_strike is not None:
            results[exp] = best_strike

    if not results:
        return {}

    # Front expiry = earliest date string (ISO format sorts correctly)
    front = min(results.keys())
    log.info("Max pain: front expiry %s → %.0f (%d expiries computed)", front, results[front], len(results))

    return {
        "strike":    results[front],
        "expiry":    front,
        "by_expiry": results,
    }
