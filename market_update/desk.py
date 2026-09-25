"""Trading desk: the open-source Agentic Trading Desk three-pillar framework
(Trend / Momentum / Macro, each -2..+2) run over OneView's universe with
OneView's own data. Information only: no broker, no orders.

Framework and maths: https://github.com/Oft3r/agentic-trading-desk (MIT, Oft3r),
vendored unmodified under `market_update.atd`.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from . import config, fetch
from . import atd

log = logging.getLogger(__name__)

MACRO_SYMBOLS = ["SPY", "RSP", "IWM", "HYG", "LQD", "TLT", "XLY", "XLP"]

# The framework's decision strings -> a short code for the ledger and plain words for the page.
DECISIONS: dict[str, dict[str, str]] = {
    "EXIT / TRIM": {"code": "exit_trim", "word": "TAKE PROFIT", "cls": "down",
                    "plain": "The buying has run out of steam. Someone holding it would sell part or all here and wait for the next dip to come back in."},
    "EXIT": {"code": "exit", "word": "EXIT", "cls": "down",
             "plain": "The selling is relentless. Someone holding it would get out and not add on the way down."},
    "RE-ENTRY (new cycle)": {"code": "re_entry", "word": "FRESH ENTRY", "cls": "up",
                             "plain": "It is bouncing and the longer-term structure is healthy: this is what the start of a new up-leg looks like. Confirm with a strong day and heavy trading before treating it as real."},
    "TACTICAL REBOUND (counter-trend)": {"code": "tactical_rebound", "word": "QUICK BOUNCE ONLY", "cls": "caution",
                                         "plain": "It is bouncing inside a downtrend. A quick trade at best: small, with a close target, and out fast if the bounce stalls."},
    "HOLD (ride the cycle)": {"code": "hold_ride", "word": "HOLD", "cls": "up",
                              "plain": "Trend and momentum are both positive. Someone holding it would stay in and watch for the buying to tire, not add more."},
    "HOLD (under review)": {"code": "hold_review", "word": "HOLD, WATCH CLOSELY", "cls": "caution",
                            "plain": "Structure and momentum are weak but there is no full exit signal yet. Do not add; be ready to leave if more warning signs appear."},
    "WAIT (do not chase)": {"code": "wait", "word": "WAIT, DO NOT CHASE", "cls": "flat",
                            "plain": "The trend is healthy but there is no fresh trigger. Buying mid-move is chasing; wait for a pullback to the 20-day line and a turn back up."},
    "STAY OUT / AVOID": {"code": "stay_out", "word": "STAY OUT", "cls": "down",
                         "plain": "Structure and momentum are negative and nothing is turning yet. The next thing to wait for is a real bounce."},
    "HOLD / OBSERVE": {"code": "observe", "word": "NO ACTION", "cls": "flat", "plain": "Mixed signals. Nothing to do; look again after the next close."},
    "OBSERVE": {"code": "observe", "word": "NO ACTION", "cls": "flat", "plain": "Mixed signals. Nothing to do; look again after the next close."},
}

PILLAR_WORDS = {2: "strong", 1: "positive", 0: "neutral", -1: "weak", -2: "negative"}


def _stats(frame, spy_closes: list[float]) -> dict[str, Any]:
    """What a desk looks at beside the score: relative strength against SPY, volume against normal,
    money traded per day, distance from the 52-week high, stretch above the 20-day line."""
    out: dict[str, Any] = {}
    if frame is None or "Close" not in frame:
        return out
    close = [float(x) for x in frame["Close"].dropna().tolist()]
    vol = [float(x) for x in frame["Volume"].fillna(0).tolist()] if "Volume" in frame else []
    high = [float(x) for x in frame["High"].dropna().tolist()] if "High" in frame else close
    def ret(series, n):
        return (series[-1] / series[-1 - n] - 1) * 100 if len(series) > n and series[-1 - n] else None
    r1, r3 = ret(close, 21), ret(close, 63)
    s1, s3 = ret(spy_closes, 21), ret(spy_closes, 63)
    out["ret_1m"] = round(r1, 1) if r1 is not None else None
    out["ret_3m"] = round(r3, 1) if r3 is not None else None
    out["rel_1m"] = round(r1 - s1, 1) if r1 is not None and s1 is not None else None
    out["rel_3m"] = round(r3 - s3, 1) if r3 is not None and s3 is not None else None
    if len(vol) >= 22 and sum(vol[-21:-1]) > 0:
        out["vol_ratio"] = round(vol[-1] / (sum(vol[-21:-1]) / 20), 2)
    if len(vol) >= 21 and len(close) >= 21:
        out["dollar_vol"] = round(sum(c * v for c, v in zip(close[-20:], vol[-20:])) / 20)
    if high:
        hi = max(high[-252:])
        out["pct_from_hi52"] = round((close[-1] / hi - 1) * 100, 1) if hi else None
    return out


def _closes(frame) -> list[float]:
    if frame is None or "Close" not in frame:
        return []
    return [float(x) for x in frame["Close"].dropna().tolist()]


def _macro(series: dict[str, list[float]], report: dict[str, Any]) -> dict[str, Any] | None:
    spread_hist = ((((report.get("rates") or {}).get("spreads") or {}).get("2s10s") or {}).get("history") or [])
    spread = [x["v"] / 100.0 for x in spread_hist if isinstance(x.get("v"), (int, float))][-60:]   # bp -> percentage points
    data = {"as_of": datetime.now(tz=config.ET).date().isoformat(), "series": {k: v for k, v in series.items() if v}}
    if spread:
        data["yield_spread"] = spread
    try:
        r = atd.score_macro(data)
    except Exception as e:  # noqa: BLE001
        log.warning("macro pillar failed: %s", e)
        return None
    comps = []
    for c in r.components:
        comps.append({"name": c["name"], "ratio": c["ratio"], "weight": c["weight"], "signal": c["signal"], "detail": c["detail"], "available": c["available"]})
    words = {"Broadening": "More stocks are joining the move: healthy, broad participation.",
             "Concentration": "A few big names carry the market while the rest lag: fragile leadership.",
             "Contraction": "Credit and breadth are weakening together: risk is being taken off.",
             "Inflationary": "Stocks and bonds are falling together: inflation worry, nowhere to hide.",
             "Transitional": "No clear regime: the signals disagree."}
    return {"as_of": r.as_of, "composite": r.composite, "regime": r.regime, "regime_plain": words.get(r.regime, ""), "pillar": r.pillar_score,
            "label": r.pillar_label, "inflationary": r.inflationary_flag, "spy_tlt_corr": r.spy_tlt_corr, "components": comps, "notes": r.notes}


def _card(sym: str, closes: list[float], macro_score: int | None, meta: dict[str, Any]) -> dict[str, Any] | None:
    if len(closes) < 60:
        return None
    try:
        ind = atd.compute_indicators(closes)
        t, td = atd.score_trend(ind)
        m, md = atd.score_momentum(ind)
        flat_d = atd.decide(ind, t, m, macro_score, False)
        held_d = atd.decide(ind, t, m, macro_score, True)
    except Exception as e:  # noqa: BLE001
        log.warning("desk score failed for %s: %s", sym, e)
        return None
    def dec(d: dict[str, Any]) -> dict[str, Any]:
        w = DECISIONS.get(d["action"]) or {"code": "observe", "word": d["action"], "cls": "flat", "plain": d["rationale"]}
        return {"action": d["action"], **w, "rationale": d["rationale"], "framing": d["framing"]}
    f = flat_d["flags"]
    rnd = lambda v: round(v, 4) if isinstance(v, float) else v
    return {
        "ticker": sym, "name": meta.get("name") or sym, "kind": meta.get("kind") or "Stock", "source": meta.get("source") or "yahoo",
        "price": closes[-1], "n_bars": ind["n_bars"], "warning": ind["warning"],
        "trend": {"score": t, "detail": td, "word": PILLAR_WORDS.get(t, "")},
        "momentum": {"score": m, "detail": md, "word": PILLAR_WORDS.get(m, "")},
        "macro": macro_score, "total": t + m + (macro_score if macro_score is not None else 0),
        "flat": dec(flat_d), "holding": dec(held_d),
        "flags": {"exhaustion": f["exhaustion"], "bearish": f["bearish"], "rebound": f["rebound"], "death_cross": f["death_cross"], "stretch_pct": f["stretch_pct"]},
        "indicators": {k: rnd(ind.get(k)) for k in ("ema20", "ema50", "ema200", "rsi14", "macd_hist", "trix", "trix_signal", "percent_b", "bb_upper", "bb_lower", "bars_since_below_ema20")},
    }


def build_desk(report: dict[str, Any], extra: list[str] | None = None) -> dict[str, Any]:
    """One pass over the whole universe: macro pillar once, then a card per symbol."""
    from . import db
    lite = report.get("lite") or {}
    universe = list(dict.fromkeys(
        list(config.INDEX_ETFS) + list(config.SECTOR_ETFS) + [s["ticker"] for s in report.get("stocks", [])]
        + [t for t in lite] + list(extra or []) + [t.upper() for t in db.all_watchlist_tickers()]
    ))
    universe = [t for t in universe if t and not t.startswith("^") and "=" not in t and "-" not in t]
    symbols = list(dict.fromkeys(MACRO_SYMBOLS + universe))
    hist = fetch.download(symbols, period="2y", interval="1d", prepost=False)
    series = {s: _closes(fetch.frame_for(hist, s)) for s in symbols}
    macro = _macro({s: series[s] for s in MACRO_SYMBOLS}, report)
    macro_score = macro["pillar"] if macro else None
    names = {s["ticker"]: {"name": s.get("name"), "kind": s.get("kind")} for s in report.get("stocks", [])}
    for t, q in lite.items():
        names.setdefault(t, {"name": q.get("name"), "kind": q.get("kind")})
    for t, n in config.INDEX_ETFS.items():
        names.setdefault(t, {"name": n, "kind": "ETF"})
    for t, n in config.SECTOR_ETFS.items():
        names.setdefault(t, {"name": n, "kind": "ETF"})
    cards = []
    spy_closes = series.get("SPY") or []
    earnings = {st["ticker"]: (st.get("fundamentals") or {}).get("days_to_earnings") for st in report.get("stocks") or []}
    for sym in universe:
        c = _card(sym, series.get(sym) or [], macro_score, names.get(sym) or {})
        if c:
            c["stats"] = _stats(fetch.frame_for(hist, sym), spy_closes)
            if isinstance(earnings.get(sym), int):
                c["stats"]["days_to_earnings"] = earnings[sym]
            cards.append(c)
    order = {"re_entry": 0, "tactical_rebound": 1, "hold_ride": 2, "wait": 3, "observe": 4, "hold_review": 5, "exit_trim": 6, "stay_out": 7, "exit": 8}
    cards.sort(key=lambda c: (order.get(c["flat"]["code"], 9), -c["total"], c["ticker"]))
    counts: dict[str, int] = {}
    for c in cards:
        counts[c["flat"]["code"]] = counts.get(c["flat"]["code"], 0) + 1
    return {"generated_at": datetime.now(tz=config.ET).isoformat(), "macro": macro, "cards": cards, "counts": counts,
            "index": [t for t in config.INDEX_ETFS], "sectors": [t for t in config.SECTOR_ETFS],
            "source": {"name": "Agentic Trading Desk", "url": "https://github.com/Oft3r/agentic-trading-desk", "license": "MIT", "author": "Oft3r"},
            "how": ("Each name gets three scores from -2 to +2. Trend: price against its 20-, 50- and 200-day lines and the slope of the 200-day. "
                    "Momentum: RSI, the MACD histogram and TRIX. Macro: one score for the whole market from six cross-asset ratios. "
                    "The decision follows the framework's fixed rules for a short-term rotation style: enter on a bounce, ride, take profit when the buying tires, wait for the next trigger. "
                    "Daily bars include today's session so far. Information, not advice; no orders are placed by OneView.")}


def rescore(desk: dict[str, Any], pulled: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-score the names in `pulled` ({sym: {closes, source, as_of}}) with the desk's current macro score and
    swap the new cards into the desk in place. Returns the new cards."""
    macro_score = (desk.get("macro") or {}).get("pillar")
    by = {c["ticker"]: c for c in desk.get("cards") or []}
    out = []
    for sym, v in pulled.items():
        old = by.get(sym) or {}
        meta = {"name": old.get("name"), "kind": old.get("kind"), "source": v.get("source") or "tradingview"}
        c = _card(sym, v.get("closes") or [], macro_score, meta)
        if not c:
            continue
        c["as_of"] = v.get("as_of")
        for k in ("stats", "sector", "index", "bucket", "market_cap"):
            if old.get(k) is not None:
                c[k] = old[k]
        out.append(c)
        if desk.get("cards") is not None:
            if sym in by:
                desk["cards"][desk["cards"].index(by[sym])] = c
            else:
                desk["cards"].append(c)
    return out


