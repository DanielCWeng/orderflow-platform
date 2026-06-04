"""Clean console output and optional JSON save."""

import json
import logging
import os
from datetime import datetime, timezone

from config import OUTPUT_CSV

log = logging.getLogger(__name__)


def _fmt(value, decimals=0) -> str:
    """Format a number with commas, or 'N/A' if None."""
    if value is None:
        return "N/A"
    if decimals == 0:
        return f"{value:,.0f}"
    return f"{value:,.{decimals}f}"


def _print_instrument(name: str, levels: dict, spot: float | None):
    """Print a single instrument's levels."""
    print(f"\n{name}")
    print(f"  Call Wall:           {_fmt(levels.get('call_wall'))}")
    print(f"  Put Wall:            {_fmt(levels.get('put_wall'))}")
    print(f"  Zero Gamma (flip):   {_fmt(levels.get('zero_gamma'))}")
    print(f"  Zero Gamma (cum):    {_fmt(levels.get('zero_gamma_cumulative'))}")
    print(f"  Vol Trigger:         {_fmt(levels.get('volatility_trigger'))}")

    lg = levels.get("large_gamma", [])
    if lg:
        lg_str = " / ".join(_fmt(s) for s in lg)
        print(f"  Large Gamma 1-{len(lg)}:     {lg_str}")
    else:
        print("  Large Gamma:         N/A")

    vanna = levels.get("vanna", {})
    if vanna:
        dtes = vanna.get("dtes", [])
        dte_str = f"  [{', '.join(f'{d:.0f}DTE' for d in dtes)}]" if dtes else ""
        print(f"  Vanna Flip:{dte_str:<20} {_fmt(vanna.get('flip'))}")
        top_v = vanna.get("top", [])
        if top_v:
            print(f"  Top Vanna:           {' / '.join(_fmt(s) for s in top_v)}")

    charm = levels.get("charm", {})
    if charm:
        print(f"  Charm Flip:          {_fmt(charm.get('flip'))}")
        top_c = charm.get("top", [])
        if top_c:
            print(f"  Top Charm:           {' / '.join(_fmt(s) for s in top_c)}")

    if spot is not None:
        print(f"  Spot:                {_fmt(spot, 2)}")


def print_snapshot(result: dict):
    """Print the full GEX morning snapshot to console."""
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%d %b %Y")

    print()
    print("=" * 50)
    print(f"  GEX MORNING SNAPSHOT — {date_str}")
    print("=" * 50)

    spots = result.get("spot", {})

    if "nq" in result and result["nq"]:
        _print_instrument("NQ Futures Options", result["nq"], spots.get("nq"))

    if "qqq" in result and result["qqq"]:
        _print_instrument("QQQ Options", result["qqq"], spots.get("qqq"))

    if "ndx" in result and result["ndx"]:
        _print_instrument("NDX Options", result["ndx"], spots.get("ndx"))

    combos = result.get("combo", [])
    if combos:
        print("\nCOMBO LEVELS (cross-instrument confluence)")
        for c in combos:
            inst_str = "+".join(c["instruments"])
            print(
                f"  Combo {c['rank']} [{inst_str}]:".ljust(30)
                + f"{_fmt(c['strike'])}  (score: {_fmt(c['score'])})"
            )
    else:
        print("\nCOMBO LEVELS: No cross-instrument confluence detected")

    gen = result.get("generated_at", now.strftime("%Y-%m-%d %H:%M UTC"))
    print(f"\nGenerated: {gen}")
    print("=" * 50)
    print()


