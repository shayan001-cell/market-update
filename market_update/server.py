"""Public web service: serves the dashboard, rebuilds on a schedule, and
exposes a rate-limited refresh endpoint.

    uvicorn market_update.server:app --host 0.0.0.0 --port 8000

Environment:
    TYPESAFE_API_KEY       required unless MU_NO_AI=1
    MU_SECRET              signs session cookies (generated once into MU_DATA_DIR/.secret if unset)
    MU_PUBLIC_URL          base URL used in sign-in links (default: the request's origin)
    MU_SMTP_HOST/PORT/USER/PASS/FROM   send sign-in links by email; without them the link is
                           logged and, unless MU_DEV_LINKS=0, returned to the page for local use
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
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Response, Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi import Request, Response
from fastapi.staticfiles import StaticFiles

from . import config, db, fetch, mail
from . import judgments as J
from . import scanner
from .analyze import _clean, _scan_slim, analyze_ticker, build_report

log = logging.getLogger("market_update.server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

DATA_DIR = Path(os.environ.get("MU_DATA_DIR", config.OUTPUT_DIR))
REPORT_PATH = DATA_DIR / "report.json"
USE_AI = os.environ.get("MU_NO_AI", "0") not in ("1", "true", "yes")

app = FastAPI(title="OneView", version="0.3.0")
_CORS = [o.strip().rstrip("/") for o in os.environ.get("MU_CORS_ORIGINS", "https://shayan001-cell.github.io").split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_CORS, allow_credentials=True, allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["*"])


@app.middleware("http")
async def _no_stale_static(request, call_next):
    """The page and its assets change with every deploy; make browsers revalidate them. Also counts traffic for the admin view."""
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    if not path.startswith("/static/") and path != "/healthz":
        try:
            await asyncio.to_thread(db.count_request, path == "/")
        except Exception:  # noqa: BLE001
            pass
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
    "live_scan": None,    # minute-by-minute intraday scan (numbers only; the hourly build adds the model reads)
    "live_scan_at": 0.0,
    "desk": None,         # three-pillar trading desk scorecards (Agentic Trading Desk framework, MIT)
    "desk_at": 0.0,
}
_lock = asyncio.Lock()


def _interval() -> int:
    ms = fetch.market_state()
    if ms in ("pre", "open"):
        return config.INTERVAL_MARKET_S
    if ms == "post":
        return config.INTERVAL_POST_S
    return config.INTERVAL_OFF_S


AI_REPORT_PATH = DATA_DIR / "report_ai.json"      # the last build whose model reads succeeded
AI_INTERVAL_S = int(os.environ.get("MU_AI_INTERVAL", "1800"))   # re-judge at most this often; prices still refresh every build


def _run_build_sync(use_ai: bool) -> dict[str, Any]:
    # build_report is async but its fetchers block; give it its own loop in a worker thread.
    return asyncio.run(build_report(use_ai=use_ai))


def _carry_ai(new: dict[str, Any], old: dict[str, Any] | None) -> dict[str, Any]:
    """When a build has no model reads (credits out, provider down, or a deliberate no-AI build), keep the
    last good reads next to the fresh prices instead of showing empty cards. Everything carried is stamped."""
    if not old:
        return new
    if not new.get("regime") and old.get("regime"):
        new["regime"] = old["regime"]
    for key in ("horizons", "theme", "options", "smart_money"):
        if isinstance(new.get(key), dict) and isinstance(old.get(key), dict) and not new[key].get("ai") and old[key].get("ai"):
            new[key]["ai"] = old[key]["ai"]
    def by(rows, k): return {r.get(k): r for r in (rows or []) if isinstance(r, dict) and r.get(k)}
    for path, k, fields in (("stocks", "ticker", ("ai", "verdict", "scores", "tags", "plan", "checklist")), ("headlines", "id", ("ai",)),
                            (("scan", "rows"), "ticker", ("ai",)), (("low_float", "rows"), "ticker", ("ai",)), (("smart_money", "rows"), "ticker", ("ai",)),
                            (("options", "rows"), "ticker", ("ai",)), (("theme", "rows"), "ticker", ("ai", "rank")), ("earnings", "symbol", ("ai",))):
        nrows = new.get(path) if isinstance(path, str) else (new.get(path[0]) or {}).get(path[1])
        orows = old.get(path) if isinstance(path, str) else (old.get(path[0]) or {}).get(path[1])
        om = by(orows, k)
        for r in nrows or []:
            o = om.get(r.get(k))
            if not o:
                continue
            for f in fields:
                if r.get(f) in (None, [], {}) and o.get(f) not in (None, [], {}):
                    r[f] = o[f]
            for sub in ("smart", "options"):
                if isinstance(r.get(sub), dict) and isinstance(o.get(sub), dict) and not r[sub].get("ai") and o[sub].get("ai"):
                    r[sub]["ai"] = o[sub]["ai"]
    new["ai_from"] = old.get("ai_from") or old.get("generated_at")
    new["ai_enabled"] = True
    return new


async def do_build(reason: str) -> bool:
    if _lock.locked():
        return False
    async with _lock:
        state["building"] = True
        state["last_build_started"] = time.time()
        log.info("build start (%s)", reason)
        try:
            use_ai = USE_AI and (time.time() - state.get("ai_at", 0) >= AI_INTERVAL_S or reason == "manual")
            report = await asyncio.to_thread(_run_build_sync, use_ai)
            src = report.get("ai_source") or ("model" if (report.get("ai_stats") or {}).get("calls", 0) > 0 else "none")
            if src in ("model", "mixed") and report.get("regime"):
                state["ai_at"] = time.time(); state["ai_report"] = report
                try:
                    AI_REPORT_PATH.write_text(json.dumps(report, default=str))
                except Exception:  # noqa: BLE001
                    log.exception("could not save the AI report")
            elif src == "rules" and report.get("regime"):
                # Backup engine answered: fresh reads from rules, clearly labelled. Re-try the model next build.
                state["ai_at"] = 0
                log.warning("model reads failed this build (%s); %s answers came from the backup rules", (report.get("ai_stats") or {}).get("last_error"), (report.get("ai_stats") or {}).get("rule_answers"))
            else:
                if not state.get("ai_report") and AI_REPORT_PATH.exists():
                    try:
                        state["ai_report"] = json.loads(AI_REPORT_PATH.read_text())
                    except Exception:  # noqa: BLE001
                        pass
                report = _carry_ai(report, state.get("ai_report"))
                if use_ai:
                    log.error("model reads failed this build (%s failures); carrying reads from %s", (report.get("ai_stats") or {}).get("failures"), report.get("ai_from"))
            state["report"] = report
            state["last_error"] = None
            state["builds"] += 1
            try:
                await asyncio.to_thread(_ledger_from_report, report)
            except Exception:  # noqa: BLE001
                log.exception("verdict ledger failed")
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


def _live_scan_sync() -> dict[str, Any]:
    r = state["report"] or {}
    watch = config.load_watchlist()
    universe = list(dict.fromkeys(list(config.INDEX_ETFS) + list(config.SECTOR_ETFS) + config.UNIVERSE + watch + [x["ticker"] for x in (r.get("low_float") or {}).get("rows", [])]
                                  + [s["ticker"] for s in r.get("stocks", [])] + [k for k in state["adhoc"]]))
    mstate = fetch.market_state()
    sc = scanner.scan(fetch.fetch_intraday(universe), {}, universe, mstate)
    # One quote map for every view: last 15-minute bar for the scan universe, fast quotes for the tape symbols.
    now_ts = time.time()
    # bar-based prices are only as fresh as the last bar: before the open they are yesterday's closes and must not
    # outrank the report's pre-market snapshot, so each quote carries the bar's own timestamp
    try:
        bar_ts = datetime.fromisoformat(str(sc["last_bar"])).timestamp() if sc.get("last_bar") else now_ts
    except Exception:  # noqa: BLE001
        bar_ts = now_ts
    quotes: dict[str, Any] = {}
    for t, rec in sc["by_ticker"].items():
        ses = rec.get("session") or {}
        if rec.get("price") is not None:
            vol = ses.get("session_volume")
            quotes[t] = {"last": rec["price"], "chg_pct": rec.get("chg_pct"), "ts": bar_ts, "src": "bars", "rvol": ses.get("rvol_time_of_day"),
                         "above_vwap": ses.get("above_vwap"), "dollar_vol": round(vol * rec["price"]) if vol else None, "vol": vol,
                         "score": rec.get("score"), "direction": rec.get("direction"), "range_pos": ses.get("range_pos")}
    tape_syms = [m["symbol"] for m in r.get("macro", [])] + [w["symbol"] for w in r.get("world", [])]
    try:
        for sym, q in fetch.fetch_quotes(tape_syms).items():
            if q.get("last") is not None:
                quotes[sym] = {"last": q["last"], "chg_pct": q.get("change_pct"), "ts": now_ts, "src": "quote"}
    except Exception as e:  # noqa: BLE001
        log.warning("tape quotes failed: %s", e)
    if not state.get("sym_names"):
        state["sym_names"] = {row[0]: row[1] for row in fetch.fetch_symbol_index()}
    names = dict(state["sym_names"])
    names.update({t: q["name"] for t, q in (r.get("lite") or {}).items() if q.get("name")})
    reads = {x["ticker"]: x.get("ai") for x in (r.get("scan") or {}).get("rows", []) if x.get("ai")}
    rows = []
    for x in sorted(sc["by_ticker"].values(), key=lambda v: (not v["qualifies"], -v["score"]))[:40]:   # every qualifying name first, so the count on the page matches the rows
        slim = _scan_slim(x)
        slim.update(ticker=x["ticker"], name=names.get(x["ticker"], x["ticker"]), price=x["price"], chg_pct=x["chg_pct"], qualifies=x["qualifies"],
                    session={k: x["session"].get(k) for k in ("rvol_time_of_day", "above_vwap", "range_pos", "chg_from_open_pct", "session_volume", "avg_session_volume", "bars_today", "session_date")},
                    ai=reads.get(x["ticker"]))
        rows.append(slim)
    return _clean({"rows": rows, "scanned": sc["scanned"], "qualified": sc["qualified"], "as_of": time.time(), "last_bar": sc["last_bar"], "market_state": mstate,
                   "settings": sc["settings"], "quotes": quotes, "quotes_at": now_ts})


def _live_interval() -> int:
    return config.SCAN_LIVE_SECONDS if fetch.market_state() in ("pre", "open", "post") else config.SCAN_LIVE_SECONDS_OFF


async def live_scanner() -> None:
    while True:
        try:
            if state["report"] is not None and time.time() - state["live_scan_at"] >= _live_interval():
                state["live_scan"] = await asyncio.to_thread(_live_scan_sync)
                state["live_scan_at"] = time.time()
        except Exception:  # noqa: BLE001
            log.exception("live scan failed")
        await asyncio.sleep(5)


@app.get("/api/scan/live")
async def api_scan_live() -> JSONResponse:
    ls = state["live_scan"]
    if ls is None:
        return JSONResponse({"status": "warming"}, status_code=202, headers={"Cache-Control": "no-store"})
    nxt = max(0, int(_live_interval() - (time.time() - state["live_scan_at"])))
    return JSONResponse({**ls, "next_in_s": nxt, "interval_s": _live_interval()}, headers={"Cache-Control": "no-store"})


def _ledger_from_report(report: dict[str, Any]) -> None:
    """Log every stance the build produced and score the ones whose horizon has passed."""
    rows = []
    for s in report.get("stocks", []):
        a = s.get("ai") or {}
        v = s.get("verdict") or {}
        if v.get("code"):
            rows.append({"ticker": s["ticker"], "kind": "swing", "verdict": v["code"], "price": s.get("last_price"), "build_id": report["build_id"]})
        elif a.get("stance"):
            rows.append({"ticker": s["ticker"], "kind": "swing", "verdict": a["stance"]["choice"], "price": s.get("last_price"), "build_id": report["build_id"]})
        if a.get("intraday"):
            rows.append({"ticker": s["ticker"], "kind": "intraday", "verdict": a["intraday"]["choice"], "price": s.get("last_price"), "build_id": report["build_id"]})
        if a.get("long_term"):
            rows.append({"ticker": s["ticker"], "kind": "long_term", "verdict": a["long_term"]["choice"], "price": s.get("last_price"), "build_id": report["build_id"]})
    n = db.log_verdicts(rows)
    prices = {t: q["last_price"] for t, q in (report.get("lite") or {}).items() if q.get("last_price")}
    prices.update({s["ticker"]: s["last_price"] for s in report.get("stocks", []) if s.get("last_price")})
    scored = db.evaluate_verdicts(prices)
    log.info("verdict ledger: %d logged, %d scored", n, scored)


def _brief_dir() -> Path:
    d = DATA_DIR / "briefs"
    d.mkdir(parents=True, exist_ok=True)
    return d


BRIEF_SLOTS = [("morning", 7 * 60), ("close", 16 * 60 + 30)]     # minutes after midnight ET; the middle of the day is the live 15-minute direction read


def _brief_file(day: str, slot: str) -> Path:
    return _brief_dir() / (f"{day}.json" if slot == "morning" else f"{day}-{slot}.json")


def _load_briefs(day: str) -> dict[str, Any]:
    out = {}
    for slot, _ in BRIEF_SLOTS:
        p = _brief_file(day, slot)
        if p.exists():
            try:
                b = json.loads(p.read_text()); b.setdefault("slot", slot); b.setdefault("title", {"morning": "Morning briefing", "close": "After the close"}[slot]); out[slot] = b
            except Exception:  # noqa: BLE001
                pass
    return out


async def make_brief(day: str, slot: str = "morning") -> None:
    from .analyze import Judge, morning_brief
    if state.get("brief_building") or not state.get("report"):
        return
    state["brief_building"] = True
    try:
        b = await morning_brief(state["report"], Judge(enabled=USE_AI), slot)
        if slot == "morning":
            for sym in ("SPY", "QQQ"):
                x = (b.get("indexes") or {}).get(sym) or {}
                a = (x.get("ai") or {}).get("next_move") or {}
                if a.get("choice") and not any(m["symbol"] == sym for m in db.day_detail(day).get("morning", [])):
                    db.log_analysis(day, "morning_index", sym, x.get("now_price") or x.get("last"), a["choice"], a.get("confidence"), {k: v for k, v in x.items() if k not in ("bars", "ai")})
        if slot == "close":
            try:
                b["scorecard"] = await asyncio.to_thread(_score_day, day, b)
            except Exception:  # noqa: BLE001
                log.exception("scorecard failed")
            try:
                from .analyze import week_and_mood
                b["extras"] = await asyncio.to_thread(week_and_mood, state["report"], state.get("desk"))
            except Exception:  # noqa: BLE001
                log.exception("close extras failed")
        _brief_file(day, slot).write_text(json.dumps(b, default=str))
        state.setdefault("briefs", {})
        if state.get("briefs_day") != day:
            state["briefs"] = {}; state["briefs_day"] = day
        state["briefs"][slot] = b
        state["brief"] = state["briefs"].get("morning") or b
        log.info("%s briefing generated for %s", slot, day)
        if slot == "morning":
            await asyncio.to_thread(_mail_brief, b, day)
        if slot == "close":
            await asyncio.to_thread(_mail_close, b, day)
            await asyncio.to_thread(_post_whatsapp, b, day)
    except Exception:  # noqa: BLE001
        log.exception("%s briefing failed", slot)
    finally:
        state["brief_building"] = False


def _api_root() -> str:
    env = os.environ.get("MU_API_PUBLIC_URL") or os.environ.get("MU_API_URL")
    if env:
        return env.rstrip("/")
    p = Path("/tmp/mu-tunnel-url.txt")
    if p.exists() and p.read_text().strip():
        return p.read_text().strip().rstrip("/")
    return "http://localhost:8000"


def _closing_quotes(tickers: list[str]) -> dict[str, dict[str, float]]:
    """Regular-session close and change for the after-close email (no extended-hours prints)."""
    out: dict[str, dict[str, float]] = {}
    if not tickers:
        return out
    try:
        h = fetch.download(list(dict.fromkeys(tickers)), period="5d", interval="1d", prepost=False)
        for t in tickers:
            f = fetch.frame_for(h, t)
            if f is None or "Close" not in f or len(f) < 2:
                continue
            c = [float(x) for x in f["Close"].dropna().tolist()]
            if len(c) >= 2 and c[-2]:
                out[t] = {"last": c[-1], "chg_pct": (c[-1] / c[-2] - 1) * 100}
    except Exception as e:  # noqa: BLE001
        log.warning("closing quotes failed: %s", e)
    return out


def _watch_for_email(email: str, report: dict[str, Any], closing: dict[str, dict[str, float]] | None = None) -> list[dict[str, Any]]:
    prof = db.profile(email) or {}
    tickers = (prof.get("tickers") or [])[:8]
    by_ticker = {s["ticker"]: s for s in report.get("stocks", [])}
    lite = report.get("lite") or {}
    ls = state.get("live_scan") or {}
    quotes = ls.get("quotes") or {}
    out = []
    for t in tickers:
        s = by_ticker.get(t) or state["adhoc"].get(t, {}).get("stock")
        q = (closing or {}).get(t) or (quotes.get(t) if closing is None else {}) or {}
        l = lite.get(t) or {}
        v = (s or {}).get("verdict") or {}
        out.append({"ticker": t, "name": (s or {}).get("name") or l.get("name") or "", "last": q.get("last") or (s or {}).get("last_price") or l.get("last_price"),
                    "chg_pct": q.get("chg_pct") if q.get("chg_pct") is not None else ((s or {}).get("chg_pct") if s else l.get("chg_pct")),
                    "read": v.get("word"), "why": (v.get("why") or [None])[0]})
    return out


def _mail_brief(b: dict[str, Any], day: str) -> None:
    """One short email per signed-in user, once per day, after the 07:00 briefing."""
    marker = _brief_dir() / f"{day}.mailed"
    if marker.exists() or not mail.status().get("configured"):
        return
    report = state.get("report") or {}
    site = (os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL) + "/#view=home&brief=1"   # opens the desk on the briefing
    sent = 0
    for u in db.brief_recipients():
        try:
            unsub = f"{_api_root()}/brief/unsubscribe?t={_sign(u['email'])}"
            subject, text, html = mail.brief_email(u.get("name") or "", b, _watch_for_email(u["email"], report), site, unsub)
            mail.send(u["email"], subject, text, html, unsubscribe_url=unsub)
            sent += 1
        except Exception as e:  # noqa: BLE001
            log.warning("briefing email to %s failed: %s", u["email"], e)
    if sent:
        marker.write_text(str(sent))
    else:
        log.error("briefing emailed to nobody; will retry")
    log.info("briefing emailed to %d users", sent)


def _mail_close(b: dict[str, Any], day: str) -> None:
    """One after-the-close email per signed-in user, once per day. The marker lists who has it, so a retry
    after a provider throttle sends only to the rest; a throttle reply stops the run instead of burning the list."""
    marker = _brief_dir() / f"{day}-close.mailed"
    if not mail.status().get("configured"):
        return
    done: set[str] = set()
    if marker.exists():
        try:
            raw = marker.read_text().strip()
            done = set(json.loads(raw).get("sent", [])) if raw.startswith("{") else set()
            if not raw.startswith("{"):
                return                                   # old-style marker (a count): that day is finished
        except Exception:  # noqa: BLE001
            return
    recipients = [u for u in db.brief_recipients() if u["email"] not in done]
    if not recipients:
        return
    report = state.get("report") or {}
    base = os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL
    site = base + "/#view=home&brief=1"
    record = base + "/#view=record"
    all_tickers = sorted({t for u in recipients for t in ((db.profile(u["email"]) or {}).get("tickers") or [])[:8]})
    closing = _closing_quotes(all_tickers)
    sent = 0
    throttled = False
    for u in recipients:
        try:
            unsub = f"{_api_root()}/brief/unsubscribe?t={_sign(u['email'])}"
            subject, text, html = mail.close_email(u.get("name") or "", b, _watch_for_email(u["email"], report, closing), site, record, unsub)
            mail.send(u["email"], subject, text, html, unsubscribe_url=unsub)
            done.add(u["email"]); sent += 1
            time.sleep(1.2)
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            log.warning("close email to %s failed: %s", u["email"], msg[:160])
            if "Unusual sending activity" in msg or "5.4.6" in msg or "rate" in msg.lower() and "limit" in msg.lower():
                throttled = True
                break
    marker.write_text(json.dumps({"sent": sorted(done), "remaining": len(db.brief_recipients()) - len(done), "throttled": throttled}))
    log.info("close briefing emailed to %d users this run, %d done, %d remaining%s", sent, len(done), len(db.brief_recipients()) - len(done), " (provider throttled; will retry)" if throttled else "")


def _post_whatsapp(b: dict[str, Any], day: str) -> None:
    """Post the short after-the-close summary to the WhatsApp group through the linked account (tools/whatsapp)."""
    group = os.environ.get("MU_WA_GROUP", "").strip()
    session = Path(os.environ.get("MU_WA_AUTH") or (DATA_DIR / "wa-baileys"))
    marker = _brief_dir() / f"{day}-close.whatsapp"
    if not group or not session.exists() or marker.exists():
        return
    from .analyze import close_whatsapp_text
    import subprocess, tempfile
    base = os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL
    text = close_whatsapp_text(b, keep_url=f"{_api_root()}/keep-in-inbox", site_url=base)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text); path = f.name
    try:
        r = subprocess.run(["node", str(Path(__file__).resolve().parents[1] / "tools" / "whatsapp" / "wab.js"), "send", group, path], capture_output=True, text=True, timeout=300)
        if r.returncode == 0:
            marker.write_text(r.stdout.strip()); log.info("whatsapp: %s", r.stdout.strip())
        else:
            log.error("whatsapp post failed: %s %s", r.stdout.strip()[-200:], r.stderr.strip()[-200:])
    except Exception:  # noqa: BLE001
        log.exception("whatsapp post failed")
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def _score_day(day: str, close_brief: dict[str, Any]) -> dict[str, Any]:
    """After the close: score every 15-minute read and the morning call against what the market did."""
    from .analyze import score_direction
    q = fetch.fetch_quotes(["SPY", "QQQ"])
    close_spy = (q.get("SPY") or {}).get("last"); close_qqq = (q.get("QQQ") or {}).get("last")
    ses = {x["symbol"]: x for x in (close_brief.get("session") or {}).get("indexes", [])}
    if not close_spy:
        close_spy = (ses.get("SPY") or {}).get("last")
    if not close_qqq:
        close_qqq = (ses.get("QQQ") or {}).get("last")
    tot = db.score_day_directions(day, close_spy or 0, close_qqq or 0, score_direction) if close_spy and close_qqq else {"n": 0, "hits": 0, "scored": 0}
    if close_spy and close_qqq:
        db.score_analysis(day, {"SPY": close_spy, "QQQ": close_qqq}, score_direction)
    try:
        _fill_paths(day)
    except Exception:  # noqa: BLE001
        log.exception("could not fill the 15/30/60-minute paths")
    reads = db.day_directions(day)
    morning = (state.get("briefs") or {}).get("morning") or {}
    m_call = (((morning.get("indexes") or {}).get("SPY") or {}).get("ai") or {}).get("next_move", {}).get("choice")
    m_expected = {"push_higher": "higher", "rebound": "higher", "break_lower": "lower", "pullback_then_higher": "lower", "range_bound": "sideways"}.get(m_call)
    spy_day = (ses.get("SPY") or {}).get("chg_pct"); qqq_day = (ses.get("QQQ") or {}).get("chg_pct")
    m_hit = score_direction(m_expected, spy_day) if m_expected is not None else None
    return {"day": day, "close_spy": close_spy, "close_qqq": close_qqq, "spy_day_pct": spy_day, "qqq_day_pct": qqq_day,
            "reads": tot.get("n", 0), "hits": tot.get("hits") or 0, "scored": tot.get("scored") or 0,
            "hit_rate": round((tot.get("hits") or 0) / tot["scored"] * 100) if tot.get("scored") else None,
            "morning_call": m_call, "morning_expected": m_expected, "morning_hit": m_hit,
            "timeline": [{"at": r["ts"], "expected": r["expected"], "confidence": r["confidence"], "spy": r["spy"], "move_spy_pct": r["move_spy_pct"], "hit": r["hit"]} for r in reads],
            "how": "Each 15-minute read is a hit when SPY closed on the side it expected (sideways: within 0.15% of the read price). The morning call is scored the same way against the full day."}


def _spy_price_at_factory(day: str):
    """`price_at(ts)` over SPY 5-minute bars for the day: the close of the last bar at or before ts."""
    try:
        bars = fetch.download(["SPY"], period="5d", interval="5m", prepost=False)
        f = fetch.frame_for(bars, "SPY")
    except Exception:  # noqa: BLE001
        f = None
    if f is None or f.empty or "Close" not in f:
        return lambda ts: None
    idx = [x.timestamp() for x in f.index]
    closes = [float(c) for c in f["Close"]]
    import bisect
    def price_at(ts: float):
        i = bisect.bisect_right(idx, ts) - 1
        if i < 0 or ts - idx[i] > 20 * 60:       # no bar within 20 minutes: market was closed
            return None
        return closes[i]
    return price_at


def _fill_paths(day: str) -> int:
    from .analyze import score_direction
    return db.fill_direction_paths(day, _spy_price_at_factory(day), score_direction)


def _score_pending_days() -> int:
    """Safety net: score any past day whose reads never got a close score (the close briefing did not run)."""
    from .analyze import score_direction
    now = fetch.now_et()
    today = now.date().isoformat()
    after_close = now.hour * 60 + now.minute >= 16 * 60 + 10 and now.weekday() < 5
    days = db.unscored_direction_days((now.date() + timedelta(days=1)).isoformat() if after_close else today)
    if not days:
        return 0
    hist = fetch.download(["SPY", "QQQ"], period="1mo", interval="1d")
    n = 0
    for day in days:
        try:
            fs, fq = fetch.frame_for(hist, "SPY"), fetch.frame_for(hist, "QQQ")
            cs = next((float(c) for d, c in zip(fs.index.date, fs["Close"]) if d.isoformat() == day), None) if fs is not None else None
            cq = next((float(c) for d, c in zip(fq.index.date, fq["Close"]) if d.isoformat() == day), None) if fq is not None else None
            if day == today and (not cs or not cq):
                q = fetch.fetch_quotes(["SPY", "QQQ"])
                cs, cq = (q.get("SPY") or {}).get("last"), (q.get("QQQ") or {}).get("last")
            if cs and cq:
                db.score_day_directions(day, cs, cq, score_direction)
                db.score_analysis(day, {"SPY": cs, "QQQ": cq}, score_direction)
                _fill_paths(day)
                n += 1
                log.info("scored pending direction reads for %s at SPY %.2f", day, cs)
        except Exception:  # noqa: BLE001
            log.exception("pending scoring failed for %s", day)
    return n


def _lessons(stats: dict[str, Any]) -> list[str]:
    """Plain-word takeaways from the scored history: what worked, what did not. Needs scored reads."""
    out: list[str] = []
    rate = lambda x: (x.get("hits") or 0) / x["scored"] * 100 if x.get("scored") else None
    tot = stats.get("totals") or {}
    if (tot.get("scored") or 0) < 10:
        return [f"Only {tot.get('scored') or 0} reads scored so far; lessons need at least 10. Every read is being logged and scored at the close and one hour on."]
    out.append(f"{tot['scored']} reads scored over the window: {round(rate(tot))}% right at the close, {round((tot.get('hits_60') or 0) / tot['scored_60'] * 100) if tot.get('scored_60') else 0}% right one hour later.")
    def best_worst(rows, label, key):
        rows = [r for r in rows if (r.get("scored") or 0) >= 5]
        if len(rows) < 2:
            return
        rows.sort(key=lambda r: rate(r))
        w, b = rows[0], rows[-1]
        out.append(f"{label}: '{str(b[key]).replace('_', ' ')}' worked best ({round(rate(b))}% of {b['scored']}); '{str(w[key]).replace('_', ' ')}' worked worst ({round(rate(w))}% of {w['scored']}).")
    best_worst(stats.get("by_driver") or [], "By reason", "driver")
    best_worst(stats.get("by_expected") or [], "By call", "expected")
    best_worst(stats.get("by_hour") or [], "By hour (ET)", "hour")
    conf = {r["conviction"]: r for r in stats.get("by_conviction") or []}
    if conf.get("high", {}).get("scored", 0) >= 5 and conf.get("low", {}).get("scored", 0) >= 5:
        hi, lo = rate(conf["high"]), rate(conf["low"])
        out.append(f"Conviction {'is' if hi > lo + 5 else 'is not'} informative: HIGH reads {round(hi)}% right vs LOW reads {round(lo)}%.")
    src = {r["source"]: r for r in stats.get("by_source") or []}
    if src.get("rules", {}).get("scored", 0) >= 5 and src.get("model", {}).get("scored", 0) >= 5:
        out.append(f"Model reads {round(rate(src['model']))}% right vs backup rules {round(rate(src['rules']))}%.")
    return out


async def direction_loop() -> None:
    """Every 15 minutes of the regular session: a technicals-plus-mood read on where the market goes into the close."""
    from .analyze import Judge, intraday_read
    if not state.get("direction_at"):
        # after a restart, continue the 15-minute rhythm from the last stored read instead of reading again at once
        try:
            last = db.day_directions(fetch.now_et().date().isoformat())
            if last:
                state["direction_at"] = float(last[-1]["ts"])
        except Exception:  # noqa: BLE001
            pass
    while True:
        try:
            if state.get("report") and fetch.market_state() == "open" and time.time() - state.get("direction_at", 0) >= 15 * 60:
                read = await intraday_read(state["report"], Judge(enabled=USE_AI))
                read["id"] = db.log_direction(read)
                state["direction"] = read; state["direction_at"] = time.time()
                log.info("direction read: %s (%.2f) %s", read.get("expected"), read.get("confidence") or 0, read.get("driver"))
                await asyncio.to_thread(_fill_paths, read.get("date") or fetch.now_et().date().isoformat())
            elif fetch.market_state() != "open" and time.time() - state.get("pending_scored_at", 0) >= 3600:
                state["pending_scored_at"] = time.time()
                await asyncio.to_thread(_score_pending_days)
                await asyncio.to_thread(_fill_paths, fetch.now_et().date().isoformat())
        except Exception:  # noqa: BLE001
            log.exception("direction read failed")
        await asyncio.sleep(60)


@app.get("/api/direction/check")
async def api_direction_check(request: Request, day: str = "") -> JSONResponse:
    """Intraday check: every read of the day, what SPY has done since each one, and the scored history
    broken down so we can see what works. Admin only (the public track record stays public)."""
    _require_admin(request)
    from .analyze import score_direction
    today = fetch.now_et().date().isoformat()
    day = day or today
    reads = await asyncio.to_thread(db.day_directions, day)
    ms = fetch.market_state()
    q = fetch.fetch_quotes(["SPY", "QQQ"]) if day == today else {}
    spy_now = (q.get("SPY") or {}).get("last"); spy_chg = (q.get("SPY") or {}).get("change_pct")
    qqq_now = (q.get("QQQ") or {}).get("last"); qqq_chg = (q.get("QQQ") or {}).get("change_pct")
    for r in reads:
        ref = r.get("close_spy") or (spy_now if day == today else None)
        r["move_now"] = (ref / r["spy"] - 1) * 100 if ref and r.get("spy") else None
        live = score_direction(r["expected"], r["move_now"]) if r.get("expected") else None
        if live is not None and r["expected"] != "sideways" and abs(r["move_now"] or 0) < 0.05:
            live_status = "flat"                      # too small to call either way yet
        else:
            live_status = {1: "on_track", 0: "against"}.get(live, "pending")
        r["status"] = ("no_read" if not r.get("expected") else "hit" if r.get("hit") == 1 else "miss" if r.get("hit") == 0 else live_status)
    on_track = sum(1 for r in reads if r["status"] in ("on_track", "hit"))
    judged = sum(1 for r in reads if r["status"] in ("on_track", "against", "hit", "miss"))
    morning = (state.get("briefs") or {}).get("morning") if day == today else None
    if not morning:
        try:
            fpath = _brief_file(day, "morning")
            morning = json.loads(fpath.read_text()) if fpath.exists() else None
        except Exception:  # noqa: BLE001
            morning = None
    m_idx = ((morning or {}).get("indexes") or {})
    m_call = {sym: (((m_idx.get(sym) or {}).get("ai") or {}).get("next_move") or {}).get("choice") for sym in ("SPY", "QQQ")}
    m_expected = {"push_higher": "higher", "rebound": "higher", "break_lower": "lower", "pullback_then_higher": "lower", "range_bound": "sideways"}
    morning_row = {"call": m_call, "expected": m_expected.get(m_call.get("SPY")), "source": (morning or {}).get("source"),
                   "status": {1: "on_track", 0: "against"}.get(score_direction(m_expected.get(m_call.get("SPY")), spy_chg), "pending") if m_call.get("SPY") else "none"}
    stats = await asyncio.to_thread(db.direction_stats, 30)
    close = None
    try:
        fpath = _brief_file(day, "close")
        close = (json.loads(fpath.read_text()) or {}).get("scorecard") if fpath.exists() else None
    except Exception:  # noqa: BLE001
        close = None
    return JSONResponse({"day": day, "market_state": ms, "spy": {"last": spy_now, "chg_pct": spy_chg}, "qqq": {"last": qqq_now, "chg_pct": qqq_chg},
                         "reads": reads, "summary": {"reads": len(reads), "no_read": sum(1 for r in reads if r["status"] == "no_read"), "on_track": on_track, "judged": judged,
                                                     "scored": sum(1 for r in reads if r.get("hit") is not None), "hits": sum(1 for r in reads if r.get("hit") == 1)},
                         "morning": morning_row, "close": close, "stats": stats, "lessons": _lessons(stats),
                         "how": "A read is on track while SPY is on the side it called (sideways: within 0.15% of the read price). It is scored for good at the close, and again one hour after the read, so we learn which reasons and hours work."},
                        headers={"Cache-Control": "no-store"})


@app.get("/api/direction/day")
async def api_direction_day(day: str = "") -> JSONResponse:
    day = day or fetch.now_et().date().isoformat()
    return JSONResponse(await asyncio.to_thread(db.day_detail, day), headers={"Cache-Control": "no-store"})


@app.get("/api/direction")
async def api_direction() -> JSONResponse:
    day = fetch.now_et().date().isoformat()
    today = await asyncio.to_thread(db.day_directions, day)
    latest = state.get("direction")
    if not latest and today:
        latest = {"at": datetime.fromtimestamp(today[-1]["ts"], tz=config.ET).isoformat(), "expected": today[-1]["expected"], "confidence": today[-1]["confidence"], "driver": today[-1]["driver"], "facts": None}
    return JSONResponse({"status": "ok" if latest else "none", "market_state": fetch.market_state(), "latest": latest, "today": today, "next_in_s": max(0, int(15 * 60 - (time.time() - state.get("direction_at", 0)))) if state.get("direction_at") else None,
                         "stats": await asyncio.to_thread(db.direction_stats, 30)}, headers={"Cache-Control": "no-store"})


async def brief_scheduler() -> None:
    """Three briefings a day, each built once when its time arrives: 07:00 morning (every day, emailed),
    13:00 midday and 16:30 after the close (market days). A slot is only built inside its own window,
    so a restart at night does not fake a midday card."""
    while True:
        try:
            now = fetch.now_et()
            today = now.date().isoformat()
            mins = now.hour * 60 + now.minute
            if state.get("briefs_day") != today:
                state["briefs"] = _load_briefs(today); state["briefs_day"] = today
                state["brief"] = state["briefs"].get("morning")
                if not state["briefs"]:                                   # nothing yet today: keep yesterday's cards visible until the morning one lands
                    y = (now.date() - timedelta(days=1)).isoformat()
                    state["briefs_prev"] = _load_briefs(y); state["briefs_prev_day"] = y
            # the morning email retries every 30 minutes until at least one message goes out (mail provider hiccups)
            morning = (state.get("briefs") or {}).get("morning")
            if morning and mins >= 7 * 60 and mins < 15 * 60 and not (_brief_dir() / f"{today}.mailed").exists() and time.time() - state.get("brief_mail_try", 0) >= 1800:
                state["brief_mail_try"] = time.time()
                await asyncio.to_thread(_mail_brief, morning, today)
            # the after-close email retries every 30 minutes until 21:00
            closing = (state.get("briefs") or {}).get("close")
            cm = _brief_dir() / f"{today}-close.mailed"
            cm_data = json.loads(cm.read_text()) if cm.exists() and cm.read_text().strip().startswith("{") else None
            close_pending = (not cm.exists()) or (cm_data is not None and cm_data.get("remaining", 0) > 0 and not cm_data.get("manual"))
            if closing and mins >= 16 * 60 + 30 and mins < 23 * 60 and close_pending and time.time() - state.get("close_mail_try", 0) >= 1800:
                state["close_mail_try"] = time.time()
                await asyncio.to_thread(_mail_close, closing, today)
            weekday = now.weekday() < 5
            for i, (slot, start) in enumerate(BRIEF_SLOTS):
                end = BRIEF_SLOTS[i + 1][1] if i + 1 < len(BRIEF_SLOTS) else 24 * 60 + 7 * 60
                if slot == "close" and not weekday:
                    continue
                if start <= mins < end and slot not in (state.get("briefs") or {}) and not _brief_file(today, slot).exists():
                    await make_brief(today, slot)
        except Exception:  # noqa: BLE001
            log.exception("brief scheduler error")
        await asyncio.sleep(60)


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
    if USERS_PATH.exists():
        log.info("imported %d accounts from users.json into %s", db.import_legacy_json(USERS_PATH), db.DB_PATH)
    asyncio.create_task(scheduler())
    asyncio.create_task(brief_scheduler())
    asyncio.create_task(direction_loop())
    asyncio.create_task(stocktwits_loop())
    asyncio.create_task(desk_loop())
    asyncio.create_task(live_scanner())


from .render import static_version as _static_version
_APP_VERSION = _static_version()


@app.get("/")
async def index(request: Request) -> HTMLResponse:
    """Serve index.html with asset URLs versioned by file mtime, so a deploy never fights a browser cache."""
    html = (config.STATIC_DIR / "index.html").read_text()
    html = html.replace('<script src="/static/app.js"></script>', f'<script>window.MU_VERSION = "{_APP_VERSION}";</script>\n<script src="/static/app.js"></script>')
    html = html.replace("__PUBLIC_URL__", os.environ.get("MU_PUBLIC_URL", "").rstrip("/") or _public_url(request)).replace("__APP_URL__", "").replace("__API_URL__", "")
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
        "app_version": _APP_VERSION,
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
async def api_stock(ticker: str, request: Request) -> JSONResponse:
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
    db.log_activity(_session_email(request), "analyzed", t)
    a = rec.get("ai") or {}
    rows = [{"ticker": t, "kind": k, "verdict": a[q]["choice"], "price": rec.get("last_price"), "build_id": (r or {}).get("build_id")}
            for k, q in (("intraday", "intraday"), ("long_term", "long_term")) if a.get(q)]
    if (rec.get("verdict") or {}).get("code"):
        rows.append({"ticker": t, "kind": "swing", "verdict": rec["verdict"]["code"], "price": rec.get("last_price"), "build_id": (r or {}).get("build_id")})
    db.log_verdicts(rows)
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
        judged = {h.get("id"): h.get("ai") for h in r.get("headlines", []) if h.get("id") and h.get("ai")}
        reads: dict[str, Any] = fetch._cache_get("news_reads", 7 * 86400) or {}
        for it in items:
            it["ai"] = judged.get(it["id"]) or reads.get(it["id"])
        fresh = [it for it in items[:60] if not it.get("ai")][:30]
        if fresh:                                            # read each new headline once so the feed can keep only what matters
            from .analyze import Judge, _headline_state
            ans = await Judge(enabled=USE_AI).run_many([_headline_state(h) for h in fresh], J.HEADLINE_QUESTIONS)
            changed = False
            for it, a in zip(fresh, ans):
                if a:
                    it["ai"] = a; reads[it["id"]] = a; changed = True
            if changed:
                fetch._cache_put("news_reads", reads)
        _news_cache.update(at=now, items=items[:60])
    return JSONResponse({"items": _news_cache["items"], "as_of": _news_cache["at"]}, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------------------
# Sign-in: email -> one-time link -> signed session cookie; then disclaimer + picks
# ---------------------------------------------------------------------------
import base64
import hashlib
import hmac
import re
import secrets
import smtplib
from email.message import EmailMessage

USERS_PATH = DATA_DIR / "users.json"
TOKENS_PATH = DATA_DIR / "auth_tokens.json"
SESSION_COOKIE = "mu_session"
SESSION_DAYS = 30
LINK_MINUTES = 10
EXPIRED_KEEP_S = 24 * 3600      # remember expired tokens so an old link can trigger a fresh email
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _secret() -> bytes:
    env = os.environ.get("MU_SECRET")
    if env:
        return env.encode()
    path = DATA_DIR / ".secret"
    if not path.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_urlsafe(48))
        try:
            path.chmod(0o600)
        except OSError:
            pass
    return path.read_text().strip().encode()


def _load(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return {}


def _save(path: Path, data: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1))


def _sign(payload: str) -> str:
    mac = hmac.new(_secret(), payload.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=") + "." + base64.urlsafe_b64encode(mac).decode().rstrip("=")


def _unsign(value: str | None) -> str | None:
    if not value or "." not in value:
        return None
    body, sig = value.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)).decode()
    except Exception:  # noqa: BLE001
        return None
    expect = _sign(payload).rsplit(".", 1)[1]
    return payload if hmac.compare_digest(expect, sig) else None


def _raw_session(request: Request) -> str | None:
    """The session value: the cookie, or a bearer token the static copy stored after the emailed link."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer ") and len(auth) > 20:
        return auth[7:].strip()
    return request.cookies.get(SESSION_COOKIE)


