"""
ironbeam.py — IronBeam WebSocket client with reconnect and in-memory CVD/delta.

Protocol (JSON over WebSocket):
  tr  → list of trades: {p, sz, td: "BUY"/"SELL", st: epoch_ms, is: bool}
  ti  → list of timebars: {t: epoch_s, o, h, l, c, v}
  d   → DOM: [{s, b: [{l,p,sz,o,is}], a: [...]}]
  q   → quote: [{s, l, op, hi, lo, tv, b, a}]

Startup sequence per instrument:
  1. POST /auth (skip in MOCK mode)
  2. GET /v2/stream/create  → streamId
  3. GET /v2/market/quotes/subscribe/{streamId}
  4. GET /v2/market/depths/subscribe/{streamId}
  5. GET /v2/market/trades/subscribe/{streamId}
  6. POST /v2/indicator/subscribe/timebars/{streamId}
  7. WS /v2/stream/{streamId}

On each tr message:  write ticks to DuckDB, update CVD/bar_delta, push to WS subscribers.
On each ti message:  write completed bar to ohlcv_store and Parquet.

Reconnect with exponential backoff (1 s → 2 → 4 → … cap 60 s) on any disconnect.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
from typing import Any, Callable, Awaitable

import aiohttp

from ..config import (
    MOCK,
    MOCK_URL,
    IRONBEAM_DEMO_URL,
    IRONBEAM_LIVE_URL,
    IRONBEAM_USERNAME,
    IRONBEAM_PASSWORD,
    INSTRUMENTS,
)
from ..ingestion.session import classify
from ..ingestion.contracts import contract_from_config
from ..storage.tick_store import TickStore
from ..storage.ohlcv_store import OHLCVStore

logger = logging.getLogger(__name__)

# Timebar subscription body (5-minute bars — IronBeam indicator endpoint)
TIMEBAR_BODY = {"period": 5, "barType": "MINUTE"}

# Reconnect config
RECONNECT_BASE = 1.0   # seconds
RECONNECT_MAX  = 60.0  # seconds cap


class IronBeamClient:
    """
    Manages the full IronBeam connection lifecycle for a single instrument.

    Parameters
    ----------
    instrument:     "ES" or "NQ"
    tick_store:     TickStore instance (shared across instruments)
    ohlcv_store:    OHLCVStore instance (shared across instruments)
    push_tick_fn:   async callable(instrument, tick_dict) — WS broadcast hook
    """

    def __init__(
        self,
        instrument: str,
        tick_store: TickStore,
        ohlcv_store: OHLCVStore,
        push_tick_fn: Callable[[str, dict], Awaitable[None]],
    ) -> None:
        self.instrument = instrument
        self.cfg = INSTRUMENTS[instrument]
        self.contract = contract_from_config(instrument)
        self.tick_store = tick_store
        self.ohlcv_store = ohlcv_store
        self.push_tick_fn = push_tick_fn

        # In-memory running state (reset at session open)
        self._cvd: float = 0.0
        self._bar_delta: int = 0
        self._current_bar_ts: int | None = None  # epoch seconds of open bar

        self._token: str | None = None
        self._running = False
        self._reconnect_count: int = 0  # suppresses log spam after first failure
        # Runtime credentials (override config values when set via /connect)
        self._username: str | None = None
        self._password: str | None = None

    # ------------------------------------------------------------------ #
    #  Public interface                                                    #
    # ------------------------------------------------------------------ #

    async def run(self) -> None:
        """Start the client; reconnects indefinitely with exponential backoff."""
        self._running = True
        backoff = RECONNECT_BASE
        while self._running:
            try:
                await self._connect_and_stream()
                backoff = RECONNECT_BASE
                self._reconnect_count = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._reconnect_count += 1
                # Log first failure at WARNING; repeated failures at DEBUG
                # to avoid filling the console when the account is rate-limited
                # or the browser is already holding the stream.
                if self._reconnect_count == 1:
                    logger.warning(
                        "[IB:%s] disconnected: %s. Reconnecting in %.1fs",
                        self.instrument, exc, backoff,
                    )
                elif self._reconnect_count <= 3:
                    logger.warning(
                        "[IB:%s] still disconnected (attempt %d). Reconnecting in %.1fs — "
                        "check that no other client is using this IronBeam account.",
                        self.instrument, self._reconnect_count, backoff,
                    )
                else:
                    logger.debug(
                        "[IB:%s] reconnect attempt %d in %.1fs",
                        self.instrument, self._reconnect_count, backoff,
                    )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, RECONNECT_MAX)

    async def stop(self) -> None:
        self._running = False

    def set_credentials(self, username: str, password: str) -> None:
        """Override config credentials at runtime (called by POST /connect)."""
        self._username = username
        self._password = password

    @property
    def is_running(self) -> bool:
        return self._running

    # ------------------------------------------------------------------ #
    #  Internal connection / stream                                        #
    # ------------------------------------------------------------------ #

    def _base_url(self) -> str:
        if MOCK:
            return MOCK_URL
        return IRONBEAM_LIVE_URL

    def _ws_url(self, stream_id: str, token: str = "") -> str:
        base = self._base_url()
        ws_base = base.replace("https://", "wss://").replace("http://", "ws://")
        url = f"{ws_base}/v2/stream/{stream_id}"
        if token:
            url += f"?token={token}"
        return url

    async def _authenticate(self, session: aiohttp.ClientSession) -> str:
        """POST /auth → token string.  Skipped in MOCK mode."""
        if MOCK:
            logger.debug("[IB:%s] MOCK mode — skipping auth", self.instrument)
            return "mock-token"

        url = f"{self._base_url()}/v2/auth"
        username = self._username or IRONBEAM_USERNAME
        password = self._password or IRONBEAM_PASSWORD
        data = {"username": username, "password": password}
        async with session.post(url, json=data) as resp:
            resp.raise_for_status()
            body = await resp.json()
            token = body.get("token", "")
            if not token:
                raise RuntimeError(f"[IB:{self.instrument}] Auth failed: {body}")
            # Only log on first connect; suppress on reconnects to reduce noise
            if self._reconnect_count == 0:
                logger.info("[IB:%s] authenticated", self.instrument)
            else:
                logger.debug("[IB:%s] re-authenticated (attempt %d)", self.instrument, self._reconnect_count)
            return token

    async def _create_stream(
        self, session: aiohttp.ClientSession, token: str
    ) -> str:
        headers = {} if MOCK else {"Authorization": f"Bearer {token}"}
        url = f"{self._base_url()}/v2/stream/create"
        async with session.get(url, headers=headers) as resp:
            resp.raise_for_status()
            body = await resp.json()
            stream_id = body["streamId"]
            logger.debug("[IB:%s] streamId=%s", self.instrument, stream_id)
            return stream_id

    async def _subscribe(
        self,
        session: aiohttp.ClientSession,
        token: str,
        stream_id: str,
    ) -> None:
        symbol = self.cfg["symbol"]
        headers = {} if MOCK else {"Authorization": f"Bearer {token}"}
        base = self._base_url()

        # Non-fatal subscriptions — IronBeam may return 400 on these but
        # the WS stream still delivers the data.  Mirror the frontend's
        # Promise.allSettled pattern: warn on failure, don't abort.
        non_fatal = [
            ("quotes", "GET",  f"{base}/v2/market/quotes/subscribe/{stream_id}",
             {"params": {"symbols": symbol}}),
            ("depths", "GET",  f"{base}/v2/market/depths/subscribe/{stream_id}",
             {"params": {"symbols": symbol}}),
            ("trades", "GET",  f"{base}/v2/market/trades/subscribe/{stream_id}",
             {"params": {"symbols": symbol}}),
        ]
        for name, method, url, kwargs in non_fatal:
            kwargs["headers"] = headers
            try:
                async with session.request(method, url, **kwargs) as resp:
                    if not resp.ok:
                        body = await resp.text()
                        logger.warning(
                            "[IB:%s] %s subscribe returned %d: %s",
                            self.instrument, name, resp.status, body[:200],
                        )
                    else:
                        logger.debug("[IB:%s] subscribed %s", self.instrument, name)
            except Exception as exc:
                logger.warning("[IB:%s] %s subscribe error: %s", self.instrument, name, exc)

        # Timebars is required — raise if it fails (chart will be empty without it)
        tb_url = f"{base}/v2/indicator/{stream_id}/timeBars/subscribe"
        async with session.post(
            tb_url,
            headers=headers,
            json={**TIMEBAR_BODY, "symbol": symbol},
        ) as resp:
            resp.raise_for_status()
            logger.debug("[IB:%s] subscribed timeBars", self.instrument)

    async def _connect_and_stream(self) -> None:
        timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
        async with aiohttp.ClientSession(timeout=timeout) as http:
            token = await self._authenticate(http)
            stream_id = await self._create_stream(http, token)
            await self._subscribe(http, token, stream_id)

            ws_url = self._ws_url(stream_id, token)
            logger.info("[IB:%s] connecting WS %s", self.instrument, ws_url)

            async with http.ws_connect(
                ws_url,
                heartbeat=30,
                max_msg_size=0,
            ) as ws:
                logger.info("[IB:%s] WS connected", self.instrument)
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        await self._handle_message(msg.data)
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        raise RuntimeError(f"WS error: {ws.exception()}")
                    elif msg.type == aiohttp.WSMsgType.CLOSED:
                        break

    # ------------------------------------------------------------------ #
    #  Message dispatch                                                    #
    # ------------------------------------------------------------------ #

    async def _handle_message(self, raw: str) -> None:
        try:
            msg: dict = json.loads(raw)
        except json.JSONDecodeError:
            logger.debug("[IB:%s] non-JSON frame: %s", self.instrument, raw[:80])
            return

        if "tr" in msg:
            await self._handle_trades(msg["tr"])
        if "ti" in msg:
            await self._handle_timebars(msg["ti"])
        # DOM and quote messages are not stored — they are real-time display only

    async def _handle_trades(self, trades: list[dict]) -> None:
        """
        For each trade in the list:
          - Derive side (B/A/U)
          - Classify session
          - Write to tick_store
          - Update in-memory CVD and bar_delta
          - Push enriched tick to WS subscribers
        """
        rows: list[dict] = []
        now_utc = datetime.datetime.now(datetime.timezone.utc)

        for t in trades:
            price: float = t.get("p", 0.0)
            size: int = int(t.get("sz", 0))
            td: str = t.get("td", "")
            st_ms: int = int(t.get("st", now_utc.timestamp() * 1000))

            ts = datetime.datetime.fromtimestamp(st_ms / 1000.0,
                                                 tz=datetime.timezone.utc)
            # IronBeam td is an integer enum: 1=buy, 2=sell, 3=cross
            side = "B" if (td == 1 or td == "BUY") else ("A" if (td == 2 or td == "SELL") else "U")
            session_label = classify(ts)

            row = {
                "instrument": self.instrument,
                "contract": self.contract,
                "timestamp": ts,
                "price": price,
                "size": size,
                "side": side,
                "session": session_label,
            }
            rows.append(row)

            # Update in-memory state
            delta = size if side == "B" else (-size if side == "A" else 0)
            self._cvd += delta
            self._bar_delta += delta

        if rows:
            try:
                self.tick_store.insert_ticks(rows)
            except Exception as exc:
                logger.error("[IB:%s] tick_store error: %s", self.instrument, exc)

        # Push to WS subscribers (last tick in the batch enriched with CVD)
        for row in rows:
            delta = row["size"] if row["side"] == "B" else (
                -row["size"] if row["side"] == "A" else 0
            )
            enriched = {
                **row,
                "timestamp": row["timestamp"].isoformat(),
                "cvd": self._cvd,
                "bar_delta": self._bar_delta,
            }
            try:
                await self.push_tick_fn(self.instrument, enriched)
            except Exception as exc:
                logger.debug("[IB:%s] push_tick error: %s", self.instrument, exc)

    async def _handle_timebars(self, bars: list[dict]) -> None:
        """
        Write completed/updated timebars to ohlcv_store and Parquet.
        Reset bar_delta on bar close (when a new bar opens).
        """
        for bar in bars:
            t_s: int = int(bar.get("t", 0))
            ts = datetime.datetime.fromtimestamp(t_s, tz=datetime.timezone.utc)

            ohlcv_row = {
                "instrument": self.instrument,
                "contract": self.contract,
                "timestamp": ts,
                "open": float(bar.get("o", 0)),
                "high": float(bar.get("h", 0)),
                "low": float(bar.get("l", 0)),
                "close": float(bar.get("c", 0)),
                "volume": int(bar.get("v", 0)),
                "source": "LIVE",
                "session": classify(ts),
            }

            try:
                self.ohlcv_store.upsert_bar(ohlcv_row)
            except Exception as exc:
                logger.error("[IB:%s] ohlcv_store error: %s", self.instrument, exc)

            # Detect bar close: when we see a new bar timestamp
            if self._current_bar_ts is not None and t_s != self._current_bar_ts:
                # Previous bar closed — reset bar_delta for the new bar
                self._bar_delta = 0
                logger.debug(
                    "[IB:%s] bar closed @ %s, reset bar_delta",
                    self.instrument, self._current_bar_ts
                )

            self._current_bar_ts = t_s


def build_clients(
    tick_store: TickStore,
    ohlcv_store: OHLCVStore,
    push_tick_fn: Callable[[str, dict], Awaitable[None]],
) -> list[IronBeamClient]:
    """Convenience factory: build one client per configured instrument."""
    return [
        IronBeamClient(
            instrument=inst,
            tick_store=tick_store,
            ohlcv_store=ohlcv_store,
            push_tick_fn=push_tick_fn,
        )
        for inst in INSTRUMENTS
    ]
