"""SQLite store for accounts, sign-in tokens, sessions (logged in or not) and watchlists.

One file, MU_DATA_DIR/market_update.db, created on first use. Every function opens a
short connection, so it is safe from the threadpool the server uses.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import config

DB_PATH = Path(config.OUTPUT_DIR) / "market_update.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    created REAL NOT NULL,
    last_login REAL,
    accepted_disclaimer_at REAL
);
CREATE TABLE IF NOT EXISTS signin_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created REAL NOT NULL,
    expires REAL NOT NULL,
    used_at REAL
);
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,               -- sha256 of the cookie value
    email TEXT NOT NULL,
    created REAL NOT NULL,
    expires REAL NOT NULL,
    last_seen REAL NOT NULL,
    logged_in INTEGER NOT NULL DEFAULT 1,
    user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions(email, logged_in);
CREATE TABLE IF NOT EXISTS traffic (
    minute INTEGER PRIMARY KEY,        -- unix minute
    requests INTEGER NOT NULL DEFAULT 0,
    pages INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at REAL NOT NULL,
    email TEXT,
    action TEXT NOT NULL,
    detail TEXT
);
CREATE TABLE IF NOT EXISTS verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- swing | intraday | long_term
    verdict TEXT NOT NULL,
    price REAL,
    ts REAL NOT NULL,
    horizon_days INTEGER NOT NULL,
    build_id TEXT,
    eval_price REAL,
    eval_ts REAL,
    hit INTEGER                          -- 1 hit, 0 miss, NULL not evaluated / not directional
);
CREATE INDEX IF NOT EXISTS verdicts_open ON verdicts(eval_ts, ts);
CREATE UNIQUE INDEX IF NOT EXISTS verdicts_once ON verdicts(ticker, kind, build_id);
CREATE TABLE IF NOT EXISTS crowd_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    symbol TEXT NOT NULL,
    score REAL, label TEXT, bullish_pct REAL, volume_label TEXT,
    price REAL, change_pct REAL
);
CREATE INDEX IF NOT EXISTS crowd_day ON crowd_reads(day, symbol);
CREATE TABLE IF NOT EXISTS analysis_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- morning_index | close_index
    symbol TEXT NOT NULL,
    price REAL,
    read TEXT,                          -- the chosen answer
    confidence REAL,
    facts TEXT,                         -- JSON inputs
    outcome_pct REAL,
    hit INTEGER,
    scored_at REAL
);
CREATE INDEX IF NOT EXISTS analysis_day ON analysis_log(day);
CREATE TABLE IF NOT EXISTS direction_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    day TEXT NOT NULL,
    spy REAL, qqq REAL,
    expected TEXT, confidence REAL, driver TEXT,
    facts TEXT,                         -- JSON: the technical and sentiment inputs
    close_spy REAL, close_qqq REAL,
    move_spy_pct REAL, move_qqq_pct REAL,
    hit INTEGER,
    scored_at REAL
);
CREATE INDEX IF NOT EXISTS direction_day ON direction_reads(day);
CREATE TABLE IF NOT EXISTS alerts (
    email TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    rvol_threshold REAL NOT NULL DEFAULT 3.0,
    min_price REAL NOT NULL DEFAULT 2.0,
    channel TEXT NOT NULL DEFAULT 'email',
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
    email TEXT NOT NULL,
    ticker TEXT NOT NULL,
    position INTEGER NOT NULL,
    added REAL NOT NULL,
    list_name TEXT NOT NULL DEFAULT 'My watchlist',
    PRIMARY KEY (email, list_name, ticker)
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        con.executescript(_SCHEMA)
        _migrate(con)
        yield con
        con.commit()
    finally:
        con.close()


DEFAULT_LIST = "My watchlist"


def _migrate(con: sqlite3.Connection) -> None:
    cols_users = {r[1] for r in con.execute("PRAGMA table_info(users)")}
    if "brief_opt_out" not in cols_users:
        con.execute("ALTER TABLE users ADD COLUMN brief_opt_out INTEGER NOT NULL DEFAULT 0")
    if con.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'direction_reads'").fetchone():
        dcols = {r[1] for r in con.execute("PRAGMA table_info(direction_reads)")}
        for col, typ in (("source", "TEXT"), ("move_15", "REAL"), ("move_30", "REAL"), ("move_60", "REAL"), ("hit_60", "INTEGER")):
            if col not in dcols:
                con.execute(f"ALTER TABLE direction_reads ADD COLUMN {col} {typ}")
    cols = {r["name"] for r in con.execute("PRAGMA table_info(users)")}
    if "name" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN name TEXT")
    if "active_list" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN active_list TEXT")
    wcols = {r["name"] for r in con.execute("PRAGMA table_info(watchlist)")}
    if "list_name" not in wcols:                      # older single-list table: rebuild with the list name in the key
        con.execute("ALTER TABLE watchlist RENAME TO watchlist_old")
        con.execute("CREATE TABLE watchlist (email TEXT NOT NULL, ticker TEXT NOT NULL, position INTEGER NOT NULL, added REAL NOT NULL, list_name TEXT NOT NULL DEFAULT 'My watchlist', PRIMARY KEY (email, list_name, ticker))")
        con.execute("INSERT INTO watchlist(email, ticker, position, added, list_name) SELECT email, ticker, position, added, 'My watchlist' FROM watchlist_old")
        con.execute("DROP TABLE watchlist_old")


def _sid(cookie_value: str) -> str:
    return hashlib.sha256(cookie_value.encode()).hexdigest()


# ---- users -------------------------------------------------------------------
def ensure_user(email: str) -> dict[str, Any]:
    with connect() as con:
        con.execute("INSERT OR IGNORE INTO users(email, created) VALUES (?, ?)", (email, time.time()))
        return dict(con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone())


def touch_login(email: str) -> None:
    with connect() as con:
        con.execute("UPDATE users SET last_login = ? WHERE email = ?", (time.time(), email))


def accept_disclaimer(email: str) -> None:
    with connect() as con:
        con.execute("UPDATE users SET accepted_disclaimer_at = ? WHERE email = ?", (time.time(), email))


def profile(email: str) -> dict[str, Any] | None:
    with connect() as con:
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not row:
            return None
        lists: dict[str, list[str]] = {}
        for r in con.execute("SELECT list_name, ticker FROM watchlist WHERE email = ? ORDER BY list_name, position", (email,)):
            lists.setdefault(r["list_name"], []).append(r["ticker"])
        active = row["active_list"] if row["active_list"] in lists else (next(iter(lists)) if lists else DEFAULT_LIST)
        return {"email": email, "name": row["name"], "created": row["created"], "last_login": row["last_login"],
                "accepted_disclaimer_at": row["accepted_disclaimer_at"], "tickers": lists.get(active, []), "lists": lists, "active": active}


def set_name(email: str, name: str) -> None:
    with connect() as con:
        con.execute("UPDATE users SET name = ? WHERE email = ?", (name[:60], email))


# ---- traffic + activity (admin dashboard) ---------------------------------------
def count_request(is_page: bool) -> None:
    minute = int(time.time() // 60)
    with connect() as con:
        con.execute("INSERT INTO traffic(minute, requests, pages) VALUES (?, 1, ?) ON CONFLICT(minute) DO UPDATE SET requests = requests + 1, pages = pages + ?",
                    (minute, 1 if is_page else 0, 1 if is_page else 0))
        if minute % 60 == 0:
            con.execute("DELETE FROM traffic WHERE minute < ?", (minute - 7 * 24 * 60,))


def log_activity(email: str | None, action: str, detail: str | None = None) -> None:
    with connect() as con:
        con.execute("INSERT INTO activity(at, email, action, detail) VALUES (?, ?, ?, ?)", (time.time(), email, action, (detail or "")[:200]))
        con.execute("DELETE FROM activity WHERE id < (SELECT MAX(id) FROM activity) - 5000")


def admin_overview() -> dict[str, Any]:
    now = time.time()
    minute = int(now // 60)
    with connect() as con:
        live = [dict(r) for r in con.execute(
            "SELECT s.email, u.name, MAX(s.last_seen) AS last_seen, MIN(s.created) AS since, COUNT(*) AS sessions, MAX(s.user_agent) AS user_agent "
            "FROM sessions s LEFT JOIN users u ON u.email = s.email WHERE s.logged_in = 1 AND s.expires > ? GROUP BY s.email ORDER BY last_seen DESC", (now,))]
        active_sessions = con.execute("SELECT COUNT(*) FROM sessions WHERE logged_in = 1 AND expires > ?", (now,)).fetchone()[0]
        users = [dict(r) for r in con.execute("SELECT email, name, created, last_login, accepted_disclaimer_at FROM users ORDER BY last_login DESC NULLS LAST")]
        wl = {r["email"]: r["n"] for r in con.execute("SELECT email, COUNT(*) AS n FROM watchlist GROUP BY email")}
        for u in users:
            u["tickers"] = wl.get(u["email"], 0)
            u["online"] = any(l["email"] == u["email"] for l in live)
        traffic = {r["minute"]: (r["requests"], r["pages"]) for r in con.execute("SELECT * FROM traffic WHERE minute > ?", (minute - 180,))}
        series = [{"minute": m, "requests": traffic.get(m, (0, 0))[0], "pages": traffic.get(m, (0, 0))[1]} for m in range(minute - 119, minute + 1)]
        day = con.execute("SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(pages), 0) FROM traffic WHERE minute > ?", (minute - 1440,)).fetchone()
        recent = [dict(r) for r in con.execute("SELECT at, email, action, detail FROM activity ORDER BY id DESC LIMIT 40")]
        logins_24h = con.execute("SELECT COUNT(*) FROM activity WHERE action = 'login' AND at > ?", (now - 86400,)).fetchone()[0]
    return {"as_of": now, "online": live, "active_sessions": active_sessions, "users": users, "users_total": len(users),
            "traffic": {"series": series, "requests_24h": day[0], "pages_24h": day[1], "requests_last_hour": sum(x["requests"] for x in series[-60:]),
                        "logins_24h": logins_24h}, "recent": recent}


# ---- sign-in tokens ------------------------------------------------------------
def create_token(token: str, email: str, ttl_s: int) -> None:
    now = time.time()
    with connect() as con:
        con.execute("DELETE FROM signin_tokens WHERE expires < ?", (now - 24 * 3600,))
        con.execute("INSERT INTO signin_tokens(token, email, created, expires) VALUES (?, ?, ?, ?)", (token, email, now, now + ttl_s))


def recent_token_for(email: str, within_s: int = 60) -> bool:
    with connect() as con:
        return con.execute("SELECT 1 FROM signin_tokens WHERE email = ? AND created > ?", (email, time.time() - within_s)).fetchone() is not None


def consume_token(token: str) -> dict[str, Any] | None:
    """Returns the token row and marks it used; the caller checks `expires` and `used_at`."""
    with connect() as con:
        row = con.execute("SELECT * FROM signin_tokens WHERE token = ?", (token,)).fetchone()
        if not row:
            return None
        if row["used_at"] is None:
            con.execute("UPDATE signin_tokens SET used_at = ? WHERE token = ?", (time.time(), token))
        return dict(row)


# ---- sessions: the "is this user logged in" record ------------------------------
def open_session(cookie_value: str, email: str, ttl_s: int, user_agent: str | None) -> None:
    now = time.time()
    with connect() as con:
        con.execute("DELETE FROM sessions WHERE expires < ?", (now - 7 * 86400,))
        con.execute("INSERT OR REPLACE INTO sessions(id, email, created, expires, last_seen, logged_in, user_agent) VALUES (?, ?, ?, ?, ?, 1, ?)",
                    (_sid(cookie_value), email, now, now + ttl_s, now, (user_agent or "")[:200]))


def session(cookie_value: str | None) -> dict[str, Any] | None:
    """The live session for a cookie, or None when unknown, logged out or expired."""
    if not cookie_value:
        return None
    with connect() as con:
        row = con.execute("SELECT * FROM sessions WHERE id = ?", (_sid(cookie_value),)).fetchone()
        if not row or not row["logged_in"] or row["expires"] < time.time():
            return None
        return dict(row)


def touch_session(cookie_value: str, ttl_s: int) -> None:
    now = time.time()
    with connect() as con:
        con.execute("UPDATE sessions SET last_seen = ?, expires = ? WHERE id = ? AND logged_in = 1", (now, now + ttl_s, _sid(cookie_value)))


def close_session(cookie_value: str | None) -> None:
    if not cookie_value:
        return
    with connect() as con:
        con.execute("UPDATE sessions SET logged_in = 0, last_seen = ? WHERE id = ?", (time.time(), _sid(cookie_value)))


def login_state(email: str) -> dict[str, Any]:
    now = time.time()
    with connect() as con:
        n = con.execute("SELECT COUNT(*) FROM sessions WHERE email = ? AND logged_in = 1 AND expires > ?", (email, now)).fetchone()[0]
        last = con.execute("SELECT MAX(last_seen) FROM sessions WHERE email = ?", (email,)).fetchone()[0]
        return {"logged_in": n > 0, "active_sessions": n, "last_seen": last}


# ---- watchlist --------------------------------------------------------------------
def set_watchlist(email: str, tickers: list[str], list_name: str = DEFAULT_LIST) -> list[str]:
    """Replace one named list (the default list unless told otherwise) and make it active."""
    now = time.time()
    with connect() as con:
        con.execute("DELETE FROM watchlist WHERE email = ? AND list_name = ?", (email, list_name))
        con.executemany("INSERT INTO watchlist(email, ticker, position, added, list_name) VALUES (?, ?, ?, ?, ?)", [(email, t, i, now, list_name) for i, t in enumerate(tickers)])
        con.execute("UPDATE users SET active_list = ? WHERE email = ?", (list_name, email))
    return tickers


def set_watchlists(email: str, lists: dict[str, list[str]], active: str | None) -> dict[str, Any]:
    """Replace every list the user owns; `active` names the one the page is showing."""
    now = time.time()
    with connect() as con:
        con.execute("DELETE FROM watchlist WHERE email = ?", (email,))
        for name, tickers in lists.items():
            con.executemany("INSERT INTO watchlist(email, ticker, position, added, list_name) VALUES (?, ?, ?, ?, ?)", [(email, t, i, now, name) for i, t in enumerate(tickers)])
        con.execute("UPDATE users SET active_list = ? WHERE email = ?", (active if active in lists else (next(iter(lists)) if lists else DEFAULT_LIST), email))
    return {"lists": lists, "active": active}


def all_watchlist_tickers() -> list[str]:
    with connect() as con:
        return [r["ticker"] for r in con.execute("SELECT DISTINCT ticker FROM watchlist")]


def import_legacy_json(users_path: Path) -> int:
    """One-time import of the earlier users.json into the database."""
    try:
        data = json.loads(users_path.read_text())
    except Exception:  # noqa: BLE001
        return 0
    n = 0
    for email, u in data.items():
        ensure_user(email)
        if u.get("accepted_disclaimer_at"):
            accept_disclaimer(email)
        if u.get("tickers"):
            set_watchlist(email, [str(t).upper() for t in u["tickers"]])
        n += 1
    try:
        users_path.rename(users_path.with_suffix(".json.imported"))
    except OSError:
        pass
    return n


# ---- verdict ledger: every call the model makes, with the price at the time, evaluated later --------
BULLISH = {"buy_now", "buy_the_dip", "long_momentum", "buy_dip_to_support", "accumulate", "trend_up", "momentum_up", "drifting_up", "pullback_in_uptrend", "buying_today",
           "re_entry", "tactical_rebound", "hold_ride"}
BEARISH = {"short_setup", "short_momentum", "trim", "avoid", "fade_the_gap", "trend_down", "momentum_down", "drifting_down", "selling_today",
           "stay_out", "exit", "exit_trim"}
HORIZON = {"swing": 7, "intraday": 1, "long_term": 90, "desk": 7}          # calendar days until a call is scored


def log_verdicts(rows: list[dict[str, Any]]) -> int:
    """rows: {ticker, kind, verdict, price, build_id}. Ignores duplicates for the same build."""
    now = time.time()
    n = 0
    with connect() as con:
        for r in rows:
            if not r.get("verdict") or r.get("price") is None:
                continue
            horizon = HORIZON.get(r["kind"], 7)
            # A call counts once: the same verdict on the same name inside an open window is the same call, not a new one.
            same = con.execute("SELECT 1 FROM verdicts WHERE ticker = ? AND kind = ? AND verdict = ? AND eval_ts IS NULL AND ts > ? LIMIT 1",
                               (r["ticker"], r["kind"], r["verdict"], now - horizon * 86400)).fetchone()
            if same:
                continue
            cur = con.execute("INSERT OR IGNORE INTO verdicts(ticker, kind, verdict, price, ts, horizon_days, build_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                              (r["ticker"], r["kind"], r["verdict"], float(r["price"]), now, horizon, r.get("build_id")))
            n += cur.rowcount
    return n


def evaluate_verdicts(prices: dict[str, float]) -> int:
    """Score every call whose horizon has passed, using today's price for that ticker."""
    now = time.time()
    n = 0
    with connect() as con:
        due = con.execute("SELECT id, ticker, verdict, price, horizon_days FROM verdicts WHERE eval_ts IS NULL AND ts + horizon_days * 86400 <= ?", (now,)).fetchall()
        for r in due:
            px = prices.get(r["ticker"])
            if px is None or not r["price"]:
                continue
            move = px / r["price"] - 1
            v = r["verdict"]
            hit = None
            if v in BULLISH:
                hit = 1 if move > 0 else 0
            elif v in BEARISH:
                hit = 1 if move <= 0 else 0
            con.execute("UPDATE verdicts SET eval_price = ?, eval_ts = ?, hit = ? WHERE id = ?", (px, now, hit, r["id"]))
            n += 1
    return n


