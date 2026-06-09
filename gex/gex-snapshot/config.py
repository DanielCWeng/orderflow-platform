import os
from dotenv import load_dotenv

load_dotenv()

# --- API credentials ---
IRONBEAM_USERNAME = os.getenv("IRONBEAM_USERNAME", "")
IRONBEAM_API_KEY = os.getenv("IRONBEAM_API_KEY", "")
# --- Endpoints ---
IRONBEAM_BASE_URL = os.getenv("IRONBEAM_BASE_URL", "https://live.ironbeamapi.com/v2")

# --- NQ front-month contract (update on quarterly roll) ---
# Match the contract in orderflow/config.py INSTRUMENTS["NQ"]["contract"]
NQ_CONTRACT = os.getenv("NQ_CONTRACT", "NQM26")

# --- Computation settings ---
COMBO_TOLERANCE_POINTS = 50   # strike proximity window for combo detection (index points)
RISK_FREE_RATE = 0.05         # annualised risk-free rate for BS / Black-76
OUTPUT_CSV = True             # save results to output/snapshot_{date}.json

# --- Chain filtering ---
# Exclude options whose strike is outside this fraction of spot.
# Deep OTM legacy puts (e.g. QQQ 194 when spot=735) have huge OI but
# negligible gamma and corrupt GEX levels.  0.70–1.30 = ±30% of spot.
MONEYNESS_MIN = 0.70
MONEYNESS_MAX = 1.30

# --- Derived ---
# QQQ trades at ~1/40th of NDX/NQ. Scale tolerance for QQQ comparisons.
QQQ_SCALE_FACTOR = 40.0
