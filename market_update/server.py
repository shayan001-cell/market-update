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
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi import Request, Response
from fastapi.staticfiles import StaticFiles

from . import config, db, fetch, mail
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
    quotes: dict[str, Any] = {}
    for t, rec in sc["by_ticker"].items():
        ses = rec.get("session") or {}
        if rec.get("price") is not None:
            vol = ses.get("session_volume")
            quotes[t] = {"last": rec["price"], "chg_pct": rec.get("chg_pct"), "ts": now_ts, "src": "bars", "rvol": ses.get("rvol_time_of_day"),
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
    asyncio.create_task(live_scanner())


@app.get("/")
async def index(request: Request) -> HTMLResponse:
    """Serve index.html with asset URLs versioned by file mtime, so a deploy never fights a browser cache."""
    html = (config.STATIC_DIR / "index.html").read_text()
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
        judged = {h.get("id"): h.get("ai") for h in r.get("headlines", []) if h.get("id")}
        for it in items:
            if it["id"] in judged:
                it["ai"] = judged[it["id"]]
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
    return JSONResponse(await asyncio.to_thread(db.track_record), headers={"Cache-Control": "no-store"})


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
