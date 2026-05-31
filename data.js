// Deterministic synthetic data for ES futures orderflow display
// All numbers are made up — purely illustrative.

(function () {
  // seeded RNG
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(20260506);

  // ---- Watchlist ----
  const watchlist = [
    { group: 'Equity Index', items: [
      { sym: 'ES',  desc: 'E-mini S&P 500',   px: 5842.25, ch: +0.42, vol: '1.8M' },
      { sym: 'NQ',  desc: 'E-mini Nasdaq',    px: 20418.5, ch: +0.78, vol: '612K' },
      { sym: 'YM',  desc: 'E-mini Dow',       px: 43210,   ch: +0.18, vol: '108K' },
      { sym: 'RTY', desc: 'E-mini Russell',   px: 2284.10, ch: -0.34, vol: '174K' },
    ]},
    { group: 'Energy', items: [
      { sym: 'CL',  desc: 'Crude Oil',        px: 71.84,   ch: -1.12, vol: '420K' },
      { sym: 'NG',  desc: 'Natural Gas',      px: 3.182,   ch: +2.41, vol: '188K' },
    ]},
    { group: 'Metals', items: [
      { sym: 'GC',  desc: 'Gold',             px: 2682.4,  ch: +0.21, vol: '241K' },
      { sym: 'SI',  desc: 'Silver',           px: 31.18,   ch: -0.56, vol: '88K'  },
    ]},
    { group: 'Rates', items: [
      { sym: 'ZN',  desc: '10Y Treasury',     px: 110.21,  ch: +0.08, vol: '950K' },
      { sym: 'ZB',  desc: '30Y Bond',         px: 117.08,  ch: +0.14, vol: '210K' },
    ]},
  ];

  // ---- Candles (footprint-ready) ----
  // Each candle: { o, h, l, c, vol, delta, footprint: [{px, bid, ask}] }
  const TICK = 0.25;
  const PRICE_BASE = 5842.25;
  const N_BARS = 60;
  const SESSION_START = Math.floor(Date.UTC(2026, 2, 16, 14, 30) / 1000); // 09:30 ET, 2026-03-16
  function genCandles() {
    const out = [];
    let last = PRICE_BASE - 6;
    for (let i = 0; i < N_BARS; i++) {
      const drift = Math.sin(i / 7) * 0.8 + (rng() - 0.5) * 1.6;
      const o = last;
      const range = 1.5 + rng() * 4.5;
      const dir = drift >= 0 ? 1 : -1;
      const c = o + dir * (rng() * range);
      const h = Math.max(o, c) + rng() * (range * 0.5);
      const l = Math.min(o, c) - rng() * (range * 0.5);
      // round to TICK
      const r = (x) => Math.round(x / TICK) * TICK;
      const O = r(o), H = r(h), L = r(l), C = r(c);
      const ticks = Math.round((H - L) / TICK) + 1;
      const fp = [];
      let totalBid = 0, totalAsk = 0;
      for (let k = 0; k < ticks; k++) {
        const px = +(L + k * TICK).toFixed(2);
        // make POC near the body midpoint, scaled by gaussian-ish bump
        const mid = (O + C) / 2;
        const dist = Math.abs(px - mid);
        const w = Math.exp(-dist * 0.55);
        const v = Math.round((30 + rng() * 220) * w);
        const skew = dir > 0 ? 0.55 + rng() * 0.15 : 0.45 - rng() * 0.15;
        const ask = Math.round(v * skew);
        const bid = v - ask;
        totalAsk += ask;
        totalBid += bid;
        fp.push({ px, bid, ask });
      }
      out.push({
        i,
        time: SESSION_START + i * 300,
        o: O, h: H, l: L, c: C,
        vol: totalBid + totalAsk,
        delta: totalAsk - totalBid,
        bid: totalBid,
        ask: totalAsk,
        footprint: fp,
      });
      last = C;
    }
    // sprinkle in deliberately-shaped candles so analytics light up consistently
    // unfinished highs / lows
    [5, 17, 33, 46].forEach((idx) => {
      const c = out[idx]; if (!c) return;
      const top = c.footprint[c.footprint.length - 1];
      top.ask = Math.max(top.ask, 90 + Math.floor(rng() * 140));
      top.bid = Math.floor(top.ask * 0.04);
    });
    [11, 24, 38, 52].forEach((idx) => {
      const c = out[idx]; if (!c) return;
      const bot = c.footprint[0];
      bot.bid = Math.max(bot.bid, 90 + Math.floor(rng() * 140));
      bot.ask = Math.floor(bot.bid * 0.04);
    });
    // absorption candles: pump volume + delta but tight close-to-open
    [14, 28, 42, 55].forEach((idx) => {
      const c = out[idx]; if (!c) return;
      const mid = Math.floor(c.footprint.length / 2);
      const dir = rng() > 0.5 ? 1 : -1;
      for (let k = mid - 1; k <= mid + 1; k++) {
        if (!c.footprint[k]) continue;
        if (dir > 0) c.footprint[k].ask += 280 + Math.floor(rng() * 200);
        else c.footprint[k].bid += 280 + Math.floor(rng() * 200);
      }
      c.c = c.o + (rng() - 0.5) * TICK; // tight body
      c.c = Math.round(c.c / TICK) * TICK;
    });
    // recompute totals after surgery
    out.forEach((c) => {
      let tb = 0, ta = 0;
      c.footprint.forEach((f) => { tb += f.bid; ta += f.ask; });
      c.bid = tb; c.ask = ta; c.vol = tb + ta; c.delta = ta - tb;
    });
    return out;
  }
  const candles = genCandles();
  const lastCandle = candles[candles.length - 1];
  const last = lastCandle.c;

  // ---- DOM Ladder ----
  // 21 levels around last
  function genDOM() {
    const levels = [];
    const center = Math.round(last / TICK) * TICK;
    for (let k = 10; k >= -10; k--) {
      const px = +(center + k * TICK).toFixed(2);
      const isAsk = k > 0;
      const isBid = k < 0;
      const dist = Math.abs(k);
      const base = 220 * Math.exp(-dist * 0.18);
      const noise = 0.6 + rng() * 0.9;
      const sz = Math.max(2, Math.round(base * noise));
      // simulated trades at this level (cumulative)
      const tradesB = Math.round(sz * 0.3 * (rng() + 0.4));
      const tradesA = Math.round(sz * 0.3 * (rng() + 0.4));
      levels.push({
        px,
        bid: isBid || k === 0 ? sz : 0,
        ask: isAsk || k === 0 ? Math.round(sz * (0.85 + rng() * 0.4)) : 0,
        cumBid: isBid || k === 0 ? tradesB : 0,
        cumAsk: isAsk || k === 0 ? tradesA : 0,
        last: k === 0,
      });
    }
    return levels;
  }
  const dom = genDOM();

  // ---- Volume Profile (VPVR) — aggregated across session ----
  function genVolumeProfile() {
    const buckets = new Map();
    candles.forEach((c) => {
      c.footprint.forEach((f) => {
        const key = f.px.toFixed(2);
        const cur = buckets.get(key) || { px: f.px, buy: 0, sell: 0 };
        cur.buy += f.ask;
        cur.sell += f.bid;
        buckets.set(key, cur);
      });
    });
    const arr = Array.from(buckets.values()).sort((a, b) => b.px - a.px);
    const max = Math.max(...arr.map((r) => r.buy + r.sell));
    // POC = highest total volume row
    let pocIdx = 0;
    let pocVol = 0;
    arr.forEach((r, i) => {
      const t = r.buy + r.sell;
      if (t > pocVol) { pocVol = t; pocIdx = i; }
    });
    // Value Area: 70% of total volume, expanded from POC
    const total = arr.reduce((s, r) => s + r.buy + r.sell, 0);
    const target = total * 0.7;
    let acc = arr[pocIdx].buy + arr[pocIdx].sell;
    let lo = pocIdx, hi = pocIdx;
    while (acc < target && (lo > 0 || hi < arr.length - 1)) {
      const upVol = lo > 0 ? arr[lo - 1].buy + arr[lo - 1].sell : -1;
      const dnVol = hi < arr.length - 1 ? arr[hi + 1].buy + arr[hi + 1].sell : -1;
      if (upVol >= dnVol) { lo--; acc += upVol; }
      else { hi++; acc += dnVol; }
    }
    arr.forEach((r, i) => {
      r.poc = i === pocIdx;
      r.va = i >= lo && i <= hi;
      r.pct = (r.buy + r.sell) / max;
      r.buyPct = r.buy / max;
      r.sellPct = r.sell / max;
    });
    return { rows: arr, vah: arr[lo].px, val: arr[hi].px, poc: arr[pocIdx].px, total };
  }
  const vp = genVolumeProfile();

  // ---- TPO / Market Profile ----
  // 30-min letters across the session, mapped onto price bins.
  const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function genTPO() {
    const minPx = Math.min(...candles.map((c) => c.l));
    const maxPx = Math.max(...candles.map((c) => c.h));
    const lo = Math.floor(minPx / TICK) * TICK;
    const hi = Math.ceil(maxPx / TICK) * TICK;
    const nBins = Math.round((hi - lo) / TICK) + 1;
    // group bars into ~13 periods of ~5 bars each
    const periodSize = Math.ceil(N_BARS / 13);
    const periods = [];
    for (let p = 0; p < 13; p++) {
      const slice = candles.slice(p * periodSize, (p + 1) * periodSize);
      if (!slice.length) continue;
      const pLo = Math.min(...slice.map((c) => c.l));
      const pHi = Math.max(...slice.map((c) => c.h));
      periods.push({ letter: TPO_LETTERS[p], lo: pLo, hi: pHi });
    }
    // for each price bin, list which periods touched it
    const rows = [];
    for (let b = nBins - 1; b >= 0; b--) {
      const px = +(lo + b * TICK).toFixed(2);
      const touches = [];
      periods.forEach((p) => {
        if (px >= p.lo && px <= p.hi) touches.push(p.letter);
      });
      rows.push({ px, letters: touches });
    }
    // POC = row with most touches; VA = top 70%
    let pocIdx = 0; let pocC = 0;
    rows.forEach((r, i) => { if (r.letters.length > pocC) { pocC = r.letters.length; pocIdx = i; } });
    const totalTouches = rows.reduce((s, r) => s + r.letters.length, 0);
    const target = totalTouches * 0.7;
    let acc = rows[pocIdx].letters.length;
    let l = pocIdx, h = pocIdx;
    while (acc < target && (l > 0 || h < rows.length - 1)) {
      const up = l > 0 ? rows[l - 1].letters.length : -1;
      const dn = h < rows.length - 1 ? rows[h + 1].letters.length : -1;
      if (up >= dn) { l--; acc += up; } else { h++; acc += dn; }
    }
    rows.forEach((r, i) => {
      r.poc = i === pocIdx;
      r.va = i >= l && i <= h;
    });
    // initial balance = first 2 periods (A,B) range
    const ibLo = Math.min(periods[0].lo, periods[1] ? periods[1].lo : periods[0].lo);
    const ibHi = Math.max(periods[0].hi, periods[1] ? periods[1].hi : periods[0].hi);
    return { rows, periods, ibLo, ibHi, poc: rows[pocIdx].px, vah: rows[l].px, val: rows[h].px };
  }
  const tpo = genTPO();

  // ---- Cumulative delta series ----
  function genDelta() {
    let cum = 0;
    return candles.map((c) => {
      cum += c.delta;
      return { i: c.i, delta: c.delta, cum };
    });
  }
  const delta = genDelta();

  // ---- Time and Sales-ish summary ----
  const sessionStats = {
    open: candles[0].o,
    high: Math.max(...candles.map((c) => c.h)),
    low: Math.min(...candles.map((c) => c.l)),
    last,
    volume: candles.reduce((s, c) => s + c.vol, 0),
    delta: candles.reduce((s, c) => s + c.delta, 0),
    vwap: (() => {
      let pv = 0, vv = 0;
      candles.forEach((c) => { const tp = (c.h + c.l + c.c) / 3; pv += tp * c.vol; vv += c.vol; });
      return Math.round((pv / vv) / TICK) * TICK;
    })(),
  };

  // ---- Time & Sales (the tape) ----
  function genTape() {
    const out = [];
    // generate 80 most recent trades, time descending
    let t = 14 * 3600 + 32 * 60 + 18; // 14:32:18 ET
    let px = last;
    for (let i = 0; i < 90; i++) {
      // walk price by 0–2 ticks
      const drift = (rng() - 0.48) * 0.5;
      px = +(Math.round((px + drift) / TICK) * TICK).toFixed(2);
      // size distribution: mostly small, occasional fat
      const r = rng();
      let size;
      if (r > 0.985) size = 80 + Math.floor(rng() * 200); // block
      else if (r > 0.93) size = 25 + Math.floor(rng() * 40);
      else if (r > 0.7) size = 6 + Math.floor(rng() * 14);
      else size = 1 + Math.floor(rng() * 5);
      // aggressor: ask = buy aggressor, bid = sell aggressor
      const side = rng() > 0.49 ? 'ask' : 'bid';
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = t % 60;
      out.push({
        i,
        time: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'),
        px,
        size,
        side,
        block: size >= 80,
        condition: r > 0.985 ? 'BLOCK' : (r > 0.97 ? 'SWEEP' : ''),
      });
      // step time backward
      t -= 1 + Math.floor(rng() * 4);
    }
    return out;
  }
  const tape = genTape();

  // ---- Large trader scanner ----
  function genLargeTrades() {
    const symbols = ['ESH6', 'NQH6', 'CLG6', 'GCG6', 'ZNH6', 'YMH6', 'RTYH6', 'NGG6'];
    const types = ['BLOCK', 'SWEEP', 'ICEBERG', 'ABSORB', 'REFILL'];
    const out = [];
    let t = 14 * 3600 + 32 * 60 + 4;
    const refPx = { ESH6: 5842.25, NQH6: 20418.5, CLG6: 71.84, GCG6: 2682.4, ZNH6: 110.21, YMH6: 43210, RTYH6: 2284.10, NGG6: 3.182 };
    for (let i = 0; i < 18; i++) {
      const sym = symbols[Math.floor(rng() * symbols.length)];
      const type = types[Math.floor(rng() * types.length)];
      const side = rng() > 0.5 ? 'buy' : 'sell';
      const size = type === 'BLOCK' ? 400 + Math.floor(rng() * 1200) : 60 + Math.floor(rng() * 380);
      const notional = (refPx[sym] * size * (sym === 'ES' ? 50 : 20)) / 1000;
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = t % 60;
      const px = +(refPx[sym] + (rng() - 0.5) * refPx[sym] * 0.001).toFixed(sym === 'NGG6' ? 3 : 2);
      out.push({
        time: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'),
        sym, type, side, size, px,
        notional, // in thousands of $
        venue: rng() > 0.6 ? 'CME' : (rng() > 0.5 ? 'DARK' : 'CBOE'),
      });
      t -= 15 + Math.floor(rng() * 90);
    }
    return out;
  }
  const largeTrades = genLargeTrades();

  // ---- Bid/Ask ratio time series (last 30 windows) ----
  function genRatioSeries() {
    const out = [];
    for (let i = 0; i < 30; i++) {
      // skew slightly buy-heavy on recent windows
      const recencyBias = (i / 30) * 0.08;
      const r = 0.42 + recencyBias + (rng() - 0.5) * 0.25;
      out.push(Math.max(0.18, Math.min(0.82, r))); // ask share (buy aggressor %)
    }
    return out;
  }
  const ratioSeries = genRatioSeries();

  // ===== Analytics: footprint =====
  (function analyzeFootprint() {
    // adaptive imbalance threshold = mean + 1.2*sigma of session ratios
    const ratios = [];
    candles.forEach((c) => c.footprint.forEach((f) => {
      if (f.bid > 0 && f.ask > 0) {
        ratios.push(Math.max(f.ask, f.bid) / Math.max(1, Math.min(f.ask, f.bid)));
      }
    }));
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    const sigma = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length);
    const thr = mean + 1.2 * sigma;
    const allAbsDelta = candles.map((c) => Math.abs(c.delta));
    const maxAbsDelta = Math.max(...allAbsDelta);
    const avgAbsDelta = allAbsDelta.reduce((s, x) => s + x, 0) / allAbsDelta.length;
    const volSorted = candles.map((c) => c.vol).slice().sort((a, b) => a - b);
    const volP75 = volSorted[Math.floor(volSorted.length * 0.75)];

    candles.forEach((c) => {
      c.deltaIntensity = Math.abs(c.delta) / maxAbsDelta;
      c.footprint.forEach((f) => {
        const askR = f.ask / Math.max(1, f.bid);
        const bidR = f.bid / Math.max(1, f.ask);
        f.askImb = askR >= thr;
        f.bidImb = bidR >= thr;
      });
      // stacked imbalance runs (3+)
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
      // absorption: high vol + strong delta + tight body
      const body = Math.abs(c.c - c.o);
      const range = Math.max(TICK, c.h - c.l);
      c.absorption = c.vol > volP75 && Math.abs(c.delta) > avgAbsDelta * 1.4 && body < range * 0.3;
      // unfinished auction: extreme row dominated by one side
      const top = c.footprint[c.footprint.length - 1];
      const bot = c.footprint[0];
      const topT = top.bid + top.ask;
      const botT = bot.bid + bot.ask;
      c.unfinishedHi = topT > 0 && top.ask / topT > 0.9;
      c.unfinishedLo = botT > 0 && bot.bid / botT > 0.9;
    });
    window.OF_FOOTPRINT_STATS = { thr, mean, sigma, maxAbsDelta, avgAbsDelta };
  })();

  // ===== Analytics: tape =====
  (function analyzeTape() {
    // adaptive size tiers from session percentile
    const sizes = tape.map((t) => t.size).slice().sort((a, b) => a - b);
    const pct = (p) => sizes[Math.floor(sizes.length * p)];
    const thr = { sm: pct(0.55), md: pct(0.85), lg: pct(0.97) };
    tape.forEach((t) => {
      if (t.size > thr.lg) t.tier = 'inst';
      else if (t.size > thr.md) t.tier = 'lg';
      else if (t.size > thr.sm) t.tier = 'md';
      else t.tier = 'sm';
    });
    // same-price clustering: longest consecutive run starting from each row
    let i = 0;
    while (i < tape.length) {
      let j = i;
      while (j < tape.length && tape[j].px === tape[i].px) j++;
      const len = j - i;
      for (let k = i; k < j; k++) tape[k].clusterLen = len;
      i = j;
    }
    // velocity series — bucket per second, take last 28 seconds
    const buckets = new Map();
    tape.forEach((t) => {
      const [h, m, s] = t.time.split(':').map(Number);
      const sec = h * 3600 + m * 60 + s;
      buckets.set(sec, (buckets.get(sec) || 0) + 1);
    });
    const secs = Array.from(buckets.keys()).sort((a, b) => b - a).slice(0, 28).reverse();
    const velocity = secs.map((s) => buckets.get(s));
    // print size histogram (10 bins, log-scaled feels nicer for tape)
    const maxSz = Math.max(...tape.map((t) => t.size));
    const bins = new Array(12).fill(0);
    tape.forEach((t) => {
      const b = Math.min(11, Math.floor(Math.log2(t.size + 1) / Math.log2(maxSz + 1) * 12));
      bins[b]++;
    });
    // running aggressor ratio (last 50)
    const recent = tape.slice(0, 50);
    const buys = recent.filter((t) => t.side === 'ask').length;
    window.OF_TAPE_STATS = {
      thr,
      velocity,
      maxVelocity: Math.max(...velocity),
      avgVelocity: velocity.reduce((s, x) => s + x, 0) / velocity.length,
      histogram: bins,
      aggressorPct: buys / recent.length,
      windowN: recent.length,
    };
  })();
  // recent aggregate from tape
  const tapeBuy = tape.reduce((s, t) => s + (t.side === 'ask' ? t.size : 0), 0);
  const tapeSell = tape.reduce((s, t) => s + (t.side === 'bid' ? t.size : 0), 0);
  const bidAskRatio = {
    buy: tapeBuy,
    sell: tapeSell,
    buyPct: tapeBuy / (tapeBuy + tapeSell),
    series: ratioSeries,
  };

  window.OF_DATA = {
    TICK,
    watchlist,
    candles,
    last,
    dom,
    vp,
    tpo,
    delta,
    tape,
    largeTrades,
    bidAskRatio,
    sessionStats,
  };
})();
