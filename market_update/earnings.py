"""Earnings calendar with a review of every report once it is out.

One week at a time (Monday to Friday, NYSE holidays skipped), from Nasdaq's public earnings calendar:
  - before the report: time (before the open / after the close), consensus EPS, last year's EPS, analyst count;
  - after it: actual EPS, the surprise against consensus, and how the stock took it in the next session
    (before-open report: prior close to that day's close; after-close report: that close to the next day's close).
The review is rules, not a model: beat / in line / miss, and whether the stock was bought or sold on it.
Companies of $2B and up are kept, plus anything on a OneView watchlist.
"""
from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from typing import Any

import requests
import yfinance as yf

from . import ai_budget, config, db, fetch

log = logging.getLogger(__name__)

MIN_CAP = 2e9
PER_DAY = 40
IN_LINE_PCT = 2.0                  # within ±2% of consensus counts as in line
WHEN = {"time-pre-market": "before", "time-after-hours": "after"}


def _money(s: Any) -> float | None:
    try:
        return float(str(s).replace("$", "").replace(",", "").replace("(", "-").replace(")", "")) if s not in (None, "", "N/A") else None
    except ValueError:
        return None


def _day(d: date) -> list[dict[str, Any]]:
    """One day's calendar, cached: settled days for a day, today and yesterday for 20 minutes, future days for 3 hours."""
    today = fetch.now_et().date()
    ttl = 86400 if d < today - timedelta(days=2) else 1200 if d <= today else 3 * 3600
    key = f"earn_{d.isoformat()}"
    hit = fetch._cache_get(key, ttl)
    if hit is not None:
        return hit
    try:
        r = requests.get(fetch.NASDAQ_EARNINGS, params={"date": d.isoformat()}, headers=fetch.UA, timeout=20)
        r.raise_for_status()
        rows = ((r.json() or {}).get("data") or {}).get("rows") or []
    except Exception as e:  # noqa: BLE001
        log.warning("earnings calendar %s failed: %s", d, e)
        return fetch._cache_get(key, -1) or []
    # Once a day has passed Nasdaq drops the report time; keep the one seen while the day was still ahead.
    seen_when = {x["symbol"]: x["when"] for x in (fetch._cache_get(key, -1) or []) if x.get("when") in ("before", "after")}
    out = []
    for row in rows:
        sym = (row.get("symbol") or "").strip().upper()
        if not sym:
            continue
        out.append({
            "symbol": sym, "name": (row.get("name") or "").strip(), "date": d.isoformat(),
            "when": WHEN.get(row.get("time") or "") or seen_when.get(sym, "unknown"), "market_cap": _money(row.get("marketCap")),
            "quarter": row.get("fiscalQuarterEnding") or "", "eps_est": _money(row.get("epsForecast")),
            "eps": _money(row.get("eps")), "surprise_pct": _money(row.get("surprise")),
            "eps_last_year": _money(row.get("lastYearEPS")), "n_est": int(row["noOfEsts"]) if str(row.get("noOfEsts") or "").isdigit() else None,
        })
    fetch._cache_put(key, out)
    return out


def _reactions(rows: list[dict[str, Any]], start: date) -> None:
    """Next-session move for every reported row, from one batched daily-price request."""
    syms = sorted({r["symbol"] for r in rows if r["eps"] is not None})
    if not syms:
        return
    key = f"earn_px_{start.isoformat()}"
    closes = fetch._cache_get(key, 1800)
    if closes is None:
        closes = {}
        try:
            df = yf.download(syms, start=(start - timedelta(days=7)).isoformat(), end=(fetch.now_et().date() + timedelta(days=1)).isoformat(),
                             interval="1d", progress=False, auto_adjust=False, threads=False, group_by="ticker")
            for s in syms:
                try:
                    col = df[s]["Close"] if len(syms) > 1 else df["Close"]
                    col = col.dropna()
                    closes[s] = {str(k.date()): float(v) for k, v in col.items()}
                except Exception:  # noqa: BLE001
                    continue
            fetch._cache_put(key, closes)
        except Exception as e:  # noqa: BLE001
            log.warning("earnings reactions failed: %s", e)
            return
    for r in rows:
        c = closes.get(r["symbol"])
        if r["eps"] is None or not c:
            continue
        days = sorted(c)
        d = r["date"]
        before = [x for x in days if x < d]
        on_or_after = [x for x in days if x >= d]
        after = [x for x in days if x > d]
        if r["when"] == "after":
            a, b = (on_or_after[0] if on_or_after else None), (after[0] if after else None)
        elif r["when"] == "before":
            a, b = (before[-1] if before else None), (on_or_after[0] if on_or_after else None)
        else:                                     # time not known: span both sessions around the report, said as such
            a = before[-1] if before else None
            b = after[0] if after else None
            r["reaction_span"] = "two sessions"
        if a and b and a != b:
            r["reaction_pct"] = round((c[b] / c[a] - 1) * 100, 2)
            r["reaction_from"], r["reaction_to"] = a, b


