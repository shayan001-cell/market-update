"""Big options bets, live: the largest single trades and sweeps of the day from Alpaca's options data.

Every 10 minutes in the session:
  1. Option-chain snapshots for the watched names (expiries within 45 days, strikes within 15% of price) give each
     contract's dollar volume today; the most active contracts are kept.
  2. Their trades since the last run are read. A print of at least MIN_PREMIUM in premium is a big bet; prints in
     the same contract within SWEEP_MS on two or more exchanges are one sweep (an order split to fill fast).
  3. Who started it is inferred: Alpaca has no historical bid/ask, so a print is "likely bought" when it traded
     above the previous print in that contract (the tick test) and "likely sold" when below; a print within a
     minute of the latest quote is checked against the bid and ask instead. Equal prices carry the last side.
  4. Calls bought and puts sold lean bullish; puts bought and calls sold lean bearish.
Each name's net lean at the close is logged to the verdict ledger as kind "flow" and scored five sessions later,
so the page can say whether the flow has actually led the price.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests

from . import config, fetch

log = logging.getLogger(__name__)

BASE = "https://data.alpaca.markets/v1beta1/options"
CORE = ["SPY", "QQQ", "IWM", "NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "AMD", "GOOGL", "AVGO", "PLTR", "COIN",
        "NFLX", "MSTR", "SMCI", "MU", "ARM", "HOOD"]
INDEX = {"SPY", "QQQ", "IWM", "DIA"}
MIN_PREMIUM = 100_000            # single names; index ETFs need INDEX_MIN_PREMIUM
INDEX_MIN_PREMIUM = 250_000
SWEEP_MS = 150
PER_NAME = 10                    # most active contracts kept per name
MAX_CONTRACTS = 100              # one trades request covers up to 100 contracts
DAY_DIR = config.OUTPUT_DIR / "bigbets"


def creds() -> dict[str, str] | None:
    k = os.environ.get("ALPACA_API_KEY") or os.environ.get("APCA_API_KEY_ID")
    s = os.environ.get("ALPACA_SECRET_KEY") or os.environ.get("APCA_API_SECRET_KEY")
    return {"APCA-API-KEY-ID": k, "APCA-API-SECRET-KEY": s} if k and s else None


def _get(path: str, params: dict[str, Any], h: dict[str, str]) -> dict[str, Any]:
    for attempt in range(3):
        r = requests.get(f"{BASE}{path}", params=params, headers=h, timeout=30)
        if r.status_code == 429:
            time.sleep(3 + attempt * 5); continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()
    return {}


def _parse(sym: str) -> dict[str, Any]:
    """OCC symbol, e.g. NVDA261120C00240000 -> underlying, expiry, type, strike."""
    i = next(k for k in range(len(sym)) if sym[k].isdigit())
    und, rest = sym[:i], sym[i:]
    exp = date(2000 + int(rest[0:2]), int(rest[2:4]), int(rest[4:6]))
    return {"und": und, "exp": exp.isoformat(), "type": "call" if rest[6] == "C" else "put", "strike": int(rest[7:]) / 1000}


def _day_path(d: str):
    DAY_DIR.mkdir(parents=True, exist_ok=True)
    return DAY_DIR / f"{d}.json"


def load_day(d: str) -> dict[str, Any]:
    try:
        return json.loads(_day_path(d).read_text())
    except Exception:  # noqa: BLE001
        return {"date": d, "bets": [], "since": None, "last_px": {}, "last_side": {}}


def run(names: list[str], spots: dict[str, float], feed: str | None = None) -> dict[str, Any]:
    h = creds()
    if not h:
        return {"status": "no_keys"}
    t0 = time.time()
    now = datetime.now(timezone.utc)
    today = fetch.now_et().date().isoformat()
    day = load_day(today)
    feed = feed or day.get("feed") or "opra"
    exp_lte = (fetch.now_et().date() + timedelta(days=45)).isoformat()
    # 1. most active contracts per name today
    active: list[tuple[float, str, dict[str, Any]]] = []
    for u in names:
        spot = spots.get(u)
        params: dict[str, Any] = {"feed": feed, "limit": 1000, "expiration_date_lte": exp_lte}
        if spot:
            params.update(strike_price_gte=round(spot * 0.85, 2), strike_price_lte=round(spot * 1.15, 2))
        try:
            j = _get(f"/snapshots/{u}", params, h)
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 403 and feed == "opra":
                feed = "indicative"; params["feed"] = feed               # no OPRA plan: the free feed, delayed 15 minutes
                j = _get(f"/snapshots/{u}", params, h)
            else:
                log.warning("big bets snapshots %s: %s", u, e); continue
        rows = []
        for sym, snap in (j.get("snapshots") or {}).items():
            db_ = snap.get("dailyBar") or {}
            if db_.get("v") and db_.get("vw"):
                rows.append((db_["v"] * db_["vw"] * 100, sym, snap))
        rows.sort(reverse=True)
        active += rows[:PER_NAME]
    active.sort(reverse=True)
    pick = active[:MAX_CONTRACTS]
    quotes = {sym: snap.get("latestQuote") or {} for _, sym, snap in pick}
    # 2. their trades since the last run
    since = day.get("since") or (now - timedelta(hours=8)).isoformat()
    trades: dict[str, list[dict[str, Any]]] = {}
    token = None
    for _ in range(8):
        params = {"symbols": ",".join(s for _, s, _ in pick), "start": since, "limit": 10000, "sort": "asc"}
        if token:
            params["page_token"] = token
        try:
            j = _get("/trades", params, h)
        except Exception as e:  # noqa: BLE001
            log.warning("big bets trades: %s", e); break
        for sym, ts in (j.get("trades") or {}).items():
            trades.setdefault(sym, []).extend(ts)
        token = j.get("next_page_token")
        if not token:
            break
    # 3. big prints and sweeps, side by tick test (quote check near the latest quote)
    last_px, last_side = day.setdefault("last_px", {}), day.setdefault("last_side", {})
    seen = {b["id"] for b in day["bets"]}
    before = len(day["bets"])
    for sym, ts in trades.items():
        meta = _parse(sym)
        floor = INDEX_MIN_PREMIUM if meta["und"] in INDEX else MIN_PREMIUM
        q = quotes.get(sym) or {}
        qt = _ts(q["t"]) if q.get("t") else None
        group: list[dict[str, Any]] = []
        def flush(g: list[dict[str, Any]]) -> None:
            if not g:
                return
            prem = sum(x["p"] * x["s"] * 100 for x in g)
            if prem < floor:
                return
            side = g[0]["side"]
            bid = f"{sym}|{g[0]['t']}"
            if bid in seen:
                return
            spot = spots.get(meta["und"])
            dte = (date.fromisoformat(meta["exp"]) - fetch.now_et().date()).days
            otm = ((meta["strike"] / spot - 1) * 100 * (1 if meta["type"] == "call" else -1)) if spot else None
            lean = {("call", "bought"): "bullish", ("put", "sold"): "bullish", ("put", "bought"): "bearish", ("call", "sold"): "bearish"}.get((meta["type"], side), "unclear")
            day["bets"].append({"id": bid, "t": g[0]["t"], "contract": sym, **meta, "dte": dte, "size": sum(x["s"] for x in g),
                                "price": round(sum(x["p"] * x["s"] for x in g) / sum(x["s"] for x in g), 2), "premium": round(prem),
                                "side": side, "sweep": len({x["x"] for x in g}) >= 2 and len(g) >= 2, "legs": len(g),
                                "otm_pct": round(otm, 1) if otm is not None else None, "lean": lean, "spot": spot})
            seen.add(bid)
        for tr in ts:
            p = tr["p"]
            prev = last_px.get(sym)
            side = "bought" if prev is not None and p > prev else "sold" if prev is not None and p < prev else last_side.get(sym, "unclear")
            if qt and q.get("ap") and q.get("bp"):
                tt = _ts(tr["t"])
                if abs((tt - qt).total_seconds()) <= 60:
                    side = "bought" if p >= q["ap"] else "sold" if p <= q["bp"] else side
            last_px[sym] = p; last_side[sym] = side
            tr = {**tr, "side": side}
            if group and (_ms(tr["t"]) - _ms(group[-1]["t"]) > SWEEP_MS or tr["side"] != group[-1]["side"]):
                flush(group); group = []
            group.append(tr)
        flush(group)
    day["bets"].sort(key=lambda b: b["t"], reverse=True)
    day.update(since=now.isoformat(), feed=feed, updated=time.time(), names=names, contracts=len(pick))
    _day_path(today).write_text(json.dumps(day))
    return {"status": "ok", "feed": feed, "new": len(day["bets"]) - before, "elapsed_s": round(time.time() - t0, 1)}


def _ts(t: str) -> datetime:
    """RFC-3339 with up to nanoseconds ("2026-10-23T12:18:49.158584191Z") -> aware datetime."""
    t = t.rstrip("Z").split("+")[0]
    if "." in t:
        a, f = t.split("."); t = f"{a}.{(f + '000000')[:6]}"
    return datetime.fromisoformat(t).replace(tzinfo=timezone.utc)


def _ms(t: str) -> float:
    return _ts(t).timestamp() * 1000


def summary(d: str | None = None) -> dict[str, Any]:
    d = d or fetch.now_et().date().isoformat()
    day = load_day(d)
    if not day["bets"]:                              # weekend or before the first run: show the last session's tape
        files = sorted(DAY_DIR.glob("*.json")) if DAY_DIR.exists() else []
        for f in reversed(files):
            if f.stem < d:
                day = load_day(f.stem); break
    bets = day["bets"]
    names: dict[str, dict[str, Any]] = {}
    hits: dict[str, int] = {}
    for b in bets:
        n = names.setdefault(b["und"], {"und": b["und"], "bull": 0.0, "bear": 0.0, "unclear": 0.0, "n": 0, "sweeps": 0, "calls": 0.0, "puts": 0.0})
        n[{"bullish": "bull", "bearish": "bear"}.get(b["lean"], "unclear")] += b["premium"]
        n["n"] += 1; n["sweeps"] += int(b["sweep"]); n["calls" if b["type"] == "call" else "puts"] += b["premium"]
        hits[b["contract"]] = hits.get(b["contract"], 0) + 1
    for n in names.values():
        tot = n["bull"] + n["bear"]
        n["net"] = n["bull"] - n["bear"]
        n["tilt"] = round(n["bull"] / tot, 3) if tot else None
    rows = sorted(names.values(), key=lambda n: -(n["bull"] + n["bear"] + n["unclear"]))
    repeat = sorted(({"contract": c, "hits": k, **_parse(c)} for c, k in hits.items() if k >= 3), key=lambda x: -x["hits"])[:12]
    tot = {"premium": sum(b["premium"] for b in bets), "bull": sum(b["premium"] for b in bets if b["lean"] == "bullish"),
           "bear": sum(b["premium"] for b in bets if b["lean"] == "bearish"), "bets": len(bets), "sweeps": sum(1 for b in bets if b["sweep"])}
    return {"date": day["date"], "feed": day.get("feed"), "updated": day.get("updated"), "totals": tot, "names": rows, "repeat": repeat, "bets": bets[:400]}


def ledger_rows(day: dict[str, Any], prices: dict[str, float], build_id: str) -> list[dict[str, Any]]:
    """Each name's net lean for the day, for the verdict ledger (kind "flow"): needs $1M of leaning premium and a
    two-to-one split, otherwise no call is logged."""
    out = []
    for n in summary(day["date"])["names"]:
        tot = n["bull"] + n["bear"]
        if tot >= 1_000_000 and n["tilt"] is not None and (n["tilt"] >= 0.67 or n["tilt"] <= 0.33) and prices.get(n["und"]):
            out.append({"ticker": n["und"], "kind": "flow", "verdict": "flow_bullish" if n["tilt"] >= 0.67 else "flow_bearish", "price": prices[n["und"]], "build_id": build_id})
    return out
