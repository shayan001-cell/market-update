"""Top traders: the most-followed active StockTwits accounts, scored on what they actually called.

Nobody publishes verified direction hit rates for social-media traders, so OneView measures them:
  1. Discovery: read ~200 recent posts on each of the most-watched tickers and rank the authors by the likes
     their posts earn (the connector exposes likes, not follower counts; engagement is the honest proxy).
  2. Scoring: for each candidate, read their recent posts. Every post tagged Bullish or Bearish is a call on
     its first ticker. Entry is that session's close (next session's if posted after the 4pm close), the
     outcome is the close five sessions later. One call per trader, ticker and day, so repeat posting does
     not inflate a record. Moves under 0.2% are a wash and are not scored.
  3. The list: traders with at least MIN_SCORED scored calls and a measured hit rate of MIN_HIT or better,
     ranked by the lower bound of their hit rate (so 18 of 20 beats 3 of 3).

The consensus is the qualifying traders' calls in the last CONSENSUS_H hours, weighted by their hit rates.
"""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DISCOVERY_SYMBOLS = ["SPY", "QQQ", "IWM", "DIA", "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD",
                     "PLTR", "AVGO", "MU", "COIN", "MSTR", "HOOD", "SMCI", "NFLX"]
CANDIDATES = 45          # accounts scored per run (the rest of the budget goes to reading their posts)
USER_POSTS = 150         # posts read per candidate
HORIZON = 5              # sessions between entry and outcome
MIN_SCORED = 12
MIN_HIT = 0.70
TOP_N = 20
CONSENSUS_H = 72
WASH = 0.2               # percent


def yf_symbol(s: str) -> str | None:
    s = (s or "").upper()
    if s.endswith(".X"):
        return s[:-2] + "-USD"
    if s in ("SPX", "SPX.X"):
        return "^GSPC"
    if s in ("NDX",):
        return "^NDX"
    if s in ("VIX", "VIXY", "UVXY", "SQQQ", "SPXU", "SDS", "SH", "PSQ", "SPXS", "TZA", "SOXS"):
        return None      # fear gauges and inverse funds: a "bullish" tag on them is a bearish market call; skip rather than guess
    return s if re.fullmatch(r"[A-Z]{1,5}", s) else None


def wilson_low(h: int, n: int, z: float = 1.64) -> float:
    if n == 0:
        return 0.0
    p = h / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - r) / d


def discover(read_symbol: Callable[[str], list[dict[str, Any]]], blocked: Callable[[str], bool]) -> list[dict[str, Any]]:
    """Authors across the most-watched tickers, ranked by likes earned, then by tagged calls made."""
    users: dict[str, dict[str, Any]] = {}
    for sym in DISCOVERY_SYMBOLS:
        try:
            msgs = read_symbol(sym)
        except Exception:  # noqa: BLE001
            continue
        for m in msgs:
            u = m.get("user") or {}
            name = u.get("username")
            if not name or blocked(name):
                continue
            rec = users.setdefault(name, {"username": name, "id": u.get("id"), "name": u.get("name"), "likes": 0, "posts": 0, "tagged": 0, "symbols": set()})
            rec["likes"] += int(m.get("likes") or 0)
            rec["posts"] += 1
            rec["tagged"] += 1 if (m.get("sentiment") or "") in ("Bullish", "Bearish") else 0
            rec["symbols"].add(sym)
    ranked = sorted(users.values(), key=lambda r: (r["likes"], len(r["symbols"]), r["tagged"]), reverse=True)
    out = []
    for r in ranked:
        if r["tagged"] == 0:
            continue
        out.append({**r, "symbols": sorted(r["symbols"])})
    return out