def _review(r: dict[str, Any]) -> None:
    eps, est = r.get("eps"), r.get("eps_est")
    if eps is None:
        r["status"] = "upcoming"
        if est is not None and (r.get("eps_last_year") or 0) > 0:        # growth only means something off a profit
            r["growth_pct"] = round((est / r["eps_last_year"] - 1) * 100, 1)
        return
    s = r.get("surprise_pct")
    if s is None and est not in (None, 0):
        s = (eps - est) / abs(est) * 100
        r["surprise_pct"] = round(s, 1)
    r["result"] = None if s is None else "beat" if s > IN_LINE_PCT else "miss" if s < -IN_LINE_PCT else "inline"
    mv = r.get("reaction_pct")
    r["reaction"] = None if mv is None else "bought" if mv >= 1 else "sold" if mv <= -1 else "flat"
    word = {"beat": "Beat", "miss": "Missed", "inline": "In line with"}.get(r["result"] or "", "Reported against")
    txt = f"{word} estimates" + (f" by {abs(s):.0f}%" if s is not None and r["result"] != "inline" else "")
    if mv is not None:
        span = "over the two sessions around it" if r.get("reaction_span") else "next session"
        txt += {"bought": f"; buyers stepped in, {mv:+.1f}% {span}", "sold": f"; sold anyway, {mv:+.1f}% {span}" if r["result"] == "beat" else f"; sold, {mv:+.1f}% {span}",
                "flat": f"; shrugged off, {mv:+.1f}% {span}"}[r["reaction"]]
        if r["result"] == "miss" and r["reaction"] == "bought":
            txt = txt.replace("buyers stepped in", "bought anyway")
    r["status"] = "reported"
    r["review"] = txt + "."


def week(offset: int = 0) -> dict[str, Any]:
    t0 = time.time()
    today = fetch.now_et().date()
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=offset)
    days = [monday + timedelta(days=i) for i in range(5)]
    watch = set(config.load_watchlist()) | set(db.all_watchlist_tickers())
    out_days, every = [], []
    for d in days:
        if not ai_budget.is_trading_day(d):
            out_days.append({"date": d.isoformat(), "holiday": True, "rows": [], "total": 0})
            continue
        rows = _day(d)
        keep = [dict(r) for r in rows if (r["market_cap"] or 0) >= MIN_CAP or r["symbol"] in watch]
        keep.sort(key=lambda r: r["market_cap"] or 0, reverse=True)
        keep = keep[:PER_DAY] + [dict(r) for r in keep[PER_DAY:] if r["symbol"] in watch]
        for r in keep:
            r["watch"] = r["symbol"] in watch
        out_days.append({"date": d.isoformat(), "rows": keep, "total": len(rows)})
        every += keep
    _reactions(every, monday)
    for r in every:
        _review(r)
    rep = [r for r in every if r["status"] == "reported"]
    beats = [r for r in rep if r.get("result") == "beat"]
    mv = [r["reaction_pct"] for r in rep if r.get("reaction_pct") is not None]
    movers = sorted([r for r in rep if r.get("reaction_pct") is not None], key=lambda r: abs(r["reaction_pct"]), reverse=True)[:5]
    return {"week_of": monday.isoformat(), "offset": offset, "today": today.isoformat(), "days": out_days,
            "summary": {"companies": len(every), "reported": len(rep), "upcoming": len(every) - len(rep),
                        "beat": len(beats), "miss": sum(1 for r in rep if r.get("result") == "miss"), "inline": sum(1 for r in rep if r.get("result") == "inline"),
                        "beat_rate": round(len(beats) / len(rep) * 100) if rep else None,
                        "avg_reaction": round(sum(mv) / len(mv), 2) if mv else None,
                        "beat_but_sold": sum(1 for r in beats if r.get("reaction") == "sold"),
                        "movers": [{"symbol": r["symbol"], "reaction_pct": r["reaction_pct"], "result": r.get("result")} for r in movers]},
            "min_cap": MIN_CAP, "elapsed_s": round(time.time() - t0, 1)}
