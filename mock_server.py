#!/usr/bin/env python3
"""
mock_server.py v5 — Realistic IronBeam API mock for orderflow-platform.

Key improvements over v4:
  1.  LOB sweep: market orders walk through multiple price levels (consume all)
  2.  Book skew: adverse selection — attacked side loses 40% liquidity, other gains 40%
  3.  1-tick spread enforced aggressively on every replenish tick (not random)
  4.  Hawkes process: autocorrelated order flow (Markov chain blended with OU bias)
  5.  Institutional sweep: large orders replaced by 20-40 TWAP-style 5-15 lot trades
  6.  Spoof distance 2-4 ticks from inside; flash removed when price within 1 tick
  7.  Static iceberg at nearest $5 round number (no dynamic trailing)
  8.  Regime durations proportional to real trading day (~27 min full cycle at 30 s bars)

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
import os
import random
import sys
import time
import uuid
from collections import deque
from aiohttp import web

# Fix aiohttp on Windows — ProactorEventLoop (default on 3.8+) is incompatible
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

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
# Durations are proportional to a real ES trading day, compressed to ~27 min/cycle.
# buy_bias is the CENTER of the OU process, not a hard probability.
# Actual buy_prob fluctuates via Hawkes process + OU momentum.
BASE_REGIMES = [
    ('open_gap',        90,  0.57,  500,  450, 1.0, 0.09),   # ~1.5 min
    ('hard_trend',     540,  0.64,  250,  700, 1.0, 0.10),   # ~9 min
    ('absorption',     210,  0.70, 2400,  500, 1.0, 0.12),   # ~3.5 min
    ('lunchtime_chop', 420,  0.50, 1600, 1600, 1.0, 0.60),   # ~7 min
    ('failed_auction', 210,  0.36,  700,  250, 1.0, 0.09),   # ~3.5 min
    ('close_accel',    150,  0.62,  300,  650, 1.0, 0.07),   # ~2.5 min
]

NEWS_REGIME_UP   = ('news_release',   15,  0.88,  50,  50, 6.0, 0.20)
NEWS_REGIME_DOWN = ('news_release',   15,  0.12,  50,  50, 6.0, 0.20)
POST_NEWS_REGIME = ('post_news_chop', 90,  0.50, 600, 600, 1.0, 0.80)

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
            if len(crossed_bids) <= len(crossed_asks):
                for p in crossed_bids:
                    del self.bids[p]
            else:
                for p in crossed_asks:
                    del self.asks[p]

    def consume_ask(self, size: int, replenish: int) -> list[tuple[float, int]]:
        """
        Market buy sweeps through asks until size is filled.
        Returns list of (trade_px, trade_sz) fills across all levels hit.
        """
        fills = []
        remaining = size
        while remaining > 0:
            px = self.best_ask()
            if not px:
                break
            available = self.asks[px]
            filled = min(remaining, available)
            self.asks[px] -= filled
            remaining -= filled
            fills.append((px, filled))
            if self.asks[px] <= 0:
                del self.asks[px]
                new_px = snap(px + TICK)
                bb = self.best_bid()
                if not bb or new_px > bb:
                    jitter = max(1, replenish // 3)
                    current_sz = self.asks.get(new_px, 0)
                    self.asks[new_px] = max(1, current_sz + replenish + random.randint(-jitter, jitter))
                self._fill_side('ask')
                self._uncross()
        return fills

    def consume_bid(self, size: int, replenish: int) -> list[tuple[float, int]]:
        """
        Market sell sweeps through bids until size is filled.
        Returns list of (trade_px, trade_sz) fills across all levels hit.
        """
        fills = []
        remaining = size
        while remaining > 0:
            px = self.best_bid()
            if not px:
                break
            available = self.bids[px]
            filled = min(remaining, available)
            self.bids[px] -= filled
            remaining -= filled
            fills.append((px, filled))
            if self.bids[px] <= 0:
                del self.bids[px]
                new_px = snap(px - TICK)
                ba = self.best_ask()
                if not ba or new_px < ba:
                    jitter = max(1, replenish // 3)
                    current_sz = self.bids.get(new_px, 0)
                    self.bids[new_px] = max(1, current_sz + replenish + random.randint(-jitter, jitter))
                self._fill_side('bid')
                self._uncross()
        return fills

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
        Forces 1-tick spread aggressively on every call.
        """
        self.bid_target = bid_rep
        self.ask_target = ask_rep

        bb = self.best_bid()
        ba = self.best_ask()

        # Force 1-tick spread: aggressively fill any gap > 1 tick every replenish
        if bb and ba:
            spread_ticks = round((ba - bb) / TICK)
            while spread_ticks > 1 and bb and ba:
                # Always fill from both sides toward center
                new_bid = snap(bb + TICK)
                new_ask = snap(ba - TICK)
                if new_bid < ba and new_bid not in self.bids:
                    self.bids[new_bid] = max(1, bid_rep // 2 + random.randint(0, max(1, bid_rep // 4)))
                if new_ask > bb and new_ask not in self.asks:
                    self.asks[new_ask] = max(1, ask_rep // 2 + random.randint(0, max(1, ask_rep // 4)))
                bb = self.best_bid()
                ba = self.best_ask()
                if not bb or not ba:
                    break
                spread_ticks = round((ba - bb) / TICK)

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
        for i in range(0, DEPTH_LEVELS + 1):
            decay = math.exp(-max(0, i - 0.5) * 0.18)
            noise_b = 1.0 + random.uniform(-0.35, 0.35)
            noise_a = 1.0 + random.uniform(-0.35, 0.35)
            tb = max(1, int(bid_rep * decay * noise_b))
            ta = max(1, int(ask_rep * decay * noise_a))

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
        self.ou_bias: float = 0.50
        self.ou_speed: float = 0.08
        self.ou_noise: float = 0.025

        # Short-term momentum: rolling sum of recent price changes in ticks
        self.recent_moves: deque = deque(maxlen=20)

        # Hawkes process: last trade side for autocorrelation
        self.last_trade_side: str = 'BUY'

        # Institutional sweep state: TWAP-style burst on one side
        self.sweep_trades_left: int = 0
        self.sweep_side: str = 'BUY'

        # Regime controller
        self.regime_idx   = 0
        self.regime_start = time.time()
        self.prev_regime_params: tuple | None = None

        # Iceberg level (absorption regime) — static at nearest $5 round number
        self.iceberg_px: float = snap(math.ceil(INIT_PX / 5) * 5)

        # Spoofing
        self.flash: dict[float, tuple[int, float]] = {}
        self.last_flash = 0.0

mkt = Market()

_regime_queue: list[tuple] = []
_history: list[dict] = []
_ws_clients: set[web.WebSocketResponse] = set()


# ── Book skew (adverse selection) ─────────────────────────────────────────────
def compute_book_skew() -> tuple[float, float]:
    """
    Returns (ask_multiplier, bid_multiplier) based on recent price momentum.
    If price is trending up: MMs pull asks (scared of being run over) and
    stack bids (provide support behind the move).
    """
    if len(mkt.recent_moves) < 5:
        return 1.0, 1.0
    recent_sum = sum(list(mkt.recent_moves)[-10:])
    if recent_sum > 2:    # uptrend: pull asks, stack bids
        return 0.60, 1.40
    elif recent_sum < -2: # downtrend: pull bids, stack asks
        return 1.40, 0.60
    return 1.0, 1.0


# ── OU bias update ────────────────────────────────────────────────────────────
def update_ou_bias(m: 'Market', target: float):
    """
    Ornstein-Uhlenbeck step: bias drifts toward regime target with
    noise and momentum influence.
    """
    momentum = 0.0
    if len(m.recent_moves) >= 5:
        recent_sum = sum(m.recent_moves)
        momentum = 0.003 * recent_sum

    reversion = m.ou_speed * (target - m.ou_bias)
    noise = m.ou_noise * random.gauss(0, 1)
    m.ou_bias += reversion + noise + momentum
    m.ou_bias = max(0.08, min(0.92, m.ou_bias))


# ── Blended regime parameters ─────────────────────────────────────────────────
def blended_params(regime: tuple, m: 'Market') -> tuple:
    """
    If we recently transitioned, blend old -> new params over BLEND_DURATION.
    """
    if m.prev_regime_params is None:
        return regime

    elapsed = time.time() - m.regime_start
    if elapsed >= BLEND_DURATION:
        m.prev_regime_params = None
        return regime

    t = elapsed / BLEND_DURATION
    t = t * t * (3 - 2 * t)  # smooth ease-in-out

    old = m.prev_regime_params
    new = regime
    return (
        new[0],
        new[1],
        old[2] + (new[2] - old[2]) * t,
        int(old[3] + (new[3] - old[3]) * t),
        int(old[4] + (new[4] - old[4]) * t),
        old[5] + (new[5] - old[5]) * t,
        old[6] + (new[6] - old[6]) * t,
    )


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
                # Static iceberg at nearest $5 round number
                nearest_5 = math.ceil(h.price / 5) * 5
                h.iceberg_px = snap(float(nearest_5))
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
            update_ou_bias(h, buy_bias)

            # Hawkes process: autocorrelated trade direction
            hawkes_bias = 0.85 if h.last_trade_side == 'BUY' else 0.15
            blended_bias = 0.5 * hawkes_bias + 0.5 * h.ou_bias
            is_buy = random.random() < blended_bias

            sz = trade_size()

            # Book skew based on momentum
            ask_mult_h = 1.0
            bid_mult_h = 1.0
            if len(h.recent_moves) >= 5:
                rs = sum(list(h.recent_moves)[-10:])
                if rs > 2:
                    ask_mult_h, bid_mult_h = 0.60, 1.40
                elif rs < -2:
                    ask_mult_h, bid_mult_h = 1.40, 0.60

            a_rep = max(1, int(ask_rep / vol_scalar * (1.0 + random.uniform(-0.4, 0.4)) * ask_mult_h))
            b_rep = max(1, int(bid_rep / vol_scalar * (1.0 + random.uniform(-0.4, 0.4)) * bid_mult_h))

            if is_buy:
                fills = h.lob.consume_ask(sz, a_rep)
                side  = 'BUY'
            else:
                fills = h.lob.consume_bid(sz, b_rep)
                side  = 'SELL'

            if not fills:
                continue

            h.last_trade_side = side

            last_px  = fills[-1][0]
            total_sz = sum(s for _, s in fills)

            # Iceberg: static, no trailing
            if name == 'absorption':
                for px, _ in fills:
                    if is_buy and snap(px) == h.iceberg_px:
                        h.lob.asks[h.iceberg_px] = max(h.lob.asks.get(h.iceberg_px, 0), 800)

            prev    = h.price
            h.price = last_px
            h.high  = max(h.high, last_px)
            h.low   = min(h.low,  last_px)
            h.volume += total_sz
            h.delta  += total_sz if side == 'BUY' else -total_sz

            if prev:
                move = (last_px - prev) / TICK
                h.recent_moves.append(move)

            bar['h']  = max(bar['h'], last_px)
            bar['l']  = min(bar['l'], last_px)
            bar['c']  = last_px
            bar['v'] += total_sz

            # GARCH update
            if prev:
                ret = (last_px - prev) / TICK
                h.recent_returns.append(ret)
                if len(h.recent_returns) >= 4:
                    w, a, b = 0.025, 0.14, 0.83
                    e2 = h.recent_returns[-1]
                    h.vol = math.sqrt(max(1e-6, w + a * e2**2 + b * h.vol**2))
                    h.vol = max(0.05, min(5.0, h.vol))

            trade_ms = int((bar_t + (i / max(n_ticks, 1)) * BAR_SEC) * 1000)
            for j, (px, fill_sz) in enumerate(fills):
                bar_trades.append({'p': px, 'sz': fill_sz, 'td': side, 'st': trade_ms + j, 'is': False})

        h.lob.replenish(
            max(1, int(ask_rep / vol_scalar)),
            max(1, int(bid_rep / vol_scalar))
        )

        messages.append({'ti': [dict(bar)]})
        if bar_trades:
            messages.append({'tr': bar_trades})

    # Sync global state with history end state
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
    mkt.last_trade_side = h.last_trade_side

    print(f'[mock] history: {HISTORY_BARS} bars, {len(messages)} msgs, '
          f'final px={h.price:.2f}')
    return messages


# ── Regime controller ─────────────────────────────────────────────────────────
def get_regime() -> tuple:
    global _regime_queue

    current = _regime_queue[0] if _regime_queue else BASE_REGIMES[mkt.regime_idx]
    _, dur, *_ = current
    if time.time() - mkt.regime_start >= dur:
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
            # Static iceberg at nearest $5 round number — stays put
            nearest_5 = math.ceil(mkt.price / 5) * 5
            mkt.iceberg_px = snap(float(nearest_5))
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


# ── GARCH vol update ──────────────────────────────────────────────────────────
def update_vol(ret_ticks: float):
    mkt.recent_returns.append(ret_ticks)
    if len(mkt.recent_returns) < 4:
        return
    w, a, b = 0.025, 0.14, 0.83
    e2 = mkt.recent_returns[-1]
    mkt.vol = math.sqrt(max(1e-6, w + a * e2 ** 2 + b * mkt.vol ** 2))
    mkt.vol = max(0.05, min(5.0, mkt.vol))


# ── Trade generation ──────────────────────────────────────────────────────────
def gen_trades(regime: tuple) -> list[dict]:
    """
    Generate one market action — may produce multiple trade prints if:
      - The order sweeps through multiple LOB levels
      - We are in an institutional sweep state (TWAP-style burst)
    Returns a list of trade dicts.
    """
    params = blended_params(regime, mkt)
    name, _, buy_bias, ask_rep, bid_rep, vol_scalar, _ = params

    update_ou_bias(mkt, buy_bias)

    # Hawkes process: 85% chance of repeating last trade direction
    hawkes_bias = 0.85 if mkt.last_trade_side == 'BUY' else 0.15
    blended_bias = 0.5 * hawkes_bias + 0.5 * mkt.ou_bias

    # Size selection
    sz = trade_size()

    # Institutional sweep: replace large single orders with TWAP-style bursts
    if sz >= 50 and mkt.sweep_trades_left == 0:
        mkt.sweep_trades_left = random.randint(20, 40)
        mkt.sweep_side = 'BUY' if random.random() < blended_bias else 'SELL'

    if mkt.sweep_trades_left > 0:
        sz = random.randint(5, 15)
        is_buy = (mkt.sweep_side == 'BUY')
        mkt.sweep_trades_left -= 1
    else:
        is_buy = random.random() < blended_bias

    # Book skew: adverse selection adjusts replenish targets
    ask_mult, bid_mult = compute_book_skew()
    a_rep = max(1, int(ask_rep / max(0.1, vol_scalar) *
                       (1.0 + random.uniform(-0.4, 0.4)) * ask_mult))
    b_rep = max(1, int(bid_rep / max(0.1, vol_scalar) *
                       (1.0 + random.uniform(-0.4, 0.4)) * bid_mult))

    if is_buy:
        fills = mkt.lob.consume_ask(sz, a_rep)
        side = 'BUY'
    else:
        fills = mkt.lob.consume_bid(sz, b_rep)
        side = 'SELL'

    if not fills:
        return []

    # Absorption iceberg — static, no dynamic trailing
    if name == 'absorption':
        for px, _ in fills:
            if is_buy and snap(px) == mkt.iceberg_px:
                mkt.lob.asks[mkt.iceberg_px] = max(
                    mkt.lob.asks.get(mkt.iceberg_px, 0), 800
                )

    # Update session state from sweep result
    last_px  = fills[-1][0]
    total_sz = sum(s for _, s in fills)
    prev = mkt.price
    mkt.price = last_px
    mkt.high  = max(mkt.high, last_px)
    mkt.low   = min(mkt.low,  last_px)
    mkt.volume += total_sz
    mkt.delta  += total_sz if side == 'BUY' else -total_sz
    mkt.last_trade_side = side

    if prev:
        move = (last_px - prev) / TICK
        mkt.recent_moves.append(move)
        update_vol(move)

    # Build trade dicts — each fill level gets its own print
    now_ms = int(time.time() * 1000)
    trades = []
    for i, (px, fill_sz) in enumerate(fills):
        trades.append({'p': px, 'sz': fill_sz, 'td': side, 'st': now_ms + i, 'is': False})

    return trades


# ── DOM generation ────────────────────────────────────────────────────────────
def gen_depth(regime: tuple) -> dict:
    params = blended_params(regime, mkt)
    name, _, _, ask_rep, bid_rep, vol_scalar, _ = params

    ask_mult, bid_mult = compute_book_skew()
    mkt.lob.replenish(
        max(1, int(ask_rep / max(0.1, vol_scalar) * ask_mult)),
        max(1, int(bid_rep / max(0.1, vol_scalar) * bid_mult))
    )

    # Expire old flash orders
    now = time.time()
    for px in [p for p, (_, exp) in mkt.flash.items() if now >= exp]:
        del mkt.flash[px]

    bids, asks = mkt.lob.snapshot()

    # Inject flash levels into snapshot
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

    # Remove flash orders that have come within 1 tick of inside market
    bb = mkt.lob.best_bid()
    ba = mkt.lob.best_ask()
    for px in list(mkt.flash.keys()):
        if bb and abs(px - bb) <= TICK:
            del mkt.flash[px]
        elif ba and abs(px - ba) <= TICK:
            del mkt.flash[px]

    if now - mkt.last_flash < 2.5 or random.random() > 0.12:
        return
    mkt.last_flash = now
    bb = mkt.lob.best_bid()
    ba = mkt.lob.best_ask()
    ref = ba if random.random() > 0.5 else bb
    if not ref:
        return
    sign     = 1 if ref == ba else -1
    ticks    = random.randint(2, 4)   # was 5-10; spoofers operate near the inside
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

async def handle_gex_run(_req):
    print('[mock] gex/run: starting snapshot...')
    gex_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gex', 'gex-snapshot')
    import subprocess as _sp
    loop = asyncio.get_event_loop()
    def _run():
        return _sp.run(
            [sys.executable, 'main.py'],
            cwd=gex_dir,
            capture_output=True,
            timeout=120,
        )
    try:
        result = await loop.run_in_executor(None, _run)
        if result.returncode == 0:
            print('[mock] gex/run: done')
            return json_ok({'status': 'OK', 'message': 'GEX snapshot complete'})
        else:
            msg = result.stderr.decode(errors='replace')[:500]
            print(f'[mock] gex/run: error — {msg}')
            r = web.json_response({'status': 'ERR', 'message': msg}, status=500)
            r.headers.update(CORS)
            return r
    except _sp.TimeoutExpired:
        r = web.json_response({'status': 'ERR', 'message': 'timeout'}, status=500)
        r.headers.update(CORS)
        return r
    except Exception as e:
        r = web.json_response({'status': 'ERR', 'message': str(e)}, status=500)
        r.headers.update(CORS)
        return r


# ── Broadcast helper ──────────────────────────────────────────────────────────
async def broadcast(msg: str):
    """Send a message to all connected WS clients, removing dead ones."""
    dead = set()
    for ws in _ws_clients:
        try:
            await ws.send_str(msg)
        except Exception:
            dead.add(ws)
    _ws_clients.difference_update(dead)


# ── Background market simulator ───────────────────────────────────────────────
async def market_simulator_loop():
    """
    Single background loop that drives the market simulation and broadcasts
    updates to all connected clients.
    """
    bar_ts = int(time.time() // BAR_SEC) * BAR_SEC
    bar = {'t': bar_ts, 'o': mkt.price, 'h': mkt.price,
           'l': mkt.price, 'c': mkt.price, 'v': 0}
    tick = 0

    while True:
        try:
            if not _ws_clients:
                await asyncio.sleep(0.25)
                continue

            regime = get_regime()
            params = blended_params(regime, mkt)
            name = params[0]
            base_hz = params[6]

            is_news  = (name == 'news_release')
            in_sweep = mkt.sweep_trades_left > 0
            is_burst = (not is_news) and (not in_sweep) and (random.random() < 0.07)

            # In sweep state: fire one trade at a time with fast cadence
            n_trades = (1 if in_sweep
                        else random.randint(1, 2) if is_news
                        else random.randint(8, 20) if is_burst
                        else random.randint(1, 3))

            trades = []
            for burst_i in range(n_trades):
                new_trades = gen_trades(regime)
                for t in new_trades:
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

            # Sleep — sweep state runs at rapid-fire cadence
            if in_sweep:
                await asyncio.sleep(0.012 + random.random() * 0.015)
            elif is_burst:
                await asyncio.sleep(0.015 + random.random() * 0.025)
            else:
                hz = base_hz * (0.6 + random.random() * 0.8)
                await asyncio.sleep(hz)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f'[mock] simulator error (continuing): {e}')
            await asyncio.sleep(0.5)


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
            pass
    except Exception as e:
        print(f'[mock] WS error: {e}')
    finally:
        _ws_clients.discard(ws)

    print(f'[mock] WS disconnected: {sid[:8]}...')
    return ws


# ── App startup ───────────────────────────────────────────────────────────────
async def on_startup(app):
    app['market_sim'] = asyncio.create_task(market_simulator_loop())

async def on_cleanup(app):
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
app.router.add_post('/gex/run',                                           handle_gex_run)
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
    print(f'  Mock IronBeam v5   http://localhost:{PORT}')
    print(f'  Bar: {BAR_SEC}s | Cycle: {cycle}s (~{cycle//60}min) | Symbol: {SYMBOL}')
    print(f'  {names}')
    print(f'  Set MOCK = true in data-live.js')
    print('-' * 60)
    web.run_app(app, host='0.0.0.0', port=PORT)
