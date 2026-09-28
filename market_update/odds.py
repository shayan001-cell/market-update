"""Betting-market odds: what people with real money on the line expect.

Two public, key-free sources:
  * Polymarket (gamma-api.polymarket.com): the Fed decision, recession, S&P 500 targets, and per-stock markets
    ("Up or Down on <day>", "close above ___ end of <month>", "What will X hit in <month>").
  * Kalshi (api.elections.kalshi.com): the S&P 500 and Nasdaq-100 closing-range markets for the next dates.

Everything returned is a probability read straight off the market (the Yes price), plus the money traded,
so the page can say how much weight a number deserves. Thin markets are flagged, never hidden.
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

import requests

log = logging.getLogger(__name__)

PM = "https://gamma-api.polymarket.com"
KS = "https://api.elections.kalshi.com/trade-api/v2"
HEAD = {"User-Agent": "OneView/1.0 (market dashboard)"}
THIN_USD = 1000          # under this much traded, a price is one or two people's opinion
# Polymarket names indexes by the index, not the fund: the ladders only make sense on the same instrument
ALIASES = {"SPY": ["SPY", "SPX"], "QQQ": ["QQQ", "NDX"], "DIA": ["DJIA"], "IWM": ["RUT"]}
SAME_SCALE = {"SPY": "SPY", "QQQ": "QQQ"}          # funds whose own ladders exist at the fund's price


def _get(url: str, params: dict[str, Any] | None = None, tries: int = 2) -> Any:
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=HEAD, timeout=15)
            if r.status_code == 429:
                time.sleep(1.5 * (i + 1)); continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            log.info("odds fetch retry %s: %s", url, e)
            time.sleep(0.8)
    return None


def _f(x: Any) -> float | None:
    try:
        v = float(x)
        return v if v == v else None
    except (TypeError, ValueError):
        return None


def _prices(m: dict[str, Any]) -> list[float]:
    try:
        return [float(p) for p in json.loads(m.get("outcomePrices") or "[]")]
    except Exception:  # noqa: BLE001
        return []


def _end(e: dict[str, Any]) -> float:
    try:
        return datetime.fromisoformat(str(e.get("endDate")).replace("Z", "+00:00")).timestamp()
    except Exception:  # noqa: BLE001
        return 0.0


def pm_search(q: str, n: int = 12) -> list[dict[str, Any]]:
    """Active Polymarket events matching q, with only their still-open markets, soonest first."""
    j = _get(f"{PM}/public-search", {"q": q, "events_status": "active", "limit_per_type": n}) or {}
    now = time.time()
    out = []
    for e in j.get("events") or []:
        if e.get("closed") or _end(e) < now:
            continue
        ms = [m for m in (e.get("markets") or []) if not m.get("closed")]
        if not ms:
            continue
        out.append({"title": e.get("title") or "", "slug": e.get("slug"), "end": e.get("endDate"), "end_ts": _end(e),
                    "volume": _f(e.get("volume")) or 0.0, "markets": ms})
    return sorted(out, key=lambda x: x["end_ts"])


def _url(slug: str | None) -> str | None:
    return f"https://polymarket.com/event/{slug}" if slug else None


def _strike(label: str) -> float | None:
    m = re.search(r"\$?\s*([\d,]+(?:\.\d+)?)", label or "")
    return float(m.group(1).replace(",", "")) if m else None


def _ladder(points: list[tuple[float, float]], spot: float | None) -> dict[str, Any] | None:
    """(strike, P(close above strike)) -> a clean falling curve, the chance of closing above today's price,
    and the implied middle (the strike where the chance crosses 50%)."""
    pts = sorted((k, p) for k, p in points if k and p is not None)
    if len(pts) < 3:
        return None
    clean, run = [], 1.0
    for k, p in pts:                              # thin books wobble: P(above) can only fall as the strike rises
        run = min(run, max(0.0, min(1.0, p)))
        clean.append((k, run))

    def interp(x: float) -> float:
        if x <= clean[0][0]:
            return clean[0][1]
        if x >= clean[-1][0]:
            return clean[-1][1]
        for (k1, p1), (k2, p2) in zip(clean, clean[1:]):
            if k1 <= x <= k2:
                return p1 + (p2 - p1) * (x - k1) / (k2 - k1 or 1)
        return clean[-1][1]

    mid = None
    for (k1, p1), (k2, p2) in zip(clean, clean[1:]):
        if p1 >= 0.5 >= p2 and p1 != p2:
            mid = k1 + (k2 - k1) * (p1 - 0.5) / (p1 - p2); break
    return {"points": [{"k": k, "p": round(p, 4)} for k, p in clean], "p_above_spot": round(interp(spot), 4) if spot else None,
            "median": round(mid, 2) if mid else None}


def _dated(title: str) -> str:
    m = re.search(r"(on|end of|in|week of)\s+([A-Z][a-z]+(?:\s+\d{1,2}(?!\d))?(?:\s+\d{4})?)", title)
    return m.group(0) if m else ""


NAME_HINTS = {"GOOGL": ["alphabet", "google"], "GOOG": ["alphabet", "google"], "BRK-B": ["berkshire"], "META": ["meta"], "SPY": ["spy", "s&p"], "QQQ": ["nasdaq", "qqq"], "DIA": ["dow"], "IWM": ["russell"]}
_STOP = {"the", "inc", "corp", "corporation", "company", "co", "holdings", "group", "ltd", "plc", "class", "com", "technologies", "platforms"}


def _name_words(sym: str, name: str | None) -> list[str]:
    if sym in NAME_HINTS:
        return NAME_HINTS[sym]
    words = [w for w in re.split(r"[^a-z0-9&]+", (name or "").lower()) if len(w) > 2 and w not in _STOP]
    return words[:1]


def ticker_odds(sym: str, spot: float | None, name: str | None = None) -> dict[str, Any]:
    """Polymarket's per-ticker markets for one symbol: next-session up or down, the month-end 'close above'
    ladder, and the month's 'will it hit' ladder (nearest strike above and below today's price).
    A market counts only when its title carries the ticker in brackets AND the company's name, so NovaGold (NG)
    never picks up a natural-gas (NG) market. Without a known name, only the bracket rule applies."""
    sym = sym.upper()
    names = ALIASES.get(sym, [sym])
    must = _name_words(sym, name)
    evs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for n in names:
        for e in pm_search(n, 14):
            t = e["title"].lower()
            if f"({n})" in e["title"] and e["slug"] not in seen and (not must or any(w in t for w in must)):
                seen.add(e["slug"]); e["alias"] = n; evs.append(e)
    out: dict[str, Any] = {"symbol": sym, "as_of": time.time(), "spot": spot}
    ud = [e for e in evs if "Up or Down on" in e["title"] and "Opens" not in e["title"]]
    if ud:
        e = ud[0]; m = e["markets"][0]
        outs = json.loads(m.get("outcomes") or "[]"); pr = _prices(m)
        if outs and pr and "Up" in outs:
            out["updown"] = {"p_up": pr[outs.index("Up")], "when": _dated(e["title"]).replace("on ", ""), "volume": e["volume"], "url": _url(e["slug"]), "title": e["title"]}
    same = SAME_SCALE.get(sym) == sym or sym not in ALIASES
    if same:
        ab = [e for e in evs if re.search(r"close above ___ end of", e["title"]) and e.get("alias") == sym]
        if ab:
            e = max(ab[:2], key=lambda x: x["volume"])      # this month's or next month's, whichever has more money in it
            lad = _ladder([(_strike(m.get("groupItemTitle") or ""), (_prices(m) or [None])[0]) for m in e["markets"]], spot)
            if lad:
                out["above"] = {**lad, "when": _dated(e["title"]).replace("end of ", "end of "), "volume": e["volume"], "url": _url(e["slug"]), "title": e["title"]}
        hit = [e for e in evs if re.search(r"hit in [A-Z][a-z]+ \d{4}", e["title"]) and e.get("alias") == sym]
        if hit and spot:
            e = hit[0]
            ups, dns = [], []
            for m in e["markets"]:
                lbl = m.get("groupItemTitle") or ""; k = _strike(lbl); p = (_prices(m) or [None])[0]
                if k is None or p is None:
                    continue
                (ups if "↑" in lbl else dns if "↓" in lbl else []).append((k, p))
            up = min([x for x in ups if x[0] > spot], default=None, key=lambda x: x[0])
            dn = max([x for x in dns if x[0] < spot], default=None, key=lambda x: x[0])
            if up or dn:
                out["hit"] = {"up": {"k": up[0], "p": up[1]} if up else None, "down": {"k": dn[0], "p": dn[1]} if dn else None,
                              "when": _dated(e["title"]).replace("in ", ""), "volume": e["volume"], "url": _url(e["slug"]), "title": e["title"]}
    # any other market on the name (earnings beats, market-cap races, all-time highs): the three with the most money
    used = {"Up or Down on", "close above ___ end of", "hit in", "hit Week of", "closes above ___ on", "closes week of", "finish week of", "Opens Up or Down"}
    others = []
    for e in evs:
        if any(u in e["title"] for u in used):
            continue
        ms = e["markets"]
        m = ms[0] if len(ms) == 1 else max(ms, key=lambda x: _f(x.get("volume")) or 0.0)
        pr = _prices(m)
        if not pr:
            continue
        others.append({"title": e["title"], "label": (m.get("groupItemTitle") or "") if len(ms) > 1 else "", "p": pr[0], "volume": e["volume"], "url": _url(e["slug"]), "end": e["end"]})
    if others:
        out["other"] = sorted(others, key=lambda x: -x["volume"])[:3]
    out["markets"] = len(evs)
    return out


def _kalshi_close(series: str, spot: float | None) -> dict[str, Any] | None:
    """Kalshi's above/below ladder for the next 4pm close (KXINXU for the S&P 500, KXNASDAQ100U for the Nasdaq-100).
    Each market is 'above this level at 4pm?'; the mid of bid and ask is used only where the spread is tight enough
    to mean something, otherwise the last trade. The range markets (KXINX) are skipped: they rarely trade."""
    evs = (_get(f"{KS}/events", {"series_ticker": series, "status": "open", "limit": 60}) or {}).get("events") or []
    if not evs:
        return None
    evs.sort(key=lambda e: e.get("strike_date") or "")
    day = (evs[0].get("strike_date") or "")[:10]
    same_day = [e for e in evs if (e.get("strike_date") or "").startswith(day)]
    ev = next((e for e in same_day if "4pm" in (e.get("sub_title") or "")), same_day[-1])
    ms = (_get(f"{KS}/markets", {"event_ticker": ev["event_ticker"], "limit": 200}) or {}).get("markets") or []
    pts, vol, quoted = [], 0.0, 0
    for m in ms:
        if m.get("strike_type") not in ("greater", "greater_or_equal"):
            continue
        k = _f(m.get("floor_strike"))
        bid, ask, last = _f(m.get("yes_bid_dollars")) or 0.0, _f(m.get("yes_ask_dollars")), _f(m.get("last_price_dollars")) or 0.0
        vol += _f(m.get("volume_fp")) or 0.0
        if ask is not None and ask - bid <= 0.15 and (bid > 0 or ask < 1):
            p = (bid + ask) / 2; quoted += 1
        elif last > 0:
            p = last
        else:
            continue
        pts.append((k, p))
    lad = _ladder(pts, spot)
    if not lad:
        return None
    return {**lad, "title": ev.get("title"), "when": ev.get("sub_title"), "volume": vol, "quoted": quoted, "spot": spot,
            "url": f"https://kalshi.com/markets/{series.lower()}"}


def _choice_event(q: str, starts: str) -> dict[str, Any] | None:
    evs = [e for e in pm_search(q, 10) if e["title"].startswith(starts)]
    if not evs:
        return None
    e = evs[0]
    opts = []
    for m in e["markets"]:
        pr = _prices(m)
        if pr:
            opts.append({"label": m.get("groupItemTitle") or m.get("question"), "p": pr[0], "volume": _f(m.get("volume")) or 0.0})
    opts.sort(key=lambda o: -o["p"])
    return {"title": e["title"], "volume": e["volume"], "end": e["end"], "options": opts, "url": _url(e["slug"])}


def _yes_event(q: str, starts: str) -> dict[str, Any] | None:
    evs = [e for e in pm_search(q, 10) if e["title"].startswith(starts)]
    if not evs:
        return None
    e = evs[0]; pr = _prices(e["markets"][0])
    return {"title": e["title"], "p": pr[0] if pr else None, "volume": e["volume"], "end": e["end"], "url": _url(e["slug"])} if pr else None


def market_odds(spots: dict[str, float | None]) -> dict[str, Any]:
    """The market-wide picture: the next Fed decision, recession odds, and the S&P 500 and Nasdaq-100 next closes."""
    out: dict[str, Any] = {"as_of": time.time()}
    jobs = {
        "fed": lambda: _choice_event("Fed Decision", "Fed Decision in"),
        "recession": lambda: _yes_event("US recession", "US recession by end of"),
        "spx_close": lambda: _kalshi_close("KXINXU", spots.get("^GSPC")),
        "ndx_close": lambda: _kalshi_close("KXNASDAQ100U", spots.get("^NDX")),
        "spx_year": lambda: _spx_hit(spots.get("^GSPC")),
    }
    for k, fn in jobs.items():
        try:
            v = fn()
            if v:
                out[k] = v
        except Exception as e:  # noqa: BLE001
            log.warning("odds %s: %s", k, e)
    return out


def _spx_hit(spot: float | None) -> dict[str, Any] | None:
    evs = [e for e in pm_search("S&P 500 SPX hit", 10) if "(SPX) hit by end of" in e["title"]]
    if not evs or not spot:
        return None
    e = max(evs, key=lambda x: x["volume"])
    ups, dns = [], []
    for m in e["markets"]:
        lbl = m.get("groupItemTitle") or ""; k = _strike(lbl); p = (_prices(m) or [None])[0]
        if k is None or p is None:
            continue
        (ups if "↑" in lbl else dns if "↓" in lbl else []).append({"k": k, "p": p})
    ups = sorted([x for x in ups if x["k"] > spot], key=lambda x: x["k"])[:3]
    dns = sorted([x for x in dns if x["k"] < spot], key=lambda x: -x["k"])[:3]
    return {"title": e["title"], "volume": e["volume"], "url": _url(e["slug"]), "up": ups, "down": dns, "spot": spot}