# Names above roughly $200B when the market-cap cache has no figure (refreshed by hand; the cache wins when present).
MEGA_CAPS = {"AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO", "BRK-B", "LLY", "JPM", "WMT", "V", "MA", "XOM", "UNH", "ORCL",
             "COST", "NFLX", "JNJ", "HD", "PG", "ABBV", "BAC", "CVX", "KO", "AMD", "CRM", "TMUS", "CSCO", "PM", "WFC", "MRK", "ABT", "LIN", "MCD",
             "PEP", "IBM", "GE", "ACN", "MS", "GS", "ISRG", "AXP", "NOW", "TMO", "DIS", "QCOM", "INTU", "CAT", "TXN", "VZ", "BKNG", "ADBE", "AMGN",
             "RTX", "PLTR", "UBER", "T", "SPGI", "PFE", "MU", "INTC", "ANET", "APP", "GEV", "LRCX", "AMAT", "KLAC", "BLK", "NEE", "LOW", "PGR", "HON"}


def _cap_bucket(sym: str, index: str, caps: dict[str, float]) -> str:
    cap = caps.get(sym)
    if isinstance(cap, (int, float)) and cap > 0:
        return "mega" if cap >= 2e11 else "large" if cap >= 1e10 else "mid"
    if sym in MEGA_CAPS:
        return "mega"
    return "large" if index == "sp500" else "mid"


