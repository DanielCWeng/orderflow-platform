"""Cross-asset market context: VIX term structure + cross-asset divergence."""

import logging

import yfinance as yf

log = logging.getLogger(__name__)

_VIX_TICKERS = {"vix9d": "^VIX9D", "vix": "^VIX", "vix3m": "^VIX3M"}
_CROSS_TICKERS = {"spy": "SPY", "tlt": "TLT", "gld": "GLD", "dxy": "DX-Y.NYB", "cl": "CL=F"}


def _last_price(sym: str) -> float | None:
    try:
        t = yf.Ticker(sym)
        p = t.fast_info.get("last_price") or t.fast_info.get("previous_close")
        if p:
            return float(p)
        hist = t.history(period="5d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception as exc:
        log.warning("Price fetch failed for %s: %s", sym, exc)
    return None


def _day_chg(sym: str) -> float | None:
    try:
        hist = yf.Ticker(sym).history(period="5d")
        if len(hist) >= 2:
            prev = float(hist["Close"].iloc[-2])
            last = float(hist["Close"].iloc[-1])
            if prev:
                return round((last - prev) / prev * 100, 3)
    except Exception as exc:
        log.warning("Day-change fetch failed for %s: %s", sym, exc)
    return None


def fetch_vix_curve() -> dict:
    """
    Fetch VIX 9D / 30D / 3M and compute term structure.

    Returns:
        {
          "levels":      {"vix9d": 14.2, "vix": 15.1, "vix3m": 17.4},
          "slope_3m":    2.3,           # vix3m - vix  (positive = contango)
          "structure":   "contango",    # or "backwardation"
          "short_spread": 0.9,          # vix - vix9d  (positive = near-term calm)
          "short_stress": False,        # True when vix9d > vix (front-month spike)
        }
    """
    levels = {}
    for key, sym in _VIX_TICKERS.items():
        px = _last_price(sym)
        if px is not None:
            levels[key] = round(px, 2)

    result: dict = {"levels": levels}

    if "vix" in levels and "vix3m" in levels:
        slope = round(levels["vix3m"] - levels["vix"], 2)
        result["slope_3m"] = slope
        result["structure"] = "contango" if slope >= 0 else "backwardation"

    if "vix9d" in levels and "vix" in levels:
        short_spread = round(levels["vix"] - levels["vix9d"], 2)
        result["short_spread"] = short_spread
        result["short_stress"] = levels["vix9d"] > levels["vix"]

    return result


def _classify_cross_asset(spy: float, tlt: float, gld: float, dxy: float, cl: float = 0.0) -> tuple[str, str]:
    """
    Return (signal_code, description) from the five asset moves.

    Pattern logic:
      SPY up / TLT down / DXY up                    → classic risk-on (equities + dollar bid)
      SPY up / TLT up / GLD up / DXY down            → dollar-negative risk rotation
      SPY up / TLT up / DXY flat-or-down             → macro easing bet (duration + equities)
      SPY up / GLD up / CL up / DXY down             → reflation with commodities confirmation
      SPY up / GLD up / DXY down                     → reflation / inflation trade
      SPY down / TLT up / GLD up / DXY down          → safe-haven flight (deflationary risk-off)
      SPY down / TLT down / DXY up / CL up           → energy-driven stagflation (most toxic)
      SPY down / TLT down / DXY up                   → taper / rates fear (financial, not energy)
      SPY down / CL up / DXY up / TLT down           → supply shock (oil spike + dollar, bonds sold)
      SPY down / TLT up / DXY up                     → equity-specific selling, rates + dollar bid
    """
    _up   = lambda x, t=0.2: x > t
    _down = lambda x, t=0.2: x < -t
    _flat = lambda x, t=0.15: abs(x) < t

    # Crude-aware stagflation split — check before generic stagflation
    if _down(spy) and _down(tlt) and _up(dxy) and _up(cl):
        return "stagflation_fear", "SPY+TLT down, DXY+CL up — energy-driven stagflation, most toxic combination"
    if _down(spy) and _down(tlt) and _up(dxy):
        return "taper_fear", "SPY+TLT down, DXY up — taper / rates fear, equities and bonds sold, not energy-driven"

    # Supply shock: oil spike + dollar, but bonds rally as safety (different from stagflation)
    if _down(spy) and _up(cl) and _up(dxy) and _down(tlt):
        return "supply_shock", "SPY down, CL+DXY up, TLT down — energy supply shock, stagflationary pressure building"

    if _up(spy) and _up(tlt) and _up(gld) and _down(dxy):
        return "dollar_neg_rotation", "SPY+TLT+GLD up, DXY down — dollar-negative risk rotation with safe-haven undercurrent"
    if _up(spy) and _down(tlt) and _up(dxy):
        return "risk_on", "SPY up, TLT down, DXY up — classic risk-on, dollar and equities bid"
    if _up(spy) and _up(tlt) and _down(dxy):
        return "macro_easing_bet", "SPY+TLT up, DXY down — duration and equities bid together, macro easing priced in"
    if _up(spy) and _up(gld) and _up(cl) and _down(dxy):
        return "reflation", "SPY+GLD+CL up, DXY down — reflation / commodities bid, real assets leading"
    if _up(spy) and _up(gld) and _down(dxy):
        return "reflation", "SPY+GLD up, DXY down — reflation / inflation trade, real assets bid"
    if _down(spy) and _up(tlt) and _up(gld) and _down(dxy):
        return "risk_off", "SPY down, TLT+GLD up, DXY down — classic safe-haven flight, deflationary risk-off"
    if _down(spy) and _up(tlt) and _up(dxy):
        return "equity_specific_selling", "SPY down, TLT+DXY up — equity-specific selling, rates and dollar bid"
    if _flat(spy) and _flat(tlt) and _flat(gld) and _flat(cl):
        return "neutral", "No significant cross-asset moves"
    return "mixed", f"SPY {spy:+.2f}% TLT {tlt:+.2f}% GLD {gld:+.2f}% DXY {dxy:+.2f}% CL {cl:+.2f}% — no dominant pattern"


def fetch_cross_asset(spots: dict | None = None) -> dict:
    """
    Fetch 1-day % change for SPY, TLT, GLD, DXY, CL and compute NQ/QQQ divergence.

    Returns:
        {
          "day_chg_pct":            {"spy": 0.42, "tlt": 0.18, "gld": 0.31, "dxy": -0.25, "cl": 1.10},
          "nq_qqq_divergence_pct":  0.08,
          "signal":                 "dollar_neg_rotation",
          "signal_description":     "SPY+TLT+GLD up, DXY down — dollar-negative risk rotation...",
        }
    """
    changes: dict = {}
    for key, sym in _CROSS_TICKERS.items():
        chg = _day_chg(sym)
        if chg is not None:
            changes[key] = chg

    result: dict = {"day_chg_pct": changes}

    # Futures vs cash divergence — NQ implied vs QQQ spot
    if spots:
        nq = spots.get("nq")
        qqq = spots.get("qqq")
        if nq and qqq:
            nq_equiv = nq / 40.0
            result["nq_qqq_divergence_pct"] = round((qqq - nq_equiv) / nq_equiv * 100, 3)

    spy = changes.get("spy", 0.0)
    tlt = changes.get("tlt", 0.0)
    gld = changes.get("gld", 0.0)
    dxy = changes.get("dxy", 0.0)
    cl  = changes.get("cl",  0.0)
    signal, description = _classify_cross_asset(spy, tlt, gld, dxy, cl)
    result["signal"] = signal
    result["signal_description"] = description

    return result