def calls_from(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Tagged posts -> one call per ticker per ET day (the first one that day)."""
    seen: set[tuple[str, str]] = set()
    out = []
    for m in sorted(msgs, key=lambda x: x.get("created_at") or ""):
        side = (m.get("sentiment") or "").lower()
        if side not in ("bullish", "bearish"):
            continue
        syms = m.get("symbols") or []
        first = re.search(r"\$([A-Za-z][A-Za-z.]*)", m.get("body") or "")
        sym = (first.group(1).upper() if first else (syms[0] if syms else "")).upper()
        y = yf_symbol(sym)
        if not y:
            continue
        try:
            at = datetime.fromisoformat(str(m["created_at"]).replace("Z", "+00:00")).astimezone(ET)
        except Exception:  # noqa: BLE001
            continue
        key = (sym, at.date().isoformat())
        if key in seen:
            continue
        seen.add(key)
        out.append({"sym": sym, "yf": y, "side": side, "at": at.isoformat(), "id": m.get("id"), "body": m.get("body") or "", "likes": int(m.get("likes") or 0)})
    return out


def score_calls(calls: list[dict[str, Any]], closes: dict[str, list[tuple[str, float]]]) -> list[dict[str, Any]]:
    """Attach entry, outcome and hit to each call whose five-session window has closed."""
    for c in calls:
        series = closes.get(c["yf"]) or []
        if not series:
            c["status"] = "no_price"; continue
        at = datetime.fromisoformat(c["at"])
        d = at.date().isoformat()
        after_close = at.hour >= 16 or at.weekday() >= 5
        idx = next((i for i, (day, _) in enumerate(series) if (day > d) or (day == d and not after_close)), None)
        if idx is None or idx + HORIZON >= len(series):
            c["status"] = "open"; continue
        e, x = series[idx][1], series[idx + HORIZON][1]
        ret = (x / e - 1) * 100 if e else 0.0
        c.update(entry=round(e, 4), exit=round(x, 4), ret=round(ret, 2), entry_day=series[idx][0], exit_day=series[idx + HORIZON][0])
        if abs(ret) < WASH:
            c["status"] = "wash"; continue
        c["status"] = "scored"
        c["hit"] = (ret > 0) == (c["side"] == "bullish")
    return calls


def summarize(user: dict[str, Any], calls: list[dict[str, Any]]) -> dict[str, Any]:
    sc = [c for c in calls if c.get("status") == "scored"]
    hits = sum(1 for c in sc if c["hit"])
    bulls = sum(1 for c in calls if c["side"] == "bullish")
    n = len(sc)
    return {**user, "calls": len(calls), "scored": n, "hits": hits, "hit_rate": round(hits / n, 3) if n else None,
            "hit_low": round(wilson_low(hits, n), 3), "bull_share": round(bulls / len(calls), 3) if calls else None,
            "avg_ret_hit": round(sum(abs(c["ret"]) for c in sc if c["hit"]) / hits, 2) if hits else None,
            "first_call": calls[0]["at"] if calls else None, "last_call": calls[-1]["at"] if calls else None}


def consensus(traders: list[dict[str, Any]], calls_by_user: dict[str, list[dict[str, Any]]], now: datetime | None = None) -> dict[str, Any]:
    """The qualifying traders' calls in the last CONSENSUS_H hours, per ticker, weighted by each trader's hit rate."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=CONSENSUS_H)
    per: dict[str, dict[str, Any]] = {}
    latest: list[dict[str, Any]] = []
    for t in traders:
        w = t["hit_rate"] or 0.0
        for c in calls_by_user.get(t["username"], []):
            at = datetime.fromisoformat(c["at"])
            if at < cutoff:
                continue
            p = per.setdefault(c["sym"], {"sym": c["sym"], "bull": 0, "bear": 0, "w_bull": 0.0, "w_bear": 0.0, "traders": set()})
            if c["side"] == "bullish":
                p["bull"] += 1; p["w_bull"] += w
            else:
                p["bear"] += 1; p["w_bear"] += w
            p["traders"].add(t["username"])
            latest.append({"username": t["username"], "hit_rate": t["hit_rate"], "scored": t["scored"], "sym": c["sym"], "side": c["side"], "at": c["at"], "id": c["id"], "body": c["body"]})
    rows = []
    for p in per.values():
        tot = p["w_bull"] + p["w_bear"]
        rows.append({"sym": p["sym"], "bull": p["bull"], "bear": p["bear"], "traders": len(p["traders"]),
                     "lean": round(p["w_bull"] / tot, 3) if tot else None})
    rows.sort(key=lambda r: (-r["traders"], -(r["bull"] + r["bear"])))
    latest.sort(key=lambda x: x["at"], reverse=True)
    active = len({x["username"] for x in latest})
    return {"window_h": CONSENSUS_H, "tickers": rows[:24], "latest": latest[:40], "active": active}
