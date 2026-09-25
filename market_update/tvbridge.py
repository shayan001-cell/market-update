"""TradingView Desktop bridge for the trading desk.

Reads daily bars straight from the chart open in TradingView Desktop through the
local `tradingview-mcp` bridge (Chrome DevTools Protocol on port 9222). It drives the
chart one symbol at a time, so it is used for bounded re-checks and as a fallback
when Yahoo is rate-limited, never as the bulk feed. The chart's original symbol and
timeframe are restored afterwards.

Requires: TradingView Desktop launched with remote debugging (`tv_launch` in the MCP,
or `--remote-debugging-port=9222`) on the machine that runs the OneView server.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

CDP_URL = os.environ.get("MU_TV_CDP", "http://127.0.0.1:9222")
BRIDGE_DIR = Path(os.environ.get("MU_TV_MCP_DIR", str(Path.home() / "tradingview-mcp-jackson")))
CLI = BRIDGE_DIR / "src" / "cli" / "index.js"
MAX_SYMBOLS = 12          # a re-check is bounded: about 12 s per symbol on the owner's chart
SETTLE_S = 0.6            # after a symbol switch, let the bars settle before reading


def available() -> bool:
    if not CLI.exists():
        return False
    try:
        with urllib.request.urlopen(f"{CDP_URL}/json/version", timeout=1.5) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def _cli(*args: str, timeout: int = 30) -> dict[str, Any]:
    p = subprocess.run(["node", str(CLI), *args], capture_output=True, text=True, timeout=timeout)
    out = p.stdout.strip()
    if not out:
        raise RuntimeError(f"bridge returned nothing for {' '.join(args)}: {p.stderr.strip()[:200]}")
    try:
        return json.loads(out[out.index("{"):])
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"bridge output not JSON for {' '.join(args)}: {out[:200]}") from e


def chart_state() -> dict[str, Any]:
    return _cli("state")


def daily_closes(symbols: list[str], count: int = 300) -> dict[str, dict[str, Any]]:
    """{sym: {"closes": [...old->new], "dates": [...], "last": float, "as_of": iso}} for up to MAX_SYMBOLS names.
    Switches the chart to each symbol on a daily timeframe and restores the original chart afterwards."""
    symbols = list(dict.fromkeys(s.upper() for s in symbols))[:MAX_SYMBOLS]
    out: dict[str, dict[str, Any]] = {}
    if not symbols or not available():
        return out
    try:
        orig = chart_state()
    except Exception:  # noqa: BLE001
        orig = {}
    try:
        _cli("timeframe", "D")
        for sym in symbols:
            try:
                r = _cli("symbol", sym)
                if not r.get("success"):
                    continue
                time.sleep(SETTLE_S)
                d = _cli("ohlcv", "-n", str(count))
                bars = d.get("bars") or []
                got = (r.get("symbol") or sym).split(":")[-1].upper()
                if got != sym or len(bars) < 60:
                    log.info("tv bridge: %s -> chart shows %s with %d bars, skipped", sym, got, len(bars))
                    continue
                out[sym] = {"closes": [float(b["close"]) for b in bars],
                            "dates": [datetime.fromtimestamp(int(b["time"]), tz=timezone.utc).date().isoformat() for b in bars],
                            "last": float(bars[-1]["close"]), "as_of": datetime.now(timezone.utc).isoformat(), "source": "tradingview"}
            except Exception as e:  # noqa: BLE001
                log.warning("tv bridge failed for %s: %s", sym, e)
    finally:
        try:
            if orig.get("resolution"):
                _cli("timeframe", str(orig["resolution"]).replace("1D", "D"))
            if orig.get("symbol"):
                _cli("symbol", str(orig["symbol"]))
        except Exception:  # noqa: BLE001
            log.warning("tv bridge: could not restore the chart to %s", orig)
    return out