def scan_mid_to_mega(report: dict[str, Any]) -> dict[str, Any]:
    """Score every S&P 500 and S&P 400 name with the three-pillar framework and keep the strong ones:
    trend and momentum both positive and a total of +3 or better out of +6."""
    members = fetch.fetch_index_members()
    syms = list(dict.fromkeys(m["symbol"] for m in members))
    meta = {m["symbol"]: m for m in members}
    hist = fetch.download(list(dict.fromkeys(MACRO_SYMBOLS + syms)), period="2y", interval="1d", prepost=False)
    series = {s: _closes(fetch.frame_for(hist, s)) for s in list(dict.fromkeys(MACRO_SYMBOLS + syms))}
    macro = _macro({s: series[s] for s in MACRO_SYMBOLS}, report)
    macro_score = macro["pillar"] if macro else None
    caps: dict[str, float] = {}
    for t, q in (report.get("lite") or {}).items():
        mc = ((q.get("fundamentals") or {}).get("market_cap"))
        if isinstance(mc, (int, float)):
            caps[t] = float(mc)
    for st in report.get("stocks") or []:
        mc = (st.get("fundamentals") or {}).get("market_cap")
        if isinstance(mc, (int, float)):
            caps[st["ticker"]] = float(mc)
    try:
        store = fetch._cache_get("info_last_good", -1) or {}
        for t, v in store.items():
            mc = (v.get("data") or v).get("market_cap") if isinstance(v, dict) else None
            if isinstance(mc, (int, float)) and t not in caps:
                caps[t] = float(mc)
    except Exception:  # noqa: BLE001
        pass
    cards, usable = [], 0
    dist: dict[str, int] = {}
    for sym in syms:
        closes = series.get(sym) or []
        if len(closes) < 210:
            continue
        m = meta[sym]
        c = _card(sym, closes, macro_score, {"name": m["name"], "kind": "Stock"})
        if not c:
            continue
        usable += 1
        c["stats"] = _stats(fetch.frame_for(hist, sym), series.get("SPY") or [])
        c["sector"] = m.get("sector") or ""
        c["index"] = m["index"]
        c["bucket"] = _cap_bucket(sym, m["index"], caps)
        c["market_cap"] = caps.get(sym)
        dist[str(c["total"])] = dist.get(str(c["total"]), 0) + 1
        if c["trend"]["score"] >= 1 and c["momentum"]["score"] >= 1 and c["total"] >= 3:
            cards.append(c)
    cards.sort(key=lambda c: (-c["total"], -c["momentum"]["score"], -c["trend"]["score"], c["ticker"]))
    max_total = 4 + (macro_score if macro_score is not None else 0)
    by_read: dict[str, int] = {}
    by_bucket: dict[str, int] = {}
    by_sector: dict[str, int] = {}
    for c in cards:
        by_read[c["flat"]["code"]] = by_read.get(c["flat"]["code"], 0) + 1
        by_bucket[c["bucket"]] = by_bucket.get(c["bucket"], 0) + 1
        by_sector[c["sector"]] = by_sector.get(c["sector"], 0) + 1
    top_sectors = sorted(by_sector.items(), key=lambda x: -x[1])[:4]
    fresh = by_read.get("re_entry", 0); bounce = by_read.get("tactical_rebound", 0); wait = by_read.get("wait", 0)
    meaning = [
        f"{len(cards)} of {usable} mid-, large- and mega-cap names have both a positive trend score and a positive momentum score with a total of +3 or better. The best possible total today is {max_total:+d}, because the shared macro score is {macro_score:+d}." if macro_score is not None else
        f"{len(cards)} of {usable} names have a positive trend and momentum score with a total of +3 or better (macro score unavailable).",
        f"{wait} of them read 'wait, do not chase': the trend is healthy but the move is already under way, so the framework wants a pullback to the 20-day line before treating it as an entry." if wait else "",
        f"{fresh} show a fresh-entry trigger (a bounce with the longer-term structure intact) and {bounce} a quick-bounce-only read inside a downtrend." if (fresh or bounce) else "No name in the strong group shows a fresh-entry trigger right now: strength is established, not just starting.",
        ("Strength is concentrated in " + ", ".join(f"{k} ({v})" for k, v in top_sectors) + ".") if top_sectors else "",
        "A high total means the trend and momentum maths agree, not that the stock will keep going: the same framework flags 'exhaustion' when a strong name stretches too far. Information, not advice.",
    ]
    return {"generated_at": datetime.now(tz=config.ET).isoformat(), "scanned": len(syms), "usable": usable, "macro": macro, "max_total": max_total,
            "strong": cards[:120], "strong_total": len(cards), "distribution": dist, "by_read": by_read, "by_bucket": by_bucket, "by_sector": dict(top_sectors),
            "meaning": [x for x in meaning if x], "universe": "S&P 500 (large and mega caps) plus S&P 400 (mid caps), members from Wikipedia, refreshed weekly",
            "criteria": "trend score >= +1, momentum score >= +1, total >= +3 (out of +6)"}