def _session_email(request: Request) -> str | None:
    """Signed cookie or bearer token AND a live, logged-in row in the sessions table."""
    raw = _raw_session(request)
    payload = _unsign(raw)
    if not payload:
        return None
    email, _, exp = payload.partition("|")
    try:
        if float(exp) <= time.time():
            return None
    except ValueError:
        return None
    sess = db.session(raw)
    return email if sess and sess["email"] == email else None


def _public_url(request: Request) -> str:
    env = os.environ.get("MU_PUBLIC_URL")
    if env:
        return env.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", "localhost:8000"))
    return f"{proto}://{host}"


def _send_link(email: str, link: str) -> bool:
    if not mail.status()["configured"]:
        return False
    subject, text, html = mail.signin_email(link, LINK_MINUTES)
    mail.send(email, subject, text, html)
    return True


@app.get("/api/auth/mail-status")
async def auth_mail_status() -> dict[str, Any]:
    """What the sign-in card shows: which transport sends the links and from whom (never the credentials)."""
    return mail.status()


async def _issue_link(request: Request, email: str) -> dict[str, Any]:
    """Create a single-use token for `email`, email the link (or hand it back locally), rate-limited to one a minute."""
    if db.recent_token_for(email, 60):
        raise HTTPException(status_code=429, detail="a link was sent less than a minute ago; check your inbox")
    token = secrets.token_urlsafe(32)
    db.create_token(token, email, LINK_MINUTES * 60)
    db.log_activity(email, "link_requested")
    link = f"{_public_url(request)}/auth/verify?token={token}"
    sent = False
    try:
        sent = await asyncio.to_thread(_send_link, email, link)
    except Exception as e:  # noqa: BLE001
        log.warning("email delivery failed for %s: %s", email, e)
    out: dict[str, Any] = {"status": "sent" if sent else "not_sent", "email": email, "expires_in_s": LINK_MINUTES * 60, "expires_in_min": LINK_MINUTES}
    if not sent:
        log.info("SIGN-IN LINK for %s: %s", email, link)
        if os.environ.get("MU_DEV_LINKS", "1") not in ("0", "false", "no"):
            out["dev_link"] = link          # no mail server configured: hand the link to the page (local use)
    return out