def save_levels_json(result: dict, output_path: str, strike_gex_all: dict | None = None):
    """
    Write a flat levels array to a fixed-path JSON file for the chart frontend.
    This file is replaced daily and read by chartlwc.js to render GEX lines.
    """
    COLORS = {
        "call_wall":            "#3fb950",
        "put_wall":             "#f85149",
        "zero_gamma":           "#d29922",
        "zero_gamma_cumulative": "#a37c1a",
        "volatility_trigger":   "#8957e5",
        "large_gamma":          "#6e7681",
        "vanna_flip":           "#58a6ff",
        "top_vanna":            "#388bfd",
        "charm_flip":           "#f0883e",
        "top_charm":            "#d18616",
    }
    LABELS = {
        "call_wall":            "Call Wall",
        "put_wall":             "Put Wall",
        "zero_gamma":           "Zero Gamma",
        "zero_gamma_cumulative": "Zero Gamma (Cum)",
        "volatility_trigger":   "Vol Trigger",
    }

    spots = result.get("spot", {})

    levels = []
    for inst_key in ("nq", "qqq", "ndx"):
        inst_data = result.get(inst_key)
        if not inst_data:
            continue
        tag = inst_key.upper()
        spot = spots.get(inst_key)

        def lvl(name, px, color):
            entry = {"name": name, "price": px, "color": color, "instrument": tag}
            if spot is not None:
                entry["spot"] = spot
            return entry

        # GEX levels
        for field, label in LABELS.items():
            px = inst_data.get(field)
            if px is not None:
                levels.append(lvl(f"{tag} {label}", px, COLORS[field]))
        for i, px in enumerate(inst_data.get("large_gamma", []), start=1):
            levels.append(lvl(f"{tag} GEX {i}", px, COLORS["large_gamma"]))

        # Vanna levels
        vanna = inst_data.get("vanna", {})
        if vanna:
            if vanna.get("flip") is not None:
                levels.append(lvl(f"{tag} Vanna Flip", vanna["flip"], COLORS["vanna_flip"]))
            for i, px in enumerate(vanna.get("top", []), start=1):
                levels.append(lvl(f"{tag} Vanna {i}", px, COLORS["top_vanna"]))

        # Charm levels
        charm = inst_data.get("charm", {})
        if charm:
            if charm.get("flip") is not None:
                levels.append(lvl(f"{tag} Charm Flip", charm["flip"], COLORS["charm_flip"]))
            for i, px in enumerate(charm.get("top", []), start=1):
                levels.append(lvl(f"{tag} Charm {i}", px, COLORS["top_charm"]))

    # Combo / confluence levels
    for combo in result.get("combo", []):
        px = combo.get("strike")
        if px is None:
            continue
        insts = combo.get("instruments", [])
        inst_label = "+".join(insts)
        rank = combo.get("rank", "")
        name = f"Combo {rank} [{inst_label}]" if rank else f"Combo [{inst_label}]"
        # Use the primary instrument's spot for proportional scaling on the chart
        primary = insts[0] if insts else None
        combo_spot = spots.get(primary.lower()) if primary else None
        entry = {
            "name":       name,
            "price":      px,
            "color":      "#c9a227",
            "instrument": inst_label,
            "is_combo":   True,
        }
        if combo_spot is not None:
            entry["spot"] = combo_spot
        levels.append(entry)

    # Build per-strike GEX profile for chart sidebar rendering
    profile = {}
    if strike_gex_all:
        spots = result.get("spot", {})
        for inst_key in ("NQ", "QQQ", "NDX"):
            gex_map = strike_gex_all.get(inst_key)
            if not gex_map:
                continue
            spot = spots.get(inst_key.lower())
            sorted_strikes = sorted(gex_map.keys())
            profile[inst_key] = {
                "spot": spot,
                "strikes": [[k, round(gex_map[k], 0)] for k in sorted_strikes],
            }

    payload = {
        "date":           datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "generated_at":   result.get("generated_at", ""),
        "levels":         levels,
        "profile":        profile,
        "market_context": result.get("market_context"),
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(payload, f, indent=2)
    log.info("GEX levels written to %s (%d levels)", output_path, len(levels))


def save_json(result: dict):
    """Save result dict as JSON file in output/ directory."""
    if not OUTPUT_CSV:
        return

    now = datetime.now(timezone.utc)
    filename = f"snapshot_{now.strftime('%Y%m%d')}.json"
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)))
    filepath = os.path.join(out_dir, filename)

    with open(filepath, "w") as f:
        json.dump(result, f, indent=2, default=str)

    log.info("Snapshot saved to %s", filepath)
    print(f"Saved: {filepath}")
