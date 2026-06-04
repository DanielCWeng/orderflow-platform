"""CFTC Traders in Financial Futures (TFF) — NQ Mini positioning."""

import io
import logging
import zipfile
from datetime import datetime

import pandas as pd
import requests

log = logging.getLogger(__name__)

# Financial futures COT (TFF report — contains equities, FX, rates)
COT_URL = "https://www.cftc.gov/files/dea/history/fut_fin_txt_2026.zip"
_MARKET = "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE"


def _parse_date(yymmdd) -> str:
    """Convert YYMMDD (string or int) → YYYY-MM-DD."""
    try:
        s = str(int(yymmdd)).zfill(6)
        return datetime.strptime("20" + s, "%Y%m%d").strftime("%Y-%m-%d")
    except Exception:
        return str(yymmdd)


def fetch_cot_nq() -> dict:
    """
    Fetch CFTC TFF report and return the latest NQ Mini positioning snapshot.

    Key categories (TFF format):
      - lev_money  = Leveraged Money (hedge funds) — primary sentiment signal
      - asset_mgr  = Asset Manager / Institutional (long-only funds, pensions)
      - dealer     = Dealer / Intermediary (sell-side)

    Returns:
        {
          "as_of":              "2026-05-27",
          "market":             "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE",
          "open_interest":      302990,
          "lev_money_long":     52861,
          "lev_money_short":    104540,
          "lev_money_net":      -51679,
          "lev_money_net_chg":  -6308,
          "asset_mgr_long":     117374,
          "asset_mgr_short":    32311,
          "asset_mgr_net":      85063,
          "asset_mgr_net_chg":  -7238,
          "dealer_net":         -45022,
          "pct_oi_lev_long":    17.4,
          "pct_oi_lev_short":   34.5,
          "pct_oi_am_long":     38.7,
          "pct_oi_am_short":    10.7,
          "stance":             "bearish",   # based on lev_money net
        }
    """
    log.info("Fetching CFTC TFF file (financial futures)...")
    try:
        r = requests.get(COT_URL, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            csv_name = zf.namelist()[0]
            with zf.open(csv_name) as f:
                df = pd.read_csv(f, encoding="latin-1", low_memory=False)
    except Exception as exc:
        log.error("COT fetch failed: %s", exc)
        return {}

    df.columns = df.columns.str.strip()

    nq = df[
        df["Market_and_Exchange_Names"].str.strip() == _MARKET
    ].sort_values("As_of_Date_In_Form_YYMMDD", ascending=False).reset_index(drop=True)

    if nq.empty:
        log.warning("COT: no rows matched for '%s'", _MARKET)
        return {}

    row = nq.iloc[0]

    def _int(col: str) -> int:
        try:
            return int(str(row.get(col, 0)).strip().replace(",", "") or 0)
        except (ValueError, TypeError):
            return 0

    def _flt(col: str) -> float:
        try:
            return round(float(str(row.get(col, 0)).strip() or 0), 2)
        except (ValueError, TypeError):
            return 0.0

    lev_long  = _int("Lev_Money_Positions_Long_All")
    lev_short = _int("Lev_Money_Positions_Short_All")
    lev_net   = lev_long - lev_short
    lev_chg   = _int("Change_in_Lev_Money_Long_All") - _int("Change_in_Lev_Money_Short_All")

    am_long   = _int("Asset_Mgr_Positions_Long_All")
    am_short  = _int("Asset_Mgr_Positions_Short_All")
    am_net    = am_long - am_short
    am_chg    = _int("Change_in_Asset_Mgr_Long_All") - _int("Change_in_Asset_Mgr_Short_All")

    result = {
        "as_of":              _parse_date(row.get("As_of_Date_In_Form_YYMMDD", "")),
        "market":             _MARKET,
        "open_interest":      _int("Open_Interest_All"),
        "lev_money_long":     lev_long,
        "lev_money_short":    lev_short,
        "lev_money_net":      lev_net,
        "lev_money_net_chg":  lev_chg,
        "asset_mgr_long":     am_long,
        "asset_mgr_short":    am_short,
        "asset_mgr_net":      am_net,
        "asset_mgr_net_chg":  am_chg,
        "dealer_net":         _int("Dealer_Positions_Long_All") - _int("Dealer_Positions_Short_All"),
        "pct_oi_lev_long":    _flt("Pct_of_OI_Lev_Money_Long_All"),
        "pct_oi_lev_short":   _flt("Pct_of_OI_Lev_Money_Short_All"),
        "pct_oi_am_long":     _flt("Pct_of_OI_Asset_Mgr_Long_All"),
        "pct_oi_am_short":    _flt("Pct_of_OI_Asset_Mgr_Short_All"),
        "stance":             "bullish" if lev_net > 0 else "bearish",
    }

    log.info(
        "COT NQ as_of=%s | lev_net=%+d (chg %+d) | am_net=%+d | stance=%s",
        result["as_of"], result["lev_money_net"], result["lev_money_net_chg"],
        result["asset_mgr_net"], result["stance"],
    )
    return result
