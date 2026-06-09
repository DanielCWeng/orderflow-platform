// data-live.js — IronBeam API adapter — multi-instrument
// Populates window.OF_DATA (active) and window.OF_DATA_BY_SYM (all) from live market data.

const safeMax = (arr, selector = x => x) => {
  if (!arr || !arr.length) return 0;
  let max = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = selector(arr[i]);
    if (v > max) max = v;
  }
  return max;
};
const safeMin = (arr, selector = x => x) => {
  if (!arr || !arr.length) return 0;
  let min = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = selector(arr[i]);
    if (v < min) min = v;
  }
  return min;
};

// ─── DEV MODE ─────────────────────────────────────────────────────────────────

// Set MOCK = true to use mock_server.py instead of IronBeam.
// Run:  python mock_server.py    (requires: pip install aiohttp)
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const MOCK = false;   // ← flip to true for mock_server.py
  const INSTRUMENT_CONFIGS = [
    { symbol: 'XCME:ES.M26', instrument: 'ES', tick: 0.25 },
    { symbol: 'XCME:NQ.M26', instrument: 'NQ', tick: 0.25 },
  ];
  const BASE_URL    = MOCK ? 'http://localhost:8001' : 'https://live.ironbeamapi.com';
  const WS_BASE     = MOCK ? 'ws://localhost:8001/v2/stream' : 'wss://live.ironbeamapi.com/v2/stream';
  const BACKEND_URL = 'http://localhost:8000';
  const MAX_BARS    = 2016;   // 7 days × ~288 5m bars/day
  const MAX_TAPE    = 90;
  const LARGE_TRADE_MIN = 50; // contracts — feeds scanner
  const TIMEFRAME_SEC   = 300;

  // ── Per-instrument state ───────────────────────────────────────────────────
  const instrStates = new Map();  // 'ES' | 'NQ' → state
  const instrBySym  = new Map();  // 'XCME:ES.M26' → 'ES', etc.
  let _activeInstr  = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem('of-prefs') || '{}').active;
      if (saved && INSTRUMENT_CONFIGS.some(c => c.instrument === saved)) return saved;
    } catch {}
    return INSTRUMENT_CONFIGS[0].instrument;
  })();

  function createState(cfg) {
    return {
      cfg,
      indicatorMgr: new IndicatorManager({ barSec: MOCK ? 30 : TIMEFRAME_SEC }),
      bars: [],
      currentBar: null,
      tradeAccum: {},
      domState: [],
      domSessionDelta: {},
      tapeBuffer: [],
      largeTrades: [],
      sessionStats: { open: 0, high: 0, low: 0, last: 0, volume: 0, delta: 0, vwap: 0 },
      vwapAccum: { sumPV: 0, sumV: 0 },
      _rafPending: false,
      _expensiveRebuildNeeded: true,
      _isLoadingHistorical: false,
      _cachedVP:       { rows: [], poc: 0, vah: 0, val: 0, total: 0 },
      _cachedDailyVP:  [],
      _cachedWeeklyVP: [],
      _cachedTPO:      { rows: [], periods: [], poc: 0, vah: 0, val: 0, ibHi: 0, ibLo: 0 },
      _cachedDelta:    [],
      _smoothedThr:    0,
      _firstTradeLogged: false,
      footprintStats: { thr: 3, mean: 2, sigma: 0.8, maxAbsDelta: 1, avgAbsDelta: 1 },
      tapeStats: {
        thr: { sm: 2, md: 10, lg: 50 },
        velocity: new Array(28).fill(0),
        maxVelocity: 1, avgVelocity: 0,
        histogram: new Array(12).fill(0),
        aggressorPct: 0.5, windowN: 0,
      },
      indicators: { allSignals: [] },
    };
  }

  for (const cfg of INSTRUMENT_CONFIGS) {
    const st = createState(cfg);
    instrStates.set(cfg.instrument, st);
    instrBySym.set(cfg.symbol, cfg.instrument);
  }

  // ── Shared watchlist (mutated in-place by updateWatchlistEntry) ───────────
  const WATCHLIST = [
    { group: 'Equity Index', items: [
      { sym: 'ES',  desc: 'E-mini S&P 500',    px: 0, ch: 0, vol: '—' },
      { sym: 'NQ',  desc: 'E-mini Nasdaq 100', px: 0, ch: 0, vol: '—' },
      { sym: 'YM',  desc: 'E-mini Dow',        px: 0, ch: 0, vol: '—' },
      { sym: 'RTY', desc: 'E-mini Russell',    px: 0, ch: 0, vol: '—' },
    ]},
    { group: 'Energy', items: [
      { sym: 'CL', desc: 'Crude Oil',   px: 0, ch: 0, vol: '—' },
      { sym: 'NG', desc: 'Natural Gas', px: 0, ch: 0, vol: '—' },
    ]},
  ];

  // ── Global namespace seed ─────────────────────────────────────────────────
  function seedEmptyData(cfg) {
    return {
      TICK: cfg.tick,
      watchlist: WATCHLIST,
      candles: [], last: 0,
      dom: [], domExec: {}, domSessionDelta: {},
      vp:  { rows: [], poc: 0, vah: 0, val: 0, total: 0 },
      dailyVP: [], weeklyVP: [],
      tpo: { rows: [], periods: [], poc: 0, vah: 0, val: 0, ibHi: 0, ibLo: 0 },
      delta: [], tape: [], largeTrades: [],
      bidAskRatio: { buy: 0, sell: 0, buyPct: 0.5, series: new Array(30).fill(0.5) },
      sessionStats: { open: 0, high: 0, low: 0, last: 0, volume: 0, delta: 0, vwap: 0 },
    };
  }

  window.OF_DATA_BY_SYM = {};
  for (const cfg of INSTRUMENT_CONFIGS) window.OF_DATA_BY_SYM[cfg.instrument] = seedEmptyData(cfg);
  window.OF_DATA          = window.OF_DATA_BY_SYM[_activeInstr];
  window.OF_INDICATOR_MGR = instrStates.get(_activeInstr).indicatorMgr;
  window.OF_FOOTPRINT_STATS = instrStates.get(_activeInstr).footprintStats;
  window.OF_INDICATORS    = instrStates.get(_activeInstr).indicators;
  window.OF_TAPE_STATS    = instrStates.get(_activeInstr).tapeStats;

  // ── Instrument switch (called from app.js sidebar onSelect) ──────────────
  window.OF_SWITCH_INSTRUMENT = function (sym) {
    if (!instrStates.has(sym) || sym === _activeInstr) return;
    _activeInstr = sym;
    const st = instrStates.get(sym);
    window.OF_DATA          = window.OF_DATA_BY_SYM[sym] ?? seedEmptyData(st.cfg);
    window.OF_INDICATOR_MGR = st.indicatorMgr;
    window.OF_FOOTPRINT_STATS = st.footprintStats;
    window.OF_TAPE_STATS    = st.tapeStats;
    window.OF_INDICATORS    = st.indicators;
    document.dispatchEvent(new CustomEvent('of-data-update'));

    // Subscribe WS feeds for new instrument if connected, then load its history
    const cfg = st.cfg;
    if (token && streamId) {
      subscribeInstrument(cfg, token, streamId).catch(err => {
        console.warn(`[OF] switch subscribe ${sym} failed:`, err.message);
      });
    }
    // Load historical bars if this instrument hasn't been loaded yet
    const existing = window.OF_DATA_BY_SYM[sym];
    if (!existing || !existing.candles || existing.candles.length === 0) {
      loadHistoricalBars(st).then(() => loadFootprintBars(st));
    }
  };

  // ── Routing helpers ───────────────────────────────────────────────────────
  function resolveInstr(sym) {
    if (!sym) return INSTRUMENT_CONFIGS[0].instrument;
    return instrBySym.get(sym) || INSTRUMENT_CONFIGS[0].instrument;
  }

  function groupItems(items, getSymbol) {
    const map = new Map();
    for (const item of items) {
      const instr = resolveInstr(getSymbol(item));
      if (!map.has(instr)) map.set(instr, []);
      map.get(instr).push(item);
    }
    return map;
  }

  function filterMsgForInstr(msg, instr) {
    const out = {};
    if (msg.q)  { const f = msg.q.filter(q => resolveInstr(q.s || q.sym)  === instr); if (f.length) out.q  = f; }
    if (msg.d)  { const f = msg.d.filter(d => resolveInstr(d.s || d.sym)  === instr); if (f.length) out.d  = f; }
    if (msg.tr) { const f = msg.tr.filter(t => resolveInstr(t.s || t.sym) === instr); if (f.length) out.tr = f; }
    if (msg.ti) { const f = msg.ti.filter(b => resolveInstr(b.s || b.sym) === instr); if (f.length) out.ti = f; }
    return Object.keys(out).length ? out : null;
  }

  // ── Shared connection state ───────────────────────────────────────────────
  let token = null;
  let streamId = null;
  let ws    = null;
  let reconnectAttempts = 0;

  // ── Backend storage (fire-and-forget) ─────────────────────────────────────
  function pushToBackend(path, body) {
    fetch(BACKEND_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  // ── Overlay helpers ───────────────────────────────────────────────────────
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

  // ── IronBeam REST helpers ─────────────────────────────────────────────────
  async function ibFetch(path, options = {}) {
    try {
      const resp = await fetch(BASE_URL + path, options);
      if (!resp.ok) {
        let body = '';
        try { body = await resp.text(); } catch {}
        throw new Error(`IronBeam ${path} → HTTP ${resp.status}: ${body}`);
      }
      return resp.json();
    } catch (e) {
      if (e.message === 'Failed to fetch') {
        throw new Error(`Network error (CORS or server down) fetching ${path}`);
      }
      throw e;
    }
  }

  async function authenticate(username, password) {
    const data = await ibFetch('/v2/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
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

  async function subscribeInstrument(cfg, tok, sid) {
    const h = { Authorization: `Bearer ${tok}` };
    const sym = encodeURIComponent(cfg.symbol);
    const results = await Promise.allSettled([
      ibFetch(`/v2/market/quotes/subscribe/${sid}?symbols=${sym}`, { headers: h }),
      ibFetch(`/v2/market/depths/subscribe/${sid}?symbols=${sym}`, { headers: h }),
      ibFetch(`/v2/market/trades/subscribe/${sid}?symbols=${sym}`, { headers: h }),
      ibFetch(`/v2/indicator/${sid}/timeBars/subscribe`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: cfg.symbol, period: 5, barType: 'MINUTE', loadSize: 500 }),
      }),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const names = ['quotes', 'depths', 'trades', 'timebars'];
        console.warn(`[OF] subscribe ${cfg.instrument} ${names[i]} failed:`, r.reason?.message);
      }
    });
    if (results[3].status === 'rejected') {
      throw new Error(`${cfg.instrument} timebars subscribe failed — chart will be empty`);
    }
  }

  async function subscribeAll(tok, sid) {
    // Only subscribe the active instrument — prevents cross-instrument data mixing
    const cfg = INSTRUMENT_CONFIGS.find(c => c.instrument === _activeInstr) || INSTRUMENT_CONFIGS[0];
    await subscribeInstrument(cfg, tok, sid);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  function openWS(tok, sid) {
    streamId = sid;
    ws = new WebSocket(`${WS_BASE}/${sid}?token=${tok}`);

    ws.onopen = () => {
      reconnectAttempts = 0;
      setConnStatus('Connected · IronBeam', true);
      subscribeAll(tok, sid).catch(err => {
        console.error('[OF] subscribe error:', err);
        setConnStatus('Subscription failed', false);
      });
      // Re-merge footprint after IronBeam's 2016-bar historical batch arrives
      const activeSt = instrStates.get(_activeInstr);
      setTimeout(() => { if (activeSt) loadFootprintBars(activeSt); }, 2500);
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      routeMessage(msg);
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

  // ── Message routing ───────────────────────────────────────────────────────
  function routeMessage(msg) {
    const dirtyStates = new Set();

    if (msg.q && msg.q.length) {
      const grouped = groupItems(msg.q, q => q.s || q.sym);
      for (const [instr, items] of grouped) {
        const st = instrStates.get(instr); if (!st) continue;
        handleQuotes(st, items);
        dirtyStates.add(st);
      }
    }
    if (msg.d && msg.d.length) {
      const grouped = groupItems(msg.d, d => d.s || d.sym);
      for (const [instr, items] of grouped) {
        const st = instrStates.get(instr); if (!st) continue;
        handleDepth(st, items);
        dirtyStates.add(st);
      }
    }
    if (msg.tr && msg.tr.length) {
      const grouped = groupItems(msg.tr, t => t.s || t.sym);
      for (const [instr, items] of grouped) {
        const st = instrStates.get(instr); if (!st) continue;
        handleTrades(st, items);
        dirtyStates.add(st);
      }
    }
    if (msg.ti && msg.ti.length) {
      const grouped = groupItems(msg.ti, b => b.s || b.sym);
      for (const [instr, items] of grouped) {
        const st = instrStates.get(instr); if (!st) continue;
        handleTimeBars(st, items);
        dirtyStates.add(st);
      }
    }

    // Forward filtered sub-messages to each instrument's indicator manager
    for (const st of dirtyStates) {
      const instrMsg = filterMsgForInstr(msg, st.cfg.instrument);
      if (instrMsg) st.indicatorMgr.onMessage(instrMsg);
    }

    // Schedule RAF commit per dirty instrument
    for (const st of dirtyStates) {
      if (!st._rafPending) {
        st._rafPending = true;
        requestAnimationFrame(() => { st._rafPending = false; commitData(st); });
      }
    }
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  function handleQuotes(st, quotes) {
    const ss = st.sessionStats;
    for (const q of quotes) {
      if (q.l  != null) ss.last   = q.l;
      if (q.op != null) ss.open   = q.op;
      if (q.hi != null) ss.high   = q.hi;
      if (q.lo != null) ss.low    = q.lo;
      if (q.tv != null) ss.volume = q.tv;
    }
    // Keep the live candle moving with every quote tick
    if (st.currentBar !== null && ss.last > 0) {
      const px = snap(ss.last, st.cfg.tick);
      st.currentBar.c = px;
      if (px > st.currentBar.h) st.currentBar.h = px;
      if (px < st.currentBar.l) st.currentBar.l = px;
    }
    // Keep watchlist sidebar prices live for this instrument
    updateWatchlistEntry(st.cfg.instrument, ss.last, ss.open);
  }

  function handleDepth(st, depths) {
    for (const d of depths) {
      const bids = (d.b || []).slice().sort((a, b) => b.p - a.p);
      const asks = (d.a || []).slice().sort((a, b) => a.p - b.p);
      const mid  = st.sessionStats.last;
      const levels = [];
      for (let i = Math.min(4, asks.length - 1); i >= 0; i--) {
        const a = asks[i];
        levels.push({ px: a.p, bid: 0, ask: a.sz ?? a.o ?? 0, cumBid: 0, cumAsk: a.is ?? 0, last: false });
      }
      levels.push({ px: mid, bid: 0, ask: 0, cumBid: 0, cumAsk: 0, last: true });
      for (let i = 0; i < Math.min(5, bids.length); i++) {
        const b = bids[i];
        levels.push({ px: b.p, bid: b.sz ?? b.o ?? 0, ask: 0, cumBid: b.is ?? 0, cumAsk: 0, last: false });
      }
      st.domState = levels;
    }
  }

  function handleTrades(st, trades) {
    for (const t of trades) {
      if (!st._firstTradeLogged) {
        console.log(`[OF] first ${st.cfg.instrument} trade (raw):`, JSON.stringify(t));
        st._firstTradeLogged = true;
      }
      const td = t.td ?? t.s ?? t.side ?? 0;
      const isBuy  = td === 1 || td === 'BUY'  || td === 'B' || td === 'buy';
      const isSell = td === 2 || td === 'SELL' || td === 'S' || td === 'sell';
      const side = isBuy ? 'ask' : (isSell ? 'bid' : 'bid');
      const size = t.sz ?? 0;
      const px   = t.p  ?? 0;
      if (!px || !size) continue;

      const rawTs = t.st ?? t.tdt ?? Date.now();
      const ms = rawTs < 1e12 ? rawTs * 1000 : rawTs;
      const timeStr = new Date(ms).toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      });

      st.tapeBuffer.unshift({
        i: st.tapeBuffer.length,
        time: timeStr, px, size, side,
        block: size >= 80,
        condition: size >= 200 ? 'BLOCK' : (size >= 80 ? 'SWEEP' : ''),
        tier: 'sm',
        clusterLen: 1,
      });
      if (st.tapeBuffer.length > MAX_TAPE) st.tapeBuffer.length = MAX_TAPE;

      // Accumulate into current bar's footprint
      if (st.currentBar !== null) {
        const ts = st.currentBar.time;
        if (!st.tradeAccum[ts]) st.tradeAccum[ts] = {};
        const k = px.toFixed(2);
        if (!st.tradeAccum[ts][k]) st.tradeAccum[ts][k] = { px, bid: 0, ask: 0 };
        if (side === 'ask') st.tradeAccum[ts][k].ask += size;
        else                st.tradeAccum[ts][k].bid += size;
        if (st.currentBar._firstTradePx === undefined) st.currentBar._firstTradePx = px;
        st.currentBar._lastTradePx = px;
      }

      const ss = st.sessionStats;
      ss.delta += side === 'ask' ? size : -size;
      ss.last = px;

      st.vwapAccum.sumPV += px * size;
      st.vwapAccum.sumV  += size;
      if (st.vwapAccum.sumV > 0) {
        const T = st.cfg.tick;
        ss.vwap = Math.round((st.vwapAccum.sumPV / st.vwapAccum.sumV) / T) * T;
      }

      const dk = px.toFixed(2);
      if (!st.domSessionDelta[dk]) st.domSessionDelta[dk] = { buy: 0, sell: 0 };
      if (side === 'ask') st.domSessionDelta[dk].buy  += size;
      else                st.domSessionDelta[dk].sell += size;

      if (size >= LARGE_TRADE_MIN) {
        st.largeTrades.unshift({
          time: timeStr,
          barTime: st.currentBar ? st.currentBar.time : null,
          sym: st.cfg.instrument,
          type: size >= 200 ? 'BLOCK' : 'SWEEP',
          side: side === 'ask' ? 'buy' : 'sell',
          size, px,
          notional: Math.round((px * size * 50) / 1000),
          venue: 'CME',
        });
        if (st.largeTrades.length > 50) st.largeTrades.length = 50;
      }
    }
    if (trades.length) pushToBackend('/ingest/ticks', { instrument: st.cfg.instrument, trades });
  }

  function handleTimeBars(st, msgs) {
    const TICK = st.cfg.tick;
    for (const bar of msgs) {
      const barTs = bar.t > 9_999_999_999 ? Math.floor(bar.t / 1000) : bar.t;
      const O = snap(bar.o, TICK), H = snap(bar.h, TICK), L = snap(bar.l, TICK), C = snap(bar.c, TICK);
      const vol = bar.v ?? 0;

      if (st.currentBar === null) {
        st.currentBar = makeBar(0, barTs, O, H, L, C, vol);
        continue;
      }

      if (barTs > st.currentBar.time) {
        finaliseBar(st, st.currentBar);
        pushToBackend('/ingest/bars', { instrument: st.cfg.instrument, bars: [{
          t: st.currentBar.time, o: st.currentBar.o, h: st.currentBar.h,
          l: st.currentBar.l,   c: st.currentBar.c, v: st.currentBar.vol,
        }] });
        st.bars.push(st.currentBar);
        if (st.bars.length > MAX_BARS) st.bars.shift();
        st.bars.forEach((b, i) => { b.i = i; });
        st.currentBar = makeBar(st.bars.length, barTs, O, H, L, C, vol);
        st._expensiveRebuildNeeded = true;
      } else {
        st.currentBar.h   = Math.max(st.currentBar.h, H);
        st.currentBar.l   = Math.min(st.currentBar.l, L);
        st.currentBar.c   = C;
        st.currentBar.vol = vol;
      }
    }
  }

  // ── Bar helpers ───────────────────────────────────────────────────────────
  function snap(px, tick) {
    const t = tick ?? 0.25;
    return Math.round(Math.round((px ?? 0) / t) * t * 100) / 100;
  }

  function makeBar(idx, time, o, h, l, c, vol) {
    return {
      i: idx, time, o, h, l, c, vol,
      bid: 0, ask: 0, delta: 0,
      footprint: [],
      deltaIntensity: 0, stackedImb: [],
      absorption: false, exhaustion: false, unfinishedHi: false, unfinishedLo: false,
    };
  }

  function finaliseBar(st, bar) {
    const accum = st.tradeAccum[bar.time] || {};
    const cells = Object.values(accum).sort((a, b) => a.px - b.px);
    let tb = 0, ta = 0;
    cells.forEach(c => { tb += c.bid; ta += c.ask; });
    bar.footprint = cells;
    bar.bid   = tb;
    bar.ask   = ta;
    bar.vol   = (tb + ta) || bar.vol;
    bar.delta = ta - tb;
    delete st.tradeAccum[bar.time];
  }

  // ── Watchlist updates ─────────────────────────────────────────────────────
  function updateWatchlistEntry(instrument, last, open) {
    for (const g of WATCHLIST) {
      for (const it of g.items) {
        if (it.sym === instrument) {
          it.px = last;
          it.ch = open > 0 ? ((last - open) / open) * 100 : 0;
        }
      }
    }
  }

  // ── Analytics (adapted from data.js) ─────────────────────────────────────

  function analyzeFootprint(st, candles) {
    if (!candles.length) return;
    const TICK = st.cfg.tick;
    const ratios = [];
    candles.forEach(c => c.footprint.forEach(f => {
      if (f.bid > 0 && f.ask > 0)
        ratios.push(Math.max(f.ask, f.bid) / Math.max(1, Math.min(f.ask, f.bid)));
    }));
    const mean  = ratios.length ? ratios.reduce((s, x) => s + x, 0) / ratios.length : 2;
    const sigma = ratios.length ? Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length) : 0.8;
    const rawThr = mean + 1.2 * sigma;
    st._smoothedThr = st._smoothedThr === 0 ? rawThr : st._smoothedThr * 0.85 + rawThr * 0.15;
    const thr = st._smoothedThr;

    const allAbsDelta = candles.map(c => Math.abs(c.delta));
    const maxAbsDelta = Math.max(1, safeMax(allAbsDelta));
    const avgAbsDelta = allAbsDelta.reduce((s, x) => s + x, 0) / Math.max(1, allAbsDelta.length);
    const volSorted   = candles.map(c => c.vol).slice().sort((a, b) => a - b);
    const volP75      = volSorted[Math.floor(volSorted.length * 0.75)] ?? 0;

    candles.forEach(c => {
      c.deltaIntensity = Math.abs(c.delta) / maxAbsDelta;
      c.footprint.forEach((f, i) => {
        const up = c.footprint[i + 1];
        const dn = c.footprint[i - 1];
        f.askImb = up ? f.ask / Math.max(1, up.bid) >= thr : false;
        f.bidImb = dn ? f.bid / Math.max(1, dn.ask) >= thr : false;
      });
      const fp = c.footprint;
      const stacks = [];
      let dir = null, start = 0;
      for (let i = 0; i < fp.length; i++) {
        const f = fp[i];
        const cur = f.askImb ? 'ask' : (f.bidImb ? 'bid' : null);
        if (cur !== dir) {
          if (dir && (i - start) >= 3) {
            const stackMid = (start + i - 1) / 2;
            const pos      = stackMid / fp.length;
            const highConv = (dir === 'ask' && pos >= 0.67) || (dir === 'bid' && pos <= 0.33);
            stacks.push({ dir, from: start, to: i - 1, pos, highConv });
          }
          dir = cur; start = i;
        }
      }
      if (dir && (fp.length - start) >= 3) {
        const stackMid = (start + fp.length - 1) / 2;
        const pos      = stackMid / fp.length;
        const highConv = (dir === 'ask' && pos >= 0.67) || (dir === 'bid' && pos <= 0.33);
        stacks.push({ dir, from: start, to: fp.length - 1, pos, highConv });
      }
      c.stackedImb = stacks;
      const range = Math.max(TICK, c.h - c.l);
      const mid   = (c.h + c.l) / 2;
      const strongDelta = Math.abs(c.delta) > avgAbsDelta * 1.4;
      const highVol     = c.vol > volP75;

      const deltaDiv   = (c.delta > 0 && c.c < mid) || (c.delta < 0 && c.c > mid);
      c.absorption = highVol && strongDelta && deltaDiv;

      const deltaAlign = (c.delta > 0 && c.c > c.o) || (c.delta < 0 && c.c < c.o);
      let extremeThin = false;
      if (c.footprint.length >= 4) {
        if (c.delta > 0) {
          const top = c.footprint.slice(-3);
          extremeThin = top.slice(1).every((f, i) => (f.bid + f.ask) < (top[i].bid + top[i].ask));
        } else if (c.delta < 0) {
          const bot = c.footprint.slice(0, 3);
          extremeThin = bot.slice(0, -1).every((f, i) => (f.bid + f.ask) < (bot[i + 1].bid + bot[i + 1].ask));
        }
      }
      c.exhaustion = highVol && strongDelta && deltaAlign && extremeThin;
      const top = c.footprint[c.footprint.length - 1];
      const bot = c.footprint[0];
      const topT = top ? top.bid + top.ask : 0;
      const botT = bot ? bot.bid + bot.ask : 0;
      c.unfinishedHi = topT >= 8 && top.ask / topT > 0.9;
      c.unfinishedLo = botT >= 8 && bot.bid / botT > 0.9;
    });

    st.footprintStats = { thr, mean, sigma, maxAbsDelta, avgAbsDelta };
    if (st.cfg.instrument === _activeInstr) window.OF_FOOTPRINT_STATS = st.footprintStats;
  }

  function analyzeTape(st) {
    const tape = st.tapeBuffer;
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
    const maxSz = Math.max(1, safeMax(tape, t => t.size));
    const bins = new Array(12).fill(0);
    tape.forEach(t => {
      const b = Math.min(11, Math.floor(Math.log2(t.size + 1) / Math.log2(maxSz + 1) * 12));
      bins[b]++;
    });
    const recent = tape.slice(0, 50);
    const buys = recent.filter(t => t.side === 'ask').length;
    st.tapeStats = {
      thr, velocity,
      maxVelocity: Math.max(1, safeMax(velocity)),
      avgVelocity: velocity.length ? velocity.reduce((s, x) => s + x, 0) / velocity.length : 0,
      histogram: bins,
      aggressorPct: recent.length ? buys / recent.length : 0.5,
      windowN: recent.length,
    };
    if (st.cfg.instrument === _activeInstr) window.OF_TAPE_STATS = st.tapeStats;
  }

  // ── Derived data builders ─────────────────────────────────────────────────
  function syntheticFootprint(bar, TICK) {
    if (!bar.vol || bar.h <= bar.l) return [];
    const lo    = Math.round(bar.l / TICK) * TICK;
    const hi    = Math.round(bar.h / TICK) * TICK;
    const range = Math.max(hi - lo, TICK);
    const levels = [];
    let totalW = 0;
    for (let px = lo; px <= hi + TICK / 2; px = Math.round((px + TICK) * 100) / 100) {
      const w = Math.max(0.05, 1 - Math.abs(px - bar.c) / range);
      levels.push({ px, w });
      totalW += w;
    }
    return levels.map(({ px, w }) => {
      const half = (bar.vol * w / totalW) / 2;
      return { px, bid: half, ask: half, synthetic: true };
    });
  }

  function buildVP(allBars, TICK) {
    const buckets = new Map();
    allBars.forEach(c => {
      const fp = c.footprint.length > 0 ? c.footprint : syntheticFootprint(c, TICK);
      fp.forEach(f => {
        const key = f.px.toFixed(2);
        const cur = buckets.get(key) || { px: f.px, buy: 0, sell: 0 };
        cur.buy  += f.ask;
        cur.sell += f.bid;
        buckets.set(key, cur);
      });
    });
    if (!buckets.size) return { rows: [], poc: 0, vah: 0, val: 0, total: 0 };
    const arr = Array.from(buckets.values()).sort((a, b) => b.px - a.px);
    const max = Math.max(1, safeMax(arr, r => r.buy + r.sell));
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
      r.poc = i === pocIdx; r.va = i >= lo && i <= hi;
      r.pct = (r.buy + r.sell) / max;
      r.buyPct = r.buy / max; r.sellPct = r.sell / max;
    });
    return { rows: arr, vah: arr[lo].px, val: arr[hi].px, poc: arr[pocIdx].px, total };
  }

  function buildDailyVP(allBars, TICK) {
    const dayBuckets = new Map();
    allBars.forEach(bar => {
      const d   = new Date(bar.time * 1000);
      const key = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      if (!dayBuckets.has(key)) dayBuckets.set(key, []);
      dayBuckets.get(key).push(bar);
    });
    const days = [];
    for (const [date, dayBars] of dayBuckets)
      days.push({ date, barTimes: dayBars.map(b => b.time), ...buildVP(dayBars, TICK) });
    return days;
  }

  function buildWeeklyVP(allBars, TICK) {
    const weekBuckets = new Map();
    allBars.forEach(bar => {
      const d  = new Date(bar.time * 1000);
      const ct = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
      const day = ct.getDay();
      const diff = ct.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(ct); mon.setDate(diff); mon.setHours(0, 0, 0, 0);
      const key = mon.toISOString().slice(0, 10);
      if (!weekBuckets.has(key)) weekBuckets.set(key, []);
      weekBuckets.get(key).push(bar);
    });
    const weeks = [];
    for (const [weekStart, weekBars] of weekBuckets)
      weeks.push({ weekStart, barTimes: weekBars.map(b => b.time), ...buildVP(weekBars, TICK) });
    return weeks;
  }

  function buildTPO(allBars, TICK) {
    if (!allBars.length) return { rows: [], periods: [], poc: 0, vah: 0, val: 0, ibHi: 0, ibLo: 0 };
    const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const PER_PERIOD = 6;
    const periods = [];
    for (let p = 0; p * PER_PERIOD < allBars.length; p++) {
      const slice = allBars.slice(p * PER_PERIOD, (p + 1) * PER_PERIOD);
      if (!slice.length) break;
      periods.push({
        letter: LETTERS[p % 26],
        lo: safeMin(slice, c => c.l),
        hi: safeMax(slice, c => c.h),
      });
    }
    const minPx = safeMin(allBars, c => c.l);
    const maxPx = safeMax(allBars, c => c.h);
    const lo    = Math.floor(minPx / TICK) * TICK;
    const hi    = Math.ceil(maxPx  / TICK) * TICK;
    const nBins = Math.min(400, Math.round((hi - lo) / TICK) + 1);
    const rows  = [];
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

  // ── Commit to window.OF_DATA_BY_SYM and notify React ─────────────────────
  function commitData(st) {
    const TICK  = st.cfg.tick;
    const instr = st.cfg.instrument;
    const isActive = instr === _activeInstr;

    // Build a display copy of currentBar with live accumulated footprint
    let liveCurrentBar = st.currentBar;
    if (st.currentBar !== null) {
      const liveAccum    = st.tradeAccum[st.currentBar.time] || {};
      const liveFootprint = Object.values(liveAccum).sort((a, b) => a.px - b.px);
      if (liveFootprint.length > 0) {
        const fpHi = liveFootprint[liveFootprint.length - 1].px;
        const fpLo = liveFootprint[0].px;
        let liveBid = 0, liveAsk = 0;
        liveFootprint.forEach(f => { liveBid += f.bid; liveAsk += f.ask; });
        const liveO = st.currentBar._firstTradePx ?? fpLo;
        const liveC = st.currentBar._lastTradePx  ?? fpHi;
        liveCurrentBar = { ...st.currentBar, o: liveO, h: fpHi, l: fpLo, c: liveC, footprint: liveFootprint, bid: liveBid, ask: liveAsk, delta: liveAsk - liveBid };
      } else {
        const pinPx = st.currentBar.c;
        liveCurrentBar = { ...st.currentBar, o: pinPx, h: pinPx, l: pinPx, c: pinPx };
      }
    }
    const allBars = liveCurrentBar ? [...st.bars, liveCurrentBar] : [...st.bars];

    analyzeTape(st);

    const ss = st.sessionStats;
    if (allBars.length) {
      const bHi = allBars.reduce((m, b) => b.h > m ? b.h : m, -Infinity);
      const bLo = allBars.reduce((m, b) => b.l < m ? b.l : m,  Infinity);
      if (!ss.high || bHi > ss.high) ss.high = bHi;
      if (!ss.low  || bLo < ss.low)  ss.low  = bLo;
    }

    if (st._expensiveRebuildNeeded) {
      const recentBars = allBars.length > 300 ? allBars.slice(-300) : allBars;
      analyzeFootprint(st, recentBars);
      st._cachedVP       = buildVP(allBars, TICK);
      st._cachedDailyVP  = buildDailyVP(allBars, TICK);
      st._cachedWeeklyVP = buildWeeklyVP(allBars, TICK);
      st._cachedTPO      = buildTPO(recentBars, TICK);
      st._cachedDelta    = buildDelta(allBars);
      st._expensiveRebuildNeeded = false;
    } else if (liveCurrentBar && liveCurrentBar.footprint.length > 0) {
      analyzeFootprint(st, allBars.length > 20 ? allBars.slice(-20) : allBars);
    }

    const domExec = {};
    if (st.currentBar !== null && st.tradeAccum[st.currentBar.time]) {
      for (const [k, v] of Object.entries(st.tradeAccum[st.currentBar.time])) {
        domExec[k] = { buy: v.ask, sell: v.bid };
      }
    }

    const dsdKeys = Object.keys(st.domSessionDelta);
    if (dsdKeys.length > 500) {
      const lastPx = ss.last || 0;
      dsdKeys
        .sort((a, b) => Math.abs(parseFloat(a) - lastPx) - Math.abs(parseFloat(b) - lastPx))
        .slice(500)
        .forEach(k => delete st.domSessionDelta[k]);
    }

    // Build indicator signals for this instrument
    const mgr = st.indicatorMgr;
    const INDICATOR_META = [
      [mgr.deepTrades,         'DEEP-T', 'S'],
      [mgr.deepWall,           'WALL',   'S'],
      [mgr.unfinishedAuction,  'UA',     'S'],
      [mgr.shiftCandle,        'SHIFT',  'S'],
      [mgr.imbalanceTracker,   'IMB',    'S'],
      [mgr.deepVTracker,       'VTRK',   'A'],
      [mgr.volumeProfile,      'VP',     'A'],
      [mgr.deltaCumulative,    'CVD',    'A'],
      [mgr.stopSpotter,        'STOP',   'A'],
      [mgr.speedOfTape,        'TAPE',   'A'],
      [mgr.divergenceDetector, 'DIV',    'A'],
      [mgr.patternBuilder,     'PAT',    'A'],
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

    st.indicators = {
      deepTrades:         { recentBlocks: mgr.deepTrades.megaPrints, absorptionLevels: mgr.deepTrades.state.absorptionLevels },
      deepWall:           mgr.deepWall.state,
      unfinishedAuction:  mgr.unfinishedAuction.state,
      shiftCandle:        mgr.shiftCandle.state,
      imbalanceTracker:   mgr.imbalanceTracker.state,
      deepVTracker:       mgr.deepVTracker.state,
      volumeProfile:      mgr.volumeProfile.state,
      deltaCumulative:    mgr.deltaCumulative.state,
      stopSpotter:        mgr.stopSpotter.state,
      speedOfTape:        mgr.speedOfTape.state,
      divergenceDetector: mgr.divergenceDetector.state,
      patternBuilder:     mgr.patternBuilder.state,
      allSignals,
    };

    const data = {
      TICK,
      watchlist: WATCHLIST,
      candles: allBars,
      last: ss.last || 0,
      dom: st.domState,
      domExec,
      domSessionDelta: st.domSessionDelta,
      vp:       st._cachedVP,
      dailyVP:  st._cachedDailyVP,
      weeklyVP: st._cachedWeeklyVP,
      tpo:      st._cachedTPO,
      delta:    st._cachedDelta,
      tape:     st.tapeBuffer,
      largeTrades: st.largeTrades,
      bidAskRatio: buildBidAskRatio(st.tapeBuffer),
      sessionStats: { ...ss },
    };

    window.OF_DATA_BY_SYM[instr] = data;

    if (isActive) {
      window.OF_DATA          = data;
      window.OF_FOOTPRINT_STATS = st.footprintStats;
      window.OF_TAPE_STATS    = st.tapeStats;
      window.OF_INDICATORS    = st.indicators;
      window.OF_INDICATOR_MGR = st.indicatorMgr;
    }

    document.dispatchEvent(new CustomEvent('of-data-update'));
  }

  // ── Historical bars from backend OHLCV store ──────────────────────────────
  async function loadHistoricalBars(st) {
    if (st._isLoadingHistorical) return;
    st._isLoadingHistorical = true;
    try {
      const now  = new Date();
      const from = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const to   = now.toISOString();
      const resp = await fetch(
        `${BACKEND_URL}/ohlcv?instrument=${st.cfg.instrument}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.bars || !data.bars.length) return;

      const TICK = st.cfg.tick;
      const buckets = new Map();
      for (const b of data.bars) {
        const ts      = Math.floor(new Date(b.timestamp).getTime() / 1000);
        const aligned = Math.floor(ts / 300) * 300;
        if (!buckets.has(aligned)) {
          buckets.set(aligned, { o: b.open, h: b.high, l: b.low, c: b.close, vol: b.volume });
        } else {
          const cur = buckets.get(aligned);
          if (b.high > cur.h) cur.h = b.high;
          if (b.low < cur.l)  cur.l = b.low;
          cur.c   = b.close;
          cur.vol += b.volume;
        }
      }

      const existingTimes = new Set(st.bars.map(b => b.time));
      if (st.currentBar !== null) existingTimes.add(st.currentBar.time);
      const newBars = [];
      for (const [ts, ohlcv] of buckets) {
        if (!existingTimes.has(ts))
          newBars.push(makeBar(0, ts, snap(ohlcv.o, TICK), snap(ohlcv.h, TICK), snap(ohlcv.l, TICK), snap(ohlcv.c, TICK), ohlcv.vol));
      }
      if (!newBars.length) return;

      st.bars = [...newBars, ...st.bars].sort((a, b) => a.time - b.time);
      st.bars.forEach((b, i) => { b.i = i; });
      st._expensiveRebuildNeeded = true;
      commitData(st);
      console.log(`[OF] ${st.cfg.instrument} historical: seeded ${newBars.length} bars from backend`);
    } catch (e) {
      console.debug(`[OF] ${st.cfg.instrument} historical bars unavailable:`, e.message);
    } finally {
      st._isLoadingHistorical = false;
    }
  }

  // Restore session footprint data from backend tick store on page load
  async function loadFootprintBars(st) {
    try {
      const now  = new Date();
      const from = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const to   = now.toISOString();
      const resp = await fetch(
        `${BACKEND_URL}/footprint?instrument=${st.cfg.instrument}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      );
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.bars || !data.bars.length) return;

      const fpMap = new Map();
      for (const fb of data.bars) {
        const ts      = Math.floor(new Date(fb.timestamp).getTime() / 1000);
        const aligned = Math.floor(ts / 300) * 300;
        if (!fpMap.has(aligned)) fpMap.set(aligned, new Map());
        const lvMap = fpMap.get(aligned);
        for (const lv of fb.levels) {
          const k = lv.price.toFixed(2);
          if (!lvMap.has(k)) lvMap.set(k, { px: lv.price, bid: 0, ask: 0 });
          const cur = lvMap.get(k);
          cur.bid += lv.bid_vol;
          cur.ask += lv.ask_vol;
        }
      }

      let merged = 0;
      for (const bar of st.bars) {
        if (bar.footprint.length > 0) continue;
        const lvMap = fpMap.get(bar.time);
        if (!lvMap) continue;
        bar.footprint = Array.from(lvMap.values()).sort((a, b) => a.px - b.px);
        let bid = 0, ask = 0;
        bar.footprint.forEach(f => { bid += f.bid; ask += f.ask; });
        bar.bid = bid; bar.ask = ask; bar.delta = ask - bid;
        merged++;
      }

      if (merged > 0) {
        st._expensiveRebuildNeeded = true;
        commitData(st);
        console.log(`[OF] ${st.cfg.instrument} footprint: restored ${merged} bars from backend`);
      }
    } catch (e) {
      console.debug(`[OF] ${st.cfg.instrument} footprint restore unavailable:`, e.message);
    }
  }

  window.OF_RELOAD_OHLCV = () => {
    const activeSt = instrStates.get(_activeInstr);
    if (activeSt) loadHistoricalBars(activeSt);
  };

  // ── Public entry point (called by auth form) ──────────────────────────────
  window.connectIronBeam = async function (username, password) {
    const errEl = document.getElementById('auth-error');
    if (errEl) errEl.textContent = 'Connecting…';
    try {
      token = await authenticate(username, password);
      const sid = await createStream(token);
      hideOverlay();
      if (!MOCK && username && username !== 'mock') {
        try {
          localStorage.setItem('ib_user', username);
          localStorage.setItem('ib_pass', password);
        } catch (_) {}
        fetch(`${BACKEND_URL}/connect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }).then(r => r.json()).then(d => {
          console.log('[OF] orderflow backend connected:', d);
        }).catch(() => {
          console.log('[OF] orderflow backend not reachable — skipping');
        });
      }
      openWS(token, sid);
    } catch (err) {
      console.error('[OF] connect error:', err);
      if (errEl) errEl.textContent = err.message || 'Connection failed — check credentials';
    }
  };

  // Load historical OHLCV + restore session footprint for active instrument only
  setTimeout(() => {
    const activeSt = instrStates.get(_activeInstr);
    if (activeSt) loadHistoricalBars(activeSt).then(() => loadFootprintBars(activeSt));
    // Kick yfinance backfill to fill any OHLCV gaps, then reload bars into charts
    fetch(`${BACKEND_URL}/backfill/run`, { method: 'POST' })
      .then(r => r.ok ? window.OF_RELOAD_OHLCV?.() : null)
      .catch(() => {});
  }, 500);

  // Mock mode: auto-connect silently
  if (MOCK) {
    window.connectIronBeam('mock', 'mock');
  } else {
    try {
      const savedUser = localStorage.getItem('ib_user');
      const savedPass = localStorage.getItem('ib_pass');
      if (savedUser && savedPass) {
        const userEl = document.getElementById('ib-user');
        const passEl = document.getElementById('ib-pass');
        if (userEl) userEl.value = savedUser;
        if (passEl) passEl.value = savedPass;
        setTimeout(() => window.connectIronBeam(savedUser, savedPass), 200);
      }
    } catch (_) {}
  }
  // Without saved credentials the overlay stays open for manual login
})();
