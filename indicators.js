/**
 * indicators.js — S & A Tier Orderflow Indicator Suite
 *
 * Implements every S and A tier indicator against the IronBeam WS data model.
 * Each indicator is a class with a consistent interface:
 *
 *   indicator.onTrade(trade)          — called for every trade in a `tr` message
 *   indicator.onBarClose(bar, fp)     — called when a bar closes; fp = FootprintBar
 *   indicator.onBarUpdate(bar, fp)    — called on live bar updates (every 3 ticks)
 *   indicator.onDOM(bids, asks)       — called on every `d` message
 *   indicator.signals                 — array of recent signals for renderer
 *   indicator.state                   — current computed state for renderer
 *
 * Wire up via IndicatorManager at the bottom of this file.
 *
 * Data shapes from mock_server.py v3:
 *   Trade:  { p, sz, td: 'BUY'|'SELL', st, is }
 *   Bar:    { t, o, h, l, c, v }
 *   Depth:  { l, p, sz, o, is }  (one entry per level)
 *   Quote:  { s, l, op, hi, lo, tv, b, a }
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK          = 0.25;
const MAX_SIGNALS   = 200;   // cap history per indicator
const snap = p => Math.round(Math.round(p / TICK) * TICK * 100) / 100;


// ═══════════════════════════════════════════════════════════════════════════════
// SHARED STATE — FootprintBar
//
// Accumulates all trades within one time bar into per-price-level bid/ask splits.
// All indicators consume FootprintBar rather than raw trade arrays.
// ═══════════════════════════════════════════════════════════════════════════════
class FootprintBar {
  constructor(barTs, openPx) {
    this.t          = barTs;
    this.o          = openPx;
    this.h          = openPx;
    this.l          = openPx;
    this.c          = openPx;
    this.v          = 0;
    this.delta      = 0;         // cumulative ask_vol - bid_vol
    this.cells      = new Map(); // snap(price) → { askVol, bidVol }
    this.trades     = [];        // raw trades for velocity calculations
    this.maxDelta   = 0;
    this.minDelta   = 0;
    this._runDelta  = 0;
  }

  addTrade(trade) {
    const { p, sz, td, st } = trade;
    const px  = snap(p);
    this.h    = Math.max(this.h, px);
    this.l    = Math.min(this.l, px);
    this.c    = px;
    this.v   += sz;
    this.trades.push({ px, sz, td, st });

    const cell = this.cells.get(px) ?? { askVol: 0, bidVol: 0 };
    if (td === 'BUY') { cell.askVol += sz; this._runDelta += sz; }
    else              { cell.bidVol += sz; this._runDelta -= sz; }
    this.cells.set(px, cell);

    this.delta    = this._runDelta;
    this.maxDelta = Math.max(this.maxDelta, this._runDelta);
    this.minDelta = Math.min(this.minDelta, this._runDelta);
  }

  // Body in ticks (close - open direction)
  get bodyTicks() {
    return Math.abs(snap(this.c - this.o)) / TICK;
  }

  // Candle range in ticks
  get rangeTicks() {
    return Math.abs(snap(this.h - this.l)) / TICK;
  }

  // Delta as % of total volume (0-1)
  get deltaPct() {
    return this.v > 0 ? Math.abs(this.delta) / this.v : 0;
  }

  // Dominant side delta as % of total volume (the "horizontal delta")
  get horizontalDeltaPct() {
    if (this.v === 0) return 0;
    let askTotal = 0, bidTotal = 0;
    for (const { askVol, bidVol } of this.cells.values()) {
      askTotal += askVol;
      bidTotal += bidVol;
    }
    return Math.max(askTotal, bidTotal) / this.v;
  }

  /**
   * Returns sorted price levels with diagonal imbalance data.
   * Standard footprint imbalance: askVol[P] vs bidVol[P + TICK]
   * (aggressive buying at P overwhelmed passive selling one tick above)
   *
   * Returns array of { px, askVol, bidVol, askImb, bidImb } sorted low→high
   */
  getImbalanceCells(threshold = 1.5) {
    const prices = Array.from(this.cells.keys()).sort((a, b) => a - b);
    return prices.map((px, i) => {
      const curr = this.cells.get(px);
      const above = this.cells.get(snap(px + TICK));
      const below = this.cells.get(snap(px - TICK));

      // Ask imbalance: curr ask vs above bid  (diagonal up)
      const askImb = above && above.bidVol > 0
        ? curr.askVol / above.bidVol
        : curr.askVol > 0 ? Infinity : 0;

      // Bid imbalance: curr bid vs below ask  (diagonal down)
      const bidImb = below && below.askVol > 0
        ? curr.bidVol / below.askVol
        : curr.bidVol > 0 ? Infinity : 0;

      return {
        px,
        askVol:  curr.askVol,
        bidVol:  curr.bidVol,
        delta:   curr.askVol - curr.bidVol,
        askImb,
        bidImb,
        hasAskImb: askImb >= threshold,
        hasBidImb: bidImb >= threshold,
      };
    });
  }

  /**
   * Count consecutive stacked imbalances in one direction.
   * Returns { maxAskStack, maxBidStack }
   */
  getStackedImbalanceCounts(threshold = 1.5) {
    const cells = this.getImbalanceCells(threshold);
    let maxAsk = 0, maxBid = 0, runAsk = 0, runBid = 0;
    for (const c of cells) {
      runAsk = c.hasAskImb ? runAsk + 1 : 0;
      runBid = c.hasBidImb ? runBid + 1 : 0;
      maxAsk = Math.max(maxAsk, runAsk);
      maxBid = Math.max(maxBid, runBid);
    }
    return { maxAskStack: maxAsk, maxBidStack: maxBid };
  }

  /**
   * POC — price with highest total volume in this bar
   */
  get poc() {
    let best = null, bestVol = 0;
    for (const [px, { askVol, bidVol }] of this.cells) {
      const total = askVol + bidVol;
      if (total > bestVol) { bestVol = total; best = px; }
    }
    return best;
  }

  /**
   * Inter-trade time deltas in ms — used for velocity calculations
   */
  get interTradeDeltas() {
    const ts = this.trades.map(t => t.st);
    const out = [];
    for (let i = 1; i < ts.length; i++) out.push(ts[i] - ts[i - 1]);
    return out;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SHARED STATE — CVDTracker
//
// Single session-level CVD maintained here; indicators READ from it.
// Reset on session open if needed.
// ═══════════════════════════════════════════════════════════════════════════════
class CVDTracker {
  constructor() {
    this.value    = 0;
    this.history  = []; // { t, open, high, low, close } — CVD bars per time bar
    this._barOpen = 0;
    this._barHigh = 0;
    this._barLow  = 0;
  }

  onTrade(trade) {
    const delta = trade.td === 'BUY' ? trade.sz : -trade.sz;
    this.value += delta;
    this._barHigh = Math.max(this._barHigh, this.value);
    this._barLow  = Math.min(this._barLow,  this.value);
  }

  onBarClose(bar) {
    this.history.push({
      t:     bar.t,
      open:  this._barOpen,
      high:  this._barHigh,
      low:   this._barLow,
      close: this.value,
    });
    if (this.history.length > 500) this.history.shift();
    this._barOpen = this.value;
    this._barHigh = this.value;
    this._barLow  = this.value;
  }

  get current() {
    return {
      t:     Date.now(),
      open:  this._barOpen,
      high:  this._barHigh,
      low:   this._barLow,
      close: this.value,
    };
  }

  reset() {
    this.value   = 0;
    this.history = [];
    this._barOpen = this._barHigh = this._barLow = 0;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SHARED STATE — SwingTracker
//
// Pivot-based swing high/low detector. lookback bars on each side required.
// Emits swings as { type: 'HIGH'|'LOW', px, t, barIdx, cvd }
// ═══════════════════════════════════════════════════════════════════════════════
class SwingTracker {
  constructor(lookback = 3) {
    this.lookback = lookback;
    this.bars     = [];         // ring buffer of closed bars
    this.cvdBars  = [];         // parallel CVD closes
    this.swings   = [];         // confirmed swings
  }

  onBarClose(bar, cvdClose) {
    this.bars.push(bar);
    this.cvdBars.push(cvdClose);
    if (this.bars.length < this.lookback * 2 + 1) return;

    const mid   = this.bars.length - this.lookback - 1;
    const pivot = this.bars[mid];
    const n     = this.lookback;

    // Pivot high: mid.high > all n bars on each side
    let isPivotHigh = true, isPivotLow = true;
    for (let i = mid - n; i <= mid + n; i++) {
      if (i === mid) continue;
      if (this.bars[i].h >= pivot.h) isPivotHigh = false;
      if (this.bars[i].l <= pivot.l) isPivotLow  = false;
    }

    if (isPivotHigh) {
      this.swings.push({ type: 'HIGH', px: pivot.h, t: pivot.t,
                         barIdx: mid, cvd: this.cvdBars[mid] });
    }
    if (isPivotLow) {
      this.swings.push({ type: 'LOW',  px: pivot.l, t: pivot.t,
                         barIdx: mid, cvd: this.cvdBars[mid] });
    }
    if (this.swings.length > 100) this.swings.shift();
  }

  lastHigh() { return [...this.swings].reverse().find(s => s.type === 'HIGH') ?? null; }
  lastLow()  { return [...this.swings].reverse().find(s => s.type === 'LOW')  ?? null; }
  last2Highs() {
    const highs = [...this.swings].filter(s => s.type === 'HIGH');
    return highs.slice(-2);
  }
  last2Lows() {
    const lows = [...this.swings].filter(s => s.type === 'LOW');
    return lows.slice(-2);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// S TIER — 1. DEEP TRADES
//
// Reconstructs institutional-scale prints by aggregating consecutive trades
// at the same price within a configurable time window.
// Detects absorption when large prints accumulate at a level but price stalls.
//
// Signal types:
//   BLOCK_PRINT  — aggregated print >= blockThreshold contracts
//   ABSORPTION   — >= absorptionMinPrints large prints at same level, price
//                  moved < absorptionMaxTicks away after
// ═══════════════════════════════════════════════════════════════════════════════
class DeepTrades {
  constructor(opts = {}) {
    this.aggregateWindowMs   = opts.aggregateWindowMs   ?? 500;
    this.blockThreshold      = opts.blockThreshold      ?? 25;
    this.absorptionMinPrints = opts.absorptionMinPrints ?? 3;
    this.absorptionMaxTicks  = opts.absorptionMaxTicks  ?? 2;

    this._pending = [];    // trades accumulating in current window
    this._windowEnd = 0;
    this.megaPrints = [];  // { px, sz, side, ts, isAbsorption }
    this.signals = [];
    this.state = { recentBlocks: [], absorptionLevels: new Map() };
  }

  onTrade(trade) {
    const now = trade.st;

    // Start new aggregation window if expired
    if (now > this._windowEnd || this._pending.length === 0) {
      this._flush();
      this._windowEnd = now + this.aggregateWindowMs;
    }

    // Only aggregate same-price, same-side trades within the window
    const lastPending = this._pending[this._pending.length - 1];
    if (lastPending && lastPending.px === snap(trade.p) && lastPending.side === trade.td) {
      lastPending.sz += trade.sz;
      lastPending.ts  = now;
    } else {
      this._flush();
      this._pending.push({ px: snap(trade.p), sz: trade.sz, side: trade.td, ts: now });
    }
  }

  _flush() {
    for (const agg of this._pending) {
      if (agg.sz >= this.blockThreshold) {
        // Track per-level absorption state
        const key = `${agg.px}`;
        const lvl = this.state.absorptionLevels.get(key) ?? { prints: 0, totalSz: 0, firstPx: agg.px };
        lvl.prints++;
        lvl.totalSz += agg.sz;
        this.state.absorptionLevels.set(key, lvl);

        const isAbsorption = lvl.prints >= this.absorptionMinPrints;
        const print = { px: agg.px, sz: agg.sz, side: agg.side, ts: agg.ts, isAbsorption };
        this.megaPrints.push(print);
        if (this.megaPrints.length > MAX_SIGNALS) this.megaPrints.shift();

        this._emit(isAbsorption ? 'ABSORPTION' : 'BLOCK_PRINT', print);
      }
    }
    this._pending = [];
  }

  // Price moving away clears absorption tracking for that level
  onBarUpdate(_bar, fp) {
    const px = fp.c;
    for (const [key, lvl] of this.state.absorptionLevels) {
      const ticksAway = Math.abs(snap(px - lvl.firstPx)) / TICK;
      if (ticksAway > this.absorptionMaxTicks) {
        this.state.absorptionLevels.delete(key);
      }
    }
  }

  onBarClose() { this._flush(); }
  onDOM() {}

  _emit(type, data) {
    this.signals.push({ type, ts: data.ts, data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// S TIER — 2. DEEP WALL
//
// Detects iceberg / passive walls by watching whether price repeatedly attempts
// to clear a level but gets absorbed back.
//
// Detection logic:
//   1. Volume at a specific price level within current bar >= wallVolumeThreshold
//   2. Price has touched that level >= wallTouchCount times
//   3. Price has NOT moved past that level by > wallBreakTicks
//   4. DOM shows consistent large size at that level (≥ domMinSize) across
//      consecutive DOM snapshots (≥ domSnapshots)
//
// Signal: WALL_DETECTED  — {px, side, totalVol, touchCount, domConfirmed}
//         WALL_BROKEN    — {px, side} when price finally clears
// ═══════════════════════════════════════════════════════════════════════════════
class DeepWall {
  constructor(opts = {}) {
    this.wallVolumeThreshold = opts.wallVolumeThreshold ?? 120;
    this.wallTouchCount      = opts.wallTouchCount      ?? 3;
    this.wallBreakTicks      = opts.wallBreakTicks      ?? 2;
    this.domMinSize          = opts.domMinSize          ?? 150;
    this.domSnapshots        = opts.domSnapshots        ?? 4;

    // Per-level tracking: px → { vol, touches, domCount, side, alerted }
    this._levels  = new Map();
    this._domSnap = new Map();  // px → consecutive snapshot count with large size
    this.walls    = [];         // active detected walls
    this.signals  = [];
    this.state    = { activeWalls: [] };
  }

  onTrade(trade) {
    const px = snap(trade.p);
    const lvl = this._levels.get(px) ?? { vol: 0, touches: 0, side: trade.td, alerted: false };
    lvl.vol    += trade.sz;
    lvl.touches += 1;
    lvl.side    = trade.td === 'BUY' ? 'ASK' : 'BID';  // BUY hits ask wall, SELL hits bid wall
    this._levels.set(px, lvl);

    if (!lvl.alerted && lvl.touches >= this.wallTouchCount && lvl.vol >= this.wallVolumeThreshold) {
      const domCount = this._domSnap.get(px) ?? 0;
      const domOk    = domCount >= this.domSnapshots;
      lvl.alerted = true;
      const wall = { px, side: lvl.side, totalVol: lvl.vol, touchCount: lvl.touches, domConfirmed: domOk };
      this.walls.push(wall);
      this.state.activeWalls = [...this.walls];
      this._emit('WALL_DETECTED', wall);
    }
  }

  onDOM(bids, asks) {
    // Track how many consecutive snapshots each level has maintained large size
    const allLevels = [...bids, ...asks];
    const largePrices = new Set();
    for (const lvl of allLevels) {
      if (lvl.sz >= this.domMinSize) largePrices.add(snap(lvl.p));
    }
    // Increment snapshot count for large levels, reset for others
    for (const [px, count] of this._domSnap) {
      this._domSnap.set(px, largePrices.has(px) ? count + 1 : 0);
    }
    for (const px of largePrices) {
      if (!this._domSnap.has(px)) this._domSnap.set(px, 1);
    }
  }

  onBarClose(_bar, fp) {
    const currentPx = fp.c;
    // Check if any active walls have been broken
    this.walls = this.walls.filter(wall => {
      const ticksThrough = (wall.side === 'ASK')
        ? (currentPx - wall.px) / TICK    // price moved above ask wall
        : (wall.px  - currentPx) / TICK;  // price moved below bid wall
      if (ticksThrough >= this.wallBreakTicks) {
        this._emit('WALL_BROKEN', { px: wall.px, side: wall.side });
        this._levels.delete(wall.px);
        return false;
      }
      return true;
    });
    this.state.activeWalls = [...this.walls];
  }

  onBarUpdate() {}

  _emit(type, data) {
    this.signals.push({ type, ts: Date.now(), data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// S TIER — 3. UNFINISHED AUCTION
//
// A "finished" high has 0 bid volume (no sellers hit) at the top tick.
// A "finished" low has 0 ask volume (no buyers hit) at the bottom tick.
// When both sides transact at the extreme, the auction is "unfinished" and
// price has a statistical tendency to return and complete it.
//
// Signal: UNFINISHED_HIGH — {px, ts, bidVolAtHigh, askVolAtHigh}
//         UNFINISHED_LOW  — {px, ts, bidVolAtLow,  askVolAtLow}
//         AUCTION_RESOLVED — {px} when price returns to the level
// ═══════════════════════════════════════════════════════════════════════════════
class UnfinishedAuction {
  constructor() {
    this.openLevels = [];  // active unresolved auction levels
    this.signals    = [];
    this.state      = { openLevels: [] };
  }

  onBarClose(_bar, fp) {
    const highCell = fp.cells.get(fp.h);
    const lowCell  = fp.cells.get(fp.l);

    // Unfinished HIGH: aggressive sellers (bid vol) present at the top tick
    if (highCell && highCell.bidVol > 0) {
      const level = {
        type:    'HIGH',
        px:      fp.h,
        ts:      fp.t,
        bidVol:  highCell.bidVol,
        askVol:  highCell.askVol,
      };
      this.openLevels.push(level);
      this._emit('UNFINISHED_HIGH', level);
    }

    // Unfinished LOW: aggressive buyers (ask vol) present at the bottom tick
    if (lowCell && lowCell.askVol > 0) {
      const level = {
        type:   'LOW',
        px:     fp.l,
        ts:     fp.t,
        bidVol: lowCell.bidVol,
        askVol: lowCell.askVol,
      };
      this.openLevels.push(level);
      this._emit('UNFINISHED_LOW', level);
    }

    // Resolve levels that price has returned to
    this._resolveAt(fp.h, fp.l);
  }

  onBarUpdate(_bar, fp) {
    this._resolveAt(fp.h, fp.l);
  }

  _resolveAt(high, low) {
    this.openLevels = this.openLevels.filter(lvl => {
      const hit = (lvl.type === 'HIGH' && high >= lvl.px) ||
                  (lvl.type === 'LOW'  && low  <= lvl.px);
      if (hit) this._emit('AUCTION_RESOLVED', { px: lvl.px, type: lvl.type });
      return !hit;
    });
    this.state.openLevels = [...this.openLevels];
  }

  onTrade() {}
  onDOM()   {}

  _emit(type, data) {
    this.signals.push({ type, ts: Date.now(), data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// S TIER — 4. SHIFT CANDLE
//
// Detects meaningful delta reversals at swing extremes, with stacked imbalance
// confirmation. All six conditions must pass.
//
// Conditions (evaluated at bar close):
//   1. Delta sign flips relative to previous bar
//   2. Absolute delta change >= minDeltaPct * bar_volume (default 15%)
//   3. Absolute delta change >= minDeltaAbs (default 80)
//   4. Bar forms within swingProximityBars of a confirmed swing high/low
//   5. Bar POC within pocMaxTicks of the swing level
//   6. Stacked imbalances >= minStackCount consecutive (default 2) at threshold
//
// Signal: SHIFT_BUY  — delta reversal to upside at swing low
//         SHIFT_SELL — delta reversal to downside at swing high
// ═══════════════════════════════════════════════════════════════════════════════
class ShiftCandle {
  constructor(swingTracker, opts = {}) {
    this.swings            = swingTracker;
    this.minDeltaPct       = opts.minDeltaPct       ?? 0.15;
    this.minDeltaAbs       = opts.minDeltaAbs       ?? 80;
    this.swingProximityBars= opts.swingProximityBars?? 5;
    this.pocMaxTicks       = opts.pocMaxTicks       ?? 4;
    this.minStackCount     = opts.minStackCount     ?? 2;
    this.imbThreshold      = opts.imbThreshold      ?? 1.5;

    this._prevBar = null;
    this._prevFp  = null;
    this._barCount = 0;
    this.signals  = [];
    this.state    = { lastSignal: null };
  }

  onBarClose(bar, fp) {
    this._barCount++;
    const prev = this._prevFp;

    if (prev) {
      const prevDelta = prev.delta;
      const currDelta = fp.delta;

      // Condition 1: delta sign flip
      const signFlip = Math.sign(prevDelta) !== 0 && Math.sign(currDelta) !== 0
                       && Math.sign(prevDelta) !== Math.sign(currDelta);

      if (signFlip) {
        const deltaDiff  = Math.abs(currDelta - prevDelta);
        const pctOk      = fp.v > 0 && (deltaDiff / fp.v) >= this.minDeltaPct;
        const absOk      = deltaDiff >= this.minDeltaAbs;

        // Condition 4: near a swing
        const lastHigh  = this.swings.lastHigh();
        const lastLow   = this.swings.lastLow();
        const nearHigh  = lastHigh && (this._barCount - (lastHigh.barIdx ?? this._barCount)) <= this.swingProximityBars;
        const nearLow   = lastLow  && (this._barCount - (lastLow.barIdx  ?? this._barCount)) <= this.swingProximityBars;
        const nearSwing = nearHigh || nearLow;

        // Condition 5: POC proximity to swing level
        const poc         = fp.poc;
        const swingLevel  = currDelta > 0 ? lastLow?.px : lastHigh?.px;
        const pocOk       = poc != null && swingLevel != null
                            && (Math.abs(snap(poc - swingLevel)) / TICK) <= this.pocMaxTicks;

        // Condition 6: stacked imbalances
        const { maxAskStack, maxBidStack } = fp.getStackedImbalanceCounts(this.imbThreshold);
        const imbOk = currDelta > 0
          ? maxAskStack >= this.minStackCount
          : maxBidStack >= this.minStackCount;

        if (pctOk && absOk && nearSwing && pocOk && imbOk) {
          const side = currDelta > 0 ? 'SHIFT_BUY' : 'SHIFT_SELL';
          const sig  = { type: side, px: fp.c, ts: bar.t, delta: currDelta,
                         deltaDiff, poc, stackCount: currDelta > 0 ? maxAskStack : maxBidStack };
          this.signals.push(sig);
          this.state.lastSignal = sig;
          if (this.signals.length > MAX_SIGNALS) this.signals.shift();
        }
      }
    }

    this._prevFp  = fp;
    this._prevBar = bar;
  }

  onTrade()     {}
  onBarUpdate() {}
  onDOM()       {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// S TIER — 5. IMBALANCE TRACKER
//
// Builds a live map of diagonal footprint imbalances and categorises each as:
//   FRESH    — imbalance zone that price has not yet returned to
//   TRIGGERED — zone that price has touched (may act as support/resistance)
//
// Zones are drawn as horizontal rectangles extending right from their bar.
// ═══════════════════════════════════════════════════════════════════════════════
class ImbalanceTracker {
  constructor(opts = {}) {
    this.threshold  = opts.threshold  ?? 1.5;   // imbalance ratio
    this.minVol     = opts.minVol     ?? 0;      // min volume in cell to qualify

    this.freshZones     = [];  // { px, side, ratio, ts }
    this.triggeredZones = [];
    this.signals  = [];
    this.state    = { freshZones: [], triggeredZones: [] };
  }

  onBarClose(_bar, fp) {
    const cells = fp.getImbalanceCells(this.threshold);
    const ts    = fp.t;

    for (const c of cells) {
      const vol = c.askVol + c.bidVol;
      if (vol < this.minVol) continue;

      if (c.hasAskImb) {
        this.freshZones.push({ px: c.px, side: 'ASK', ratio: c.askImb, ts });
      }
      if (c.hasBidImb) {
        this.freshZones.push({ px: c.px, side: 'BID', ratio: c.bidImb, ts });
      }
    }

    this.state.freshZones     = [...this.freshZones];
    this.state.triggeredZones = [...this.triggeredZones];
  }

  onBarUpdate(_bar, fp) {
    this._checkTriggers(fp.h, fp.l);
  }

  _checkTriggers(high, low) {
    const stillFresh = [];
    for (const zone of this.freshZones) {
      const hit = (zone.side === 'ASK' && high >= zone.px) ||
                  (zone.side === 'BID' && low  <= zone.px);
      if (hit) {
        zone.triggeredAt = Date.now();
        this.triggeredZones.push(zone);
        this._emit('ZONE_TRIGGERED', zone);
      } else {
        stillFresh.push(zone);
      }
    }
    this.freshZones           = stillFresh;
    this.state.freshZones     = [...this.freshZones];
    this.state.triggeredZones = [...this.triggeredZones];
  }

  onTrade() {}
  onDOM()   {}

  _emit(type, data) {
    this.signals.push({ type, ts: Date.now(), data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 6. DEEP V-TRACKER
//
// Two independent modules:
//
//   MODULE A — PATTERNS (trade velocity anomalies within bar formation)
//     ACCELERATION  Sudden compression of inter-trade intervals — institutional
//                   aggression entering. Most reliable signal; enable this only.
//     EXHAUSTION    Velocity drops AND price stops moving — energy drained.
//     SLOWDOWN      Pace of price movement (ticks/time) decelerating.
//
//   MODULE B — ABSORPTION & PRESSURE
//     PRESSURE      Large vol at a level + price moves through it.
//     ABSORPTION    Large vol at a level + price stalls (< stallTicks movement).
// ═══════════════════════════════════════════════════════════════════════════════
class DeepVTracker {
  constructor(opts = {}) {
    // Module A config
    this.accelMinTrades    = opts.accelMinTrades    ?? 8;    // min trades to evaluate
    this.accelRatioThresh  = opts.accelRatioThresh  ?? 0.40; // ratio new_mean / old_mean
    this.exhaustThresh     = opts.exhaustThresh     ?? 2.5;  // decel ratio
    this.slowdownTicks     = opts.slowdownTicks     ?? 2;    // max price movement

    // Module B config
    this.pressureMinVol    = opts.pressureMinVol    ?? 60;
    this.absorptionMinVol  = opts.absorptionMinVol  ?? 80;
    this.stallTicks        = opts.stallTicks        ?? 1;

    // Enable/disable per signal type
    this.enableAcceleration= opts.enableAcceleration ?? true;
    this.enableExhaustion  = opts.enableExhaustion   ?? false;  // noisy, off by default
    this.enableSlowdown    = opts.enableSlowdown     ?? false;
    this.enablePressure    = opts.enablePressure     ?? true;
    this.enableAbsorption  = opts.enableAbsorption   ?? true;

    this._levelVolume = new Map();  // px → { vol, priceAtEntry }
    this.signals  = [];
    this.state    = { velocityLevel: 0, pressureZones: [], absorptionZones: [] };
  }

  onTrade(trade) {
    // Module B: track volume accumulation at levels
    const px  = snap(trade.p);
    const lvl = this._levelVolume.get(px) ?? { vol: 0, priceAtEntry: px, side: trade.td };
    lvl.vol += trade.sz;
    this._levelVolume.set(px, lvl);
  }

  onBarUpdate(bar, fp) {
    // Module A: velocity analysis on live bar
    const deltas = fp.interTradeDeltas;
    if (deltas.length >= this.accelMinTrades) {
      const half    = Math.floor(deltas.length / 2);
      const oldMean = deltas.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const newMean = deltas.slice(-half).reduce((a, b) => a + b, 0) / half;

      if (oldMean > 0) {
        const ratio = newMean / oldMean;
        this.state.velocityLevel = Math.min(1, 1 - ratio); // 1 = max acceleration

        if (this.enableAcceleration && ratio <= this.accelRatioThresh) {
          this._emit('ACCELERATION', {
            px: fp.c, ts: Date.now(),
            side: fp.delta > 0 ? 'BUY' : 'SELL',
            ratio, oldMean, newMean,
          });
        }
        if (this.enableExhaustion && ratio >= this.exhaustThresh) {
          this._emit('EXHAUSTION', { px: fp.c, ts: Date.now(), ratio });
        }
        if (this.enableSlowdown) {
          const rangeTicks = fp.rangeTicks;
          if (rangeTicks <= this.slowdownTicks && fp.v > 50) {
            this._emit('SLOWDOWN', { px: fp.c, ts: Date.now(), rangeTicks, vol: fp.v });
          }
        }
      }
    }

    // Module B: evaluate accumulated levels
    if (this.enablePressure || this.enableAbsorption) {
      const currentPx = fp.c;
      for (const [px, lvl] of this._levelVolume) {
        const ticksMoved = Math.abs(snap(currentPx - px)) / TICK;
        if (lvl.vol >= this.pressureMinVol && ticksMoved > this.stallTicks && this.enablePressure) {
          this._emit('PRESSURE', { px, vol: lvl.vol, side: lvl.side, ts: Date.now() });
          this._levelVolume.delete(px);
        } else if (lvl.vol >= this.absorptionMinVol && ticksMoved <= this.stallTicks && this.enableAbsorption) {
          this._emit('ABSORPTION', { px, vol: lvl.vol, side: lvl.side, ts: Date.now() });
          this._levelVolume.delete(px);
        }
      }
    }
  }

  onBarClose(_bar, _fp) {
    this._levelVolume.clear();  // reset per-level volume each bar
  }

  onDOM() {}

  _emit(type, data) {
    this.signals.push({ type, ts: data.ts, data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 7. VOLUME PROFILE + DEEP PROFILE SWING
//
// Two modes:
//   SESSION   — accumulates all volume since session start into price buckets
//   SWING     — builds a fresh profile for each new swing range detected by
//               SwingTracker. Auto-plots on the chart between swing pivots.
//
// Output per profile: { priceMin, priceMax, buckets, poc, vaHigh, vaLow }
// Value Area = 70% of total volume centred on POC
// ═══════════════════════════════════════════════════════════════════════════════
class VolumeProfile {
  constructor(swingTracker, opts = {}) {
    this.swings      = swingTracker;
    this.valueAreaPct= opts.valueAreaPct ?? 0.70;

    // Session profile
    this._sessionBuckets = new Map();  // snap(px) → { vol, bidVol, askVol }

    // Swing profiles
    this._currentSwingBuckets = new Map();
    this._currentSwingRange   = null;
    this.swingProfiles        = [];  // historical completed swing profiles

    this.state = { session: null, currentSwing: null, swingProfiles: [] };
  }

  onTrade(trade) {
    const px = snap(trade.p);
    const s  = this._sessionBuckets.get(px) ?? { vol: 0, bidVol: 0, askVol: 0 };
    s.vol    += trade.sz;
    trade.td === 'BUY' ? (s.askVol += trade.sz) : (s.bidVol += trade.sz);
    this._sessionBuckets.set(px, s);

    const sw = this._currentSwingBuckets.get(px) ?? { vol: 0, bidVol: 0, askVol: 0 };
    sw.vol    += trade.sz;
    trade.td === 'BUY' ? (sw.askVol += trade.sz) : (sw.bidVol += trade.sz);
    this._currentSwingBuckets.set(px, sw);
  }

  onBarClose(bar, _fp) {
    // Check if a new swing has been confirmed; if so, save and start fresh profile
    const lastSwing = this.swings.swings[this.swings.swings.length - 1];
    if (lastSwing && lastSwing.t === bar.t && this._currentSwingBuckets.size > 0) {
      const profile = this._buildProfile(this._currentSwingBuckets, this._currentSwingRange);
      this.swingProfiles.push(profile);
      if (this.swingProfiles.length > 20) this.swingProfiles.shift();
      this._currentSwingBuckets = new Map();
      this._currentSwingRange   = { start: bar.t, high: bar.h, low: bar.l };
    } else if (!this._currentSwingRange) {
      this._currentSwingRange = { start: bar.t, high: bar.h, low: bar.l };
    } else {
      this._currentSwingRange.high = Math.max(this._currentSwingRange.high, bar.h);
      this._currentSwingRange.low  = Math.min(this._currentSwingRange.low,  bar.l);
    }

    this.state.session      = this._buildProfile(this._sessionBuckets, null);
    this.state.currentSwing = this._buildProfile(this._currentSwingBuckets, this._currentSwingRange);
    this.state.swingProfiles= [...this.swingProfiles];
  }

  _buildProfile(buckets, range) {
    if (buckets.size === 0) return null;
    const sorted = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
    const totalVol = sorted.reduce((s, [, b]) => s + b.vol, 0);

    // POC
    let poc = sorted[0][0], pocVol = 0;
    for (const [px, b] of sorted) {
      if (b.vol > pocVol) { pocVol = b.vol; poc = px; }
    }

    // Value Area: expand from POC until 70% of volume is included
    const target = totalVol * this.valueAreaPct;
    const pocIdx = sorted.findIndex(([px]) => px === poc);
    let lo = pocIdx, hi = pocIdx, included = sorted[pocIdx]?.[1]?.vol ?? 0;

    while (included < target && (lo > 0 || hi < sorted.length - 1)) {
      const loNext = lo > 0                ? sorted[lo - 1][1].vol : -Infinity;
      const hiNext = hi < sorted.length - 1? sorted[hi + 1][1].vol : -Infinity;
      if (loNext >= hiNext) { lo--; included += sorted[lo][1].vol; }
      else                  { hi++; included += sorted[hi][1].vol; }
    }

    return {
      buckets:  sorted.map(([px, b]) => ({ px, ...b })),
      poc,
      pocVol,
      vaLow:    sorted[lo]?.[0] ?? poc,
      vaHigh:   sorted[hi]?.[0] ?? poc,
      totalVol,
      range,
    };
  }

  onBarUpdate() {}
  onDOM()       {}
  get signals() { return []; }
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 8. DELTA CUMULATIVE (HISTOGRAM + CANDLESTICK)
//
// Thin wrapper around CVDTracker to expose both render modes.
// Histogram: bar per time period showing delta as +/- bar height
// Candlestick: each bar is OHLC of the CVD value during that period
//
// The renderer chooses mode; this exposes both via state.
// ═══════════════════════════════════════════════════════════════════════════════
class DeltaCumulative {
  constructor(cvdTracker) {
    this.cvd     = cvdTracker;
    this.signals = [];
    this.state   = {
      // For histogram: just the history of delta per bar (close - open)
      histogram: [],
      // For candlestick: OHLC CVD bars
      candlestick: [],
      // Live (current incomplete bar)
      live: null,
    };
  }

  onTrade(trade) {
    this.cvd.onTrade(trade);
    this.state.live = this.cvd.current;
  }

  onBarClose(bar, _fp) {
    this.cvd.onBarClose(bar);
    const last = this.cvd.history[this.cvd.history.length - 1];
    if (last) {
      this.state.histogram.push({ t: last.t, delta: last.close - last.open, close: last.close });
      this.state.candlestick.push({ ...last });
    }
    if (this.state.histogram.length   > 500) this.state.histogram.shift();
    if (this.state.candlestick.length > 500) this.state.candlestick.shift();
    this.state.live = this.cvd.current;
  }

  onBarUpdate() {
    this.state.live = this.cvd.current;
  }

  onDOM() {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 9. STOP SPOTTER
//
// All six mechanical conditions evaluated at bar close (or 59s mark if you have
// a per-second tick — in practice, fire on bar close and apply the criteria).
//
// Conditions:
//   1. abs(delta) / volume >= 0.25            (minimum delta %)
//   2. volume >= 1000
//   3. volume - preceding_low_avg >= 500      (volume surge)
//   4. bodyTicks >= 6
//   5. horizontalDeltaPct >= 0.60
//   6. maxAskStack >= 2 OR maxBidStack >= 2   (stacked imbalances at 150%)
//
// Discretionary context (flagged in signal, not enforced):
//   - Prefer at swing extremes (uses SwingTracker)
//   - Prefer low-volume windows
//
// NOTE: Dan's testing showed this doesn't perform well in practice. Code it
// accurately anyway — it may be useful as a component in DeepPatternBuilder.
// ═══════════════════════════════════════════════════════════════════════════════
class StopSpotter {
  constructor(swingTracker, opts = {}) {
    this.swings        = swingTracker;
    this.minDeltaPct   = opts.minDeltaPct   ?? 0.25;
    this.minVolume     = opts.minVolume     ?? 1000;
    this.minVolSurge   = opts.minVolSurge   ?? 500;
    this.minBodyTicks  = opts.minBodyTicks  ?? 6;
    this.minHorizDelta = opts.minHorizDelta ?? 0.60;
    this.minImbStack   = opts.minImbStack   ?? 2;
    this.imbThreshold  = opts.imbThreshold  ?? 1.5;

    // Rolling window to measure "preceding low-liquidity" baseline volume
    this._recentBarVols = [];
    this._lowVolWindow  = opts.lowVolWindow ?? 5;  // bars to average for baseline

    this.signals = [];
    this.state   = { lastSignal: null };
  }

  onBarClose(_bar, fp) {
    // Build baseline from recent bars
    const baselineAvg = this._recentBarVols.length > 0
      ? this._recentBarVols.reduce((a, b) => a + b, 0) / this._recentBarVols.length
      : 0;

    const { maxAskStack, maxBidStack } = fp.getStackedImbalanceCounts(this.imbThreshold);

    const c1 = fp.deltaPct         >= this.minDeltaPct;
    const c2 = fp.v                >= this.minVolume;
    const c3 = fp.v - baselineAvg  >= this.minVolSurge;
    const c4 = fp.bodyTicks        >= this.minBodyTicks;
    const c5 = fp.horizontalDeltaPct >= this.minHorizDelta;
    const c6 = Math.max(maxAskStack, maxBidStack) >= this.minImbStack;

    const allMet = c1 && c2 && c3 && c4 && c5 && c6;

    // Discretionary context flags (informational only)
    const lastHigh = this.swings.lastHigh();
    const lastLow  = this.swings.lastLow();
    const atSwingExtreme = (lastHigh && Math.abs(fp.h - lastHigh.px) / TICK <= 4) ||
                           (lastLow  && Math.abs(fp.l - lastLow.px)  / TICK <= 4);
    const lowLiqEnv = baselineAvg < 400;  // rough proxy for low liquidity

    if (allMet) {
      const side = fp.delta > 0 ? 'BUY_STOP_RUN' : 'SELL_STOP_RUN';
      const sig  = {
        type: side, px: fp.c, ts: fp.t,
        volume: fp.v, delta: fp.delta, deltaPct: fp.deltaPct,
        bodyTicks: fp.bodyTicks, horizDelta: fp.horizontalDeltaPct,
        maxAskStack, maxBidStack,
        atSwingExtreme, lowLiqEnv,
        conditions: { c1, c2, c3, c4, c5, c6 },
      };
      this.signals.push(sig);
      this.state.lastSignal = sig;
      if (this.signals.length > MAX_SIGNALS) this.signals.shift();
    }

    this._recentBarVols.push(fp.v);
    if (this._recentBarVols.length > this._lowVolWindow) this._recentBarVols.shift();
  }

  onTrade()     {}
  onBarUpdate() {}
  onDOM()       {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 10. SPEED OF TAPE (INSTANT)
//
// Measures instantaneous trade velocity within a rolling time window.
// Compare to a longer baseline to produce a normalised intensity score (0-1+).
//
// state.intensity  — current intensity (>1 = faster than baseline)
// state.history    — [{t, intensity, volumeRate, tradeRate}, ...]
// ═══════════════════════════════════════════════════════════════════════════════
class SpeedOfTapeInstant {
  constructor(opts = {}) {
    this.windowMs    = opts.windowMs    ?? 5_000;   // measurement window
    this.baselineMs  = opts.baselineMs  ?? 60_000;  // baseline for normalisation
    this.alertThresh = opts.alertThresh ?? 3.0;     // intensity ratio for alert

    this._trades     = [];   // { st, sz }
    this.signals     = [];
    this.state       = { intensity: 0, volumeRate: 0, tradeRate: 0, history: [] };
  }

  onTrade(trade) {
    const now = trade.st;
    this._trades.push({ st: now, sz: trade.sz });

    // Prune anything older than baseline window
    const cutoff = now - this.baselineMs;
    while (this._trades.length > 0 && this._trades[0].st < cutoff) this._trades.shift();

    // Current window stats
    const winCutoff  = now - this.windowMs;
    const window     = this._trades.filter(t => t.st >= winCutoff);
    const baseWindow = this._trades;  // full baseline set

    const winVol   = window.reduce((s, t) => s + t.sz, 0);
    const winCount = window.length;

    const baseVol   = baseWindow.reduce((s, t) => s + t.sz, 0);
    const baseCount = baseWindow.length;

    // Rates normalised to per-second
    const windowSec   = this.windowMs   / 1000;
    const baselineSec = Math.min(this.baselineMs, now - (this._trades[0]?.st ?? now)) / 1000;

    const currentVolumeRate  = winVol   / windowSec;
    const currentTradeRate   = winCount / windowSec;
    const baselineVolumeRate = baselineSec > 0 ? baseVol / baselineSec : 1;

    const intensity = baselineVolumeRate > 0 ? currentVolumeRate / baselineVolumeRate : 0;

    this.state.intensity   = intensity;
    this.state.volumeRate  = currentVolumeRate;
    this.state.tradeRate   = currentTradeRate;
    this.state.history.push({ t: now, intensity, volumeRate: currentVolumeRate, tradeRate: currentTradeRate });
    if (this.state.history.length > 1000) this.state.history.shift();

    if (intensity >= this.alertThresh) {
      this._emit('TAPE_SPIKE', {
        intensity, volumeRate: currentVolumeRate, tradeRate: currentTradeRate, ts: now,
      });
    }
  }

  onBarClose()  {}
  onBarUpdate() {}
  onDOM()       {}

  _emit(type, data) {
    this.signals.push({ type, ts: data.ts, data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 11. DIVERGENCE DETECTOR
//
// Identifies volume divergence and delta divergence at confirmed swing points.
//
// Volume divergence:    price makes a new HH/LL but bar volume is lower.
// Delta divergence:     price makes a new HH/LL but CVD doesn't confirm.
// VDD (both together):  highest conviction, emit only when both diverge.
//
// Only evaluates when SwingTracker confirms a new pivot — prevents whipsawing.
// ═══════════════════════════════════════════════════════════════════════════════
class DivergenceDetector {
  constructor(swingTracker, cvdTracker, opts = {}) {
    this.swings = swingTracker;
    this.cvd    = cvdTracker;
    this.mode   = opts.mode ?? 'VDD'; // 'VD' | 'DD' | 'VDD'

    this._barVolumes = [];  // { t, v }
    this._lastProcessedSwingCount = 0;

    this.signals = [];
    this.state   = { divergences: [] };
  }

  onBarClose(bar, fp) {
    this._barVolumes.push({ t: bar.t, v: fp.v });
    if (this._barVolumes.length > 200) this._barVolumes.shift();

    // Only proceed if a new swing has been confirmed since last check
    const currentSwingCount = this.swings.swings.length;
    if (currentSwingCount <= this._lastProcessedSwingCount) return;
    this._lastProcessedSwingCount = currentSwingCount;

    const newSwing = this.swings.swings[this.swings.swings.length - 1];

    if (newSwing.type === 'HIGH') {
      const prevHighs = this.swings.last2Highs();
      if (prevHighs.length < 2) return;
      const [prev, curr] = prevHighs;

      // Price: higher high (curr.px > prev.px)
      const pxHigherHigh = curr.px > prev.px;
      if (!pxHigherHigh) return;

      // Volume at current swing vs previous swing
      const currBarVol = this._barVolumes.find(b => b.t === curr.t)?.v ?? 0;
      const prevBarVol = this._barVolumes.find(b => b.t === prev.t)?.v ?? 0;
      const volDivergence = currBarVol < prevBarVol;

      // CVD: not making a higher high at this swing
      const currCvd = this.cvd.history.find(h => h.t === curr.t)?.close ?? this.cvd.value;
      const prevCvd = this.cvd.history.find(h => h.t === prev.t)?.close ?? 0;
      const deltaDivergence = currCvd <= prevCvd;

      const shouldEmit = this.mode === 'VDD' ? (volDivergence && deltaDivergence)
                       : this.mode === 'VD'  ? volDivergence
                       :                       deltaDivergence;

      if (shouldEmit) {
        this._emit('BEARISH_DIVERGENCE', {
          type: this.mode, px: curr.px, ts: curr.t,
          prevPx: prev.px, currBarVol, prevBarVol, currCvd, prevCvd,
        });
      }

    } else if (newSwing.type === 'LOW') {
      const prevLows = this.swings.last2Lows();
      if (prevLows.length < 2) return;
      const [prev, curr] = prevLows;

      const pxLowerLow = curr.px < prev.px;
      if (!pxLowerLow) return;

      const currBarVol = this._barVolumes.find(b => b.t === curr.t)?.v ?? 0;
      const prevBarVol = this._barVolumes.find(b => b.t === prev.t)?.v ?? 0;
      const volDivergence = currBarVol < prevBarVol;

      const currCvd = this.cvd.history.find(h => h.t === curr.t)?.close ?? this.cvd.value;
      const prevCvd = this.cvd.history.find(h => h.t === prev.t)?.close ?? 0;
      const deltaDivergence = currCvd >= prevCvd;  // CVD not confirming lower low

      const shouldEmit = this.mode === 'VDD' ? (volDivergence && deltaDivergence)
                       : this.mode === 'VD'  ? volDivergence
                       :                       deltaDivergence;

      if (shouldEmit) {
        this._emit('BULLISH_DIVERGENCE', {
          type: this.mode, px: curr.px, ts: curr.t,
          prevPx: prev.px, currBarVol, prevBarVol, currCvd, prevCvd,
        });
      }
    }
  }

  onTrade()     {}
  onBarUpdate() {}
  onDOM()       {}

  _emit(type, data) {
    this.signals.push({ type, ts: data.ts, data });
    this.state.divergences.push({ type, ...data });
    if (this.signals.length > MAX_SIGNALS) this.signals.shift();
    if (this.state.divergences.length > 50) this.state.divergences.shift();
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// A TIER — 12. DEEP PATTERN BUILDER
//
// A lightweight rule engine that chains conditions on bar/footprint data
// and fires signals when all conditions are met.
//
// Designed to be configured by the renderer/user layer, not hardcoded.
//
// Each condition: { field, op, value, indicatorRef?, subgraph? }
//   field       — any property on FootprintBar or its methods
//                 ('v', 'delta', 'deltaPct', 'bodyTicks', 'poc', 'rangeTicks', ...)
//   op          — '>' | '<' | '>=' | '<=' | '==' | 'crosses_above' | 'crosses_below'
//   value       — number, or string key referencing a shared indicator state value
//   indicatorRef— optional: { indicator, statePath } to pull live value from another indicator
//
// combinator: 'AND' | 'OR' (default AND)
// evaluateOnClose: bool — only fire on bar close (not live updates)
// ═══════════════════════════════════════════════════════════════════════════════
class DeepPatternBuilder {
  constructor(opts = {}) {
    this.conditions      = opts.conditions      ?? [];
    this.combinator      = opts.combinator      ?? 'AND';
    this.evaluateOnClose = opts.evaluateOnClose ?? true;
    this.name            = opts.name            ?? 'Custom Pattern';

    this._prevValues = {};   // for crosses_above / crosses_below
    this.signals  = [];
    this.state    = { lastFire: null, conditionResults: [] };
  }

  addCondition(condition) {
    this.conditions.push(condition);
    return this;
  }

  _resolve(condition, fp) {
    let current;

    // Resolve left-hand value from footprint bar
    switch (condition.field) {
      case 'v':                 current = fp.v;               break;
      case 'delta':             current = fp.delta;           break;
      case 'deltaPct':          current = fp.deltaPct;        break;
      case 'bodyTicks':         current = fp.bodyTicks;       break;
      case 'rangeTicks':        current = fp.rangeTicks;      break;
      case 'poc':               current = fp.poc;             break;
      case 'horizontalDelta':   current = fp.horizontalDeltaPct; break;
      case 'maxDelta':          current = fp.maxDelta;        break;
      case 'minDelta':          current = fp.minDelta;        break;
      default:
        // Support dot-notation for nested fields, e.g. 'cells.size'
        current = condition.field.split('.').reduce((o, k) => o?.[k], fp);
    }

    // Resolve right-hand value — can be a constant OR a live indicator value
    let threshold = condition.value;
    if (condition.indicatorRef) {
      const path = condition.statePath.split('.');
      threshold  = path.reduce((o, k) => o?.[k], condition.indicatorRef.state) ?? threshold;
    }

    if (current === undefined || threshold === undefined) return false;

    const key = condition.field;
    let result = false;
    switch (condition.op) {
      case '>':  result = current > threshold;  break;
      case '<':  result = current < threshold;  break;
      case '>=': result = current >= threshold; break;
      case '<=': result = current <= threshold; break;
      case '==': result = current === threshold;break;
      case 'crosses_above':
        result = (this._prevValues[key] ?? current) <= threshold && current > threshold; break;
      case 'crosses_below':
        result = (this._prevValues[key] ?? current) >= threshold && current < threshold; break;
    }

    this._prevValues[key] = current;
    return result;
  }

  _evaluate(fp) {
    if (this.conditions.length === 0) return false;
    const results = this.conditions.map(c => this._resolve(c, fp));
    this.state.conditionResults = results;
    return this.combinator === 'OR'
      ? results.some(Boolean)
      : results.every(Boolean);
  }

  onBarClose(bar, fp) {
    if (!this.evaluateOnClose) return;
    if (this._evaluate(fp)) {
      const sig = { type: this.name, px: fp.c, ts: bar.t,
                    conditionResults: [...this.state.conditionResults] };
      this.signals.push(sig);
      this.state.lastFire = sig;
      if (this.signals.length > MAX_SIGNALS) this.signals.shift();
    }
  }

  onBarUpdate(_bar, fp) {
    if (this.evaluateOnClose) return;  // live evaluation disabled
    this._evaluate(fp);  // updates conditionResults for renderer without firing
  }

  onTrade() {}
  onDOM()   {}
}


// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR MANAGER
//
// Wires up all indicators, maintains shared state (FootprintBar, CVDTracker,
// SwingTracker), and routes incoming WS messages to the right handlers.
//
// Usage:
//   const mgr = new IndicatorManager();
//   ws.onmessage = e => mgr.onMessage(JSON.parse(e.data));
//   // Access indicator outputs:
//   mgr.deepTrades.signals
//   mgr.imbalanceTracker.state.freshZones
//   mgr.volumeProfile.state.session
//   etc.
// ═══════════════════════════════════════════════════════════════════════════════
class IndicatorManager {
  constructor(opts = {}) {
    // Shared state
    this.cvd    = new CVDTracker();
    this.swings = new SwingTracker(opts.swingLookback ?? 3);

    // Current footprint bar
    this._currentFp = null;
    this._currentBarTs = null;
    this._barSec = opts.barSec ?? 30;  // must match server BAR_SEC

    // S Tier
    this.deepTrades       = new DeepTrades(opts.deepTrades);
    this.deepWall         = new DeepWall(opts.deepWall);
    this.unfinishedAuction= new UnfinishedAuction();
    this.shiftCandle      = new ShiftCandle(this.swings, opts.shiftCandle);
    this.imbalanceTracker = new ImbalanceTracker(opts.imbalanceTracker);

    // A Tier
    this.deepVTracker     = new DeepVTracker(opts.deepVTracker);
    this.volumeProfile    = new VolumeProfile(this.swings, opts.volumeProfile);
    this.deltaCumulative  = new DeltaCumulative(this.cvd);
    this.stopSpotter      = new StopSpotter(this.swings, opts.stopSpotter);
    this.speedOfTape      = new SpeedOfTapeInstant(opts.speedOfTape);
    this.divergenceDetector = new DivergenceDetector(this.swings, this.cvd, opts.divergenceDetector);
    this.patternBuilder   = new DeepPatternBuilder(opts.patternBuilder ?? {});

    // All indicators in dispatch order
    this._all = [
      this.deepTrades, this.deepWall, this.unfinishedAuction, this.shiftCandle,
      this.imbalanceTracker, this.deepVTracker, this.volumeProfile,
      this.deltaCumulative, this.stopSpotter, this.speedOfTape,
      this.divergenceDetector, this.patternBuilder,
    ];
  }

  onMessage(msg) {
    if (msg.tr)  this._handleTrades(msg.tr);
    if (msg.ti)  this._handleBars(msg.ti);
    if (msg.d)   this._handleDepth(msg.d);
    if (msg.q)   this._handleQuote(msg.q);
  }

  _handleTrades(trades) {
    for (const t of trades) {
      // Ensure current footprint bar exists
      const barTs = Math.floor(t.st / 1000 / this._barSec) * this._barSec;
      if (!this._currentFp || this._currentBarTs !== barTs) {
        if (this._currentFp) this._closeBar();
        this._currentBarTs = barTs;
        this._currentFp    = new FootprintBar(barTs, snap(t.p));
      }

      this._currentFp.addTrade(t);
      for (const ind of this._all) ind.onTrade(t);
    }

    // Live update after each trade batch
    if (this._currentFp) {
      for (const ind of this._all) ind.onBarUpdate({ t: this._currentBarTs }, this._currentFp);
    }
  }

  _handleBars(bars) {
    for (const bar of bars) {
      const barTs = bar.t;
      if (this._currentFp && this._currentBarTs !== barTs) {
        // Server sent a new bar time → close current
        this._closeBar();
        this._currentBarTs = barTs;
        this._currentFp    = new FootprintBar(barTs, bar.o);
      }
    }
  }

  _closeBar() {
    if (!this._currentFp) return;
    const bar = {
      t: this._currentFp.t,
      o: this._currentFp.o,
      h: this._currentFp.h,
      l: this._currentFp.l,
      c: this._currentFp.c,
      v: this._currentFp.v,
    };
    this.swings.onBarClose(bar, this.cvd.value);
    for (const ind of this._all) ind.onBarClose(bar, this._currentFp);
    this._currentFp = null;
  }

  _handleDepth(depthArr) {
    for (const d of depthArr) {
      const bids = d.b ?? [];
      const asks = d.a ?? [];
      for (const ind of this._all) ind.onDOM(bids, asks);
    }
  }

  _handleQuote(_quotes) {
    // Quote data (OHLCV totals) — not consumed by current indicators
    // but available here for any future indicator that needs session stats
  }

  // Convenience: get all recent signals across all indicators, newest first
  allSignals(since = 0) {
    return this._all
      .flatMap(ind => (ind.signals ?? []).filter(s => s.ts > since))
      .sort((a, b) => b.ts - a.ts);
  }
}


// ─── Export ───────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    IndicatorManager,
    FootprintBar, CVDTracker, SwingTracker,
    DeepTrades, DeepWall, UnfinishedAuction, ShiftCandle, ImbalanceTracker,
    DeepVTracker, VolumeProfile, DeltaCumulative, StopSpotter,
    SpeedOfTapeInstant, DivergenceDetector, DeepPatternBuilder,
  };
}
