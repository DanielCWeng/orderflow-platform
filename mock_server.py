#!/usr/bin/env python3
"""
mock_server.py v4 — Realistic IronBeam API mock for orderflow-platform.

Key improvements over v3:
  1. Decoupled market simulator from WS connections (single background loop)
  2. History → live price continuity (global state synced after history gen)
  3. L1 consumption adds to L2 instead of overwriting
  4. Uncross only adjusts one side (no double vacuum)
  5. Spread tightener randomly picks bid or ask side
  6. Spoofing renders at empty price levels
  7. Burst trade timestamps are staggered
  8. GARCH uses correct lag index (-1 not -2)
  9. Iceberg dynamically trails price during absorption

Requirements:
    pip install aiohttp

Run:
    python mock_server.py

Then in data-live.js set MOCK = true (line 11).
Bars close every 30 s in mock mode (vs 300 s prod) so the chart fills quickly.
"""

import asyncio
import json
import math
import random
import time
import uuid
from collections import deque
from aiohttp import web

# ── Constants ──────────────────────────────────────────────────────────────────
PORT         = 8001
TICK         = 0.25
BAR_SEC      = 30
SYMBOL       = 'XCME:ESH6'
INIT_PX      = 5842.25
DEPTH_LEVELS = 10
HISTORY_BARS = 240   # ~120 min of 30 s bars

# ── Regime definitions ─────────────────────────────────────────────────────────
# (name, duration_s, buy_bias, ask_rep_base, bid_rep_base, vol_scalar, base_trade_hz_s)
#
# buy_bias is the CENTER of the OU process, not a hard probability.
# Actual buy_prob fluctuates ±0.12 around this with momentum.
# Replenish bases are MEDIAN values — actual sizes vary ±50% each tick.
BASE_REGIMES = [
    ('open_gap',       60,  0.57, 500,  450, 1.0, 0.09),
    ('hard_trend',     90,  0.64, 250,  700, 1.0, 0.10),
    ('absorption',     75,  0.70,2400,  500, 1.0, 0.12),
    ('lunchtime_chop',120,  0.50,1600, 1600, 1.0, 0.60),
    ('failed_auction', 60,  0.36, 700,  250, 1.0, 0.09),
    ('close_accel',    90,  0.62, 300,  650, 1.0, 0.07),
]

NEWS_REGIME_UP   = ('news_release',    6,  0.88,  50,  50, 6.0, 0.20)
NEWS_REGIME_DOWN = ('news_release',    6,  0.12,  50,  50, 6.0, 0.20)
POST_NEWS_REGIME = ('post_news_chop', 45,  0.50, 600, 600, 1.0, 0.80)

NEWS_PROB = 0.15

# ── Regime transition blending ─────────────────────────────────────────────────
BLEND_DURATION = 8.0  # seconds to blend from old regime params to new


# ── CORS helpers ───────────────────────────────────────────────────────────────
CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

def json_ok(data: dict) -> web.Response:
    r = web.json_response(data)
    r.headers.update(CORS)
    return r

def snap(p: float) -> float:
    return round(round(p / TICK) * TICK, 2)


