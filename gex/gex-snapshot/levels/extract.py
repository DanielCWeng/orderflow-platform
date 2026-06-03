"""Level extraction: walls, gamma flip, vol trigger, large gamma, combo detection."""

import logging
from config import COMBO_TOLERANCE_POINTS, QQQ_SCALE_FACTOR

log = logging.getLogger(__name__)


def _cumulative_gex(strike_gex: dict[float, float]) -> list[tuple[float, float]]:
    """Return sorted list of (strike, cumulative_gex) pairs."""
    strikes = sorted(strike_gex.keys())
    cum = 0.0
    result = []
    for k in strikes:
        cum += strike_gex[k]
        result.append((k, cum))
    return result


def extract_instrument_levels(
    strike_gex: dict[float, float],
    spot: float | None,
) -> dict:
    """
    Extract GEX levels for a single instrument.

    Returns dict with call_wall, put_wall, zero_gamma, volatility_trigger,
    large_gamma (list of 4).
    """
    if not strike_gex:
        return {
            "call_wall": None,
            "put_wall": None,
            "zero_gamma": None,
            "volatility_trigger": None,
            "large_gamma": [],
        }

    # Call wall: strike with highest positive GEX
    positive = {k: v for k, v in strike_gex.items() if v > 0}
    call_wall = max(positive, key=positive.get) if positive else None

    # Put wall: strike with most negative GEX
    negative = {k: v for k, v in strike_gex.items() if v < 0}
    put_wall = min(negative, key=negative.get) if negative else None

    # Zero gamma: where cumulative GEX crosses from negative to positive
    cum = _cumulative_gex(strike_gex)
    zero_gamma = None
    for i in range(1, len(cum)):
        prev_strike, prev_cum = cum[i - 1]
        curr_strike, curr_cum = cum[i]
        if prev_cum < 0 and curr_cum >= 0:
            # Linear interpolation
            if curr_cum != prev_cum:
                frac = -prev_cum / (curr_cum - prev_cum)
                zero_gamma = prev_strike + frac * (curr_strike - prev_strike)
            else:
                zero_gamma = (prev_strike + curr_strike) / 2.0
            break

    # Volatility trigger: strike nearest to spot where net GEX is closest to zero
    volatility_trigger = None
    if spot is not None and strike_gex:
        # Consider strikes within 5% of spot
        nearby = {
            k: abs(v)
            for k, v in strike_gex.items()
            if abs(k - spot) / spot < 0.05
        }
        if nearby:
            volatility_trigger = min(nearby, key=nearby.get)

    # Large gamma 1-4: top 4 by absolute GEX magnitude
    sorted_by_abs = sorted(strike_gex.items(), key=lambda x: abs(x[1]), reverse=True)
    large_gamma = [k for k, v in sorted_by_abs[:4]]

    return {
        "call_wall": call_wall,
        "put_wall": put_wall,
        "zero_gamma": round(zero_gamma, 2) if zero_gamma is not None else None,
        "volatility_trigger": volatility_trigger,
        "large_gamma": large_gamma,
    }


def _normalise_strike(strike: float, instrument: str) -> float:
    """Normalise a strike to NQ/NDX-equivalent index points for comparison."""
    if instrument == "QQQ":
        return strike * QQQ_SCALE_FACTOR
    return strike


def _denormalise_strike(normalised: float, instrument: str) -> float:
    """Convert back from normalised to native units."""
    if instrument == "QQQ":
        return normalised / QQQ_SCALE_FACTOR
    return normalised


def detect_combos(
    instrument_data: dict[str, dict],
    strike_gex_all: dict[str, dict[float, float]],
) -> list[dict]:
    """
    Detect cross-instrument combo levels.

    instrument_data: {"NQ": {levels_dict}, "QQQ": {...}, "NDX": {...}}
    strike_gex_all: {"NQ": {strike: gex}, ...}

    Returns sorted list of combo dicts.
    """
    # Collect candidate strikes from large_gamma across all instruments
    candidates = []  # list of (normalised_strike, instrument, native_strike, abs_gex)
    for inst, levels in instrument_data.items():
        gex_map = strike_gex_all.get(inst, {})
        for strike in levels.get("large_gamma", []):
            norm = _normalise_strike(strike, inst)
            abs_gex = abs(gex_map.get(strike, 0))
            candidates.append((norm, inst, strike, abs_gex))

    if not candidates:
        return []

    tolerance = COMBO_TOLERANCE_POINTS

    # Group candidates into clusters
    # Sort by normalised strike
    candidates.sort(key=lambda x: x[0])

    clusters = []
    used = set()

    for i, (norm_i, inst_i, strike_i, gex_i) in enumerate(candidates):
        if i in used:
            continue
        cluster = [(norm_i, inst_i, strike_i, gex_i)]
        used.add(i)

        for j, (norm_j, inst_j, strike_j, gex_j) in enumerate(candidates):
            if j in used:
                continue
            if abs(norm_i - norm_j) <= tolerance:
                cluster.append((norm_j, inst_j, strike_j, gex_j))
                used.add(j)

        # Require at least 2 different instruments
        instruments = set(c[1] for c in cluster)
        if len(instruments) < 2:
            continue

        score = sum(c[3] for c in cluster)
        # Weighted average strike (in normalised space)
        if score > 0:
            weighted_strike = sum(c[0] * c[3] for c in cluster) / score
        else:
            weighted_strike = sum(c[0] for c in cluster) / len(cluster)

        clusters.append({
            "strike": round(weighted_strike, 2),
            "instruments": sorted(instruments),
            "score": round(score, 2),
            "contributing_strikes": {c[1]: c[2] for c in cluster},
        })

    # Deduplicate overlapping clusters (merge if centres within tolerance/2)
    merged = []
    clusters.sort(key=lambda x: x["strike"])
    for cl in clusters:
        if merged and abs(cl["strike"] - merged[-1]["strike"]) < tolerance / 2:
            # Merge into previous
            prev = merged[-1]
            prev["score"] += cl["score"]
            prev["instruments"] = sorted(set(prev["instruments"]) | set(cl["instruments"]))
            prev["contributing_strikes"].update(cl["contributing_strikes"])
            prev["strike"] = round(
                (prev["strike"] * prev["score"] + cl["strike"] * cl["score"])
                / (prev["score"] + cl["score"]),
                2,
            ) if (prev["score"] + cl["score"]) > 0 else prev["strike"]
        else:
            merged.append(cl)

    # Rank by score descending, take top 5
    merged.sort(key=lambda x: x["score"], reverse=True)
    combos = []
    for rank, cl in enumerate(merged[:5], start=1):
        combos.append({
            "rank": rank,
            "strike": cl["strike"],
            "instruments": cl["instruments"],
            "score": cl["score"],
        })

    return combos
