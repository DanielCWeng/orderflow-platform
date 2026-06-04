"""GEX Morning Snapshot — orchestrator.

Fetches NQ, QQQ, and NDX options chains, computes GEX per strike,
extracts key levels (walls, gamma flip, vol trigger, combos), and
outputs a clean morning snapshot.
"""

import logging
import os
import sys
from datetime import datetime, timezone

from config import IRONBEAM_USERNAME, IRONBEAM_API_KEY
from data.ironbeam import fetch_nq_options
from data.tradier import fetch_equity_options
from data.market_context import fetch_vix_curve, fetch_cross_asset
from data.qqq_weights import get_qqq_weights
from data.cot import fetch_cot_nq
from data.put_call import fetch_put_call
from compute.gex import aggregate_gex, aggregate_vanna, aggregate_charm
from levels.extract import extract_instrument_levels, extract_greek_levels, extract_confluence, detect_combos
from output.format import print_snapshot, save_json, save_levels_json

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("gex-snapshot")


def run():
    results = {}
    spots = {}
    strike_gex_all = {}
    strike_vanna_all = {}
    strike_charm_all = {}
    instrument_levels = {}
    total_skipped_iv = 0

    # -----------------------------------------------------------------------
    # 1. Fetch NQ futures options (optional — requires IronBeam credentials)
    # -----------------------------------------------------------------------
    nq_chain = []
    if IRONBEAM_USERNAME and IRONBEAM_API_KEY:
        try:
            log.info("=== Fetching NQ futures options ===")
            nq_chain, nq_spot = fetch_nq_options()
            if nq_spot:
                spots["nq"] = nq_spot
                log.info("NQ spot: %.2f | Chain: %d contracts", nq_spot, len(nq_chain))
            else:
                log.warning("NQ spot price unavailable — skipping NQ GEX")
                nq_chain = []
        except Exception as exc:
            log.error("NQ fetch failed: %s", exc)
            nq_chain = []
    else:
        log.info("=== Skipping NQ (no IronBeam credentials in .env) ===")

    # -----------------------------------------------------------------------
    # 2. Fetch QQQ options
    # -----------------------------------------------------------------------
    try:
        log.info("=== Fetching QQQ options ===")
        qqq_chain, qqq_spot = fetch_equity_options("QQQ")
        if qqq_spot:
            spots["qqq"] = qqq_spot
            log.info("QQQ spot: %.2f | Chain: %d contracts", qqq_spot, len(qqq_chain))
        else:
            log.warning("QQQ spot price unavailable — skipping QQQ GEX")
            qqq_chain = []
    except Exception as exc:
        log.error("QQQ fetch failed: %s", exc)
        qqq_chain = []

    # -----------------------------------------------------------------------
    # 3. Fetch NDX options
    # -----------------------------------------------------------------------
    try:
        log.info("=== Fetching NDX options ===")
        ndx_chain, ndx_spot = fetch_equity_options("NDX")
        if ndx_spot:
            spots["ndx"] = ndx_spot
            log.info("NDX spot: %.2f | Chain: %d contracts", ndx_spot, len(ndx_chain))
        else:
            log.warning("NDX spot price unavailable — skipping NDX GEX")
            ndx_chain = []
    except Exception as exc:
        log.error("NDX fetch failed: %s", exc)
        ndx_chain = []

    # -----------------------------------------------------------------------
    # 3b. Market context (VIX curve, cross-asset, QQQ weights)
    # -----------------------------------------------------------------------
    log.info("=== Fetching market context ===")
    vix_curve = fetch_vix_curve()
    cross_asset = fetch_cross_asset(spots=spots)
    log.info(
        "VIX: %s | structure: %s | signal: %s",
        vix_curve.get("levels", {}),
        vix_curve.get("structure", "?"),
        cross_asset.get("signal", "?"),
    )

    cot_nq = fetch_cot_nq()
    put_call = fetch_put_call()
    qqq_weights = get_qqq_weights()

    # -----------------------------------------------------------------------
    # 4-5. Compute GEX, vanna, and charm per instrument
    # -----------------------------------------------------------------------
    for name, chain, spot, is_futures in [
        ("NQ", nq_chain, spots.get("nq"), True),
        ("QQQ", qqq_chain, spots.get("qqq"), False),
        ("NDX", ndx_chain, spots.get("ndx"), False),
    ]:
        if not chain or spot is None:
            continue

        log.info("Computing GEX for %s (%d contracts)...", name, len(chain))
        gex_map, skipped = aggregate_gex(chain, spot, is_futures=is_futures)
        total_skipped_iv += skipped
        strike_gex_all[name] = gex_map
        log.info(
            "%s: %d strikes with GEX, %d skipped",
            name, len(gex_map), skipped,
        )

        log.info("Computing vanna for %s (15-25 DTE window)...", name)
        vanna_map, included_dtes, skipped_v = aggregate_vanna(
            chain, spot, is_futures=is_futures
        )
        total_skipped_iv += skipped_v
        strike_vanna_all[name] = (vanna_map, included_dtes)
        log.info(
            "%s: %d strikes with vanna, %d skipped", name, len(vanna_map), skipped_v
        )

        log.info("Computing charm for %s (full 2-weekly chain)...", name)
        charm_map, skipped_c = aggregate_charm(chain, spot, is_futures=is_futures)
        total_skipped_iv += skipped_c
        strike_charm_all[name] = charm_map
        log.info(
            "%s: %d strikes with charm, %d skipped", name, len(charm_map), skipped_c
        )

    # -----------------------------------------------------------------------
    # 6. Extract levels
    # -----------------------------------------------------------------------
    for name in ["NQ", "QQQ", "NDX"]:
        if name not in strike_gex_all:
            continue
        spot = spots.get(name.lower())
        levels = extract_instrument_levels(strike_gex_all[name], spot)

        # Attach vanna levels
        vanna_map = {}
        if name in strike_vanna_all:
            vanna_map, included_dtes = strike_vanna_all[name]
            vanna_levels = extract_greek_levels(vanna_map)
            vanna_levels["dtes"] = included_dtes
            levels["vanna"] = vanna_levels

        # Attach charm levels
        charm_map = {}
        if name in strike_charm_all:
            charm_map = strike_charm_all[name]
            charm_levels = extract_greek_levels(charm_map)
            if charm_map:
                cum_charm = sum(charm_map.values())
                charm_sign = "positive" if cum_charm >= 0 else "negative"
                charm_levels["cumulative_sign"] = charm_sign
                # Directional bias: cumulative sign is about delta decay direction across the book.
                # Top strikes are local pin gravity — distinct from the directional signal.
                if charm_sign == "negative":
                    charm_levels["directional_bias"] = "dealers net losing delta from theta — overall bearish charm pressure"
                else:
                    charm_levels["directional_bias"] = "dealers net gaining delta from theta — overall bullish charm pressure"
                top = charm_levels.get("top", [])
                if top:
                    charm_levels["pin_description"] = f"local pin gravity concentrated at {', '.join(str(int(s)) for s in top[:2])}"
            levels["charm"] = charm_levels

        # Regime block
        if spot is not None:
            zero_gamma = levels.get("zero_gamma")
            vol_trigger = levels.get("volatility_trigger")
            gamma_regime = None
            if zero_gamma is not None:
                gamma_regime = "positive" if spot > zero_gamma else "negative"
            above_vol_trigger = (spot > vol_trigger) if vol_trigger is not None else None
            parts = []
            if gamma_regime == "positive":
                parts.append("positive gamma — dealers dampen moves")
            elif gamma_regime == "negative":
                parts.append("negative gamma — dealers amplify moves")
            if above_vol_trigger is True:
                parts.append("above vol trigger — vol suppression active")
            elif above_vol_trigger is False:
                parts.append("below vol trigger")
            levels["regime"] = {
                "gamma": gamma_regime,
                "above_vol_trigger": above_vol_trigger,
                "description": " | ".join(parts) if parts else "unknown",
            }

        # Multi-greek confluence (within instrument)
        if spot is not None:
            levels["confluence"] = extract_confluence(
                strike_gex_all[name], vanna_map, charm_map, spot
            )

        instrument_levels[name] = levels

    # Unwrap vanna maps for combo enrichment (strip the included_dtes tuple)
    vanna_maps_only = {k: v[0] for k, v in strike_vanna_all.items()}
    combos = detect_combos(
        instrument_levels, strike_gex_all,
        spots=spots,
        strike_vanna_all=vanna_maps_only,
        strike_charm_all=strike_charm_all,
    )

    # Surface high-conviction single-instrument levels (2+ greeks) not already in a combo
    for inst_name in ["NQ", "QQQ", "NDX"]:
        inst_data = instrument_levels.get(inst_name, {})
        inst_spot = spots.get(inst_name.lower())
        if not inst_spot:
            continue
        tol = inst_spot * 0.005  # same tolerance as extract_confluence
        for level in inst_data.get("confluence", []):
            if level["greek_count"] < 2:
                continue
            strike = level["strike"]
            covered = any(
                abs(combo["contributing_strikes"].get(inst_name, float("inf")) - strike) <= tol
                for combo in combos
            )
            if covered:
                continue
            abs_gex = abs(strike_gex_all.get(inst_name, {}).get(strike, 0))
            combos.append({
                "rank": None,
                "strike": strike,
                "instruments": [inst_name],
                "score": abs_gex,
                "contributing_strikes": {inst_name: strike},
                "greeks": {inst_name: level["greeks"]},
                "single_instrument": True,
            })

    # Re-rank: cross-instrument first by score, then single-instrument by score
    cross = sorted([c for c in combos if not c.get("single_instrument")], key=lambda x: -x["score"])
    single = sorted([c for c in combos if c.get("single_instrument")], key=lambda x: -x["score"])
    combos = []
    for rank, c in enumerate(cross + single, start=1):
        c["rank"] = rank
        combos.append(c)

    # -----------------------------------------------------------------------
    # 7. Build result and output
    # -----------------------------------------------------------------------
    result = {
        "nq": instrument_levels.get("NQ"),
        "qqq": instrument_levels.get("QQQ"),
        "ndx": instrument_levels.get("NDX"),
        "combo": combos,
        "spot": spots,
        "market_context": {
            "vix_curve": vix_curve,
            "cross_asset": cross_asset,
            "cot_nq": cot_nq,
            "put_call": put_call,
        },
        "qqq_weights": qqq_weights,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    print_snapshot(result)
    save_json(result)

    # Write flat levels JSON to project root data/ for the chart frontend
    _here = os.path.dirname(os.path.abspath(__file__))
    _project_root = os.path.normpath(os.path.join(_here, '..', '..'))
    _levels_path = os.path.join(_project_root, 'data', 'gex_levels.json')
    save_levels_json(result, _levels_path, strike_gex_all=strike_gex_all)

    log.info(
        "Done. Total contracts with unsolvable IV skipped: %d", total_skipped_iv
    )


if __name__ == "__main__":
    run()
