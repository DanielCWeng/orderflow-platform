import os
from dotenv import load_dotenv

load_dotenv()

# --- API credentials ---
IRONBEAM_USERNAME = os.getenv("IRONBEAM_USERNAME", "")
IRONBEAM_API_KEY = os.getenv("IRONBEAM_API_KEY", "")
TRADIER_API_TOKEN = os.getenv("TRADIER_API_TOKEN", "")

# --- Endpoints ---
IRONBEAM_BASE_URL = os.getenv("IRONBEAM_BASE_URL", "https://live.ironbeamapi.com/v2")
TRADIER_BASE_URL = os.getenv("TRADIER_BASE_URL", "https://api.tradier.com/v1")

# --- Computation settings ---
COMBO_TOLERANCE_POINTS = 50   # strike proximity window for combo detection (index points)
RISK_FREE_RATE = 0.05         # annualised risk-free rate for BS / Black-76
OUTPUT_CSV = True             # save results to output/snapshot_{date}.json

# --- Derived ---
# QQQ trades at ~1/40th of NDX/NQ. Scale tolerance for QQQ comparisons.
QQQ_SCALE_FACTOR = 40.0
