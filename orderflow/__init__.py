"""
orderflow — Python data platform for NQ and ES futures order flow.

Subpackages:
  ingestion  — IronBeam WebSocket client, session classification, contract logic
  storage    — DuckDB tick/OHLCV stores and pruner
  backfill   — Gap detection and yfinance backfill
  compute    — VP, delta, CVD, footprint analytics
  api        — FastAPI REST and WebSocket endpoints
"""

__version__ = "0.1.0"