def track_record() -> dict[str, Any]:
    with connect() as con:
        by_verdict = [dict(r) for r in con.execute(
            "SELECT kind, verdict, COUNT(*) AS n, SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) AS scored, "
            "AVG(CASE WHEN eval_price IS NOT NULL THEN (eval_price / price - 1) * 100 END) AS avg_move_pct "
            "FROM verdicts GROUP BY kind, verdict ORDER BY kind, n DESC")]
        by_ticker = [dict(r) for r in con.execute(
            "SELECT ticker, COUNT(*) AS n, SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) AS scored, "
            "AVG(CASE WHEN eval_price IS NOT NULL THEN (eval_price / price - 1) * 100 END) AS avg_move_pct "
            "FROM verdicts GROUP BY ticker HAVING scored > 0 ORDER BY scored DESC, hits DESC LIMIT 60")]
        recent = [dict(r) for r in con.execute("SELECT ticker, kind, verdict, price, ts, eval_price, eval_ts, hit FROM verdicts ORDER BY ts DESC LIMIT 80")]
        totals = dict(con.execute("SELECT COUNT(*) AS n, SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) AS scored, MIN(ts) AS since FROM verdicts").fetchone())
    return {"by_verdict": by_verdict, "by_ticker": by_ticker, "recent": recent, "totals": totals, "as_of": time.time()}


