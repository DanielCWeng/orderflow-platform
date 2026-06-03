"""GEX Morning Snapshot — orchestrator.

Fetches NQ, QQQ, and NDX options chains, computes GEX per strike,
extracts key levels (walls, gamma flip, vol trigger, combos), and
outputs a clean morning snapshot.
"""

import logging
import os
import sys
from datetime import datetime, timezone

from data.ironbeam import fetch_nq_options
from data.tradier import fetch_equity_options
from compute.gex import aggregate_gex
from levels.extract import extract_instrument_levels, detect_combos
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
    instrument_levels = {}
    total_skipped_iv = 0

    # -----------------------------------------------------------------------
    # 1. Fetch NQ futures options
    # -----------------------------------------------------------------------
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
    # 4-5. Compute IV, Gamma, and per-strike GEX
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
            "%s: %d strikes with GEX, %d contracts skipped (IV unsolvable)",
            name, len(gex_map), skipped,
        )

    # -----------------------------------------------------------------------
    # 6. Extract levels
    # -----------------------------------------------------------------------
    for name in ["NQ", "QQQ", "NDX"]:
        if name in strike_gex_all:
            levels = extract_instrument_levels(
                strike_gex_all[name], spots.get(name.lower())
            )
            instrument_levels[name] = levels

    combos = detect_combos(instrument_levels, strike_gex_all)

    # -----------------------------------------------------------------------
    # 7. Build result and output
    # -----------------------------------------------------------------------
    result = {
        "nq": instrument_levels.get("NQ"),
        "qqq": instrument_levels.get("QQQ"),
        "ndx": instrument_levels.get("NDX"),
        "combo": combos,
        "spot": spots,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    print_snapshot(result)
    save_json(result)

    # Write flat levels JSON to project root data/ for the chart frontend
    _here = os.path.dirname(os.path.abspath(__file__))
    _project_root = os.path.normpath(os.path.join(_here, '..', '..'))
    _levels_path = os.path.join(_project_root, 'data', 'gex_levels.json')
    save_levels_json(result, _levels_path)

    log.info(
        "Done. Total contracts with unsolvable IV skipped: %d", total_skipped_iv
    )


if __name__ == "__main__":
    run()
