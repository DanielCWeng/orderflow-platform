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

    # Zero gamma — two complementary definitions:
    #
    # zero_gamma (gamma flip): per-strike sign-change nearest to spot.
    #   Robust in net-negative regimes where the cumulative never recovers.
    #
    # zero_gamma_cumulative: where the running cumulative GEX (low→high strike)
    #   crosses from negative to positive.  Valid only when total positive GEX
    #   exceeds total negative GEX, but meaningful when it exists — it marks
    #   the structural level where the full book tips positive.
    strikes_sorted = sorted(strike_gex.keys())

    zero_gamma = None
    crossings: list[tuple[float, float]] = []  # (distance_from_spot, interpolated_strike)
    for i in range(1, len(strikes_sorted)):
        k0, k1 = strikes_sorted[i - 1], strikes_sorted[i]
        g0, g1 = strike_gex[k0], strike_gex[k1]
        if g0 < 0 and g1 >= 0:
            frac = -g0 / (g1 - g0) if g1 != g0 else 0.5
            zk = k0 + frac * (k1 - k0)
            dist = abs(zk - spot) if spot is not None else abs(zk)
            crossings.append((dist, zk))
    if crossings:
        crossings.sort(key=lambda x: x[0])
        zero_gamma = crossings[0][1]

    cum = _cumulative_gex(strike_gex)
    zero_gamma_cumulative = None
    for i in range(1, len(cum)):
        prev_strike, prev_cum = cum[i - 1]
        curr_strike, curr_cum = cum[i]
        if prev_cum < 0 and curr_cum >= 0:
            if curr_cum != prev_cum:
                frac = -prev_cum / (curr_cum - prev_cum)
                zero_gamma_cumulative = prev_strike + frac * (curr_strike - prev_strike)
            else:
                zero_gamma_cumulative = (prev_strike + curr_strike) / 2.0
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
        "zero_gamma_cumulative": round(zero_gamma_cumulative, 2) if zero_gamma_cumulative is not None else None,
        "volatility_trigger": volatility_trigger,
        "large_gamma": large_gamma,
    }


def extract_greek_levels(strike_map: dict[float, float]) -> dict:
    """
    Generic level extractor for vanna / charm strike maps.

    Returns:
        flip  — zero-crossing of cumulative exposure (interpolated)
        top   — top-4 strikes by absolute exposure magnitude
    """
    if not strike_map:
        return {"flip": None, "top": []}

    cum = _cumulative_gex(strike_map)
    flip = None
    for i in range(1, len(cum)):
        prev_k, prev_c = cum[i - 1]
        curr_k, curr_c = cum[i]
        if prev_c < 0 and curr_c >= 0:
            if curr_c != prev_c:
                frac = -prev_c / (curr_c - prev_c)
                flip = prev_k + frac * (curr_k - prev_k)
            else:
                flip = (prev_k + curr_k) / 2.0
            break

    sorted_by_abs = sorted(strike_map.items(), key=lambda x: abs(x[1]), reverse=True)
    top = [k for k, _ in sorted_by_abs[:4]]

    return {
        "flip": round(flip, 2) if flip is not None else None,
        "top": top,
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


def extract_confluence(
    strike_gex: dict[float, float],
    strike_vanna: dict[float, float],
    strike_charm: dict[float, float],
    spot: float,
    top_n: int = 4,
) -> list[dict]:
    """
    Find strikes where 2+ greeks cluster — highest-conviction levels per instrument.

    Uses a tolerance of 0.5% of spot so it scales naturally across QQQ and NDX.
    Returns list of {strike, greeks, greek_count, rank}, sorted by greek_count desc.
    """
    tolerance = spot * 0.005

    # Top-N strikes per greek by absolute magnitude
    candidates: list[tuple[float, str, float]] = []  # (strike, greek, abs_val)
    for greek, smap in [("gex", strike_gex), ("vanna", strike_vanna), ("charm", strike_charm)]:
        if not smap:
            continue
        top = sorted(smap.items(), key=lambda x: abs(x[1]), reverse=True)[:top_n]
        for strike, val in top:
            candidates.append((strike, greek, abs(val)))

    if not candidates:
        return []

    candidates.sort(key=lambda x: x[0])

    clusters: list[dict] = []
    used: set[int] = set()

    for i, (strike_i, greek_i, val_i) in enumerate(candidates):
        if i in used:
            continue
        cluster_greeks: dict[str, float] = {greek_i: val_i}
        rep_strike = strike_i
        used.add(i)

        for j, (strike_j, greek_j, val_j) in enumerate(candidates):
            if j in used:
                continue
            if abs(strike_i - strike_j) <= tolerance:
                if greek_j not in cluster_greeks or val_j > cluster_greeks[greek_j]:
                    cluster_greeks[greek_j] = val_j
                used.add(j)

        if len(cluster_greeks) < 2:
            continue

        clusters.append({
            "strike": rep_strike,
            "greeks": sorted(cluster_greeks.keys()),
            "greek_count": len(cluster_greeks),
        })

    clusters.sort(key=lambda x: -x["greek_count"])
    for i, cl in enumerate(clusters, start=1):
        cl["rank"] = i

    return clusters


def detect_combos(
    instrument_data: dict[str, dict],
    strike_gex_all: dict[str, dict[float, float]],
    spots: dict[str, float] | None = None,
    strike_vanna_all: dict[str, dict[float, float]] | None = None,
    strike_charm_all: dict[str, dict[float, float]] | None = None,
) -> list[dict]:
    """
    Detect cross-instrument combo levels.

    instrument_data: {"NQ": {levels_dict}, "QQQ": {...}, "NDX": {...}}
    strike_gex_all: {"NQ": {strike: gex}, ...}

    Returns sorted list of combo dicts.
    """
    # Compute live QQQ→NDX scale from spot prices if available, else fall back to config
    qqq_scale = QQQ_SCALE_FACTOR
    if spots and spots.get("qqq") and spots.get("ndx"):
        qqq_scale = spots["ndx"] / spots["qqq"]

    def _norm(strike: float, inst: str) -> float:
        return strike * qqq_scale if inst == "QQQ" else strike

    # Collect candidate strikes from large_gamma across all instruments
    candidates = []  # list of (normalised_strike, instrument, native_strike, abs_gex)
    for inst, levels in instrument_data.items():
        gex_map = strike_gex_all.get(inst, {})
        for strike in levels.get("large_gamma", []):
            norm = _norm(strike, inst)
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
        # Enrich: for each instrument, check which greeks also flag this level
        greek_detail: dict[str, list[str]] = {}
        for inst, native_strike in cl["contributing_strikes"].items():
            greeks_here = ["gex"]
            tol = native_strike * 0.005
            if strike_vanna_all and inst in strike_vanna_all:
                vmap = strike_vanna_all[inst]
                top_v = sorted(vmap.items(), key=lambda x: abs(x[1]), reverse=True)[:4]
                if any(abs(s - native_strike) <= tol for s, _ in top_v):
                    greeks_here.append("vanna")
            if strike_charm_all and inst in strike_charm_all:
                cmap = strike_charm_all[inst]
                top_c = sorted(cmap.items(), key=lambda x: abs(x[1]), reverse=True)[:4]
                if any(abs(s - native_strike) <= tol for s, _ in top_c):
                    greeks_here.append("charm")
            greek_detail[inst] = sorted(greeks_here)

        combos.append({
            "rank": rank,
            "strike": cl["strike"],
            "instruments": cl["instruments"],
            "score": cl["score"],
            "contributing_strikes": cl["contributing_strikes"],
            "greeks": greek_detail,
        })

    return combos
