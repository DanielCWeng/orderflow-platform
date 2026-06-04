"""Fetch QQQ and NDX equity options chains from Yahoo Finance via yfinance."""

import logging
from datetime import date

import yfinance as yf

from config import MONEYNESS_MIN, MONEYNESS_MAX

log = logging.getLogger(__name__)

# Map canonical symbol names to Yahoo Finance tickers
_YAHOO_SYMBOL = {
    "NDX": "^NDX",
    "QQQ": "QQQ",
}


def _get_spot(ticker: yf.Ticker, symbol: str) -> float | None:
    try:
        price = ticker.fast_info["last_price"]
        if price:
            return float(price)
    except Exception:
        pass
    try:
        hist = ticker.history(period="1d")
        if not hist.empty:
            return float(hist["Close"].iloc[-1])
    except Exception as exc:
        log.warning("Failed to get %s spot: %s", symbol, exc)
    return None


def fetch_equity_options(symbol: str) -> tuple[list[dict], float | None]:
    """
    Fetch options chain for an equity symbol (QQQ or NDX) via yfinance.

    Uses the two nearest available expirations.  Returns (chain, spot).
    """
    yahoo_sym = _YAHOO_SYMBOL.get(symbol, symbol)
    ticker = yf.Ticker(yahoo_sym)

    spot = _get_spot(ticker, symbol)
    log.info("%s spot: %s", symbol, spot)

    try:
        all_exps = ticker.options  # tuple of YYYY-MM-DD strings, ascending
    except Exception as exc:
        log.error("Failed to get %s expirations: %s", symbol, exc)
        return [], spot

    today = date.today()
    expirations = [
        exp for exp in all_exps
        if (date.fromisoformat(exp) - today).days <= 30
    ]
    log.info("Fetching %s chains for expirations: %s", symbol, expirations)

    chain = []
    skipped = 0

    for exp in expirations:
        try:
            opt = ticker.option_chain(exp)
        except Exception as exc:
            log.warning("Failed to fetch %s chain for %s: %s", symbol, exp, exc)
            continue

        for option_type, df in [("CALL", opt.calls), ("PUT", opt.puts)]:
            for _, row in df.iterrows():
                oi = int(row.get("openInterest") or 0)
                bid = float(row.get("bid") or 0)
                ask = float(row.get("ask") or 0)
                strike = float(row.get("strike") or 0)

                if oi <= 0:
                    skipped += 1
                    continue

                if spot and not (MONEYNESS_MIN * spot <= strike <= MONEYNESS_MAX * spot):
                    skipped += 1
                    continue

                chain.append({
                    "symbol":          str(row.get("contractSymbol", "")),
                    "strike":          strike,
                    "option_type":     option_type,
                    "expiration_date": exp,
                    "oi":              oi,
                    "bid":             bid,
                    "ask":             ask,
                    "underlying":      symbol,
                })

    log.info(
        "%s chain: %d contracts (skipped %d — zero-OI or outside %.0f%%–%.0f%% moneyness)",
        symbol, len(chain), skipped,
        MONEYNESS_MIN * 100, MONEYNESS_MAX * 100,
    )
    return chain, spot
