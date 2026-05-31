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

## Architecture

This is a single-page trading workstation UI with zero build tooling. Dependencies are loaded from CDN at runtime:

- **React 18** (UMD) — via `<script>` tags in `index.html`
- **Babel Standalone** — transpiles JSX in-browser from `type="text/babel"` script tags
- **Lightweight Charts 4.2** — TradingView charting library for the candlestick/footprint chart

### Script load order (matters)

```
data-live.js → panels.js → chart-lwc.js → app.js
```

Each file is loaded sequentially. Components defined in earlier files are attached to `window` so later files can reference them.

> `data.js` is still in the repo but **not loaded** — it's the original synthetic-data generator kept for reference. The live data layer is entirely in `data-live.js`.

### Global namespace

All shared state lives on `window`:

| Global | Set by | Contents |
|---|---|---|
| `window.OF_DATA` | `data-live.js` | All market data: candles, DOM, tape, vp, tpo, delta, watchlist, largeTrades, sessionStats |
| `window.OF_FOOTPRINT_STATS` | `data-live.js` (analyzeFootprint) | Imbalance threshold, delta stats |
| `window.OF_TAPE_STATS` | `data-live.js` (analyzeTape) | Velocity, histogram, aggressor %, tiers |
| `window._OF_LIVE_STATUS` | `data-live.js` | `{text, ok}` — current connection status shown in statusbar |
| `window.connectIronBeam` | `data-live.js` | `fn(username, password)` — called by the auth form |
| `window.ChartLW` | `chart-lwc.js` | The chart React component |
| `window.Sidebar`, `window.DOMLadder`, `window.TapePanel`, `window.TPO`, `window.DeltaPanel`, `window.ScannerPanel` | `panels.js` | All panel React components |

### File responsibilities

- **`data-live.js`** — Live data layer. Connects to IronBeam API (demo: `demo.ironbeamapi.com`, prod: `live.ironbeamapi.com`) via WebSocket. Subscribes to quotes, DOM depth, trades, and 5-min timebars for `XCME:ESH6`. Accumulates trades into per-bar footprint arrays, runs the same analytics as `data.js` did (imbalance, absorption, tape tiers), and rebuilds VP/TPO/delta after each update. Dispatches `CustomEvent('of-data-update')` to trigger React re-renders. Exposes `window.connectIronBeam(user, pass)` for the auth form. Symbol is configurable via the `SYMBOL` constant at the top of the file.

- **`data.js`** *(not loaded)* — Original synthetic data generator. Kept for reference. The analytics logic (analyzeFootprint, analyzeTape) was re-implemented inside `data-live.js`.

- **`panels.js`** — All non-chart React components: `Sidebar`, `DOMLadder`, `TapePanel`, `TPO`, `DeltaPanel`, `ScannerPanel`. Each reads directly from `window.OF_DATA` / `window.OF_TAPE_STATS`. Exports via `Object.assign(window, {...})`.

- **`chart-lwc.js`** — The `ChartLW` component. Wraps Lightweight Charts with a custom footprint series renderer (`createFootprintSeriesView`), SVG overlay for drawings (trend lines, H-lines, boxes, long/short position templates, text notes), and a VP (volume profile) overlay rendered as SVG bars anchored to the price scale right edge. Uses `ResizeObserver` to keep the chart sized to its container.

- **`app.js`** — Root `App` component. Manages layout state (density, active symbol, timeframe, panel toggle flags), vertical drag-to-resize logic (`startVerticalDrag`), and renders the three-column grid (chart+delta+scanner | tape+TPO | DOM ladder). Mounts via `ReactDOM.createRoot`.

### Layout structure

```
topbar (44px)
subbar (36px)
main (flex-1)
  sidebar (collapsible, 220px / 44px)
  col-stack stack-mid  → ChartLW / DeltaPanel / ScannerPanel (all drag-resizable)
  col-stack stack-tape → TapePanel / TPO (drag-resizable)
  col-stack stack-dom  → DOMLadder (fixed height)
statusbar (22px)
```

Row dividers between panels are draggable — handled entirely in `app.js` via `startVerticalDrag`.

### CSS

All CSS is in `index.html` as a single `<style>` block using CSS custom properties. Density modes (`compact` / `balanced` / `spacious`) are applied via `data-density` on `<html>` and override the root variables `--row-h`, `--pad`, `--fs-num`, etc.

Color palette uses `oklch` and `color-mix(in oklab, ...)` — requires a modern browser (Chrome 111+, Firefox 113+, Safari 16.4+).

### Key data concepts

- **Footprint**: Each candle has a `footprint` array of `{px, bid, ask}` entries at every 0.25-tick price level within the candle's range.
- **Imbalance**: A cell is flagged `askImb`/`bidImb` when the dominant side / weaker side ratio ≥ adaptive threshold (mean + 1.2σ of all session ratios).
- **Stacked imbalance**: 3+ consecutive imbalance cells in the same direction.
- **Absorption**: High-volume candle with strong delta but tight body (body < 30% of range).
- **Unfinished auction**: Top/bottom footprint cell is ≥90% dominated by one side.
- **Tape tiers**: `sm` / `md` / `lg` / `inst` assigned by session percentiles (p55 / p85 / p97).

### Mock server (local dev)

`mock_server.py` fakes the full IronBeam HTTP + WebSocket API locally.

```bash
pip install aiohttp
python mock_server.py      # runs on http://localhost:8001
```

Then in `data-live.js` set `MOCK = true` (line 9) — the platform auto-connects with no credentials. Set it back to `false` for the real IronBeam feed. Bars close every 30 s in mock mode (vs 300 s in prod) so the chart fills up quickly.

### IronBeam connection

- **Connect button**: Small button in topbar-right. Toggles a credential panel (bottom-right, above statusbar). Platform is fully usable without connecting.
- **Symbol format**: `XCME:ESH6` — change the `SYMBOL` constant at the top of `data-live.js` when the contract rolls.
- **No historical bars**: IronBeam only streams real-time bars. Chart is empty on fresh connect and fills in as 5-min bars close.
- **Footprint source**: Trades stream (`tr` WS messages). Each trade is bucketed by price level into the current bar's footprint array; finalized when a new bar starts.
- **Debugging data flow**: Check DevTools Network → WS frames for `q`/`d`/`tr`/`ti` messages. Check console for `[OF]` prefixed errors. Verify `CustomEvent('of-data-update')` is firing with `document.addEventListener('of-data-update', console.log)` in the console.
