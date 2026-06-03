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
    print(f"  Zero Gamma:          {_fmt(levels.get('zero_gamma'))}")
    print(f"  Vol Trigger:         {_fmt(levels.get('volatility_trigger'))}")

    lg = levels.get("large_gamma", [])
    if lg:
        lg_str = " / ".join(_fmt(s) for s in lg)
        print(f"  Large Gamma 1-{len(lg)}:     {lg_str}")
    else:
        print("  Large Gamma:         N/A")

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
