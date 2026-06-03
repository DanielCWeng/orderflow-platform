// data-live.js — IronBeam API adapter
// Populates window.OF_DATA from live market data.
// Read-only: no order or account endpoints are called.
//
// ─── DEV MODE ────────────────────────────────────────────────────────────────
// Set MOCK = true to use mock_server.py instead of IronBeam.
// Run:  python mock_server.py    (requires: pip install aiohttp)
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const MOCK     = true;    // ← flip to false for live IronBeam feed
  const SYMBOL   = 'XCME:ESH6';
  const BASE_URL = MOCK ? 'http://localhost:8001' : 'https://demo.ironbeamapi.com';
  const WS_BASE  = MOCK ? 'ws://localhost:8001/v2/stream' : 'wss://demo.ironbeamapi.com/v2/stream';
  const TICK = 0.25;
  const MAX_BARS = 60;
  const MAX_TAPE = 90;
  const LARGE_TRADE_MIN = 50;   // contracts — feeds the scanner
  const TIMEFRAME_SEC = 300;    // 5-minute bars

  // ── Indicator manager ──────────────────────────────────────────────
  const indicatorMgr = new IndicatorManager({
    barSec: MOCK ? 30 : TIMEFRAME_SEC,
  });
  window.OF_INDICATOR_MGR = indicatorMgr;

  // ── Seed empty OF_DATA so panels don't crash before auth ──────────────────
  window.OF_DATA = {
    TICK,
    watchlist: [
      { group: 'Equity Index', items: [
        { sym: 'ES',  desc: 'E-mini S&P 500', px: 0, ch: 0, vol: '—' },
        { sym: 'NQ',  desc: 'E-mini Nasdaq',  px: 0, ch: 0, vol: '—' },
        { sym: 'YM',  desc: 'E-mini Dow',     px: 0, ch: 0, vol: '—' },
        { sym: 'RTY', desc: 'E-mini Russell', px: 0, ch: 0, vol: '—' },
      ]},
      { group: 'Energy', items: [
        { sym: 'CL', desc: 'Crude Oil',    px: 0, ch: 0, vol: '—' },
        { sym: 'NG', desc: 'Natural Gas',  px: 0, ch: 0, vol: '—' },
      ]},
    ],
    candles: [],
    last: 0,
    dom: [],
    domExec: {},
    domSessionDelta: {},
    vp:  { rows: [], poc: 0, vah: 0, val: 0, total: 0 },
    dailyVP: [],
    weeklyVP: [],
    tpo: { rows: [], periods: [], poc: 0, vah: 0, val: 0, ibHi: 0, ibLo: 0 },
    delta: [],
    tape: [],
    largeTrades: [],
    bidAskRatio: { buy: 0, sell: 0, buyPct: 0.5, series: new Array(30).fill(0.5) },
    sessionStats: { open: 0, high: 0, low: 0, last: 0, volume: 0, delta: 0, vwap: 0 },
  };

  // Seed empty stats so chartlwc.js doesn't blow up reading them
  window.OF_FOOTPRINT_STATS = { thr: 3, mean: 2, sigma: 0.8, maxAbsDelta: 1, avgAbsDelta: 1 };
  window.OF_INDICATORS = { allSignals: [] };
  window.OF_TAPE_STATS = {
    thr: { sm: 2, md: 10, lg: 50 },
    velocity: new Array(28).fill(0),
    maxVelocity: 1, avgVelocity: 0,
    histogram: new Array(12).fill(0),
    aggressorPct: 0.5, windowN: 0,
  };

  // ── Module state ───────────────────────────────────────────────────────────
  let token = null;
  let ws = null;
  let reconnectAttempts = 0;

  let bars = [];          // completed candles, oldest first
  let currentBar = null;  // open bar being built in real time
  let tradeAccum = {};    // { [barTimestamp]: { [pxKey]: {px, bid, ask} } }
  let domState = [];
  let domSessionDelta = {}; // { [pxKey]: { buy: 0, sell: 0 } } — session-cumulative volume per price
  let tapeBuffer = [];    // newest trade first
  let largeTrades = [];
  let sessionStats = { open: 0, high: 0, low: 0, last: 0, volume: 0, delta: 0, vwap: 0 };
  let vwapAccum = { sumPV: 0, sumV: 0 };

  // ── Overlay helpers ────────────────────────────────────────────────────────
  function showOverlay(msg) {
    const ov = document.getElementById('auth-overlay');
    if (ov) ov.style.display = 'block';
    const err = document.getElementById('auth-error');
    if (err && msg) err.textContent = msg;
  }

  function hideOverlay() {
    const ov = document.getElementById('auth-overlay');
    if (ov) ov.style.display = 'none';
  }

  function setConnStatus(text, ok) {
    window._OF_LIVE_STATUS = { text, ok };
    document.dispatchEvent(new CustomEvent('of-status-update'));
  }

  // ── IronBeam REST helpers ──────────────────────────────────────────────────
  async function ibFetch(path, options = {}) {
    const resp = await fetch(BASE_URL + path, options);
    if (!resp.ok) {
      let body = '';
      try { body = await resp.text(); } catch {}
      throw new Error(`IronBeam ${path} → HTTP ${resp.status}: ${body}`);
    }
    return resp.json();
  }

  async function authenticate(username, password) {
    const data = await ibFetch('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
    if (!data.token) throw new Error(data.message || 'No token in auth response');
    return data.token;
  }

  async function createStream(tok) {
    const data = await ibFetch('/v2/stream/create', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!data.streamId) throw new Error('No streamId in response');
    return data.streamId;
  }

  async function subscribeAll(tok, sid) {
    const h = { Authorization: `Bearer ${tok}` };
    const sym = encodeURIComponent(SYMBOL);
    // subscribe order: quotes, depth, trades, timebars
    await ibFetch(`/v2/market/quotes/subscribe/${sid}?symbols=${sym}`, { headers: h });
    await ibFetch(`/v2/market/depths/subscribe/${sid}?symbols=${sym}`, { headers: h });
    await ibFetch(`/v2/market/trades/subscribe/${sid}?symbols=${sym}`, { headers: h });
    await ibFetch(`/v2/indicator/subscribe/timebars/${sid}?symbols=${sym}`, {
      method: 'POST',
      headers: { ...h, 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval: TIMEFRAME_SEC }),
    });
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────
  function openWS(tok, sid) {
    ws = new WebSocket(`${WS_BASE}/${sid}?token=${tok}`);

    ws.onopen = () => {
      reconnectAttempts = 0;
      setConnStatus('Connected · IronBeam', true);
      subscribeAll(tok, sid).catch(err => {
        console.error('[OF] subscribe error:', err);
        setConnStatus('Subscription failed', false);
      });
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      indicatorMgr.onMessage(msg);
      let dirty = false;
      if (msg.q  && msg.q.length)  { handleQuotes(msg.q);    dirty = true; }
      if (msg.d  && msg.d.length)  { handleDepth(msg.d);     dirty = true; }
      if (msg.tr && msg.tr.length) { handleTrades(msg.tr);   dirty = true; }
      if (msg.ti && msg.ti.length) { handleTimeBars(msg.ti); dirty = true; }
      if (dirty) commitData();
    };

    ws.onclose = () => {
      setConnStatus('Disconnected — reconnecting…', false);
      scheduleReconnect(tok);
    };

    ws.onerror = (err) => {
      console.error('[OF] WS error:', err);
    };
  }

  function scheduleReconnect(tok) {
    const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts++));
    setTimeout(async () => {
      try {
        const sid = await createStream(tok);
        openWS(tok, sid);
      } catch (e) {
        console.error('[OF] reconnect failed:', e);
        scheduleReconnect(tok);
      }
    }, delay);
  }

  // ── Message handlers (mutate module state, no commitData call here) ────────

  function handleQuotes(quotes) {
    for (const q of quotes) {
      if (q.l  != null) sessionStats.last   = q.l;
      if (q.op != null) sessionStats.open   = q.op;
      if (q.hi != null) sessionStats.high   = q.hi;
      if (q.lo != null) sessionStats.low    = q.lo;
      if (q.tv != null) sessionStats.volume = q.tv;
    }
  }

  function handleDepth(depths) {
    for (const d of depths) {
      const bids = (d.b || []).slice().sort((a, b) => b.p - a.p); // highest bid first
      const asks = (d.a || []).slice().sort((a, b) => a.p - b.p); // lowest ask first
      const mid  = sessionStats.last;
      const levels = [];

      // 5 ask levels, highest first (so they display above the mid row)
      for (let i = Math.min(4, asks.length - 1); i >= 0; i--) {
        const a = asks[i];
        levels.push({ px: a.p, bid: 0, ask: a.sz ?? a.o ?? 0, cumBid: 0, cumAsk: a.is ?? 0, last: false });
      }
      // mid price
      levels.push({ px: mid, bid: 0, ask: 0, cumBid: 0, cumAsk: 0, last: true });
      // 5 bid levels below mid
      for (let i = 0; i < Math.min(5, bids.length); i++) {
        const b = bids[i];
        levels.push({ px: b.p, bid: b.sz ?? b.o ?? 0, ask: 0, cumBid: b.is ?? 0, cumAsk: 0, last: false });
      }
      domState = levels;
    }
  }

  function handleTrades(trades) {
    for (const t of trades) {
      const side = t.td === 'BUY' ? 'ask' : 'bid';
      const size = t.sz ?? 0;
      const px   = t.p  ?? 0;
      if (!px || !size) continue;

      // timestamp → ET time string
      const rawTs = t.st ?? t.tdt ?? Date.now();
      const ms = rawTs < 1e12 ? rawTs * 1000 : rawTs;
      const timeStr = new Date(ms).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });

      tapeBuffer.unshift({
        i: tapeBuffer.length,
        time: timeStr,
        px,
        size,
        side,
        block: size >= 80,
        condition: size >= 200 ? 'BLOCK' : (size >= 80 ? 'SWEEP' : ''),
        tier: 'sm',    // set by analyzeFootprintStats
        clusterLen: 1, // set by analyzeTapeStats
      });
      if (tapeBuffer.length > MAX_TAPE) tapeBuffer.length = MAX_TAPE;

      // accumulate into current bar's footprint
      if (currentBar !== null) {
        const ts = currentBar.time;
        if (!tradeAccum[ts]) tradeAccum[ts] = {};
        const k = px.toFixed(2);
        if (!tradeAccum[ts][k]) tradeAccum[ts][k] = { px, bid: 0, ask: 0 };
        if (side === 'ask') tradeAccum[ts][k].ask += size;
        else                tradeAccum[ts][k].bid += size;
      }

      // session delta
      sessionStats.delta += side === 'ask' ? size : -size;
      sessionStats.last = px;

      // VWAP (running)
      vwapAccum.sumPV += px * size;
      vwapAccum.sumV  += size;
      if (vwapAccum.sumV > 0) {
        sessionStats.vwap = Math.round((vwapAccum.sumPV / vwapAccum.sumV) / TICK) * TICK;
      }

      // session-cumulative delta per price level
      const dk = px.toFixed(2);
      if (!domSessionDelta[dk]) domSessionDelta[dk] = { buy: 0, sell: 0 };
      if (side === 'ask') domSessionDelta[dk].buy  += size;
      else                domSessionDelta[dk].sell += size;

      // large trade scanner
      if (size >= LARGE_TRADE_MIN) {
        largeTrades.unshift({
          time: timeStr,
          sym: 'ESH6',
          type: size >= 200 ? 'BLOCK' : 'SWEEP',
          side: side === 'ask' ? 'buy' : 'sell',
          size,
          px,
          notional: Math.round((px * size * 50) / 1000),
          venue: 'CME',
        });
        if (largeTrades.length > 50) largeTrades.length = 50;
      }
    }
  }

  function handleTimeBars(msgs) {
    for (const bar of msgs) {
      const barTs = bar.t; // unix seconds
      const O = snap(bar.o), H = snap(bar.h), L = snap(bar.l), C = snap(bar.c);
      const vol = bar.v ?? 0;

      if (currentBar === null) {
        // first bar on connect
        currentBar = makeBar(0, barTs, O, H, L, C, vol);
        continue;
      }

      if (barTs > currentBar.time) {
        // new bar opened — finalise the previous one
        finaliseBar(currentBar);
        bars.push(currentBar);
        if (bars.length > MAX_BARS) bars.shift();
        // re-index
        bars.forEach((b, i) => { b.i = i; });
        currentBar = makeBar(bars.length, barTs, O, H, L, C, vol);
      } else {
        // update the in-progress bar
        currentBar.h   = Math.max(currentBar.h, H);
        currentBar.l   = Math.min(currentBar.l, L);
        currentBar.c   = C;
        currentBar.vol = vol;
      }
    }
  }

  // ── Bar helpers ────────────────────────────────────────────────────────────
  function snap(px) { return Math.round(Math.round((px ?? 0) / TICK) * TICK * 100) / 100; }

  function makeBar(idx, time, o, h, l, c, vol) {
    return {
      i: idx, time, o, h, l, c, vol,
      bid: 0, ask: 0, delta: 0,
      footprint: [],
      deltaIntensity: 0, stackedImb: [],
      absorption: false, unfinishedHi: false, unfinishedLo: false,
    };
  }

  function finaliseBar(bar) {
    const accum = tradeAccum[bar.time] || {};
    const cells = Object.values(accum).sort((a, b) => a.px - b.px);
    let tb = 0, ta = 0;
    cells.forEach(c => { tb += c.bid; ta += c.ask; });
    bar.footprint = cells;
    bar.bid   = tb;
    bar.ask   = ta;
    bar.vol   = (tb + ta) || bar.vol;
    bar.delta = ta - tb;
    delete tradeAccum[bar.time];
  }

  // ── Analytics (adapted from data.js) ──────────────────────────────────────

  let _smoothedThr = 0;
  function analyzeFootprint(candles) {
    if (!candles.length) return;
    const ratios = [];
    candles.forEach(c => c.footprint.forEach(f => {
      if (f.bid > 0 && f.ask > 0) {
        ratios.push(Math.max(f.ask, f.bid) / Math.max(1, Math.min(f.ask, f.bid)));
      }
    }));
    const mean  = ratios.length ? ratios.reduce((s, x) => s + x, 0) / ratios.length : 2;
    const sigma = ratios.length ? Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length) : 0.8;
    const rawThr = mean + 1.2 * sigma;
    // EMA-smooth the threshold so imbalance flags don't flicker on every tick
    _smoothedThr = _smoothedThr === 0 ? rawThr : _smoothedThr * 0.85 + rawThr * 0.15;
    const thr = _smoothedThr;

    const allAbsDelta  = candles.map(c => Math.abs(c.delta));
    const maxAbsDelta  = Math.max(...allAbsDelta, 1);
    const avgAbsDelta  = allAbsDelta.reduce((s, x) => s + x, 0) / Math.max(1, allAbsDelta.length);
    const volSorted    = candles.map(c => c.vol).slice().sort((a, b) => a - b);
    const volP75       = volSorted[Math.floor(volSorted.length * 0.75)] ?? 0;

    candles.forEach(c => {
      c.deltaIntensity = Math.abs(c.delta) / maxAbsDelta;
      c.footprint.forEach(f => {
        f.askImb = f.ask / Math.max(1, f.bid) >= thr;
        f.bidImb = f.bid / Math.max(1, f.ask) >= thr;
      });
      const stacks = [];
      let dir = null, start = 0;
      for (let i = 0; i < c.footprint.length; i++) {
        const f = c.footprint[i];
        const cur = f.askImb ? 'ask' : (f.bidImb ? 'bid' : null);
        if (cur !== dir) {
          if (dir && (i - start) >= 3) stacks.push({ dir, from: start, to: i - 1 });
          dir = cur; start = i;
        }
      }
      if (dir && (c.footprint.length - start) >= 3) stacks.push({ dir, from: start, to: c.footprint.length - 1 });
      c.stackedImb = stacks;
      const body  = Math.abs(c.c - c.o);
      const range = Math.max(TICK, c.h - c.l);
      c.absorption = c.vol > volP75 && Math.abs(c.delta) > avgAbsDelta * 1.4 && body < range * 0.3;
      const top = c.footprint[c.footprint.length - 1];
      const bot = c.footprint[0];
      const topT = top ? top.bid + top.ask : 0;
      const botT = bot ? bot.bid + bot.ask : 0;
      c.unfinishedHi = topT > 0 && top.ask / topT > 0.9;
      c.unfinishedLo = botT > 0 && bot.bid / botT > 0.9;
    });
    window.OF_FOOTPRINT_STATS = { thr, mean, sigma, maxAbsDelta, avgAbsDelta };
  }

  function analyzeTape(tape) {
    if (!tape.length) return;
    const sizes = tape.map(t => t.size).slice().sort((a, b) => a - b);
    const pct = (p) => sizes[Math.floor(sizes.length * p)] ?? 1;
    const thr = { sm: pct(0.55), md: pct(0.85), lg: pct(0.97) };
    tape.forEach(t => {
      if      (t.size > thr.lg) t.tier = 'inst';
      else if (t.size > thr.md) t.tier = 'lg';
      else if (t.size > thr.sm) t.tier = 'md';
      else                      t.tier = 'sm';
    });
    let i = 0;
    while (i < tape.length) {
      let j = i;
      while (j < tape.length && tape[j].px === tape[i].px) j++;
      const len = j - i;
      for (let k = i; k < j; k++) tape[k].clusterLen = len;
      i = j;
    }
    const buckets = new Map();
    tape.forEach(t => {
      const parts = t.time.split(':').map(Number);
      const sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
      buckets.set(sec, (buckets.get(sec) || 0) + 1);
    });
    const secs = Array.from(buckets.keys()).sort((a, b) => b - a).slice(0, 28).reverse();
    const velocity = secs.map(s => buckets.get(s));
    const maxSz = Math.max(...tape.map(t => t.size), 1);
    const bins = new Array(12).fill(0);
    tape.forEach(t => {
      const b = Math.min(11, Math.floor(Math.log2(t.size + 1) / Math.log2(maxSz + 1) * 12));
      bins[b]++;
    });
    const recent = tape.slice(0, 50);
    const buys = recent.filter(t => t.side === 'ask').length;
    window.OF_TAPE_STATS = {
      thr, velocity,
      maxVelocity: Math.max(...velocity, 1),
      avgVelocity: velocity.length ? velocity.reduce((s, x) => s + x, 0) / velocity.length : 0,
      histogram: bins,
      aggressorPct: recent.length ? buys / recent.length : 0.5,
      windowN: recent.length,
    };
  }

  // ── Derived data builders ──────────────────────────────────────────────────

  function buildVP(allBars) {
    const buckets = new Map();
    allBars.forEach(c => c.footprint.forEach(f => {
      const key = f.px.toFixed(2);
      const cur = buckets.get(key) || { px: f.px, buy: 0, sell: 0 };
      cur.buy  += f.ask;
      cur.sell += f.bid;
      buckets.set(key, cur);
    }));
    if (!buckets.size) return { rows: [], poc: 0, vah: 0, val: 0, total: 0 };

    const arr = Array.from(buckets.values()).sort((a, b) => b.px - a.px);
    const max = Math.max(...arr.map(r => r.buy + r.sell), 1);
    let pocIdx = 0, pocVol = 0;
    arr.forEach((r, i) => { const t = r.buy + r.sell; if (t > pocVol) { pocVol = t; pocIdx = i; } });

    const total = arr.reduce((s, r) => s + r.buy + r.sell, 0);
    let acc = arr[pocIdx].buy + arr[pocIdx].sell;
    let lo = pocIdx, hi = pocIdx;
    while (acc < total * 0.7 && (lo > 0 || hi < arr.length - 1)) {
      const upV = lo > 0 ? arr[lo - 1].buy + arr[lo - 1].sell : -1;
      const dnV = hi < arr.length - 1 ? arr[hi + 1].buy + arr[hi + 1].sell : -1;
      if (upV >= dnV) { lo--; acc += upV; } else { hi++; acc += dnV; }
    }
    arr.forEach((r, i) => {
      r.poc     = i === pocIdx;
      r.va      = i >= lo && i <= hi;
      r.pct     = (r.buy + r.sell) / max;
      r.buyPct  = r.buy  / max;
      r.sellPct = r.sell / max;
    });
    return { rows: arr, vah: arr[lo].px, val: arr[hi].px, poc: arr[pocIdx].px, total };
  }

  function buildDailyVP(allBars) {
    // Group bars by calendar date (CT / America/Chicago)
    const dayBuckets = new Map();
    allBars.forEach(bar => {
      const d = new Date(bar.time * 1000);
      const key = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); // YYYY-MM-DD
      if (!dayBuckets.has(key)) dayBuckets.set(key, []);
      dayBuckets.get(key).push(bar);
    });
    const days = [];
    for (const [date, dayBars] of dayBuckets) {
      days.push({ date, barTimes: dayBars.map(b => b.time), ...buildVP(dayBars) });
    }
    return days;
  }

  function buildWeeklyVP(allBars) {
    const weekBuckets = new Map();
    allBars.forEach(bar => {
      const d = new Date(bar.time * 1000);
      const ct = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      const day = ct.getDay(); // 0=Sun
      const diff = ct.getDate() - day + (day === 0 ? -6 : 1); // Monday start
      const mon = new Date(ct); mon.setDate(diff); mon.setHours(0,0,0,0);
      const key = mon.toISOString().slice(0,10);
      if (!weekBuckets.has(key)) weekBuckets.set(key, []);
      weekBuckets.get(key).push(bar);
    });
    const weeks = [];
    for (const [weekStart, weekBars] of weekBuckets) {
      weeks.push({ weekStart, barTimes: weekBars.map(b => b.time), ...buildVP(weekBars) });
    }
    return weeks;
  }

  function buildTPO(allBars) {
    if (!allBars.length) return { rows: [], periods: [], poc: 0, vah: 0, val: 0, ibHi: 0, ibLo: 0 };
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const PER_PERIOD = 6; // 6 × 5-min = 30-min period
    const periods = [];
    for (let p = 0; p * PER_PERIOD < allBars.length; p++) {
      const slice = allBars.slice(p * PER_PERIOD, (p + 1) * PER_PERIOD);
      if (!slice.length) break;
      periods.push({
        letter: LETTERS[p % 26],
        lo: Math.min(...slice.map(c => c.l)),
        hi: Math.max(...slice.map(c => c.h)),
      });
    }

    const minPx = Math.min(...allBars.map(c => c.l));
    const maxPx = Math.max(...allBars.map(c => c.h));
    const lo    = Math.floor(minPx / TICK) * TICK;
    const hi    = Math.ceil(maxPx  / TICK) * TICK;
    const nBins = Math.min(400, Math.round((hi - lo) / TICK) + 1);

    const rows = [];
    for (let b = nBins - 1; b >= 0; b--) {
      const px = +(lo + b * TICK).toFixed(2);
      rows.push({ px, letters: periods.filter(p => px >= p.lo && px <= p.hi).map(p => p.letter) });
    }

    let pocIdx = 0, pocC = 0;
    rows.forEach((r, i) => { if (r.letters.length > pocC) { pocC = r.letters.length; pocIdx = i; } });

    const totalT = rows.reduce((s, r) => s + r.letters.length, 0);
    let acc2 = rows[pocIdx]?.letters.length ?? 0;
    let l = pocIdx, h = pocIdx;
    while (acc2 < totalT * 0.7 && (l > 0 || h < rows.length - 1)) {
      const up = l > 0 ? rows[l - 1].letters.length : -1;
      const dn = h < rows.length - 1 ? rows[h + 1].letters.length : -1;
      if (up >= dn) { l--; acc2 += up; } else { h++; acc2 += dn; }
    }
    rows.forEach((r, i) => { r.poc = i === pocIdx; r.va = i >= l && i <= h; });

    const ibLo = periods[1] ? Math.min(periods[0].lo, periods[1].lo) : (periods[0]?.lo ?? 0);
    const ibHi = periods[1] ? Math.max(periods[0].hi, periods[1].hi) : (periods[0]?.hi ?? 0);
    return {
      rows, periods, ibLo, ibHi,
      poc: rows[pocIdx]?.px ?? 0,
      vah: rows[l]?.px ?? 0,
      val: rows[h]?.px ?? 0,
    };
  }

  function buildDelta(allBars) {
    let cum = 0;
    return allBars.map((b, i) => { cum += b.delta; return { i, delta: b.delta, cum }; });
  }

  function buildBidAskRatio(tape) {
    const buy  = tape.reduce((s, t) => s + (t.side === 'ask' ? t.size : 0), 0);
    const sell = tape.reduce((s, t) => s + (t.side === 'bid' ? t.size : 0), 0);
    const tot  = buy + sell || 1;
    const series = [];
    for (let i = 0; i < 30; i++) {
      const sl = tape.slice(i * 3, (i + 1) * 3);
      if (!sl.length) { series.push(0.5); continue; }
      const b = sl.reduce((s, t) => s + (t.side === 'ask' ? t.size : 0), 0);
      const v = sl.reduce((s, t) => s + (t.side === 'bid' ? t.size : 0), 0);
      series.push(b / (b + v || 1));
    }
    return { buy, sell, buyPct: buy / tot, series };
  }

  // ── Commit to window.OF_DATA and notify React ──────────────────────────────
  function commitData() {
    // Build a display copy of currentBar with live accumulated footprint
    let liveCurrentBar = currentBar;
    if (currentBar !== null) {
      const liveAccum = tradeAccum[currentBar.time] || {};
      const liveFootprint = Object.values(liveAccum).sort((a, b) => a.px - b.px);
      if (liveFootprint.length > 0) {
        liveCurrentBar = { ...currentBar, footprint: liveFootprint };
      }
    }
    const allBars = liveCurrentBar ? [...bars, liveCurrentBar] : [...bars];

    analyzeFootprint(allBars);
    analyzeTape(tapeBuffer);

    // keep high/low in sync with bar data
    if (allBars.length) {
      const bHi = Math.max(...allBars.map(b => b.h));
      const bLo = Math.min(...allBars.map(b => b.l));
      if (!sessionStats.high || bHi > sessionStats.high) sessionStats.high = bHi;
      if (!sessionStats.low  || bLo < sessionStats.low)  sessionStats.low  = bLo;
    }

    // Build executed volume map from current bar's trade accumulator
    const domExec = {};
    if (currentBar !== null && tradeAccum[currentBar.time]) {
      for (const [k, v] of Object.entries(tradeAccum[currentBar.time])) {
        // v.ask = buy-aggressor volume (lifted offer), v.bid = sell-aggressor volume (hit bid)
        domExec[k] = { buy: v.ask, sell: v.bid };
      }
    }

    // Cap domSessionDelta to 500 price levels (keep levels nearest to last price)
    const dsdKeys = Object.keys(domSessionDelta);
    if (dsdKeys.length > 500) {
      const lastPx = sessionStats.last || 0;
      dsdKeys
        .sort((a, b) => Math.abs(parseFloat(a) - lastPx) - Math.abs(parseFloat(b) - lastPx))
        .slice(500)
        .forEach(k => delete domSessionDelta[k]);
    }

    window.OF_DATA = {
      TICK,
      watchlist: window.OF_DATA.watchlist,
      candles:   allBars,
      last:      sessionStats.last || 0,
      dom:       domState,
      domExec,
      domSessionDelta,
      vp:        buildVP(allBars),
      dailyVP:   buildDailyVP(allBars),
      weeklyVP:  buildWeeklyVP(allBars),
      tpo:       buildTPO(allBars),
      delta:     buildDelta(allBars),
      tape:      tapeBuffer,
      largeTrades,
      bidAskRatio: buildBidAskRatio(tapeBuffer),
      sessionStats: { ...sessionStats },
    };

    // Build aggregated signals with normalized timestamps and indicator metadata
    const INDICATOR_META = [
      [indicatorMgr.deepTrades,         'DEEP-T', 'S'],
      [indicatorMgr.deepWall,           'WALL',   'S'],
      [indicatorMgr.unfinishedAuction,  'UA',     'S'],
      [indicatorMgr.shiftCandle,        'SHIFT',  'S'],
      [indicatorMgr.imbalanceTracker,   'IMB',    'S'],
      [indicatorMgr.deepVTracker,       'VTRK',   'A'],
      [indicatorMgr.volumeProfile,      'VP',     'A'],
      [indicatorMgr.deltaCumulative,    'CVD',    'A'],
      [indicatorMgr.stopSpotter,        'STOP',   'A'],
      [indicatorMgr.speedOfTape,        'TAPE',   'A'],
      [indicatorMgr.divergenceDetector, 'DIV',    'A'],
      [indicatorMgr.patternBuilder,     'PAT',    'A'],
    ];
    const cutoffMs = Date.now() - 300_000;
    const allSignals = [];
    for (const [ind, shortName, tier] of INDICATOR_META) {
      if (!ind?.signals) continue;
      for (const s of ind.signals) {
        const tsMs = s.ts < 1e10 ? s.ts * 1000 : s.ts;
        if (tsMs >= cutoffMs) allSignals.push({ ...s, tsMs, ind: shortName, tier });
      }
    }
    allSignals.sort((a, b) => b.tsMs - a.tsMs);

    window.OF_INDICATORS = {
      deepTrades:        { recentBlocks: indicatorMgr.deepTrades.megaPrints, absorptionLevels: indicatorMgr.deepTrades.state.absorptionLevels },
      deepWall:          indicatorMgr.deepWall.state,
      unfinishedAuction: indicatorMgr.unfinishedAuction.state,
      shiftCandle:       indicatorMgr.shiftCandle.state,
      imbalanceTracker:  indicatorMgr.imbalanceTracker.state,
      deepVTracker:      indicatorMgr.deepVTracker.state,
      volumeProfile:     indicatorMgr.volumeProfile.state,
      deltaCumulative:   indicatorMgr.deltaCumulative.state,
      stopSpotter:       indicatorMgr.stopSpotter.state,
      speedOfTape:       indicatorMgr.speedOfTape.state,
      divergenceDetector:indicatorMgr.divergenceDetector.state,
      patternBuilder:    indicatorMgr.patternBuilder.state,
      allSignals,
    };

    document.dispatchEvent(new CustomEvent('of-data-update'));
  }

  // ── Public entry point (called by auth form) ───────────────────────────────
  window.connectIronBeam = async function (username, password) {
    const errEl = document.getElementById('auth-error');
    if (errEl) errEl.textContent = 'Connecting…';
    try {
      token = await authenticate(username, password);
      const sid = await createStream(token);
      hideOverlay();
      openWS(token, sid);
    } catch (err) {
      console.error('[OF] connect error:', err);
      if (errEl) errEl.textContent = err.message || 'Connection failed — check credentials';
    }
  };

  // Mock mode: auto-connect silently, no credentials needed
  if (MOCK) {
    window.connectIronBeam('mock', 'mock');
  }
  // Otherwise overlay stays hidden — user opens it via the Connect button
})();
