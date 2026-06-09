# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step — open `index.html` directly in a browser, or serve it with any static file server:

```bash
npx serve .
# or
python -m http.server 8080
```

There are no tests, no linter, and no package.json.

### Python backend (optional but needed for tick storage, backfill, GEX)

```bash
pip install -r requirements.txt

# Set env vars (or create a .env file)
export IRONBEAM_USERNAME="your_user"
export IRONBEAM_PASSWORD="your_pass"
export IRONBEAM_API_KEY="your_api_key"   # GEX pipeline only

python -m orderflow.main    # starts FastAPI on http://localhost:8000
```

### Local dev with mock server

```bash
# Terminal 1: mock IronBeam API (no credentials needed)
python mock_server.py       # http://localhost:8001

# Terminal 2: Python backend
# Set MOCK = True in orderflow/config.py first
python -m orderflow.main

# Terminal 3: static frontend
npx serve .
```

In `data-live.js` set `MOCK = true` — platform auto-connects. Bars close every 30 s in mock mode (vs 300 s prod).

---

## Architecture

Single-page trading workstation UI with zero build tooling, backed by an optional Python FastAPI service for tick storage and analytics.

**Frontend CDN dependencies** (loaded in `index.html`):
- **React 18** (UMD)
- **Babel Standalone 7.29.0** — transpiles JSX in-browser
- **Lightweight Charts 4.2.3** — TradingView charting library

### Script load order (matters)

```
indicators.js → data-live.js → panels.js → chartlwc.js → app.js
```

Each file is loaded sequentially. Components defined in earlier files are attached to `window` so later files can reference them.

> `data.js` is still in the repo but **not loaded** — original synthetic-data generator kept for reference.

### Global namespace

All shared state lives on `window`:

| Global | Set by | Contents |
|---|---|---|
| `window.OF_DATA` | `data-live.js` | All market data: candles, DOM, tape, vp, tpo, delta, watchlist, largeTrades, sessionStats |
| `window.OF_FOOTPRINT_STATS` | `data-live.js` | Imbalance threshold, delta stats |
| `window.OF_TAPE_STATS` | `data-live.js` | Velocity, histogram, aggressor %, tiers |
| `window.OF_INDICATOR_MGR` | `indicators.js` | IndicatorManager instance |
| `window._OF_LIVE_STATUS` | `data-live.js` | `{text, ok}` — connection status for statusbar |
| `window.connectIronBeam` | `data-live.js` | `fn(username, password)` — called by auth form |
| `window.ChartLW` | `chartlwc.js` | The chart React component |
| `window.Sidebar`, `window.DOMLadder`, `window.TapePanel`, `window.TPO`, `window.DeltaPanel`, `window.ScannerPanel` | `panels.js` | All panel React components |

### File responsibilities

- **`indicators.js`** — S/A-tier orderflow indicators. Exports `IndicatorManager` (`window.OF_INDICATOR_MGR`). Routes WS messages to registered indicator classes via `onMessage(msg)`, `onTrade(trade)`, `onBarClose(bar, footprintBar)`, `onDOM(bids, asks)`. Each indicator has a `signals[]` array and `state` object consumed by the renderer.

- **`data-live.js`** — Live data layer. Connects to IronBeam via WebSocket. Subscribes to quotes, DOM depth, trades, and 5-min timebars for the active symbol. Accumulates trades into per-bar footprint arrays, runs imbalance/absorption/tape-tier analytics, rebuilds VP/TPO/delta after each update. Dispatches `CustomEvent('of-data-update')` to trigger React re-renders. Pushes ticks/bars to the Python backend (`BACKEND_URL = 'http://localhost:8000'`) fire-and-forget. Key constants at top of file: `MOCK`, `SYMBOL`, `BACKEND_URL`, `TICK`, `MAX_BARS`, `TIMEFRAME_SEC`.

- **`panels.js`** — All non-chart React components: `Sidebar`, `DOMLadder`, `TapePanel`, `TPO`, `DeltaPanel`, `ScannerPanel`. Each reads directly from `window.OF_DATA` / `window.OF_TAPE_STATS`. Exports via `Object.assign(window, {...})`.