# ---- alerts (settings only for now; delivery comes later) -----------------------------------------
def get_alert(email: str) -> dict[str, Any]:
    with connect() as con:
        r = con.execute("SELECT * FROM alerts WHERE email = ?", (email,)).fetchone()
        return dict(r) if r else {"email": email, "enabled": 0, "rvol_threshold": 3.0, "min_price": 2.0, "channel": "email", "updated": None}


def set_alert(email: str, enabled: bool, rvol_threshold: float, min_price: float, channel: str) -> dict[str, Any]:
    with connect() as con:
        con.execute("INSERT INTO alerts(email, enabled, rvol_threshold, min_price, channel, updated) VALUES (?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(email) DO UPDATE SET enabled = excluded.enabled, rvol_threshold = excluded.rvol_threshold, min_price = excluded.min_price, channel = excluded.channel, updated = excluded.updated",
                    (email, 1 if enabled else 0, float(rvol_threshold), float(min_price), channel, time.time()))
    return get_alert(email)


# ---- morning-briefing email recipients ---------------------------------------------------------
def brief_recipients() -> list[dict[str, Any]]:
    """Everyone who has signed in at least once and has not opted out."""
    with connect() as con:
        return [dict(r) for r in con.execute("SELECT email, name, active_list FROM users WHERE last_login IS NOT NULL AND COALESCE(brief_opt_out, 0) = 0 ORDER BY email")]


