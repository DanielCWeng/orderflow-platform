#!/usr/bin/env python3
"""
mock_server.py v2 — Realistic IronBeam API mock for orderflow-platform.

Fixes over v1:
  1. Aggressor → trade price  (BUY @ best_ask, SELL @ best_bid)
  2. Stateful LOB with queue depletion → real price discovery
  3. Price ticks only when best-level queue empties
  4. GARCH(1,1)-like volatility clustering
  5. Realistic ES size distribution (1-2 lot heavy, blocks are rare)
  6. Regime state machine with 8-minute cycle
  7. Burst trade-arrival model (Poisson bursts)
  8. Spoofing / flash-order simulation

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

# ── Regime definitions ─────────────────────────────────────────────────────────
# (name, duration_s, buy_prob, ask_replenish, bid_replenish, vol_scalar, base_trade_hz_s)
#   ask_replenish / bid_replenish = base queue size restocked when a level clears
#   vol_scalar    = multiplier on base_trade_hz (higher = slower / more volatile)
REGIMES = [
    ('open_gap',       60,  0.62, 120, 100, 1.6, 0.09),
    ('hard_trend',     90,  0.86,  35, 280, 1.2, 0.10),
    ('absorption',     75,  0.80, 900, 120, 0.9, 0.12),  # iceberg floods ask at target
    ('lunchtime_chop',120,  0.50, 480, 480, 0.4, 0.60),
    ('failed_auction', 60,  0.22, 260,  45, 1.5, 0.09),
    ('close_accel',    90,  0.73,  55, 180, 1.9, 0.07),
    ('news_release',   25,  0.50,   4,   4, 4.5, 0.02),  # liquidity drained, big move
]


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
    Stateful limit order book.  Sizes persist between ticks — only updated
    incrementally rather than regenerated from scratch each DOM refresh.
    """

    def __init__(self, mid: float):
        self.bids: dict[float, int] = {}   # price → resting size
        self.asks: dict[float, int] = {}
        self._seed(mid)

    def _seed(self, mid: float):
        for i in range(1, DEPTH_LEVELS + 2):
            bp = snap(mid - i * TICK)
            ap = snap(mid + i * TICK)
            base = max(1, int(200 * math.exp(-i * 0.18)))
            self.bids[bp] = base + random.randint(0, base)
            self.asks[ap] = base + random.randint(0, base)

    # ── Accessors ──────────────────────────────────────────────────────────────
    def best_bid(self) -> float:
        return max(self.bids) if self.bids else 0.0

    def best_ask(self) -> float:
        return min(self.asks) if self.asks else 0.0

    # ── Queue consumption ──────────────────────────────────────────────────────
    def consume_ask(self, size: int, replenish: int) -> tuple[float, bool]:
        """Market buy hits best ask.  Returns (trade_px, level_cleared)."""
        px = self.best_ask()
        if not px:
            return 0.0, False
        self.asks[px] = max(0, self.asks[px] - size)
        if self.asks[px] <= 0:
            del self.asks[px]
            # Price ticks up: open a new ask level one tick higher
            new_px = snap(px + TICK)
            jitter = max(1, replenish // 4)
            self.asks[new_px] = max(1, replenish + random.randint(-jitter, jitter))
            self._fill()
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
            jitter = max(1, replenish // 4)
            self.bids[new_px] = max(1, replenish + random.randint(-jitter, jitter))
            self._fill()
            return px, True
        return px, False

    # ── Level maintenance ──────────────────────────────────────────────────────
    def _fill(self):
        """Ensure we always have DEPTH_LEVELS on each side."""
        bb = self.best_bid()
        ba = self.best_ask()
        for i in range(1, DEPTH_LEVELS + 2):
            if bb:
                px = snap(bb - i * TICK)
                if px not in self.bids:
                    base = max(1, int(160 * math.exp(-i * 0.20)))
                    self.bids[px] = base + random.randint(0, base // 2)
            if ba:
                px = snap(ba + i * TICK)
                if px not in self.asks:
                    base = max(1, int(160 * math.exp(-i * 0.20)))
                    self.asks[px] = base + random.randint(0, base // 2)

    def replenish(self, ask_rep: int, bid_rep: int):
        """
        Gentle mean-reversion of resting sizes toward regime targets.
        Called once per DOM refresh — NOT a full regeneration.
        """
        bb = self.best_bid()
        ba = self.best_ask()
        for i in range(1, DEPTH_LEVELS + 1):
            decay = math.exp(-i * 0.18)
            tb = max(1, int(bid_rep * decay))
            ta = max(1, int(ask_rep * decay))
            bp = snap(bb - i * TICK) if bb else 0.0
            ap = snap(ba + i * TICK) if ba else 0.0
            if bp:
                cur = self.bids.get(bp, tb)
                self.bids[bp] = max(1, int(cur * 0.88 + tb * 0.12 + random.randint(0, tb // 5)))
            if ap:
                cur = self.asks.get(ap, ta)
                self.asks[ap] = max(1, int(cur * 0.88 + ta * 0.12 + random.randint(0, ta // 5)))

        # Prune stale outer levels
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
        self.vol: float = 0.30   # in ticks

        # Regime controller
        self.regime_idx   = 0
        self.regime_start = time.time()

        # Iceberg level (absorption regime)
        self.iceberg_px: float = snap(INIT_PX + 8 * TICK)

        # Spoofing: {price → (size, expiry_ts)}
        self.flash: dict[float, tuple[int, float]] = {}
        self.last_flash = 0.0

mkt = Market()


# ── Regime controller ─────────────────────────────────────────────────────────
def get_regime() -> tuple:
    elapsed = time.time() - mkt.regime_start
    _, dur, *_ = REGIMES[mkt.regime_idx]
    if elapsed >= dur:
        mkt.regime_idx = (mkt.regime_idx + 1) % len(REGIMES)
        mkt.regime_start = time.time()
        name = REGIMES[mkt.regime_idx][0]
        if name == 'absorption':
            mkt.iceberg_px = snap(mkt.price + 8 * TICK)
        print(f'[mock] ─ regime → {name}')
    return REGIMES[mkt.regime_idx]


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
    ω, α, β = 0.025, 0.14, 0.83
    ε = mkt.recent_returns[-2]
    mkt.vol = math.sqrt(max(1e-6, ω + α * ε ** 2 + β * mkt.vol ** 2))
    mkt.vol = max(0.05, min(5.0, mkt.vol))


# ── Trade generation ──────────────────────────────────────────────────────────
def gen_trade(regime: tuple) -> dict | None:
    name, _, buy_prob, ask_rep, bid_rep, vol_scalar, _ = regime

    sz    = trade_size()
    is_buy = random.random() < buy_prob

    if is_buy:
        px, ticked = mkt.lob.consume_ask(sz, max(1, int(ask_rep * vol_scalar)))
        side = 'BUY'
    else:
        px, ticked = mkt.lob.consume_bid(sz, max(1, int(bid_rep * vol_scalar)))
        side = 'SELL'

    if not px:
        return None

    # Absorption iceberg: re-flood the ask level so price can't escape
    if name == 'absorption' and is_buy and snap(px) >= mkt.iceberg_px:
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
    name, _, _, ask_rep, bid_rep, _, _ = regime

    # Gentle mean-reversion of resting sizes — NOT a full regeneration
    mkt.lob.replenish(ask_rep, bid_rep)

    # Expire old flash orders
    now = time.time()
    for px in [p for p, (_, exp) in mkt.flash.items() if now >= exp]:
        del mkt.flash[px]

    bids, asks = mkt.lob.snapshot()

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
    print(f'[mock] stream: {sid[:8]}…')
    return json_ok({'streamId': sid, 'status': 'OK', 'message': ''})

async def handle_subscribe(req):
    print(f'[mock] subscribe: {req.path}')
    return json_ok({'status': 'OK', 'message': 'Subscribed'})


# ── WebSocket ─────────────────────────────────────────────────────────────────
async def handle_ws(req):
    sid = req.match_info['streamId']
    ws  = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(req)
    print(f'[mock] WS connected: {sid[:8]}…')

    regime = get_regime()
    bar_ts = int(time.time() // BAR_SEC) * BAR_SEC
    bar = {'t': bar_ts, 'o': mkt.price, 'h': mkt.price,
           'l': mkt.price, 'c': mkt.price, 'v': 0}

    # Send initial snapshots immediately so panels populate
    await ws.send_str(json.dumps(gen_depth(regime)))
    await ws.send_str(json.dumps(gen_quote()))
    await ws.send_str(json.dumps({'ti': [dict(bar)]}))

    tick = 0
    try:
        while not ws.closed:
            regime = get_regime()
            name, _, _, _, _, vol_scalar, base_hz = regime

            # ── Burst vs normal trade arrival ─────────────────────────────────
            is_burst = (name == 'news_release') or (random.random() < 0.07)
            burst_n  = random.randint(15, 35) if name == 'news_release' else random.randint(8, 20)
            n_trades = burst_n if is_burst else random.randint(1, 3)

            trades = []
            for _ in range(n_trades):
                t = gen_trade(regime)
                if t:
                    trades.append(t)
                    bar['h'] = max(bar['h'], t['p'])
                    bar['l'] = min(bar['l'], t['p'])
                    bar['c'] = t['p']
                    bar['v'] += t['sz']

            if trades:
                await ws.send_str(json.dumps({'tr': trades}))

            tick += 1
            maybe_spoof(regime)

            # ── Bar close ─────────────────────────────────────────────────────
            now_ts = int(time.time() // BAR_SEC) * BAR_SEC
            if now_ts > bar['t']:
                await ws.send_str(json.dumps({'ti': [dict(bar)]}))
                bar = {'t': now_ts, 'o': mkt.price, 'h': mkt.price,
                       'l': mkt.price, 'c': mkt.price, 'v': 0}
                print(f'[mock] bar close @ {now_ts} | {name}')

            # ── In-progress bar update every 3 ticks ──────────────────────────
            if tick % 3 == 0:
                await ws.send_str(json.dumps({'ti': [dict(bar)]}))

            # ── DOM: stateful, refreshed every tick ───────────────────────────
            await ws.send_str(json.dumps(gen_depth(regime)))

            # ── Quote every ~10 ticks ─────────────────────────────────────────
            if tick % 10 == 0:
                await ws.send_str(json.dumps(gen_quote()))

            # ── Sleep: burst mode uses very short delay, normal uses regime hz ─
            if is_burst:
                await asyncio.sleep(0.015 + random.random() * 0.025)
            else:
                hz = base_hz * (0.6 + random.random() * 0.8)
                await asyncio.sleep(hz)

    except Exception as e:
        print(f'[mock] WS error: {e}')

    print(f'[mock] WS disconnected: {sid[:8]}…')
    return ws


# ── App ───────────────────────────────────────────────────────────────────────
app = web.Application()
app.router.add_route('OPTIONS', '/{path_info:.*}',                       handle_options)
app.router.add_post('/auth',                                              handle_auth)
app.router.add_get( '/v2/stream/create',                                  handle_create_stream)
app.router.add_get( '/v2/market/quotes/subscribe/{streamId}',             handle_subscribe)
app.router.add_get( '/v2/market/depths/subscribe/{streamId}',             handle_subscribe)
app.router.add_get( '/v2/market/trades/subscribe/{streamId}',             handle_subscribe)
app.router.add_post('/v2/indicator/subscribe/timebars/{streamId}',        handle_subscribe)
app.router.add_get( '/v2/stream/{streamId}',                              handle_ws)

if __name__ == '__main__':
    cycle = sum(r[1] for r in REGIMES)
    names = ' → '.join(r[0] for r in REGIMES)
    print('━' * 60)
    print(f'  Mock IronBeam v2   http://localhost:{PORT}')
    print(f'  Bar: {BAR_SEC}s | Cycle: {cycle}s | Symbol: {SYMBOL}')
    print(f'  {names}')
    print(f'  Set MOCK = true in data-live.js')
    print('━' * 60)
    web.run_app(app, host='127.0.0.1', port=PORT, print=lambda _: None)