- **`chartlwc.js`** — The `ChartLW` component. Wraps Lightweight Charts with a custom footprint series renderer (`createFootprintSeriesView`), SVG overlay for drawings (trend lines, H-lines, boxes, long/short position templates, text notes), VP overlay as SVG bars anchored to the price scale, and GEX heatmap overlay. `ResizeObserver` keeps canvas sized to container. Drawing keyboard shortcuts: `D` toolbar, `L` line, `H` hline, `B` box, `T` text, `U`/`Ctrl+Z` undo.

- **`app.js`** — Root `App` component. Manages layout state (density, active symbol, timeframe, panel heights, toggle flags). Persists preferences to `localStorage` key `'of-prefs'`. Contains `BackfillButton` (POST `/backfill/run`) and `GexButton` (POST `/gex/run`). Drag-to-resize rows via `startVerticalDrag`. Mounts via `ReactDOM.createRoot`.

- **`mock_server.py`** — Realistic IronBeam API simulator. Regime-based market sim (open_gap, hard_trend, absorption, lunchtime_chop, failed_auction, close_accel) with Hawkes process trade generation and a stateful limit order book. Runs on port 8001.

### Layout structure

```
topbar (44px)
subbar (36px)
main (flex-1)
  sidebar (collapsible, 220px / 44px)
  col-stack stack-mid  → ChartLW / DeltaPanel / ScannerPanel (drag-resizable)
  col-stack stack-tape → TapePanel / TPO (drag-resizable)
  col-stack stack-dom  → DOMLadder (340px fixed)
statusbar (22px)
```

Row dividers between panels are draggable — handled entirely in `app.js` via `startVerticalDrag`.

### CSS

All CSS is in `index.html` as a single `<style>` block using CSS custom properties. Density modes (`compact` / `balanced` / `spacious`) are applied via `data-density` on `<html>` and override `--row-h`, `--pad`, `--fs-num`, etc.

Color palette uses `oklch` and `color-mix(in oklab, ...)` — requires Chrome 111+, Firefox 113+, Safari 16.4+.

### Key data concepts

- **Footprint**: Each candle has a `footprint` array of `{px, bid, ask}` entries at every 0.25-tick price level.
- **Imbalance**: A cell is flagged `askImb`/`bidImb` when dominant/weaker ratio ≥ adaptive threshold (mean + 1.2σ of all session ratios).
- **Stacked imbalance**: 3+ consecutive imbalance cells in the same direction.
- **Absorption**: High-volume candle with strong delta but tight body (body < 30% of range).
- **Unfinished auction**: Top/bottom footprint cell is ≥90% dominated by one side.
- **Tape tiers**: `sm` / `md` / `lg` / `inst` assigned by session percentiles (p55 / p85 / p97).
- **Tick side**: `B` = buy aggressor (lifts ask), `A` = sell aggressor (hits bid), `U` = unknown.

### IronBeam connection

- **Current symbol**: `XCME:ES.M26` — update `SYMBOL` in `data-live.js` and `orderflow/config.py` on contract roll.
- **Connect button**: Small button in topbar-right. Toggles a credential panel (bottom-right, above statusbar).
- **Auth flow**: POST `/v2/auth` → GET `/v2/stream/create` → subscribe market data → open WS `/v2/stream/{streamId}`.
- **WS message types**: `q` (quote), `d` (depth), `tr` (trades), `ti` (timebars).
- **No historical bars**: IronBeam streams only real-time; chart fills as bars close. Python backend provides historical.
- **Debugging**: DevTools → Network → WS frames for message types. Console `[OF]` prefix errors. `document.addEventListener('of-data-update', console.log)` to verify events.

---

## Python backend (`orderflow/`)

FastAPI service on port 8000. Handles tick/OHLCV storage, historical queries, live WebSocket push, and yfinance backfill.

### Entry point

```bash
python -m orderflow.main
```