def set_brief_opt_out(email: str, flag: bool) -> None:
    with connect() as con:
        con.execute("UPDATE users SET brief_opt_out = ? WHERE email = ?", (1 if flag else 0, email))


# ---- intraday direction reads and their scoring --------------------------------------------------
def log_direction(read: dict[str, Any]) -> int:
    import json as _json
    f = read.get("facts") or {}
    with connect() as con:
        cur = con.execute("INSERT INTO direction_reads(ts, day, spy, qqq, expected, confidence, driver, facts, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                          (time.time(), read.get("date"), (f.get("spy") or {}).get("last"), (f.get("qqq") or {}).get("last"), read.get("expected"), read.get("confidence"), read.get("driver"), _json.dumps(f), read.get("source")))
        return int(cur.lastrowid)


def day_directions(day: str) -> list[dict[str, Any]]:
    with connect() as con:
        return [dict(r) for r in con.execute("SELECT id, ts, spy, qqq, expected, confidence, driver, source, move_15, move_30, move_60, hit_60, move_spy_pct, move_qqq_pct, close_spy, hit FROM direction_reads WHERE day = ? ORDER BY ts", (day,))]


def score_day_directions(day: str, close_spy: float, close_qqq: float, scorer) -> dict[str, Any]:
    """Score every unscored read of the day against the closing prices. `scorer(expected, move_pct) -> hit`."""
    now = time.time()
    with connect() as con:
        rows = [dict(r) for r in con.execute("SELECT id, spy, qqq, expected FROM direction_reads WHERE day = ? AND scored_at IS NULL", (day,))]
        for r in rows:
            ms = (close_spy / r["spy"] - 1) * 100 if r.get("spy") else None
            mq = (close_qqq / r["qqq"] - 1) * 100 if r.get("qqq") else None
            hit = scorer(r.get("expected"), ms)
            con.execute("UPDATE direction_reads SET close_spy = ?, close_qqq = ?, move_spy_pct = ?, move_qqq_pct = ?, hit = ?, scored_at = ? WHERE id = ?", (close_spy, close_qqq, ms, mq, hit, now, r["id"]))
        tot = dict(con.execute("SELECT COUNT(*) AS n, SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) AS scored FROM direction_reads WHERE day = ?", (day,)).fetchone())
    return tot


def direction_stats(days: int = 30) -> dict[str, Any]:
    """Hit rates by day, answer, driver, hour of day, engine and conviction band, at the close and one hour on."""
    since = time.time() - days * 86400
    agg = ("COUNT(*) AS n, SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END) AS scored, "
           "SUM(CASE WHEN hit_60 = 1 THEN 1 ELSE 0 END) AS hits_60, SUM(CASE WHEN hit_60 IS NOT NULL THEN 1 ELSE 0 END) AS scored_60, "
           "AVG(move_spy_pct) AS avg_move, AVG(move_60) AS avg_move_60")
    with connect() as con:
        q = lambda group, label: [dict(r) for r in con.execute(f"SELECT {group} AS {label}, {agg} FROM direction_reads WHERE ts >= ? AND expected IS NOT NULL GROUP BY {group} ORDER BY {label}", (since,))]
        by_day = [dict(r) for r in con.execute(f"SELECT day, {agg} FROM direction_reads WHERE ts >= ? GROUP BY day ORDER BY day DESC", (since,))]
        by_expected = q("expected", "expected")
        by_driver = q("driver", "driver")
        by_source = q("COALESCE(source, 'model')", "source")
        by_hour = q("strftime('%H', ts - 4 * 3600, 'unixepoch')", "hour")
        by_conf = q("CASE WHEN confidence >= 0.7 THEN 'high' WHEN confidence >= 0.5 THEN 'med' ELSE 'low' END", "conviction")
        tot = dict(con.execute(f"SELECT {agg} FROM direction_reads WHERE ts >= ?", (since,)).fetchone())
        missing = con.execute("SELECT COUNT(*) FROM direction_reads WHERE ts >= ? AND expected IS NULL", (since,)).fetchone()[0]
    return {"by_day": by_day, "by_expected": by_expected, "by_driver": by_driver, "by_source": by_source, "by_hour": by_hour, "by_conviction": by_conf,
            "totals": tot, "no_read": missing, "days": days}


def fill_direction_paths(day: str, price_at, scorer) -> int:
    """Fill the SPY move 15, 30 and 60 minutes after each read (`price_at(ts) -> price or None`) once that
    much time has passed, and score the one-hour hit. Returns the number of rows touched."""
    now = time.time()
    n = 0
    with connect() as con:
        rows = [dict(r) for r in con.execute("SELECT id, ts, spy, expected, move_15, move_30, move_60 FROM direction_reads WHERE day = ? AND move_60 IS NULL", (day,))]
        for r in rows:
            if not r.get("spy"):
                continue
            upd: dict[str, Any] = {}
            for mins, col in ((15, "move_15"), (30, "move_30"), (60, "move_60")):
                if r.get(col) is None and r["ts"] + mins * 60 <= now:
                    px = price_at(r["ts"] + mins * 60)
                    if px:
                        upd[col] = (px / r["spy"] - 1) * 100
            if not upd:
                continue
            if "move_60" in upd:
                upd["hit_60"] = scorer(r.get("expected"), upd["move_60"])
            sets = ", ".join(f"{k} = ?" for k in upd)
            con.execute(f"UPDATE direction_reads SET {sets} WHERE id = ?", (*upd.values(), r["id"]))
            n += 1
    return n


def unscored_direction_days(before_day: str) -> list[str]:
    """Past days that still have reads without a close score (the close briefing did not run)."""
    with connect() as con:
        return [r[0] for r in con.execute("SELECT DISTINCT day FROM direction_reads WHERE day < ? AND scored_at IS NULL AND expected IS NOT NULL ORDER BY day", (before_day,))]


def log_analysis(day: str, kind: str, symbol: str, price: Any, read: str | None, confidence: Any, facts: dict[str, Any]) -> None:
    import json as _json
    with connect() as con:
        con.execute("INSERT INTO analysis_log(ts, day, kind, symbol, price, read, confidence, facts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (time.time(), day, kind, symbol, price, read, confidence, _json.dumps(facts)))


def score_analysis(day: str, closes: dict[str, float], scorer) -> None:
    with connect() as con:
        rows = [dict(r) for r in con.execute("SELECT id, symbol, price, read FROM analysis_log WHERE day = ? AND kind = 'morning_index' AND scored_at IS NULL", (day,))]
        for r in rows:
            c = closes.get(r["symbol"])
            if not c or not r.get("price"):
                continue
            mv = (c / r["price"] - 1) * 100
            exp = {"push_higher": "higher", "rebound": "higher", "break_lower": "lower", "pullback_then_higher": "lower", "range_bound": "sideways"}.get(r.get("read"))
            con.execute("UPDATE analysis_log SET outcome_pct = ?, hit = ?, scored_at = ? WHERE id = ?", (mv, scorer(exp, mv) if exp else None, time.time(), r["id"]))


def analysis_days(days: int = 60) -> list[dict[str, Any]]:
    since = time.time() - days * 86400
    with connect() as con:
        return [dict(r) for r in con.execute("""SELECT day,
            SUM(CASE WHEN kind = 'morning_index' AND symbol = 'SPY' THEN 1 ELSE 0 END) AS morning_calls,
            SUM(CASE WHEN kind = 'morning_index' AND hit = 1 THEN 1 ELSE 0 END) AS morning_hits,
            SUM(CASE WHEN kind = 'morning_index' AND hit IS NOT NULL THEN 1 ELSE 0 END) AS morning_scored
            FROM analysis_log WHERE ts >= ? GROUP BY day ORDER BY day DESC""", (since,))]


def day_detail(day: str) -> dict[str, Any]:
    import json as _json
    with connect() as con:
        reads = [dict(r) for r in con.execute("SELECT ts, spy, qqq, expected, confidence, driver, source, move_15, move_30, move_60, hit_60, move_spy_pct, hit, facts FROM direction_reads WHERE day = ? ORDER BY ts", (day,))]
        for r in reads:
            try:
                f = _json.loads(r.pop("facts") or "{}"); r["facts"] = {"spy": {k: (f.get("spy") or {}).get(k) for k in ("above_vwap", "range_pos", "chg_day_pct")}, "sentiment": f.get("sentiment")}
            except Exception:  # noqa: BLE001
                r["facts"] = None
        morning = [dict(r) for r in con.execute("SELECT ts, symbol, price, read, confidence, outcome_pct, hit FROM analysis_log WHERE day = ? AND kind = 'morning_index' ORDER BY symbol", (day,))]
    return {"day": day, "reads": reads, "morning": morning}


def log_crowd(day: str, rows: list[dict[str, Any]]) -> None:
    with connect() as con:
        con.executemany("INSERT INTO crowd_reads(ts, day, symbol, score, label, bullish_pct, volume_label, price, change_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        [(time.time(), day, r["symbol"], r.get("score"), r.get("label"), r.get("bullish_pct"), r.get("volume_label"), r.get("price"), r.get("change_pct")) for r in rows])
