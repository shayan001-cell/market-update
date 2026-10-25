"""Tipster X-ray: an honest report card for any StockTwits account.

Built on the top-traders ledger (pros.py): every bullish or bearish call, scored against the price over its window.
A raw hit rate flatters anyone who happened to lean the way the market went, so each call is compared with the
base rate: how often calls on the same side, entered in the same half-month, were right across every account.
  - edge:        hit rate minus that expected rate (in points)
  - luck:        chance a caller with the same side mix and no skill would do at least this well
                 (normal approximation to the Poisson-binomial)
  - copy result: the average move per call had you taken every call the way it was made
The verdict needs a sample: fewer than MIN_N scored calls is "too few to judge".
On 2026-10-25 the ledger showed past accuracy barely predicts future accuracy (top 20 by hit rate hit about 50%
afterwards), so the page says plainly that even a real edge so far is not a promise.
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

MIN_N = 10
BIAS = 0.9


def _bucket(day: str) -> str:
    return day[:8] + ("1" if int(day[8:10]) <= 15 else "2")


def base_rates(calls_by_user: dict[str, list[dict[str, Any]]]) -> dict[str, list[int]]:
    b: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for cs in calls_by_user.values():
        for c in cs:
            if c.get("status") == "scored":
                k = f"{c['side']}|{_bucket(c['entry_day'])}"
                b[k][0] += int(bool(c["hit"])); b[k][1] += 1
    return dict(b)


def _expected(c: dict[str, Any], base: dict[str, list[int]]) -> float:
    h, n = base.get(f"{c['side']}|{_bucket(c['entry_day'])}", [0, 0])
    if n < 20:                                       # thin bucket: fall back to the side's overall rate
        hh = sum(v[0] for k, v in base.items() if k.startswith(c["side"] + "|")); nn = sum(v[1] for k, v in base.items() if k.startswith(c["side"] + "|"))
        return hh / nn if nn else 0.5
    return h / n


def _phi(z: float) -> float:
    return 0.5 * (1 + math.erf(z / math.sqrt(2)))


EDGE_BETS = 20                 # independent bets needed before "real edge" is possible
EDGE_LUCK = 0.01               # strict: with ~1,000 accounts checked, a 5% bar would pass ~50 by chance alone


def grade(n_bets: int, edge: float | None, luck: float | None) -> tuple[str, str, str]:
    """(key, label, one-line meaning), judged on independent bets"""
    if n_bets < MIN_N:
        return "few", "Too few calls to judge", f"Fewer than {MIN_N} separate bets have been scored. Anyone can look brilliant over a handful."
    if edge is not None and edge <= -5:
        return "worse", "Worse than the market", "Taking the other side of these calls would have done better than following them."
    if luck is not None and luck <= EDGE_LUCK and n_bets >= EDGE_BETS:
        return "edge", "Real edge so far", "Right more often than the market alone explains, over enough separate bets that luck is unlikely. Past edge still fades for most accounts."
    if luck is not None and luck <= 0.2 and (edge or 0) > 0:
        return "maybe", "Promising, not proven", "Better than the market so far, but not over enough separate bets to rule out luck."
    return "luck", "Looks like luck", "About what a caller with no skill and the same bullish/bearish mix would get."


def report(username: str, meta: dict[str, Any], calls: list[dict[str, Any]], base: dict[str, list[int]], clean=None) -> dict[str, Any]:
    sc = sorted([c for c in calls if c.get("status") == "scored"], key=lambda c: c["entry_day"])
    open_ = sorted([c for c in calls if c.get("status") == "open"], key=lambda c: c["at"], reverse=True)
    n = len(sc); hits = sum(1 for c in sc if c["hit"])
    exp = [_expected(c, base) for c in sc]
    hit_rate = hits / n if n else None
    exp_rate = sum(exp) / n if n else None
    edge = round((hit_rate - exp_rate) * 100, 1) if n else None
    # Repeating a call (same ticker, same side, same week) is one bet, not several: the luck test runs on these
    # independent bets, each counted right when most of its calls were.
    bets: dict[tuple, list[tuple[int, float]]] = defaultdict(list)
    for c, e in zip(sc, exp):
        d = date.fromisoformat(c["entry_day"]); bets[(c["sym"], c["side"], d.isocalendar()[:2])].append((int(c["hit"]), e))
    bh = sum(1 for v in bets.values() if sum(x[0] for x in v) / len(v) > 0.5)
    be = [sum(x[1] for x in v) / len(v) for v in bets.values()]
    nb = len(bets); mean = sum(be); var = sum(p * (1 - p) for p in be)
    luck = round(1 - _phi((bh - 0.5 - mean) / math.sqrt(var)), 4) if nb and var > 0 else None
    signed = [(c["ret"] if c["side"] == "bullish" else -c["ret"]) for c in sc]
    bulls = sum(1 for c in calls if c["side"] == "bullish")
    bull_share = bulls / len(calls) if calls else None
    g = grade(nb, edge, luck)
    per: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for c in sc:
        per[c["sym"]][0] += int(c["hit"]); per[c["sym"]][1] += 1
    tickers = sorted(({"sym": s, "n": v[1], "hit_rate": round(v[0] / v[1], 3)} for s, v in per.items()), key=lambda x: -x["n"])[:6]
    months: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for c in sc:
        months[c["entry_day"][:7]][0] += int(c["hit"]); months[c["entry_day"][:7]][1] += 1
    def receipt(c: dict[str, Any]) -> dict[str, Any]:
        txt = clean(c.get("body") or "", c["sym"], [c["sym"]]) if clean else None
        return {"sym": c["sym"], "side": c["side"], "at": c["at"], "entry_day": c.get("entry_day"), "exit_day": c.get("exit_day"),
                "ret": c.get("ret"), "hit": c.get("hit"), "h": c.get("h"), "text": (txt or "")[:180], "id": c.get("id")}
    return {
        "username": username, "name": meta.get("name") or username, "likes": meta.get("likes"), "id": meta.get("id"),
        "calls": len(calls), "scored": n, "hits": hits, "open": len(open_), "bets": nb, "bet_hits": bh,
        "hit_rate": round(hit_rate, 3) if n else None, "expected_rate": round(exp_rate, 3) if n else None, "edge_pts": edge, "luck": luck,
        "dist": {"mean": round(mean / nb, 4), "sd": round(math.sqrt(var) / nb, 4), "actual": round(bh / nb, 4)} if nb and var > 0 else None,
        "copy_avg": round(sum(signed) / n, 2) if n else None, "copy_total": round(sum(signed), 1) if n else None,
        "avg_win": round(sum(s for s in signed if s > 0) / max(1, sum(1 for s in signed if s > 0)), 2) if n else None,
        "avg_loss": round(sum(s for s in signed if s <= 0) / max(1, sum(1 for s in signed if s <= 0)), 2) if n else None,
        "bull_share": round(bull_share, 3) if bull_share is not None else None,
        "bias": "bullish" if bull_share is not None and bull_share >= BIAS else "bearish" if bull_share is not None and bull_share <= 1 - BIAS else None,
        "grade": {"key": g[0], "label": g[1], "say": g[2]},
        "tickers": tickers,
        "months": [{"m": m, "n": v[1], "hit_rate": round(v[0] / v[1], 3)} for m, v in sorted(months.items())][-12:],
        "receipts": [receipt(c) for c in sc[-14:]][::-1], "pending": [receipt(c) for c in open_[:5]],
        "first": sc[0]["entry_day"] if sc else None, "last": sc[-1]["entry_day"] if sc else None,
    }


def persistence(calls_by_user: dict[str, list[dict[str, Any]]], base: dict[str, list[int]], days: int = 90) -> dict[str, Any] | None:
    """Out-of-sample check: rank accounts on calls before a cut date, score the top 20 on calls after it."""
    cut = (date.today() - timedelta(days=days)).isoformat()
    rows = []
    for name, cs in calls_by_user.items():
        sc = [c for c in cs if c.get("status") == "scored"]
        tr, te = [c for c in sc if c["entry_day"] < cut], [c for c in sc if c["entry_day"] >= cut]
        if len(tr) >= MIN_N and len(te) >= 5:
            h = sum(c["hit"] for c in tr); n = len(tr); p = h / n; z = 1.64
            wl = (p + z * z / (2 * n) - z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)
            rows.append((wl, p, sum(c["hit"] for c in te), len(te)))
    if len(rows) < 40:
        return None
    rows.sort(key=lambda r: -r[0]); top, rest = rows[:20], rows[20:]
    return {"cut": cut, "accounts": len(rows),
            "top_before": round(sum(r[1] for r in top) / len(top), 3),
            "top_after": round(sum(r[2] for r in top) / sum(r[3] for r in top), 3),
            "rest_after": round(sum(r[2] for r in rest) / sum(r[3] for r in rest), 3)}


def write_store(path, users: dict[str, Any], calls_by_user: dict[str, list[dict[str, Any]]], clean=None) -> dict[str, Any]:
    """Saved by every ledger run: each account's calls (compact), the base rates, the index and the persistence check."""
    import json
    import time
    base = base_rates(calls_by_user)
    keep = ("sym", "side", "at", "entry_day", "exit_day", "ret", "hit", "status", "h", "id", "body")
    store_users, index = {}, []
    for name, cs in calls_by_user.items():
        if not cs:
            continue
        rec = users.get(name) or {}
        meta = {"name": rec.get("name"), "likes": rec.get("likes"), "id": rec.get("id")}
        store_users[name] = {"meta": meta, "calls": [{k: c.get(k) for k in keep} for c in cs if c.get("status") in ("scored", "open")]}
        r = report(name, meta, cs, base)
        if r["bets"] >= MIN_N:
            index.append({k: r[k] for k in ("username", "likes", "scored", "bets", "hit_rate", "edge_pts", "luck", "copy_avg", "bias")} | {"grade": r["grade"]["key"], "label": r["grade"]["label"], "last": r["last"]})
    rated = [x["hit_rate"] for x in index]
    out = {"as_of": time.time(), "base": base, "users": store_users, "index": index,
           "stats": {"accounts": len(store_users), "rated": len(index), "calls": sum(len(u["calls"]) for u in store_users.values()),
                     "median_hit": sorted(rated)[len(rated) // 2] if rated else None,
                     "grades": {k: sum(1 for x in index if x["grade"] == k) for k in ("edge", "maybe", "luck", "worse")},
                     "few": sum(1 for u in store_users if u not in {x["username"] for x in index})},
           "persistence": persistence(calls_by_user, base)}
    tmp = str(path) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, default=str)
    import os
    os.replace(tmp, path)
    return out