Startup sequence: validate contracts → init DuckDB → detect/backfill gaps → start pruner → connect IronBeam WS → start FastAPI.

### Config (`orderflow/config.py`)

Key constants to update on contract roll:

```python
INSTRUMENTS = {
    "ES": {"contract": "ESM26", "tick": 0.25, "yfinance": "ES=F", "symbol": "XCME:ES.M26"},
    "NQ": {"contract": "NQM26", "tick": 0.25, "yfinance": "NQ=F", "symbol": "XCME:NQ.M26"},
}
DB_PATH = "data/orderflow.duckdb"
PARQUET_DIR = "data/parquet"
MOCK = False                  # set True to point at mock_server.py
API_PORT = 8000
PRUNER_CRON = "5 18 * * *"   # 18:05 ET daily
TICK_RETENTION_DAYS = 7
OHLCV_RETENTION_DAYS = 35
GAP_LOOKBACK_DAYS = 30
```

Credentials read from env: `IRONBEAM_USERNAME`, `IRONBEAM_PASSWORD`.

### Storage

- **`storage/tick_store.py`** — DuckDB `ticks` table: `(instrument, contract, timestamp, price, size, side, session)`.
- **`storage/ohlcv_store.py`** — DuckDB `ohlcv` table + daily Parquet mirror at `data/parquet/{instrument}/{YYYY-MM-DD}.parquet`. Primary key `(instrument, timestamp)`. Source field: `LIVE` or `BACKFILL`.
- **`storage/pruner.py`** — APScheduler job at 18:05 ET; deletes ticks >7 days and OHLCV/Parquet >35 days.

### Ingestion

- **`ingestion/ironbeam.py`** — `IronBeamClient` per instrument. Auth → stream → subscribe → WS loop. Writes ticks to TickStore, completed bars to OHLCVStore. Exponential backoff reconnect (cap 60 s). Tracks CVD and bar delta in memory.
- **`ingestion/session.py`** — Classifies timestamps to session: `RTH` (09:30–16:00 ET), `PRE` (09:00–09:30), `POST` (16:00–17:00), `OVERNIGHT` (18:00–09:00), `MAINTENANCE` (17:00–18:00, takes precedence).
- **`ingestion/contracts.py`** — CME quarterly roll logic (3rd Friday of Mar/Jun/Sep/Dec). `active_contract(instrument)` derives front-month from calendar; `contract_from_config(instrument)` reads static config.

### REST API (`api/rest.py`)

All endpoints parameterized (no SQL injection risk). DateTime assumes UTC if no tz suffix.

| Endpoint | Description |
|---|---|
| `GET /health` | Status check |
| `GET /vp?instrument=ES&from=...&to=...&session=RTH` | Volume profile (POC, VAH, VAL, rows) |
| `GET /ohlcv?instrument=ES&from=...&to=...&resolution=1m&session=RTH` | OHLCV bars |
| `GET /footprint?instrument=ES&from=...&to=...` | Footprint per price level per bar |
| `GET /delta?instrument=ES&from=...&to=...` | Bar delta + cumulative volume delta |
| `POST /backfill/run` | Trigger yfinance gap backfill |

### WebSocket API (`api/ws.py`)

`WS /live/{instrument}` — streams tick events as JSON: `{type, instrument, contract, timestamp, price, size, side, session, cvd, bar_delta}`. Dead connections removed on broadcast failure. 30 s keep-alive heartbeat.

### Compute modules

- **`compute/delta.py`** — `compute_delta(instrument, start, end, ...)` → per-bar buy/sell vol, delta, running CVD.
- **`compute/footprint.py`** — `compute_footprint(...)` → `list[FootprintBar]` with `levels: list[FootprintLevel(price, bid_vol, ask_vol, delta, unknown)]`.
- **`compute/vp.py`** — `compute_vp(...)` → `VPResult(poc, vah, val, rows)`. Falls back to OHLCV distribution if ticks unavailable.

### Backfill

