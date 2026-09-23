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
CREATE TABLE IF NOT EXISTS watchlist (
    email TEXT NOT NULL,
    ticker TEXT NOT NULL,
    position INTEGER NOT NULL,
    added REAL NOT NULL,
    PRIMARY KEY (email, ticker)
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


def _migrate(con: sqlite3.Connection) -> None:
    cols = {r["name"] for r in con.execute("PRAGMA table_info(users)")}
    if "name" not in cols:
        con.execute("ALTER TABLE users ADD COLUMN name TEXT")


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
        tickers = [r["ticker"] for r in con.execute("SELECT ticker FROM watchlist WHERE email = ? ORDER BY position", (email,))]
        return {"email": email, "name": row["name"], "created": row["created"], "last_login": row["last_login"],
                "accepted_disclaimer_at": row["accepted_disclaimer_at"], "tickers": tickers}


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
def set_watchlist(email: str, tickers: list[str]) -> list[str]:
    now = time.time()
    with connect() as con:
        con.execute("DELETE FROM watchlist WHERE email = ?", (email,))
        con.executemany("INSERT INTO watchlist(email, ticker, position, added) VALUES (?, ?, ?, ?)", [(email, t, i, now) for i, t in enumerate(tickers)])
    return tickers


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