# ── Limit Order Book ──────────────────────────────────────────────────────────
class LOB:
    """
    Stateful limit order book with crossed-book protection.
    """

    def __init__(self, mid: float):
        self.bids: dict[float, int] = {}
        self.asks: dict[float, int] = {}
        # Current regime targets — updated by replenish(), used by _fill_side()
        self.bid_target: int = 400
        self.ask_target: int = 400
        self._seed(mid)

    def _seed(self, mid: float):
        for i in range(1, DEPTH_LEVELS + 2):
            bp = snap(mid - i * TICK)
            ap = snap(mid + i * TICK)
            base = max(1, int(200 * math.exp(-i * 0.18)))
            self.bids[bp] = base + random.randint(0, base)
            self.asks[ap] = base + random.randint(0, base)

    def best_bid(self) -> float:
        return max(self.bids) if self.bids else 0.0

    def best_ask(self) -> float:
        return min(self.asks) if self.asks else 0.0

    def mid(self) -> float:
        bb, ba = self.best_bid(), self.best_ask()
        if bb and ba:
            return (bb + ba) / 2
        return bb or ba or INIT_PX

    def _uncross(self):
        """Remove any crossed levels — only adjust the side with fewer affected levels."""
        ba = self.best_ask()
        bb = self.best_bid()
        if not ba or not bb:
            return
        if bb >= ba:
            crossed_bids = [p for p in self.bids if p >= ba]
            crossed_asks = [p for p in self.asks if p <= bb]
            # Only delete the smaller side to avoid double vacuum
            if len(crossed_bids) <= len(crossed_asks):
                for p in crossed_bids:
                    del self.bids[p]
            else:
                for p in crossed_asks:
                    del self.asks[p]

    def consume_ask(self, size: int, replenish: int) -> tuple[float, bool]:
        """Market buy hits best ask.  Returns (trade_px, level_cleared)."""
        px = self.best_ask()
        if not px:
            return 0.0, False
        self.asks[px] = max(0, self.asks[px] - size)
        if self.asks[px] <= 0:
            del self.asks[px]
            new_px = snap(px + TICK)
            # Only add if it doesn't cross
            bb = self.best_bid()
            if not bb or new_px > bb:
                jitter = max(1, replenish // 3)
                # Add to existing level instead of overwriting (fix 2A)
                current_sz = self.asks.get(new_px, 0)
                self.asks[new_px] = max(1, current_sz + replenish + random.randint(-jitter, jitter))
            self._fill_side('ask')
            self._uncross()
            return px, True
        return px, False

    def consume_bid(self, size: int, replenish: int) -> tuple[float, bool]:
        """Market sell hits best bid.  Returns (trade_px, level_cleared)."""
        px = self.best_bid()
        if not px:
            return 0.0, False
        self.bids[px] = max(0, self.bids[px] - size)
        if self.bids[px] <= 0:
            del self.bids[px]
            new_px = snap(px - TICK)
            ba = self.best_ask()
            if not ba or new_px < ba:
                jitter = max(1, replenish // 3)
                # Add to existing level instead of overwriting (fix 2A)
                current_sz = self.bids.get(new_px, 0)
                self.bids[new_px] = max(1, current_sz + replenish + random.randint(-jitter, jitter))
            self._fill_side('bid')
            self._uncross()
            return px, True
        return px, False

    def _fill_side(self, side: str):
        """Ensure DEPTH_LEVELS on the given side using regime-aware sizes."""
        bb = self.best_bid()
        ba = self.best_ask()
        if side == 'bid' and bb:
            for i in range(1, DEPTH_LEVELS + 2):
                px = snap(bb - i * TICK)
                if ba and px >= ba:
                    continue
                if px not in self.bids:
                    base = max(1, int(self.bid_target * math.exp(-i * 0.18)))
                    self.bids[px] = base + random.randint(0, max(1, base // 3))
        if side == 'ask' and ba:
            for i in range(1, DEPTH_LEVELS + 2):
                px = snap(ba + i * TICK)
                if bb and px <= bb:
                    continue
                if px not in self.asks:
                    base = max(1, int(self.ask_target * math.exp(-i * 0.18)))
                    self.asks[px] = base + random.randint(0, max(1, base // 3))

    def _fill(self):
        self._fill_side('bid')
        self._fill_side('ask')

    def replenish(self, ask_rep: int, bid_rep: int):
        """
        Mean-reversion of resting sizes toward noisy regime targets.
        Blend rate is faster for levels near L1 so trailing levels
        catch up quickly after a directional move.
        """
        # Store targets so _fill_side uses regime-appropriate sizes
        self.bid_target = bid_rep
        self.ask_target = ask_rep

        bb = self.best_bid()
        ba = self.best_ask()

        # Fix blown spread: if > 2 ticks, gently fill inward from random side (fix 2C)
        if bb and ba and round(ba - bb, 4) > TICK * 2:
            gap_ticks = int(round((ba - bb) / TICK))
            if gap_ticks > 2:
                if random.random() > 0.5:
                    fill_px = snap(ba - TICK)
                    if fill_px not in self.bids:
                        self.bids[fill_px] = max(1, bid_rep // 2 + random.randint(0, bid_rep // 4))
                else:
                    fill_px = snap(bb + TICK)
                    if fill_px not in self.asks:
                        self.asks[fill_px] = max(1, ask_rep // 2 + random.randint(0, ask_rep // 4))
                bb = self.best_bid()
                ba = self.best_ask()

        # Prune stale outer levels that drifted too far
        if bb and ba:
            stale_bid = [p for p in self.bids if p < snap(bb - (DEPTH_LEVELS + 3) * TICK)]
            for p in stale_bid:
                del self.bids[p]
            stale_ask = [p for p in self.asks if p > snap(ba + (DEPTH_LEVELS + 3) * TICK)]
            for p in stale_ask:
                del self.asks[p]

        # Mean-revert levels toward noisy targets
        # Faster blend for L1-L3 (0.35) so trailing side thickens quickly
        # Slower blend for deeper levels (0.12) — stable backdrop
        for i in range(0, DEPTH_LEVELS + 1):
            decay = math.exp(-max(0, i - 0.5) * 0.18)
            noise_b = 1.0 + random.uniform(-0.35, 0.35)
            noise_a = 1.0 + random.uniform(-0.35, 0.35)
            tb = max(1, int(bid_rep * decay * noise_b))
            ta = max(1, int(ask_rep * decay * noise_a))

            # Faster blend near the top of book
            blend = 0.35 if i <= 3 else 0.12
            keep = 1.0 - blend

            if bb:
                bp = snap(bb - i * TICK)
                if ba and bp >= ba:
                    continue
                cur = self.bids.get(bp, tb)
                self.bids[bp] = max(1, int(cur * keep + tb * blend))
            if ba:
                ap = snap(ba + i * TICK)
                if bb and ap <= bb:
                    continue
                cur = self.asks.get(ap, ta)
                self.asks[ap] = max(1, int(cur * keep + ta * blend))

        self._uncross()

        # Prune to max levels
        for px in sorted(self.bids, reverse=True)[DEPTH_LEVELS * 2:]:
            del self.bids[px]
        for px in sorted(self.asks)[DEPTH_LEVELS * 2:]:
            del self.asks[px]

    def snapshot(self) -> tuple[list, list]:
        bids = sorted(self.bids.items(), key=lambda x: -x[0])[:DEPTH_LEVELS]
        asks = sorted(self.asks.items(), key=lambda x:  x[0])[:DEPTH_LEVELS]
        return bids, asks


# ── Market state ───────────────────────────────────────────────────────────────
class Market:
    def __init__(self):
        self.price  = INIT_PX
        self.open_  = INIT_PX
        self.high   = INIT_PX
        self.low    = INIT_PX
        self.volume = 0
        self.delta  = 0
        self.lob    = LOB(INIT_PX)

        # GARCH(1,1) volatility state
        self.recent_returns: deque = deque(maxlen=40)
        self.vol: float = 0.30  # in ticks

        # Ornstein-Uhlenbeck directional bias
        # This is the ACTUAL buy probability, which mean-reverts to regime center
        self.ou_bias: float = 0.50
        self.ou_speed: float = 0.08   # reversion speed per trade
        self.ou_noise: float = 0.025  # noise per step

        # Short-term momentum: rolling sum of recent price changes in ticks
        self.recent_moves: deque = deque(maxlen=20)

        # Regime controller
        self.regime_idx   = 0
        self.regime_start = time.time()
        self.prev_regime_params: tuple | None = None  # for blending

        # Iceberg level (absorption regime)
        self.iceberg_px: float = snap(INIT_PX + 8 * TICK)

        # Spoofing
        self.flash: dict[float, tuple[int, float]] = {}
        self.last_flash = 0.0

mkt = Market()

_regime_queue: list[tuple] = []
_history: list[dict] = []
_ws_clients: set[web.WebSocketResponse] = set()  # all connected WS clients


# ── OU bias update ────────────────────────────────────────────────────────────
def update_ou_bias(m: 'Market', target: float):
    """
    Ornstein-Uhlenbeck step: bias drifts toward regime target but with
    noise and momentum influence -> organic, non-monotonic trends.
    """
    # Momentum contribution: if price has been moving up, bias nudges up
    momentum = 0.0
    if len(m.recent_moves) >= 5:
        recent_sum = sum(m.recent_moves)
        momentum = 0.003 * recent_sum  # small momentum nudge

    # OU mean reversion + noise + momentum
    reversion = m.ou_speed * (target - m.ou_bias)
    noise = m.ou_noise * random.gauss(0, 1)
    m.ou_bias += reversion + noise + momentum

    # Clamp to valid probability range with margin
    m.ou_bias = max(0.08, min(0.92, m.ou_bias))


# ── Blended regime parameters ─────────────────────────────────────────────────
def blended_params(regime: tuple, m: 'Market') -> tuple:
    """
    If we recently transitioned, blend old -> new params over BLEND_DURATION.
    Returns (name, dur, buy_bias, ask_rep, bid_rep, vol_scalar, hz).
    """
    if m.prev_regime_params is None:
        return regime

    elapsed = time.time() - m.regime_start
    if elapsed >= BLEND_DURATION:
        m.prev_regime_params = None
        return regime

    t = elapsed / BLEND_DURATION  # 0..1
    # Smooth ease-in-out
    t = t * t * (3 - 2 * t)

    old = m.prev_regime_params
    new = regime
    blended = (
        new[0],  # name from new regime
        new[1],  # duration from new regime
        old[2] + (new[2] - old[2]) * t,  # buy_bias
        int(old[3] + (new[3] - old[3]) * t),  # ask_rep
        int(old[4] + (new[4] - old[4]) * t),  # bid_rep
        old[5] + (new[5] - old[5]) * t,  # vol_scalar
        old[6] + (new[6] - old[6]) * t,  # hz
    )
    return blended


# ── Historical bar pre-generation ─────────────────────────────────────────────
def generate_history() -> list[dict]:
    """
    Simulate HISTORY_BARS bars synchronously for chart warm-up.
    """
    h = Market()
    h.lob = LOB(INIT_PX)

    now     = time.time()
    start_t = int((now - HISTORY_BARS * BAR_SEC) // BAR_SEC) * BAR_SEC

    reg_idx   = 0
    reg_start = start_t
    reg_queue: list[tuple] = [BASE_REGIMES[0]]

    def cur_regime(t: float) -> tuple:
        nonlocal reg_idx, reg_start
        cur = reg_queue[0] if reg_queue else BASE_REGIMES[reg_idx]
        if t - reg_start >= cur[1]:
            if reg_queue:
                reg_queue.pop(0)
            if not reg_queue:
                reg_idx = (reg_idx + 1) % len(BASE_REGIMES)
                if random.random() < NEWS_PROB:
                    news = NEWS_REGIME_UP if random.random() > 0.5 else NEWS_REGIME_DOWN
                    reg_queue.extend([news, POST_NEWS_REGIME])
                reg_queue.append(BASE_REGIMES[reg_idx])
            reg_start = t
            cur = reg_queue[0]
            if cur[0] == 'absorption':
                h.iceberg_px = snap(h.price + 2 * TICK)  # closer iceberg (fix 3E)
            if cur[0] == 'news_release':
                for px in list(h.lob.asks): h.lob.asks[px] = max(1, h.lob.asks[px] // 8)
                for px in list(h.lob.bids): h.lob.bids[px] = max(1, h.lob.bids[px] // 8)
        if not reg_queue:
            reg_queue.append(BASE_REGIMES[reg_idx])
        return reg_queue[0]

    messages: list[dict] = []

    for bar_i in range(HISTORY_BARS):
        bar_t  = start_t + bar_i * BAR_SEC
        reg    = cur_regime(bar_t)
        name, _, buy_bias, ask_rep, bid_rep, vol_scalar, _ = reg

        bar = {'t': bar_t, 'o': h.price, 'h': h.price,
               'l': h.price, 'c': h.price, 'v': 0}

        bar_trades: list[dict] = []
        n_ticks = random.randint(40, 85)

        for i in range(n_ticks):
            # OU bias update for history
            update_ou_bias(h, buy_bias)
            is_buy = random.random() < h.ou_bias

            sz = trade_size()

            a_rep = max(1, int(ask_rep / vol_scalar *
                               (1.0 + random.uniform(-0.4, 0.4))))
            b_rep = max(1, int(bid_rep / vol_scalar *
                               (1.0 + random.uniform(-0.4, 0.4))))

            if is_buy:
                px, _ = h.lob.consume_ask(sz, a_rep)
                side  = 'BUY'
            else:
                px, _ = h.lob.consume_bid(sz, b_rep)
                side  = 'SELL'

            if not px:
                continue

            # Iceberg: recalculate if price drifted too far (fix 3E)
            if name == 'absorption':
                if abs(h.price - h.iceberg_px) > 6 * TICK:
                    h.iceberg_px = snap(h.price + 2 * TICK)
                if is_buy and snap(px) == h.iceberg_px:
                    h.lob.asks[h.iceberg_px] = max(h.lob.asks.get(h.iceberg_px, 0), 800)

            prev    = h.price
            h.price = px
            h.high  = max(h.high, px)
            h.low   = min(h.low,  px)
            h.volume += sz
            h.delta  += sz if side == 'BUY' else -sz

            # Track momentum
            if prev:
                move = (px - prev) / TICK
                h.recent_moves.append(move)

            bar['h']  = max(bar['h'], px)
            bar['l']  = min(bar['l'], px)
            bar['c']  = px
            bar['v'] += sz

            # GARCH update (fix 3C: use -1 not -2)
            if prev:
                ret = (px - prev) / TICK
                h.recent_returns.append(ret)
                if len(h.recent_returns) >= 4:
                    w, a, b = 0.025, 0.14, 0.83
                    e2 = h.recent_returns[-1]
                    h.vol = math.sqrt(max(1e-6, w + a * e2**2 + b * h.vol**2))
                    h.vol = max(0.05, min(5.0, h.vol))

            trade_ms = int((bar_t + (i / max(n_ticks, 1)) * BAR_SEC) * 1000)
            bar_trades.append({'p': px, 'sz': sz, 'td': side, 'st': trade_ms, 'is': False})

        h.lob.replenish(
            max(1, int(ask_rep / vol_scalar)),
            max(1, int(bid_rep / vol_scalar))
        )

        messages.append({'ti': [dict(bar)]})
        if bar_trades:
            messages.append({'tr': bar_trades})

    # Sync global state with history end state (fix 1B)
    mkt.price  = h.price
    mkt.open_  = h.price
    mkt.high   = h.price
    mkt.low    = h.price
    mkt.volume = h.volume
    mkt.delta  = h.delta
    mkt.vol    = h.vol
    mkt.ou_bias = h.ou_bias
    mkt.lob    = h.lob
    mkt.recent_returns = h.recent_returns
    mkt.recent_moves = h.recent_moves
    mkt.iceberg_px = h.iceberg_px

    print(f'[mock] history: {HISTORY_BARS} bars, {len(messages)} msgs, '
          f'final px={h.price:.2f}')
    return messages


# ── Regime controller ─────────────────────────────────────────────────────────
def get_regime() -> tuple:
    global _regime_queue

    current = _regime_queue[0] if _regime_queue else BASE_REGIMES[mkt.regime_idx]
    _, dur, *_ = current
    if time.time() - mkt.regime_start >= dur:
        # Save old params for blending
        mkt.prev_regime_params = current

        if _regime_queue:
            _regime_queue.pop(0)

        if not _regime_queue:
            mkt.regime_idx = (mkt.regime_idx + 1) % len(BASE_REGIMES)
            next_regime = BASE_REGIMES[mkt.regime_idx]
            if random.random() < NEWS_PROB:
                news = NEWS_REGIME_UP if random.random() > 0.5 else NEWS_REGIME_DOWN
                _regime_queue.extend([news, POST_NEWS_REGIME])
            _regime_queue.append(next_regime)

        mkt.regime_start = time.time()
        current = _regime_queue[0]
        name = current[0]
        if name == 'absorption':
            mkt.iceberg_px = snap(mkt.price + 2 * TICK)  # closer iceberg (fix 3E)
        if name == 'news_release':
            for px in list(mkt.lob.asks):
                mkt.lob.asks[px] = max(1, mkt.lob.asks[px] // 8)
            for px in list(mkt.lob.bids):
                mkt.lob.bids[px] = max(1, mkt.lob.bids[px] // 8)
        print(f'[mock] regime -> {name}')

    if not _regime_queue:
        _regime_queue.append(BASE_REGIMES[mkt.regime_idx])

    return _regime_queue[0]


# ── Size distribution ─────────────────────────────────────────────────────────
def trade_size() -> int:
    """Empirically weighted ES size distribution."""
    r = random.random()
    if   r < 0.68: return random.randint(1, 2)
    elif r < 0.88: return random.randint(3, 10)
    elif r < 0.97: return random.randint(11, 49)
    else:          return random.randint(50, 300)


# ── GARCH vol update (fix 3C: use -1 not -2) ────────────────────────────────
def update_vol(ret_ticks: float):
    mkt.recent_returns.append(ret_ticks)
    if len(mkt.recent_returns) < 4:
        return
    w, a, b = 0.025, 0.14, 0.83
    e2 = mkt.recent_returns[-1]
    mkt.vol = math.sqrt(max(1e-6, w + a * e2 ** 2 + b * mkt.vol ** 2))
    mkt.vol = max(0.05, min(5.0, mkt.vol))


# ── Trade generation ──────────────────────────────────────────────────────────
def gen_trade(regime: tuple) -> dict | None:
    # Get blended params for smooth transitions
    params = blended_params(regime, mkt)
    name, _, buy_bias, ask_rep, bid_rep, vol_scalar, _ = params

    # Update OU bias toward regime's center
    update_ou_bias(mkt, buy_bias)

    sz     = trade_size()
    is_buy = random.random() < mkt.ou_bias

    # Replenish with regime params + noise (no vol feedback — regimes handle thickness)
    a_rep = max(1, int(ask_rep / max(0.1, vol_scalar) *
                       (1.0 + random.uniform(-0.4, 0.4))))
    b_rep = max(1, int(bid_rep / max(0.1, vol_scalar) *
                       (1.0 + random.uniform(-0.4, 0.4))))

    if is_buy:
        px, ticked = mkt.lob.consume_ask(sz, a_rep)
        side = 'BUY'
    else:
        px, ticked = mkt.lob.consume_bid(sz, b_rep)
        side = 'SELL'

    if not px:
        return None

    # Absorption iceberg — recalculate if price drifted too far (fix 3E)
    if name == 'absorption':
        if abs(mkt.price - mkt.iceberg_px) > 6 * TICK:
            mkt.iceberg_px = snap(mkt.price + 2 * TICK)
        if is_buy and snap(px) == mkt.iceberg_px:
            mkt.lob.asks[mkt.iceberg_px] = max(
                mkt.lob.asks.get(mkt.iceberg_px, 0), 800
            )

    # Update session state
    prev = mkt.price
    mkt.price = px
    mkt.high  = max(mkt.high, px)
    mkt.low   = min(mkt.low,  px)
    mkt.volume += sz
    mkt.delta  += sz if side == 'BUY' else -sz

    # Track momentum
    if prev:
        move = (px - prev) / TICK
        mkt.recent_moves.append(move)

    # GARCH
    if prev:
        update_vol((px - prev) / TICK)

    return {
        'p':  px,
        'sz': sz,
        'td': side,
        'st': int(time.time() * 1000),
        'is': False,
    }


# ── DOM generation ────────────────────────────────────────────────────────────
def gen_depth(regime: tuple) -> dict:
    params = blended_params(regime, mkt)
    name, _, _, ask_rep, bid_rep, vol_scalar, _ = params

    mkt.lob.replenish(
        max(1, int(ask_rep / max(0.1, vol_scalar))),
        max(1, int(bid_rep / max(0.1, vol_scalar)))
    )

    # Expire old flash orders
    now = time.time()
    for px in [p for p, (_, exp) in mkt.flash.items() if now >= exp]:
        del mkt.flash[px]

    bids, asks = mkt.lob.snapshot()

    # Inject flash levels into snapshot if they don't already exist (fix 3A)
    bid_pxs = {px for px, _ in bids}
    ask_pxs = {px for px, _ in asks}
    bb = mkt.lob.best_bid()
    ba = mkt.lob.best_ask()
    for flash_px, (flash_sz, _) in mkt.flash.items():
        if flash_px <= bb and flash_px not in bid_pxs:
            bids.append((flash_px, 0))
            bids.sort(key=lambda x: -x[0])
            bids = bids[:DEPTH_LEVELS]
        elif flash_px >= ba and flash_px not in ask_pxs:
            asks.append((flash_px, 0))
            asks.sort(key=lambda x: x[0])
            asks = asks[:DEPTH_LEVELS]

    def enrich(levels, is_bid):
        out = []
        for i, (px, sz) in enumerate(levels):
            flash_sz, _ = mkt.flash.get(px, (0, 0.0))
            out.append({'l': i + 1, 'p': px, 'sz': sz + flash_sz, 'o': 0, 'is': flash_sz > 0})
        return out

    return {'d': [{'s': SYMBOL, 'b': enrich(bids, True), 'a': enrich(asks, False)}]}


def maybe_spoof(regime: tuple):
    name = regime[0]
    if name not in ('lunchtime_chop', 'open_gap'):
        return
    now = time.time()
    if now - mkt.last_flash < 2.5 or random.random() > 0.12:
        return
    mkt.last_flash = now
    bb = mkt.lob.best_bid()
    ba = mkt.lob.best_ask()
    ref = ba if random.random() > 0.5 else bb
    if not ref:
        return
    sign    = 1 if ref == ba else -1
    ticks   = random.randint(5, 10)
    flash_px = snap(ref + sign * ticks * TICK)
    flash_sz = random.randint(500, 1200)
    ttl      = 1.0 + random.random() * 1.5
    mkt.flash[flash_px] = (flash_sz, now + ttl)


def gen_quote() -> dict:
    return {'q': [{
        's':  SYMBOL,
        'l':  mkt.price,
        'op': mkt.open_,
        'hi': mkt.high,
        'lo': mkt.low,
        'tv': mkt.volume,
        'b':  mkt.lob.best_bid(),
        'a':  mkt.lob.best_ask(),
    }]}


# ── HTTP handlers ─────────────────────────────────────────────────────────────
async def handle_options(_req):
    r = web.Response(status=204)
    r.headers.update(CORS)
    return r

async def handle_auth(_req):
    print('[mock] auth')
    return json_ok({'token': 'mock-' + uuid.uuid4().hex, 'status': 'OK', 'message': 'Mock auth OK'})

async def handle_create_stream(_req):
    sid = str(uuid.uuid4())
    print(f'[mock] stream: {sid[:8]}...')
    return json_ok({'streamId': sid, 'status': 'OK', 'message': ''})

async def handle_subscribe(req):
    print(f'[mock] subscribe: {req.path}')
    return json_ok({'status': 'OK', 'message': 'Subscribed'})


# ── Broadcast helper ──────────────────────────────────────────────────────────
async def broadcast(msg: str):
    """Send a message to all connected WS clients, removing dead ones."""
    dead = set()
    for ws in _ws_clients:
        try:
            await ws.send_str(msg)
        except Exception:
            dead.add(ws)
    _ws_clients -= dead


# ── Background market simulator (fix 1A) ─────────────────────────────────────
async def market_simulator_loop():
    """
    Single background loop that drives the market simulation and broadcasts
    updates to all connected clients. Decoupled from individual connections.
    """
    bar_ts = int(time.time() // BAR_SEC) * BAR_SEC
    bar = {'t': bar_ts, 'o': mkt.price, 'h': mkt.price,
           'l': mkt.price, 'c': mkt.price, 'v': 0}
    tick = 0

    while True:
        if not _ws_clients:
            await asyncio.sleep(0.25)
            continue

        regime = get_regime()
        params = blended_params(regime, mkt)
        name = params[0]
        base_hz = params[6]

        # Trade count per tick
        is_news  = (name == 'news_release')
        is_burst = (not is_news) and (random.random() < 0.07)
        n_trades = (random.randint(1, 2) if is_news
                    else random.randint(8, 20) if is_burst
                    else random.randint(1, 3))

        trades = []
        for burst_i in range(n_trades):
            t = gen_trade(regime)
            if t:
                t['st'] = t['st'] + burst_i  # stagger burst timestamps (fix 3B)
                trades.append(t)
                bar['h'] = max(bar['h'], t['p'])
                bar['l'] = min(bar['l'], t['p'])
                bar['c'] = t['p']
                bar['v'] += t['sz']

        if trades:
            await broadcast(json.dumps({'tr': trades}))

        tick += 1
        maybe_spoof(regime)

        # Bar close
        now_ts = int(time.time() // BAR_SEC) * BAR_SEC
        if now_ts > bar['t']:
            await broadcast(json.dumps({'ti': [dict(bar)]}))
            bar = {'t': now_ts, 'o': mkt.price, 'h': mkt.price,
                   'l': mkt.price, 'c': mkt.price, 'v': 0}
            print(f'[mock] bar close @ {now_ts} | {name} | bias={mkt.ou_bias:.2f} vol={mkt.vol:.2f}')

        # In-progress bar update every 3 ticks
        if tick % 3 == 0:
            await broadcast(json.dumps({'ti': [dict(bar)]}))

        # DOM refresh
        await broadcast(json.dumps(gen_depth(regime)))

        # Quote every ~10 ticks
        if tick % 10 == 0:
            await broadcast(json.dumps(gen_quote()))

        # Sleep
        if is_burst:
            await asyncio.sleep(0.015 + random.random() * 0.025)
        else:
            hz = base_hz * (0.6 + random.random() * 0.8)
            await asyncio.sleep(hz)


# ── WebSocket ─────────────────────────────────────────────────────────────────
async def handle_ws(req):
    sid = req.match_info['streamId']
    ws  = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)
    print(f'[mock] WS connected: {sid[:8]}...')

    regime = get_regime()

    # Initial snapshots
    await ws.send_str(json.dumps(gen_depth(regime)))
    await ws.send_str(json.dumps(gen_quote()))

    # Burst historical bars
    for hist_msg in _history:
        await ws.send_str(json.dumps(hist_msg))

    # Open live current bar
    bar_ts = int(time.time() // BAR_SEC) * BAR_SEC
    bar = {'t': bar_ts, 'o': mkt.price, 'h': mkt.price,
           'l': mkt.price, 'c': mkt.price, 'v': 0}
    await ws.send_str(json.dumps({'ti': [dict(bar)]}))

    # Register for broadcasts
    _ws_clients.add(ws)
    try:
        async for _msg in ws:
            pass  # client messages are ignored; market sim broadcasts updates
    except Exception as e:
        print(f'[mock] WS error: {e}')
    finally:
        _ws_clients.discard(ws)

    print(f'[mock] WS disconnected: {sid[:8]}...')
    return ws


# ── App startup ───────────────────────────────────────────────────────────────
async def on_startup(app):
    """Start the background market simulator when the server starts."""
    app['market_sim'] = asyncio.create_task(market_simulator_loop())

async def on_cleanup(app):
    """Cancel the market simulator on shutdown."""
    app['market_sim'].cancel()
    try:
        await app['market_sim']
    except asyncio.CancelledError:
        pass


# ── App ───────────────────────────────────────────────────────────────────────
app = web.Application()
app.on_startup.append(on_startup)
app.on_cleanup.append(on_cleanup)
app.router.add_route('OPTIONS', '/{path_info:.*}',                       handle_options)
app.router.add_post('/auth',                                              handle_auth)
app.router.add_get( '/v2/stream/create',                                  handle_create_stream)
app.router.add_get( '/v2/market/quotes/subscribe/{streamId}',             handle_subscribe)
app.router.add_get( '/v2/market/depths/subscribe/{streamId}',             handle_subscribe)
app.router.add_get( '/v2/market/trades/subscribe/{streamId}',             handle_subscribe)
app.router.add_post('/v2/indicator/subscribe/timebars/{streamId}',        handle_subscribe)
app.router.add_get( '/v2/stream/{streamId}',                              handle_ws)

if __name__ == '__main__':
    _regime_queue.append(BASE_REGIMES[0])
    _history = generate_history()
    cycle = sum(r[1] for r in BASE_REGIMES)
    names = ' -> '.join(r[0] for r in BASE_REGIMES) + ' (news ~15% random)'
    print('-' * 60)
    print(f'  Mock IronBeam v4   http://localhost:{PORT}')
    print(f'  Bar: {BAR_SEC}s | Cycle: {cycle}s | Symbol: {SYMBOL}')
    print(f'  {names}')
    print(f'  Set MOCK = true in data-live.js')
    print('-' * 60)
    web.run_app(app, host='0.0.0.0', port=PORT)