- **`backfill/gap_detector.py`** — Compares expected bar timestamps (from session schedule) against OHLCV store over last 30 days. Returns `Gap(instrument, session, date, missing_timestamps)`.
- **`backfill/yfinance_fill.py`** — Fetches 1-min bars from yfinance for each gap, classifies session, upserts to OHLCV store with `source=BACKFILL`.

### Next contract roll

ESM26 → ESU26 and NQM26 → NQU26 mid-June 2026. Files to update:
1. `data-live.js` — `SYMBOL` constant
2. `orderflow/config.py` — both `INSTRUMENTS` entries
3. `gex/gex-snapshot/config.py` — `NQ_CONTRACT`

---

## GEX Snapshot pipeline (`gex/gex-snapshot/`)

Run manually: `cd gex/gex-snapshot && python main.py`. Output: `output/snapshot_{YYYY-MM-DD}.json`.

### Data sources

| Instrument | Source | File |
|---|---|---|
| NQ futures options | Barchart (no login) | `data/barchart.py` |
| QQQ / NDX options | yfinance | `data/tradier.py` (misnamed — uses yfinance) |
| VIX curve, cross-asset | yfinance public feeds | `data/market_context.py` |
| COT | CFTC public download | `data/cot.py` |
| Put/call ratio | Public feed | `data/put_call.py` |
| QQQ weights | ETF holdings | `data/qqq_weights.py` |

### Config (`gex/gex-snapshot/config.py`)

```python
NQ_CONTRACT = "NQM26"           # update on quarterly roll
COMBO_TOLERANCE_POINTS = 50
RISK_FREE_RATE = 0.05
MONEYNESS_MIN, MAX = 0.70, 1.30 # filter deep OTM legacy options
QQQ_SCALE_FACTOR = 40.0         # QQQ trades at ~1/40th of NQ
```

Credentials: `IRONBEAM_USERNAME`, `IRONBEAM_API_KEY` from env.

### NQ options via Barchart (`data/barchart.py`)

Barchart serves NQ futures options publicly via a non-obvious internal endpoint:

- **Real endpoint**: `GET /proxies/core-api/v1/quotes/get?list=futures.options` — **not** `/proxies/core-api/v1/options/chain` (returns empty for futures).
- **Session cookies required**: First `GET /futures/quotes/{contract}/options` to obtain `XSRF-TOKEN` and `laravel_session`, then pass `X-XSRF-TOKEN` header on data requests.
- **Response shape**: `data` is `{"Call": [...], "Put": [...]}` grouped by `optionType`, not a flat list.
- **`expirationDate` always null**: Derive from contract symbol instead (e.g. `NQM26` → last Thursday before 3rd Friday of June 2026 = `2026-06-18`).
- **Other failed sources**: IronBeam `/info/symbol/search/options/` returns empty (no options data access). yfinance `NQ=F` returns 0 expirations. Polygon free tier returns 403.

### Compute (`compute/`)

- **`gex.py`** — `compute_contract_gex()`: solve IV from bid/ask mid, compute gamma (Black-Scholes or Black-76), `GEX = sign × gamma × OI × 100 × spot² × 0.01`. `aggregate_gex/vanna/charm()` aggregate per strike.
- **`greeks.py`** — Black-Scholes + Black-76 implementations: `bs_gamma/vega/vanna/charm()`, `black76_*()`, `solve_iv()` (Newton-Raphson).
- **`levels/extract.py`** — Extracts call wall (highest +GEX), put wall (most −GEX), zero gamma (sign flip nearest spot), vol trigger (GEX ≈ 0 nearest spot), top 4 large-gamma strikes, combo clusters, vanna/charm flip levels.

### DTE signal quality

| DTE | Status | Meaning |
|---|---|---|
| ≥15 | OK | Full vanna/charm character |
| 8–14 | NOTE | Short but meaningful |
| <8 | WARN | Gamma dominates; vanna/charm unreliable |

NQM26 at ≤13 DTE falls outside the 15–25 DTE window — pipeline falls back to nearest expiry. Vanna computes normally after rolling to NQU26.
