"""
ws.py — WebSocket live-push API.

Endpoint:
  WS /live/{instrument}

On each new tick from IronBeam, the ingestion layer calls push_tick()
which broadcasts to all subscribers of that instrument:

  {
    "type":       "tick",
    "instrument": "ES",
    "contract":   "ESM26",
    "timestamp":  "2026-06-03T14:30:00+00:00",
    "price":      5842.25,
    "size":       3,
    "side":       "B",
    "session":    "RTH",
    "cvd":        1234.0,
    "bar_delta":  42
  }

Maintains a set of active WebSocket connections per instrument.
Dead connections are silently removed on broadcast failure.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

logger = logging.getLogger(__name__)

router = APIRouter()

# {instrument: set of active WebSocket connections}
_subscribers: dict[str, set[WebSocket]] = {}
_lock = asyncio.Lock()


@router.websocket("/live/{instrument}")
async def live_feed(websocket: WebSocket, instrument: str) -> None:
    """
    WebSocket endpoint for live tick feed.

    Clients connect to ws://<host>/live/ES or ws://<host>/live/NQ.
    They receive a JSON message on every tick with CVD and bar_delta attached.
    """
    instrument = instrument.upper()
    await websocket.accept()
    logger.info("ws: client connected for %s", instrument)

    async with _lock:
        if instrument not in _subscribers:
            _subscribers[instrument] = set()
        _subscribers[instrument].add(websocket)

    try:
        # Send a welcome/handshake message
        await websocket.send_text(json.dumps({
            "type": "connected",
            "instrument": instrument,
            "message": f"Subscribed to live feed for {instrument}",
        }))

        # Keep alive: wait for client to disconnect or send a ping
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                # Respond to pings from the client
                if data.strip() == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
            except asyncio.TimeoutError:
                # Send a keepalive heartbeat
                try:
                    await websocket.send_text(json.dumps({"type": "heartbeat"}))
                except Exception:
                    break
    except WebSocketDisconnect:
        logger.info("ws: client disconnected from %s", instrument)
    except Exception as exc:
        logger.debug("ws: connection error for %s: %s", instrument, exc)
    finally:
        async with _lock:
            _subscribers.get(instrument, set()).discard(websocket)
        logger.debug("ws: removed subscriber for %s", instrument)


async def push_tick(instrument: str, tick_data: dict[str, Any]) -> None:
    """
    Broadcast a tick to all subscribers for the given instrument.

    Called by IronBeamClient on each processed trade.
    Dead connections are silently removed.

    Parameters
    ----------
    instrument: 'ES' or 'NQ'
    tick_data:  dict with tick fields plus 'cvd' and 'bar_delta'
    """
    instrument = instrument.upper()
    subscribers = _subscribers.get(instrument)
    if not subscribers:
        return

    payload = json.dumps({"type": "tick", **tick_data})
    dead: set[WebSocket] = set()

    for ws in list(subscribers):
        try:
            if ws.application_state == WebSocketState.CONNECTED:
                await ws.send_text(payload)
            else:
                dead.add(ws)
        except Exception as exc:
            logger.debug("ws: send failed for %s: %s", instrument, exc)
            dead.add(ws)

    if dead:
        async with _lock:
            _subscribers.get(instrument, set()).difference_update(dead)
        logger.debug("ws: removed %d dead connections for %s", len(dead), instrument)


def subscriber_count(instrument: str) -> int:
    """Return the number of active subscribers for an instrument."""
    return len(_subscribers.get(instrument.upper(), set()))
