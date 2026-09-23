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

app = FastAPI(title="Market Update", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST"], allow_headers=["*"])


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
    universe = list(dict.fromkeys(config.UNIVERSE + watch + [x["ticker"] for x in (r.get("low_float") or {}).get("rows", [])]))
    mstate = fetch.market_state()
    sc = scanner.scan(fetch.fetch_intraday(universe), {}, universe, mstate)
    if not state.get("sym_names"):
        state["sym_names"] = {row[0]: row[1] for row in fetch.fetch_symbol_index()}
    names = dict(state["sym_names"])
    names.update({t: q["name"] for t, q in (r.get("lite") or {}).items() if q.get("name")})
    reads = {x["ticker"]: x.get("ai") for x in (r.get("scan") or {}).get("rows", []) if x.get("ai")}
    rows = []
    for x in sorted(sc["by_ticker"].values(), key=lambda v: -v["score"])[:40]:
        slim = _scan_slim(x)
        slim.update(ticker=x["ticker"], name=names.get(x["ticker"], x["ticker"]), price=x["price"], chg_pct=x["chg_pct"], qualifies=x["qualifies"],
                    session={k: x["session"].get(k) for k in ("rvol_time_of_day", "above_vwap", "range_pos", "chg_from_open_pct", "session_volume", "avg_session_volume", "bars_today", "session_date")},
                    ai=reads.get(x["ticker"]))
        rows.append(slim)
    return _clean({"rows": rows, "scanned": sc["scanned"], "qualified": sc["qualified"], "as_of": time.time(), "last_bar": sc["last_bar"], "market_state": mstate,
                   "settings": sc["settings"]})


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
    html = html.replace("__PUBLIC_URL__", os.environ.get("MU_PUBLIC_URL", "").rstrip("/") or _public_url(request)).replace("__APP_URL__", "")
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


def _session_email(request: Request) -> str | None:
    """Signed cookie AND a live, logged-in row in the sessions table."""
    raw = request.cookies.get(SESSION_COOKIE)
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


_PAGE = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Market Update · sign-in link</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>html,body{{margin:0;min-height:100dvh;background:#050810;color:#E6EAF2;font:15px/1.55 "Plus Jakarta Sans",system-ui,sans-serif}}
body{{display:grid;place-items:center;padding:24px;background:radial-gradient(700px 420px at 12% -8%,rgba(16,185,129,.22),transparent 60%),radial-gradient(640px 400px at 100% 110%,rgba(59,130,246,.2),transparent 60%),#050810}}
.shell{{width:min(520px,100%);padding:6px;border-radius:2rem;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}}
.core{{border-radius:calc(2rem - 6px);background:#0B0F17;padding:32px;box-shadow:inset 0 1px 1px rgba(255,255,255,.12);display:grid;gap:14px}}
.eyebrow{{display:inline-block;width:max-content;font-size:10px;letter-spacing:.2em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.12);color:#9CA3AF}}
h1{{margin:0;font-size:24px;font-weight:800;letter-spacing:-.02em}} p{{margin:0;color:#A3ADBF}}
a.pill{{display:inline-flex;align-items:center;gap:10px;width:max-content;padding:10px 10px 10px 18px;border-radius:999px;background:linear-gradient(90deg,#10B981,#3B82F6);color:#050810;font-weight:700;text-decoration:none;transition:transform .5s cubic-bezier(.32,.72,0,1)}}
a.pill:hover{{transform:translateY(-1px)}} a.pill i{{width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.18);display:inline-grid;place-items:center;font-style:normal}}
.muted{{color:#6B7280;font-size:12.5px}}</style>
<div class="shell"><div class="core"><span class="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{body}</p>{action}<p class="muted">{foot}</p></div></div>"""


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
    raw = request.cookies.get(SESSION_COOKIE) or ""
    db.touch_session(raw, SESSION_DAYS * 86400)
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
    tickers = _clean_tickers(payload.get("tickers"))
    if len(tickers) > 40:
        raise HTTPException(status_code=400, detail="at most forty tickers")
    db.ensure_user(email)
    db.set_watchlist(email, tickers)
    db.log_activity(email, "watchlist", ", ".join(tickers[:12]))
    if tickers:
        config.save_dynamic_watchlist(config.load_dynamic_watchlist() + tickers)
    return JSONResponse({"status": "ok", "tickers": tickers})


@app.post("/api/auth/logout")
async def auth_logout(request: Request) -> JSONResponse:
    db.log_activity(_session_email(request), "logout")
    db.close_session(request.cookies.get(SESSION_COOKIE))     # the sessions row now says logged_in = 0
    resp = JSONResponse({"status": "ok", "logged_in": False})
    resp.delete_cookie(SESSION_COOKIE)
    return resp