@app.post("/api/auth/request")
async def auth_request(request: Request, payload: dict[str, Any] = Body(...)) -> JSONResponse:
    email = str(payload.get("email", "")).strip().lower()
    if not _EMAIL_RE.match(email) or len(email) > 120:
        raise HTTPException(status_code=400, detail="enter a valid email address")
    return JSONResponse(await _issue_link(request, email))


_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OneView · sign-in link</title>
<link rel="icon" href="/static/brand/favicon.png">
<style>html,body{{margin:0;min-height:100dvh;background:#080E1D;color:#F5F7FC;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif}}
body{{display:grid;place-items:center;padding:24px}}
.core{{width:min(440px,100%);border:1px solid #29364C;border-radius:12px;background:#101A2B;padding:32px;display:grid;gap:14px}}
.logo{{width:170px;height:auto;display:block;mix-blend-mode:lighten;margin:0 0 6px -8px}}
.eyebrow{{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#A8B4C8;font-weight:600}}
h1{{margin:0;font-size:26px;font-weight:600;letter-spacing:-.03em;line-height:1.15}} p{{margin:0;color:#A8B4C8}}
a.pill{{display:inline-flex;align-items:center;justify-content:center;width:100%;min-height:48px;padding:0 18px;border-radius:8px;background:#245BFF;color:#fff;font-weight:600;text-decoration:none}}
a.pill:hover{{background:#1747D1}} a.pill:focus-visible{{outline:3px solid #85A7FF;outline-offset:3px}} a.pill i{{display:none}}
.muted{{color:#A8B4C8;font-size:13px}}</style>
<div class="core"><img class="logo" src="/static/brand/oneview-logo.png" alt="OneView"><span class="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{body}</p>{action}<p class="muted">{foot}</p></div>"""


@app.get("/auth/verify")
async def auth_verify(request: Request, token: str = "") -> Response:
    rec = db.consume_token(token) if token else None
    if rec and rec.get("used_at") and rec["used_at"] < time.time() - 2:
        rec = None                                    # already used earlier
    if rec and rec["expires"] < time.time():
        # Expired: send a fresh link to the same address on the spot, then say so.
        email = rec["email"]
        try:
            issued = await _issue_link(request, email)
            action = f'<a class="pill" href="{issued["dev_link"]}">Open the new link <i>↗</i></a>' if issued.get("dev_link") else ""
            body = (f"Sign-in links are valid for {LINK_MINUTES} minutes and this one has run out. We have just emailed a fresh link to <b>{email}</b>; open it and you will land straight on your dashboard."
                    if issued["status"] == "sent" else f"Sign-in links are valid for {LINK_MINUTES} minutes and this one has run out. No mail server is configured on this machine, so a fresh link for <b>{email}</b> is below.")
        except HTTPException:
            action = ""
            body = f"This link ran out after {LINK_MINUTES} minutes. A fresh one was already sent to <b>{email}</b> less than a minute ago; open that one."
        return HTMLResponse(_PAGE.format(eyebrow="Link expired", title="A fresh link is on its way", body=body, action=action,
                                         foot="If you did not request this, you can ignore the email."), status_code=410)
    if not rec:
        return HTMLResponse(_PAGE.format(eyebrow="Link not valid", title="This link was already used", body="Each sign-in link works once. Request a new one from the sign-in page and open the latest email.",
                                         action='<a class="pill" href="/">Go to sign-in <i>↗</i></a>', foot=""), status_code=400)
    email = rec["email"]
    db.ensure_user(email)
    db.touch_login(email)
    if not (db.profile(email) or {}).get("tickers"):
        db.set_watchlist(email, list(config.DEFAULT_WATCHLIST))        # a new desk starts with the default seven
    db.log_activity(email, "login", request.headers.get("user-agent", "")[:80])
    cookie = _sign(f"{email}|{time.time() + SESSION_DAYS * 86400}")
    db.open_session(cookie, email, SESSION_DAYS * 86400, request.headers.get("user-agent"))
    # The public copy lives on another origin (GitHub Pages): send the user back there with the session in the
    # URL fragment (never sent to servers), which the page stores as a bearer token. Same-origin users get the cookie.
    public = os.environ.get("MU_SITE_URL", "").rstrip("/")            # the public page (GitHub Pages) when it differs from this server
    if public and public != _public_url(request).rstrip("/"):
        return RedirectResponse(f"{public}/?signed_in=1#st={cookie}", status_code=303)
    resp = RedirectResponse("/?signed_in=1", status_code=303)
    resp.set_cookie(SESSION_COOKIE, cookie, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax")
    return resp


@app.get("/api/me")
async def api_me(request: Request) -> JSONResponse:
    email = _session_email(request)
    if not email:
        return JSONResponse({"status": "anonymous", "logged_in": False}, status_code=401, headers={"Cache-Control": "no-store"})
    prof = db.profile(email) or {"tickers": [], "accepted_disclaimer_at": None, "created": None}
    state_ = db.login_state(email)
    resp = JSONResponse({"status": "ok", "logged_in": True, "email": email, "sessions": state_["active_sessions"], "role": _role(email),
                         "name": prof.get("name") or "",
                         "profile": {"accepted_disclaimer_at": prof.get("accepted_disclaimer_at"), "tickers": prof.get("tickers", []), "created": prof.get("created"), "name": prof.get("name")}},
                        headers={"Cache-Control": "no-store"})
    # Sliding session: every visit renews the cookie and the session row, so the login stays active
    # until the user signs out or stays away for SESSION_DAYS.
    raw = _raw_session(request) or ""
    db.touch_session(raw, SESSION_DAYS * 86400)
    if request.cookies.get(SESSION_COOKIE):
        resp.set_cookie(SESSION_COOKIE, raw, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax")
    return resp


def _role(email: str) -> str:
    return "admin" if email.lower() in config.ADMIN_EMAILS else "user"


@app.post("/api/profile/name")
async def api_profile_name(request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    email = _session_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="sign in first")
    name = re.sub(r"[^\w .'\-]", "", str(payload.get("name", "")).strip())[:60]
    if not name:
        raise HTTPException(status_code=400, detail="enter a name")
    db.set_name(email, name)
    db.log_activity(email, "name", name)
    return {"status": "ok", "name": name}


@app.get("/api/admin/overview")
async def api_admin_overview(request: Request) -> JSONResponse:
    email = _session_email(request)
    if not email or _role(email) != "admin":
        raise HTTPException(status_code=403, detail="admin only")
    ov = await asyncio.to_thread(db.admin_overview)
    ov["admin"] = email
    ov["build"] = {"build_id": (state["report"] or {}).get("build_id"), "generated_at": (state["report"] or {}).get("generated_at"), "builds": state["builds"], "building": state["building"]}
    ov["adhoc_cached"] = len(state["adhoc"])
    return JSONResponse(ov, headers={"Cache-Control": "no-store"})


@app.get("/api/auth/status")
async def auth_status(request: Request) -> dict[str, Any]:
    """Logged in or not, for this browser, from the sessions table."""
    email = _session_email(request)
    return {"logged_in": bool(email), "email": email, **(db.login_state(email) if email else {})}


@app.post("/api/profile")
async def api_profile(request: Request, payload: dict[str, Any] = Body(...)) -> JSONResponse:
    email = _session_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="sign in first")
    if not payload.get("accepted"):
        raise HTTPException(status_code=400, detail="the disclaimer must be accepted")
    tickers = _clean_tickers(payload.get("tickers"))
    db.ensure_user(email)
    db.accept_disclaimer(email)
    if tickers:
        db.set_watchlist(email, tickers[:40])
        config.save_dynamic_watchlist(config.load_dynamic_watchlist() + tickers)
    return JSONResponse({"status": "ok", "profile": db.profile(email)})


def _clean_tickers(raw: Any) -> list[str]:
    out: list[str] = []
    for t in (raw or []) if isinstance(raw, list) else []:
        t = str(t).upper().strip()
        if t and len(t) <= 12 and all(ch in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.^=" for ch in t) and t not in out:
            out.append(t)
    return out


@app.put("/api/profile/tickers")
async def api_profile_tickers(request: Request, payload: dict[str, Any] = Body(...)) -> JSONResponse:
    """The user's watchlist, kept server-side so it loads on every login from any browser."""
    email = _session_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="sign in first")
    db.ensure_user(email)
    raw_lists = payload.get("lists")
    if isinstance(raw_lists, dict) and raw_lists:
        lists: dict[str, list[str]] = {}
        for name, ticks in list(raw_lists.items())[:12]:
            name = re.sub(r"[^\w .&'\-]", "", str(name)).strip()[:30]
            if name:
                lists[name] = _clean_tickers(ticks)[:40]
        if not lists:
            raise HTTPException(status_code=400, detail="a list needs a name")
        active = str(payload.get("active") or "")
        db.set_watchlists(email, lists, active if active in lists else None)
        every = [t for ticks in lists.values() for t in ticks]
        db.log_activity(email, "watchlist", f"{len(lists)} lists · " + ", ".join(dict.fromkeys(every))[:150])
        if every:
            config.save_dynamic_watchlist(config.load_dynamic_watchlist() + every)
        return JSONResponse({"status": "ok", "lists": lists, "active": active if active in lists else next(iter(lists))})
    tickers = _clean_tickers(payload.get("tickers"))
    if len(tickers) > 40:
        raise HTTPException(status_code=400, detail="at most forty tickers")
    db.set_watchlist(email, tickers)
    db.log_activity(email, "watchlist", ", ".join(tickers[:12]))
    if tickers:
        config.save_dynamic_watchlist(config.load_dynamic_watchlist() + tickers)
    return JSONResponse({"status": "ok", "tickers": tickers})


@app.post("/api/auth/logout")
async def auth_logout(request: Request) -> JSONResponse:
    db.log_activity(_session_email(request), "logout")
    db.close_session(_raw_session(request))     # the sessions row now says logged_in = 0
    resp = JSONResponse({"status": "ok", "logged_in": False})
    resp.delete_cookie(SESSION_COOKIE)
    return resp


@app.get("/api/track-record")
async def api_track_record() -> JSONResponse:
    """Public: every verdict the model has made, scored after its horizon against the later price."""
    tr = await asyncio.to_thread(db.track_record)
    tr["direction"] = await asyncio.to_thread(db.direction_stats, 60)
    tr["analysis_days"] = await asyncio.to_thread(db.analysis_days, 60)
    return JSONResponse(tr, headers={"Cache-Control": "no-store"})


@app.get("/api/alerts")
async def api_alerts_get(request: Request) -> dict[str, Any]:
    email = _session_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="sign in first")
    return db.get_alert(email)


@app.put("/api/alerts")
async def api_alerts_put(request: Request, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    email = _session_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="sign in first")
    try:
        rv = max(1.5, min(20.0, float(payload.get("rvol_threshold", 3.0))))
        mp = max(0.5, min(1000.0, float(payload.get("min_price", 2.0))))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="bad threshold")
    channel = payload.get("channel") if payload.get("channel") in ("email", "whatsapp") else "email"
    out = db.set_alert(email, bool(payload.get("enabled")), rv, mp, channel)
    db.log_activity(email, "alerts", f"{'on' if out['enabled'] else 'off'} · RVOL ≥ {rv}×")
    return out


_TRACK_HTML = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Track record · OneView</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/static/brand/favicon.png"><link rel="stylesheet" href="/static/styles.css">
<style>body{background:var(--bg);color:var(--text);margin:0;padding:24px;font-family:var(--sans,system-ui)} .tr-wrap{max-width:1100px;margin:0 auto;display:grid;gap:18px}
.tr-h{display:flex;align-items:center;gap:12px} .tr-h img{width:34px;height:34px} .tr-h b{font-size:20px} .tr-note{color:var(--text-2);font-size:13px;line-height:1.5;max-width:70ch}
.tr-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;background:var(--line);border:1px solid var(--line)} .tr-tiles .tile{background:var(--surface-2)}
table.tbl{width:100%} .hit{color:var(--up)} .miss{color:var(--down)} .open{color:var(--muted)}</style></head><body><div class="tr-wrap">
<div class="tr-h"><img src="/static/brand/oneview-symbol.png" alt="" style="width:34px;height:34px;border-radius:8px"><div><b>Track record</b><div class="muted" style="font-size:12px">Every verdict the model has made, scored against the price after its time window</div></div></div>
<p class="tr-note">How this works: each time the desk publishes a verdict on a name, the price at that moment is written down. After the window closes (1 day for a day-trade read, 7 days for a swing read, 90 days for a long-term view) the price is checked again. A bullish call counts as a hit if the price went up, a bearish call if it went down. Calls with no direction (wait, hold, range, flat) are listed but not scored. Nothing here is advice; it is the desk keeping itself honest.</p>
<div id="tiles" class="tr-tiles"></div>
<h3>By verdict</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Window</th><th>Verdict</th><th>Calls</th><th>Scored</th><th>Hits</th><th>Hit rate</th><th>Avg move</th></tr></thead><tbody id="byv"></tbody></table></div>
<h3>By name</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Calls</th><th>Scored</th><th>Hits</th><th>Hit rate</th><th>Avg move</th></tr></thead><tbody id="byt"></tbody></table></div>
<h3>Most recent calls</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Name</th><th>Window</th><th>Verdict</th><th>Price then</th><th>Price after</th><th>Result</th></tr></thead><tbody id="recent"></tbody></table></div>
<p class="muted" style="font-size:11px">Prices from Yahoo Finance, delayed. Information, not advice.</p></div>
<script>
(async()=>{const j=await (await fetch("/api/track-record",{cache:"no-store"})).json();const e=s=>String(s==null?"":s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const pretty=k=>String(k||"").replace(/_/g," ");const pct=x=>x==null?"–":(x>0?"+":"")+x.toFixed(1)+"%";const rate=(h,n)=>n?Math.round(h/n*100)+"%":"–";
const T=j.totals||{};document.getElementById("tiles").innerHTML=[["Calls logged",T.n||0,T.since?"since "+new Date(T.since*1000).toLocaleDateString():""],["Scored so far",T.scored||0,"windows that have closed"],["Hit rate",rate(T.hits||0,T.scored||0),(T.hits||0)+" hits"]].map(([l,v,s])=>`<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${s}</div></div>`).join("");
document.getElementById("byv").innerHTML=(j.by_verdict||[]).map(r=>`<tr><td>${e(r.kind)}</td><td><b>${e(pretty(r.verdict))}</b></td><td class="num">${r.n}</td><td class="num">${r.scored||0}</td><td class="num">${r.hits||0}</td><td class="num">${rate(r.hits||0,r.scored||0)}</td><td class="num">${pct(r.avg_move_pct)}</td></tr>`).join("")||'<tr><td colspan="7" class="muted">No calls scored yet. Check back after the first windows close.</td></tr>';
document.getElementById("byt").innerHTML=(j.by_ticker||[]).map(r=>`<tr><td><b>${e(r.ticker)}</b></td><td class="num">${r.n}</td><td class="num">${r.scored||0}</td><td class="num">${r.hits||0}</td><td class="num">${rate(r.hits||0,r.scored||0)}</td><td class="num">${pct(r.avg_move_pct)}</td></tr>`).join("")||'<tr><td colspan="6" class="muted">Nothing scored yet.</td></tr>';
document.getElementById("recent").innerHTML=(j.recent||[]).map(r=>`<tr><td>${new Date(r.ts*1000).toLocaleString()}</td><td><b>${e(r.ticker)}</b></td><td>${e(r.kind)}</td><td>${e(pretty(r.verdict))}</td><td class="num">${r.price!=null?r.price.toFixed(2):"–"}</td><td class="num">${r.eval_price!=null?r.eval_price.toFixed(2):"–"}</td><td class="${r.hit===1?"hit":r.hit===0?"miss":"open"}">${r.hit===1?"hit":r.hit===0?"miss":r.eval_ts?"not directional":"open"}</td></tr>`).join("");})();
</script></body></html>"""


@app.get("/track-record")
async def track_record_page() -> HTMLResponse:
    """Public: no sign-in needed. The desk's scored history."""
    return HTMLResponse(_TRACK_HTML, headers={"Cache-Control": "no-store"})


_social_cache: dict[str, Any] = {"at": 0.0, "data": None}


@app.get("/api/social")
async def api_social() -> JSONResponse:
    """Trump's latest posts with the model's market read, plus the Reddit crowd. Refreshed at most every 5 minutes."""
    now = time.time()
    if now - _social_cache["at"] > 300 or not _social_cache["data"]:
        try:
            from .analyze import Judge, social_snapshot
            _social_cache["data"] = await social_snapshot(Judge(enabled=USE_AI))
            _social_cache["at"] = now
        except Exception as e:  # noqa: BLE001
            log.warning("social refresh failed: %s", e)
            if not _social_cache["data"]:
                _social_cache["data"] = ((state["report"] or {}).get("social")) or {"trump": {"posts": [], "status": "unavailable"}, "crowd": {"rows": [], "status": "unavailable"}}
    return JSONResponse(_social_cache["data"], headers={"Cache-Control": "no-store"})


@app.get("/api/brief")
async def api_brief() -> JSONResponse:
    """Today's briefings by slot (morning, midday, close); yesterday's when today has none yet."""
    briefs = state.get("briefs") or {}
    day = state.get("briefs_day")
    if not briefs and state.get("briefs_prev"):
        briefs, day = state["briefs_prev"], state.get("briefs_prev_day")
    if not briefs:
        return JSONResponse({"status": "not_ready", "building": bool(state.get("brief_building"))}, headers={"Cache-Control": "no-store"})
    return JSONResponse({"status": "ok", "date": day, "briefs": briefs, "slots": [s for s, _ in BRIEF_SLOTS], "building": bool(state.get("brief_building"))}, headers={"Cache-Control": "no-store"})


@app.get("/contact.vcf")
async def contact_vcf() -> Response:
    """One-tap 'add OneView to contacts': the strongest whitelist signal every mail app honours."""
    name, addr = mail._from()
    site = (os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL)
    card = f"BEGIN:VCARD\r\nVERSION:3.0\r\nFN:{name}\r\nORG:OneView\r\nEMAIL;TYPE=INTERNET,PREF:{addr}\r\nURL:{site}\r\nNOTE:Daily market briefings from OneView. Added so they land in your inbox.\r\nEND:VCARD\r\n"
    return Response(card, media_type="text/vcard", headers={"Content-Disposition": 'attachment; filename="OneView.vcf"', "Cache-Control": "no-store"})


@app.get("/keep-in-inbox")
async def keep_in_inbox() -> HTMLResponse:
    name, addr = mail._from()
    st = "margin:0;color:#A8B4C8;font-size:14px;line-height:1.5"
    steps = (f'<div style="display:grid;gap:12px;text-align:left">'
             f'<p style="{st}"><b style="color:#F5F7FC">Outlook, Hotmail, Live</b><br>Open the junked message and press <b>Not junk</b>. Then in <a href="https://outlook.live.com/mail/0/options/mail/junkEmail" style="color:#85A7FF">Settings, Junk email</a> add <span style="font-family:ui-monospace,Menlo,monospace;color:#F5F7FC">{addr}</span> under Safe senders and domains.</p>'
             f'<p style="{st}"><b style="color:#F5F7FC">Gmail</b><br>Open the message in Spam and press <b>Not spam</b>. To make it permanent, <a href="https://mail.google.com/mail/u/0/#settings/filters" style="color:#85A7FF">Settings, Filters</a>: create a filter for the address with Never send it to Spam.</p>'
             f'<p style="{st}"><b style="color:#F5F7FC">Yahoo</b><br>Open the message in Spam, press <b>Not spam</b>, and save the sender to contacts with the button above.</p>'
             f'<p style="{st}"><b style="color:#F5F7FC">Apple Mail (iPhone, Mac)</b><br>In Junk choose <b>Move to Inbox</b>, and save the sender to Contacts with the button above.</p></div>')
    action = f'<a class="pill" href="/contact.vcf">Add OneView to my contacts</a><p class="muted">Saves a contact card for {addr}. Mail apps never junk a contact.</p><p class="muted" style="margin-top:8px"><b style="color:#F5F7FC">Or tell your mail app directly</b></p>{steps}'
    return HTMLResponse(_PAGE.format(eyebrow="Keep OneView in your inbox", title="Two clicks, once", body="Mail apps decide what is junk inside your own mailbox, so one small step on your side keeps every OneView briefing in the inbox from then on.", action=action, foot=f"Sender: {name} &lt;{addr}&gt;. Information, not advice."))


@app.post("/brief/unsubscribe")
async def brief_unsubscribe_post(t: str = "") -> HTMLResponse:
    """One-click unsubscribe (RFC 8058): mail clients POST to the same link."""
    return await brief_unsubscribe(t)


@app.get("/brief/unsubscribe")
async def brief_unsubscribe(t: str = "") -> HTMLResponse:
    email = _unsign(t)
    if not email:
        return HTMLResponse(_PAGE.format(eyebrow="Link not valid", title="That link did not work", body="Open the latest briefing email and use its link, or sign in to the desk.", action="", foot="OneView"), status_code=400)
    db.set_brief_opt_out(email, True)
    return HTMLResponse(_PAGE.format(eyebrow="Done", title="No more briefing emails", body=f"{email} will not receive the morning briefing by email. The briefing stays on the desk every day at 07:00 ET.", action=f'<a class="pill" href="{config.PUBLIC_URL}">Back to OneView</a>', foot="Information, not advice."))


# ---------------------------------------------------------------------------
# StockTwits MCP connector: OAuth (dynamic registration + PKCE) done once by the admin,
# tokens kept on disk, JSON-RPC calls to the MCP endpoint from the server.
# ---------------------------------------------------------------------------
ST_MCP = "https://mcp.stocktwits.com/mcp"
ST_AUTH = "https://mcp.stocktwits.com"
_ST_FILE = lambda: DATA_DIR / "stocktwits_oauth.json"   # noqa: E731
_st_pending: dict[str, dict[str, Any]] = {}


def _st_load() -> dict[str, Any]:
    try:
        return json.loads(_ST_FILE().read_text())
    except Exception:  # noqa: BLE001
        return {}


def _st_save(d: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _ST_FILE().write_text(json.dumps(d))


def _st_callback_url() -> str:
    return _api_root() + "/api/stocktwits/callback"


def _st_register(redirect: str) -> dict[str, Any]:
    import requests as rq
    r = rq.post(f"{ST_AUTH}/register", json={"client_name": "OneView", "redirect_uris": [redirect], "grant_types": ["authorization_code", "refresh_token"],
                                            "response_types": ["code"], "token_endpoint_auth_method": "none", "scope": "read"}, timeout=20)
    r.raise_for_status()
    return r.json()


def _st_token_request(data: dict[str, Any]) -> dict[str, Any]:
    import requests as rq
    r = rq.post(f"{ST_AUTH}/token", data=data, headers={"Accept": "application/json"}, timeout=20)
    if r.status_code >= 400:
        raise RuntimeError(f"token endpoint {r.status_code}: {r.text[:200]}")
    return r.json()


def _st_access_token() -> str | None:
    d = _st_load()
    if not d.get("access_token"):
        return None
    if d.get("expires_at", 0) - 60 < time.time() and d.get("refresh_token"):
        t = _st_token_request({"grant_type": "refresh_token", "refresh_token": d["refresh_token"], "client_id": d["client_id"]})
        d.update(access_token=t["access_token"], refresh_token=t.get("refresh_token", d["refresh_token"]), expires_at=time.time() + int(t.get("expires_in", 3600)))
        _st_save(d)
    return d["access_token"]


def _st_rpc(method: str, params: dict[str, Any] | None = None, session: str | None = None) -> tuple[dict[str, Any], str | None]:
    import requests as rq
    tok = _st_access_token()
    if not tok:
        raise RuntimeError("StockTwits is not connected")
    headers = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    r = rq.post(ST_MCP, json={"jsonrpc": "2.0", "id": int(time.time() * 1000) % 100000, "method": method, "params": params or {}}, headers=headers, timeout=40)
    if r.status_code >= 400:
        raise RuntimeError(f"mcp {method} {r.status_code}: {r.text[:200]}")
    sid = r.headers.get("Mcp-Session-Id") or session
    body = r.text
    if "text/event-stream" in r.headers.get("content-type", ""):
        chunks = [ln[5:].strip() for ln in body.splitlines() if ln.startswith("data:")]
        body = chunks[-1] if chunks else "{}"
    return (json.loads(body) if body.strip() else {}), sid


def st_call(tool: str, arguments: dict[str, Any]) -> Any:
    """Initialize a session, call one tool, return its result content."""
    init, sid = _st_rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "OneView", "version": "0.3"}})
    try:
        _st_rpc("notifications/initialized", {}, sid)
    except Exception:  # noqa: BLE001
        pass
    res, _ = _st_rpc("tools/call", {"name": tool, "arguments": arguments}, sid)
    return res.get("result", res)


def st_tools() -> list[dict[str, Any]]:
    init, sid = _st_rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "OneView", "version": "0.3"}})
    try:
        _st_rpc("notifications/initialized", {}, sid)
    except Exception:  # noqa: BLE001
        pass
    res, _ = _st_rpc("tools/list", {}, sid)
    return (res.get("result") or {}).get("tools", [])


def _require_admin(request: Request) -> str:
    email = _session_email(request)
    if not email or email.lower() not in {e.lower() for e in config.ADMIN_EMAILS}:
        raise HTTPException(status_code=403, detail="admin only")
    return email


ST_BIG = ["SPY", "QQQ", "NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "GOOGL", "AVGO"]


def _st_text(res: Any) -> Any:
    if isinstance(res, dict) and res.get("structuredContent"):
        return res["structuredContent"]
    if isinstance(res, dict) and isinstance(res.get("content"), list):
        for c in res["content"]:
            if c.get("type") == "text":
                try:
                    return json.loads(c["text"])
                except Exception:  # noqa: BLE001
                    return {"text": c["text"]}
    return res


def _stocktwits_sync() -> dict[str, Any]:
    """One crowd snapshot: market mood (SPY, QQQ), trending names, the big caps' mood. About a dozen calls."""
    out: dict[str, Any] = {"as_of": time.time(), "moods": {}, "trending": [], "source": "StockTwits (official connector)"}
    for sym in ST_BIG:
        try:
            s = _st_text(st_call("get_sentiment", {"symbol": sym})) or {}
            out["moods"][sym] = {"symbol": sym, "score": s.get("score"), "label": s.get("label"), "bullish_pct": s.get("bullish_pct"), "bullish_delta": s.get("bullish_delta")}
        except Exception as e:  # noqa: BLE001
            log.warning("stocktwits sentiment %s: %s", sym, e)
    for sym in ("SPY", "QQQ"):
        try:
            v = _st_text(st_call("get_message_volume", {"symbol": sym})) or {}
            now = next((x for x in v.get("series", []) if x.get("timeframe") == "now"), None)
            if now and sym in out["moods"]:
                out["moods"][sym]["volume_label"] = now.get("normalized_label") or now.get("label"); out["moods"][sym]["volume_score"] = now.get("normalized_value")
        except Exception as e:  # noqa: BLE001
            log.warning("stocktwits volume %s: %s", sym, e)
    try:
        t = _st_text(st_call("get_trending_symbols", {"limit": 12, "asset_class": "equities"})) or {}
        out["trending"] = [{"symbol": x.get("symbol"), "title": x.get("title"), "price": x.get("price"), "change_pct": x.get("change"), "watchers": x.get("watchers"), "rank": x.get("rank")} for x in t.get("symbols", [])]
    except Exception as e:  # noqa: BLE001
        log.warning("stocktwits trending: %s", e)
    quotes = (state.get("live_scan") or {}).get("quotes") or {}
    day = fetch.now_et().date().isoformat()
    try:
        db.log_crowd(day, [{**m, "price": (quotes.get(sym) or {}).get("last"), "change_pct": (quotes.get(sym) or {}).get("chg_pct")} for sym, m in out["moods"].items()])
    except Exception:  # noqa: BLE001
        log.exception("crowd log failed")
    fetch._cache_put("stocktwits_snapshot", out)
    return out


def _desk_sync() -> dict[str, Any]:
    from .desk import build_desk
    d = build_desk(state["report"], extra=list(state.get("adhoc") or {}))
    # the desk's decisions join the verdict ledger so the track record scores them like everything else
    rows = [{"ticker": c["ticker"], "kind": "desk", "verdict": c["flat"]["code"], "price": c["price"], "build_id": f"desk-{d['generated_at'][:16]}"}
            for c in d["cards"] if c["flat"]["code"] in ("re_entry", "tactical_rebound", "stay_out")]
    try:
        n = db.log_verdicts(rows)
        log.info("desk: %d cards, %d ledger rows, macro %s", len(d["cards"]), n, (d.get("macro") or {}).get("regime"))
    except Exception:  # noqa: BLE001
        log.exception("desk ledger failed")
    try:
        (DATA_DIR / "desk.json").write_text(json.dumps(d, default=str))
    except Exception:  # noqa: BLE001
        pass
    return d


async def desk_loop() -> None:
    """Three-pillar scorecards over the universe: every 30 min while the market is open, every 4 h otherwise."""
    while True:
        try:
            if state.get("report"):
                interval = 1800 if fetch.market_state() in ("pre", "open", "post") else 4 * 3600
                if time.time() - state.get("desk_at", 0) >= interval:
                    state["desk"] = await asyncio.to_thread(_desk_sync); state["desk_at"] = time.time()
        except Exception:  # noqa: BLE001
            log.exception("desk loop error")
        await asyncio.sleep(60)


_tv_probe: dict[str, Any] = {"at": 0.0, "ok": False}
_tv_lock = asyncio.Lock()


def _tv_available() -> bool:
    from . import tvbridge
    if time.time() - _tv_probe["at"] > 60:
        _tv_probe["ok"] = tvbridge.available(); _tv_probe["at"] = time.time()
    return bool(_tv_probe["ok"])


@app.post("/api/desk/tv")
async def api_desk_tv(request: Request) -> JSONResponse:
    """Admin: re-score up to a dozen names with daily bars read from the owner's TradingView Desktop chart.
    Drives that chart one symbol at a time (about 12 s each), then restores it."""
    _require_admin(request)
    from . import tvbridge
    from .desk import rescore
    body = await request.json()
    symbols = [str(x).upper() for x in (body.get("symbols") or []) if str(x).strip()][: tvbridge.MAX_SYMBOLS]
    if not symbols:
        raise HTTPException(status_code=400, detail="no symbols")
    if not await asyncio.to_thread(tvbridge.available):
        return JSONResponse({"status": "unavailable", "detail": "TradingView Desktop is not running with its debug port on the server machine."}, headers={"Cache-Control": "no-store"})
    if _tv_lock.locked():
        return JSONResponse({"status": "busy", "detail": "A TradingView pull is already running."}, headers={"Cache-Control": "no-store"})
    async with _tv_lock:
        pulled = await asyncio.to_thread(tvbridge.daily_closes, symbols)
        d = state.get("desk") or {}
        cards = await asyncio.to_thread(rescore, d, pulled)
    return JSONResponse({"status": "ok", "pulled": sorted(pulled), "missing": [s for s in symbols if s not in pulled], "cards": cards}, headers={"Cache-Control": "no-store"})


def _desk_scan_sync() -> dict[str, Any]:
    from .desk import scan_mid_to_mega
    r = scan_mid_to_mega(state["report"])
    rows = [{"ticker": c["ticker"], "kind": "desk", "verdict": c["flat"]["code"], "price": c["price"], "build_id": f"scan-{r['generated_at'][:16]}"}
            for c in r["strong"] if c["flat"]["code"] in ("re_entry", "tactical_rebound")]
    try:
        db.log_verdicts(rows)
    except Exception:  # noqa: BLE001
        log.exception("desk scan ledger failed")
    try:
        (DATA_DIR / "desk_scan.json").write_text(json.dumps(r, default=str))
    except Exception:  # noqa: BLE001
        pass
    log.info("desk scan: %d strong of %d usable", r["strong_total"], r["usable"])
    return r


async def _desk_scan_task() -> None:
    try:
        state["desk_scan"] = await asyncio.to_thread(_desk_scan_sync)
        state["desk_scan_error"] = None
    except Exception as e:  # noqa: BLE001
        log.exception("desk scan failed")
        state["desk_scan_error"] = f"{type(e).__name__}: {e}"
    finally:
        state["desk_scan_running"] = False


@app.post("/api/desk/scan")
async def api_desk_scan_start(request: Request) -> JSONResponse:
    """Start the mid-to-mega-cap scan (about 40 s). Reuses a result younger than 30 minutes. Admin only."""
    _require_admin(request)
    if not state.get("report"):
        return JSONResponse({"status": "warming"}, headers={"Cache-Control": "no-store"})
    r = state.get("desk_scan")
    if r and time.time() - state.get("desk_scan_at", 0) < 1800:
        return JSONResponse({"status": "ok", "fresh": True, **r}, headers={"Cache-Control": "no-store"})
    if not state.get("desk_scan_running"):
        state["desk_scan_running"] = True; state["desk_scan_at"] = time.time(); state["desk_scan_started"] = time.time()
        asyncio.create_task(_desk_scan_task())
    return JSONResponse({"status": "running", "started": state.get("desk_scan_started")}, headers={"Cache-Control": "no-store"})


@app.get("/api/desk/scan")
async def api_desk_scan(request: Request) -> JSONResponse:
    _require_admin(request)
    if state.get("desk_scan_running"):
        return JSONResponse({"status": "running", "started": state.get("desk_scan_started")}, headers={"Cache-Control": "no-store"})
    r = state.get("desk_scan")
    if not r and (DATA_DIR / "desk_scan.json").exists():
        try:
            r = state["desk_scan"] = json.loads((DATA_DIR / "desk_scan.json").read_text())
        except Exception:  # noqa: BLE001
            r = None
    if state.get("desk_scan_error") and not r:
        return JSONResponse({"status": "error", "detail": state["desk_scan_error"]}, headers={"Cache-Control": "no-store"})
    if not r:
        return JSONResponse({"status": "none"}, headers={"Cache-Control": "no-store"})
    return JSONResponse({"status": "ok", **r}, headers={"Cache-Control": "no-store"})


@app.get("/api/desk")
async def api_desk(request: Request) -> JSONResponse:
    if not _session_email(request):
        raise HTTPException(status_code=401, detail="sign in first")
    d = state.get("desk")
    if not d and (DATA_DIR / "desk.json").exists():
        try:
            d = json.loads((DATA_DIR / "desk.json").read_text())
        except Exception:  # noqa: BLE001
            d = None
    if not d:
        return JSONResponse({"status": "warming"}, headers={"Cache-Control": "no-store"})
    return JSONResponse({"status": "ok", "tv_available": await asyncio.to_thread(_tv_available), "tv_max": 12, **d}, headers={"Cache-Control": "no-store"})


async def stocktwits_loop() -> None:
    while True:
        try:
            if _st_load().get("access_token"):
                interval = 600 if fetch.market_state() in ("pre", "open", "post") else 3600
                if time.time() - state.get("stocktwits_at", 0) >= interval:
                    state["stocktwits"] = await asyncio.to_thread(_stocktwits_sync); state["stocktwits_at"] = time.time()
        except Exception:  # noqa: BLE001
            log.exception("stocktwits loop error")
        await asyncio.sleep(60)


@app.get("/api/stocktwits")
async def api_stocktwits(request: Request) -> JSONResponse:
    if not _session_email(request):
        raise HTTPException(status_code=401, detail="sign in first")
    snap = state.get("stocktwits") or fetch._cache_get("stocktwits_snapshot", 6 * 3600)
    if not snap:
        return JSONResponse({"status": "not_connected" if not _st_load().get("access_token") else "warming"}, headers={"Cache-Control": "no-store"})
    return JSONResponse({"status": "ok", **snap}, headers={"Cache-Control": "no-store"})


@app.get("/api/stocktwits/status")
async def st_status(request: Request) -> dict[str, Any]:
    _require_admin(request)
    d = _st_load()
    return {"connected": bool(d.get("access_token")), "expires_at": d.get("expires_at"), "callback": _st_callback_url(), "scope": d.get("scope")}


@app.get("/api/stocktwits/connect")
async def st_connect(request: Request, json_out: int = 0) -> Any:
    """Admin clicks: register this server as an OAuth client (once), then go sign in at StockTwits.
    With json_out=1 the page fetches this with its bearer token and follows the returned URL itself."""
    import base64 as b64, hashlib as hl, secrets
    _require_admin(request)
    d = _st_load()
    redirect = _st_callback_url()
    if not d.get("client_id") or d.get("redirect_uri") != redirect:
        reg = await asyncio.to_thread(_st_register, redirect)
        d = {"client_id": reg["client_id"], "client_secret": reg.get("client_secret"), "redirect_uri": redirect}
        _st_save(d)
    verifier = b64.urlsafe_b64encode(secrets.token_bytes(48)).decode().rstrip("=")
    challenge = b64.urlsafe_b64encode(hl.sha256(verifier.encode()).digest()).decode().rstrip("=")
    st = secrets.token_urlsafe(16)
    _st_pending[st] = {"verifier": verifier, "at": time.time()}
    from urllib.parse import urlencode
    q = urlencode({"response_type": "code", "client_id": d["client_id"], "redirect_uri": redirect, "scope": "read", "state": st,
                   "code_challenge": challenge, "code_challenge_method": "S256"})
    url = f"{ST_AUTH}/authorize?{q}"
    if json_out:
        return JSONResponse({"url": url})
    return RedirectResponse(url)


@app.get("/api/stocktwits/callback")
async def st_callback(code: str = "", state: str = "", error: str = "") -> HTMLResponse:
    pend = _st_pending.pop(state, None)
    if error or not code or not pend:
        return HTMLResponse(_PAGE.format(eyebrow="StockTwits", title="Connection did not complete", body=error or "The sign-in was cancelled or the link expired. Try again from the Admin page.", action="", foot="OneView"), status_code=400)
    d = _st_load()
    try:
        t = await asyncio.to_thread(_st_token_request, {"grant_type": "authorization_code", "code": code, "redirect_uri": d["redirect_uri"], "client_id": d["client_id"], "code_verifier": pend["verifier"]})
    except Exception as e:  # noqa: BLE001
        return HTMLResponse(_PAGE.format(eyebrow="StockTwits", title="Token exchange failed", body=str(e)[:300], action="", foot="OneView"), status_code=400)
    d.update(access_token=t["access_token"], refresh_token=t.get("refresh_token"), expires_at=time.time() + int(t.get("expires_in", 3600)), scope=t.get("scope"))
    _st_save(d)
    return HTMLResponse(_PAGE.format(eyebrow="StockTwits", title="Connected", body="OneView can now read StockTwits through its connector. Close this tab and return to the desk.", action=f'<a class="pill" href="{config.PUBLIC_URL}/#view=admin">Back to OneView</a>', foot="Information, not advice."))


@app.get("/api/stocktwits/tools")
async def st_tools_api(request: Request) -> Any:
    _require_admin(request)
    return await asyncio.to_thread(st_tools)


@app.post("/api/stocktwits/call")
async def st_call_api(request: Request, payload: dict[str, Any] = Body(...)) -> Any:
    _require_admin(request)
    return await asyncio.to_thread(st_call, str(payload.get("tool")), dict(payload.get("arguments") or {}))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "brand" / "favicon.png", media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})
