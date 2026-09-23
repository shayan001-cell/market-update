"""Public web service: serves the dashboard, rebuilds on a schedule, and
exposes a rate-limited refresh endpoint.

    uvicorn market_update.server:app --host 0.0.0.0 --port 8000

Environment:
    TYPESAFE_API_KEY       required unless MU_NO_AI=1
    MU_NO_AI=1             build without TypeSafe judgments
    MU_REFRESH_COOLDOWN    seconds between manual refreshes (default 120)
    MU_INTERVAL_MARKET     rebuild interval during pre-market/regular session (default 300)
    MU_INTERVAL_POST       after-hours interval (default 900)
    MU_INTERVAL_OFF        nights/weekends interval (default 3600)
    MU_DATA_DIR            where report.json is persisted (default ./output)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, fetch
from .analyze import analyze_ticker, build_report

log = logging.getLogger("market_update.server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(os.environ.get("MU_DATA_DIR", config.OUTPUT_DIR))
REPORT_PATH = DATA_DIR / "report.json"
USE_AI = os.environ.get("MU_NO_AI", "0") not in ("1", "true", "yes")

app = FastAPI(title="Market Update", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


@app.middleware("http")
async def _no_stale_static(request, call_next):
    """The page and its assets change with every deploy; make browsers revalidate them."""
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response
app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")

state: dict[str, Any] = {
    "report": None,
    "building": False,
    "last_build_started": None,
    "last_build_finished": None,
    "last_error": None,
    "last_manual_refresh": 0.0,
    "builds": 0,
    "adhoc": {},          # ticker -> record analysed on demand from the page
    "adhoc_inflight": set(),
}
_lock = asyncio.Lock()


def _interval() -> int:
    ms = fetch.market_state()
    if ms in ("pre", "open"):
        return config.INTERVAL_MARKET_S
    if ms == "post":
        return config.INTERVAL_POST_S
    return config.INTERVAL_OFF_S


def _run_build_sync() -> dict[str, Any]:
    # build_report is async but its fetchers block; give it its own loop in a worker thread.
    return asyncio.run(build_report(use_ai=USE_AI))


async def do_build(reason: str) -> bool:
    if _lock.locked():
        return False
    async with _lock:
        state["building"] = True
        state["last_build_started"] = time.time()
        log.info("build start (%s)", reason)
        try:
            report = await asyncio.to_thread(_run_build_sync)
            state["report"] = report
            state["last_error"] = None
            state["builds"] += 1
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            REPORT_PATH.write_text(json.dumps(report, default=str))
            log.info("build done in %ss: %s calls, %s stocks", report["elapsed_s"], report["ai_stats"]["calls"], len(report["stocks"]))
        except Exception as e:  # noqa: BLE001
            state["last_error"] = f"{type(e).__name__}: {e}"
            log.exception("build failed")
        finally:
            state["building"] = False
            state["last_build_finished"] = time.time()
    return True


async def scheduler() -> None:
    while True:
        try:
            last = state["last_build_finished"] or 0
            if time.time() - last >= _interval():
                await do_build("schedule")
        except Exception:  # noqa: BLE001
            log.exception("scheduler error")
        await asyncio.sleep(30)


@app.on_event("startup")
async def _startup() -> None:
    if USE_AI and not os.environ.get("TYPESAFE_API_KEY"):
        log.warning("TYPESAFE_API_KEY is not set: builds will run without model judgments until it is exported")
    if REPORT_PATH.exists():
        try:
            state["report"] = json.loads(REPORT_PATH.read_text())
            log.info("loaded cached report from %s", REPORT_PATH)
        except Exception:  # noqa: BLE001
            log.exception("could not load cached report")
    asyncio.create_task(scheduler())


@app.get("/")
async def index() -> HTMLResponse:
    """Serve index.html with asset URLs versioned by file mtime, so a deploy never fights a browser cache."""
    html = (config.STATIC_DIR / "index.html").read_text()
    for name in ("app.js", "styles.css"):
        v = int((config.STATIC_DIR / name).stat().st_mtime)
        html = html.replace(f"/static/{name}", f"/static/{name}?v={v}")
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/api/report")
async def api_report() -> JSONResponse:
    if state["report"] is None:
        raise HTTPException(status_code=503, detail="first build in progress")
    return JSONResponse(state["report"], headers={"Cache-Control": "no-store"})


@app.get("/api/status")
async def api_status() -> dict[str, Any]:
    r = state["report"]
    now = time.time()
    return {
        "building": state["building"],
        "build_id": r["build_id"] if r else None,
        "generated_at": r["generated_at"] if r else None,
        "market_state": fetch.market_state(),
        "last_error": state["last_error"],
        "builds": state["builds"],
        "next_scheduled_in_s": max(0, int(_interval() - (now - (state["last_build_finished"] or 0)))),
        "refresh_available_in_s": max(0, int(config.REFRESH_COOLDOWN_S - (now - state["last_manual_refresh"]))),
        "ai_enabled": USE_AI,
    }


@app.post("/api/refresh")
async def api_refresh() -> JSONResponse:
    now = time.time()
    wait = config.REFRESH_COOLDOWN_S - (now - state["last_manual_refresh"])
    if state["building"]:
        return JSONResponse({"status": "building"}, status_code=202)
    if wait > 0:
        return JSONResponse({"status": "cooldown", "retry_in_s": int(wait)}, status_code=429)
    state["last_manual_refresh"] = now
    asyncio.create_task(do_build("manual"))
    return JSONResponse({"status": "started"}, status_code=202)


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "has_report": state["report"] is not None}


@app.get("/symbols.json")
async def symbols() -> JSONResponse:
    """Search index: every US-listed stock and ETF as [symbol, name, kind, exchange]."""
    rows = await asyncio.to_thread(fetch.fetch_symbol_index)
    return JSONResponse(rows, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/stock/{ticker}")
async def api_stock(ticker: str) -> JSONResponse:
    """Full analysis for one ticker on demand (a name added to a watchlist on the page).
    Cached for the life of the current report; re-analysed after the next build."""
    t = ticker.upper().strip()
    if not t.isascii() or len(t) > 10 or any(ch not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-." for ch in t):
        raise HTTPException(status_code=400, detail="bad ticker")
    r = state["report"]
    if r:
        for s in r["stocks"]:
            if s["ticker"] == t:
                return JSONResponse({"status": "ok", "source": "report", "stock": s}, headers={"Cache-Control": "no-store"})
    cached = state["adhoc"].get(t)
    if cached and cached.get("build_id") == (r or {}).get("build_id"):
        return JSONResponse({"status": "ok", "source": "adhoc", "stock": cached["stock"]}, headers={"Cache-Control": "no-store"})
    if t in state["adhoc_inflight"]:
        return JSONResponse({"status": "building"}, status_code=202)
    state["adhoc_inflight"].add(t)
    try:
        tone = (((r or {}).get("regime") or {}).get("tone") or {}).get("choice", "mixed")
        rec = await asyncio.to_thread(lambda: asyncio.run(analyze_ticker(t, tone, USE_AI)))
    except Exception as e:  # noqa: BLE001
        log.exception("adhoc analysis failed for %s", t)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    finally:
        state["adhoc_inflight"].discard(t)
    if rec is None:
        raise HTTPException(status_code=404, detail=f"no price history for {t}")
    state["adhoc"][t] = {"build_id": (r or {}).get("build_id"), "stock": rec}
    return JSONResponse({"status": "ok", "source": "adhoc", "stock": rec}, headers={"Cache-Control": "no-store"})


@app.post("/api/watchlist")
async def api_watchlist(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """The page sends every ticker across its lists; scheduled builds then analyse them fully."""
    tickers = payload.get("tickers") or []
    if not isinstance(tickers, list):
        raise HTTPException(status_code=400, detail="tickers must be a list")
    saved = config.save_dynamic_watchlist([str(t) for t in tickers])
    return {"status": "ok", "tickers": saved}


_news_cache: dict[str, Any] = {"at": 0.0, "items": []}


@app.get("/api/news")
async def api_news() -> JSONResponse:
    """Live headline feed for the home page: market seeds plus every watchlist ticker, refreshed at most once a minute."""
    now = time.time()
    if now - _news_cache["at"] > 60:
        symbols = list(dict.fromkeys(config.NEWS_SEED_SYMBOLS + config.load_watchlist()))[:40]
        try:
            items = await asyncio.to_thread(fetch.fetch_news, symbols, 6, 24)
        except Exception as e:  # noqa: BLE001
            log.warning("news feed failed: %s", e)
            items = _news_cache["items"]
        r = state["report"] or {}
        judged = {h.get("id"): h.get("ai") for h in r.get("headlines", []) if h.get("id")}
        for it in items:
            if it["id"] in judged:
                it["ai"] = judged[it["id"]]
        _news_cache.update(at=now, items=items[:60])
    return JSONResponse({"items": _news_cache["items"], "as_of": _news_cache["at"]}, headers={"Cache-Control": "no-store"})
