"""Orchestration: fetch -> technicals -> TypeSafe judgments -> report dict.

The report is plain JSON-able data consumed by static/app.js.
"""
from __future__ import annotations

import asyncio

import logging
import time
import uuid
from datetime import datetime, timedelta
from typing import Any

import pandas as pd

from typesafe_sdk import AsyncTypeSafeClient, TypeSafeError

from . import config, fetch, technicals as T
from . import judgments as J
from . import rules as R
from . import scanner

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# TypeSafe helpers
# ---------------------------------------------------------------------------
def _answers_to_dict(resp: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, a in resp.answers.items():
        t = getattr(a, "type", None)
        if t == "noul":
            out[k] = {"type": "noul", "p": float(a.noul)}
        elif t == "choice":
            out[k] = {"type": "choice", "choice": a.choice, "confidence": float(a.confidence),
                      "probabilities": {kk: float(vv) for kk, vv in dict(a.probabilities).items()}}
        elif t == "score":
            out[k] = {"type": "score", "score": float(a.score), "confidence": float(a.confidence),
                      "probabilities": {str(kk): float(vv) for kk, vv in dict(a.probabilities).items()}}
    return out


class Judge:
    """TypeSafe first; when the model service fails (no credits, outage, timeout) the same
    question is answered by plain rules (`rules.py`) so the page never goes blank. Rule
    answers are marked `rules: True` and never claim more than MED conviction."""
    # Once the API says "no credits" we stop hammering it for a while (seconds).
    CREDITS_BACKOFF_S = 900
    _credits_out_until: float = 0.0

    def __init__(self, enabled: bool = True, rules_fallback: bool = True):
        self.enabled = enabled
        self.rules_fallback = rules_fallback
        self.calls = self.failures = self.rule_answers = self.input_tokens = self.output_tokens = 0
        self.last_error: str | None = None

    @property
    def source(self) -> str:
        if self.calls and not self.rule_answers:
            return "model"
        if self.calls and self.rule_answers:
            return "mixed"
        return "rules" if self.rule_answers else "none"

    def _fallback(self, states: list[dict[str, Any]], questions: dict[str, Any], idx: list[int] | None = None) -> list[dict[str, Any] | None]:
        out: list[dict[str, Any] | None] = [None] * len(states)
        if not self.rules_fallback:
            return out
        for i in (idx if idx is not None else range(len(states))):
            a = R.answer(questions, states[i])
            if a is not None:
                self.rule_answers += 1
            out[i] = a
        return out

    async def run_many(self, states: list[dict[str, Any]], questions: dict[str, Any]) -> list[dict[str, Any] | None]:
        if not self.enabled or not states:
            return [None] * len(states)
        if time.time() < Judge._credits_out_until:
            self.failures += len(states)
            self.last_error = "TypeSafe credits exhausted (backing off)"
            return self._fallback(states, questions)
        sem = asyncio.Semaphore(config.TYPESAFE_CONCURRENCY)
        try:
            client_cm = AsyncTypeSafeClient(model=config.TYPESAFE_MODEL)
        except TypeSafeError as e:
            self.failures += len(states)
            self.last_error = str(e)[:200]
            log.error("TypeSafe unavailable, answering by rules: %s", e)
            return self._fallback(states, questions)
        async with client_cm as client:
            async def one(state: dict[str, Any]) -> dict[str, Any] | None:
                async with sem:
                    if time.time() < Judge._credits_out_until:
                        self.failures += 1
                        return None
                    try:
                        resp = await client.system_one(state=state, questions=questions)
                    except TypeSafeError as e:
                        self.failures += 1
                        msg = str(e)
                        self.last_error = msg[:200]
                        if "402" in msg or "credits" in msg.lower():
                            Judge._credits_out_until = time.time() + Judge.CREDITS_BACKOFF_S
                        log.warning("TypeSafe call failed: %s", msg[:200])
                        return None
                    self.calls += 1
                    u = getattr(resp, "usage", None)
                    if u is not None:
                        self.input_tokens += int(getattr(u, "input_tokens", 0) or 0)
                        self.output_tokens += int(getattr(u, "output_tokens", 0) or 0)
                    return _answers_to_dict(resp)
            answers = list(await asyncio.gather(*(one(s) for s in states)))
        missing = [i for i, a in enumerate(answers) if a is None]
        if missing:
            filled = self._fallback(states, questions, missing)
            for i in missing:
                answers[i] = filled[i]
        return answers

    async def run_one(self, state: dict[str, Any], questions: dict[str, Any]) -> dict[str, Any] | None:
        return (await self.run_many([state], questions))[0]


def _r(x: Any, nd: int = 2) -> Any:
    return round(x, nd) if isinstance(x, (int, float)) and not isinstance(x, bool) else x


# ---------------------------------------------------------------------------
# State builders (what the model sees)
# ---------------------------------------------------------------------------
def _headline_state(h: dict[str, Any]) -> dict[str, Any]:
    return {k: h[k] for k in ("headline", "summary", "source", "published", "related_tickers")}


def _stock_state(s: dict[str, Any], market_state: str) -> dict[str, Any]:
    t, f = s["technicals"], s["fundamentals"]
    return {
        "ticker": s["ticker"], "name": s["name"], "sector": s["sector"], "industry": s["industry"],
        "market_state": market_state,
        "price": {"last": _r(s["last_price"]), "prev_close": _r(s["prev_close"]), "chg_pct": s["chg_pct"], "gap_pct": s["gap_pct"]},
        "volatility": {"atr_pct": _r(t.get("atr_pct")), "realized_vol_20d_annualized_pct": _r(t.get("rv20")),
                       "beta": _r(f.get("beta")), "rel_volume": s["rel_volume"] if s["rel_volume"] is not None else "unavailable",
                       "prev_day_range_pct": _r(t.get("prev_range_pct"))},
        "trend": {"trend": t.get("trend"), "above_sma20": t.get("above_sma20"), "above_sma50": t.get("above_sma50"),
                  "above_sma200": t.get("above_sma200"), "dist_sma20_pct": _r(t.get("dist_sma20_pct")),
                  "rsi14": _r(t.get("rsi14"), 1), "pct_from_52w_high": _r(t.get("pct_from_hi52"), 1),
                  "pct_from_52w_low": _r(t.get("pct_from_lo52"), 1), "ret_5d": _r(t.get("ret_5d")), "ret_1m": _r(t.get("ret_1m")),
                  "ret_3m": _r(t.get("ret_3m")), "ret_6m": _r(t.get("ret_6m")), "ret_12m": _r(t.get("ret_12m")),
                  "new_high_20d": t.get("new_high_20d"), "new_low_20d": t.get("new_low_20d")},
        "levels": {"prev_high": _r(t.get("prev_high")), "prev_low": _r(t.get("prev_low")),
                   "hi_20d": _r(t.get("hi20")), "lo_20d": _r(t.get("lo20"))},
        "fundamentals": {"market_cap": f.get("market_cap"), "forward_pe": _r(f.get("forward_pe"), 1), "trailing_pe": _r(f.get("trailing_pe"), 1),
                         "price_to_sales": _r(f.get("ps"), 1), "rev_growth": _r(f.get("rev_growth"), 3), "eps_growth": _r(f.get("eps_growth"), 3),
                         "profit_margin": _r(f.get("margins"), 3), "short_float": _r(f.get("short_float"), 3),
                         "analyst": f.get("analyst"), "analyst_target": _r(f.get("target")), "days_to_earnings": f.get("days_to_earnings")},
        "price_action": {k: v for k, v in (s.get("price_action") or {}).items() if k != "prev_close"},
        "headlines": [{"headline": h["headline"], "summary": h["summary"][:300], "published": h["published"], "source": h["source"]}
                      for h in s["headlines"]],
    }


def _earnings_state(e: dict[str, Any]) -> dict[str, Any]:
    return {k: e[k] for k in ("symbol", "name", "market_cap", "report_time", "eps_forecast", "last_year_eps", "num_estimates")}


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def _stock_record(t: str, s: dict[str, Any], f: pd.DataFrame | None, meta: dict[str, Any], mstate: str, *, on_watchlist: bool,
                  is_gapper: bool, vol_rank: int | None, n_universe: int | None) -> dict[str, Any]:
    """Everything a stock card needs before any model read."""
    tech = s["technicals"]
    fundamentals = {k: meta.get(k) for k in ("market_cap", "beta", "short_float", "trailing_pe", "forward_pe", "ps",
                                              "rev_growth", "eps_growth", "margins", "analyst", "target",
                                              "next_earnings", "days_to_earnings", "profile_stale", "profile_as_of")}
    return {
        "ticker": t, "name": meta.get("name", t), "sector": meta.get("sector", ""), "industry": meta.get("industry", ""),
        "kind": {"ETF": "ETF", "CRYPTOCURRENCY": "Crypto", "INDEX": "Index", "MUTUALFUND": "Fund"}.get(meta.get("quote_type"), "Stock"),
        "last_price": s["last_price"], "prev_close": s["prev_close"], "last_ts": s["last_ts"],
        "chg_pct": s["gap_pct"], "gap_pct": s["gap_pct"] if mstate != "open" else None,
        "rel_volume": s["rel_volume"], "avg_volume": s["avg_volume"], "avg_dollar_volume": s["avg_dollar_volume"],
        "session_closes": s["session_closes"],
        "technicals": tech, "fundamentals": fundamentals,
        "price_action": T.price_action(f) if f is not None else {},
        "ohlc": T.ohlc_records(f, config.OHLC_DAYS_STOCK) if f is not None else [],
        "headlines": fetch.fetch_news([t], per_symbol=config.NEWS_PER_STOCK, lookback_hours=96),
        "on_watchlist": on_watchlist, "is_gapper": is_gapper,
        "volatility_rank": vol_rank, "volatility_universe": n_universe,
    }


def _compose_stock(s: dict[str, Any], a: dict[str, Any] | None) -> None:
    """Scores and tags from the round-1 answers."""
    s["ai"] = a
    tech = s["technicals"]
    agree = [x for x in (tech.get("above_sma20"), tech.get("above_sma50"), tech.get("above_sma200")) if x is not None]
    if agree:
        share = max(sum(agree), len(agree) - sum(agree)) / len(agree)
        trend_alignment = (share - 0.5) * 2          # 0 when split, 1 when unanimous
    else:
        trend_alignment = 0.0
    day_fit = a["day_trade_fit"]["score"] if a else None
    swing_fit = a["swing_fit"]["score"] if a else None
    s["scores"] = {
        "day": round(J.day_score(day_fit, tech.get("atr_pct"), s["chg_pct"], s["rel_volume"]), 3),
        "swing": round(J.swing_score(swing_fit, trend_alignment, tech.get("atr_pct")), 3),
    }
    tags = []
    if s["is_gapper"]:
        tags.append("gapper")
    if s["on_watchlist"]:
        tags.append("watchlist")
    if a:
        if day_fit >= J.DAY_TAG_MIN:
            tags.append("day")
        if swing_fit >= J.SWING_TAG_MIN:
            tags.append("swing")
        if a["event_risk"]["p"] >= J.EVENT_RISK_MIN:
            tags.append("event_risk")
        if a["extended"]["p"] >= J.EXTENDED_MIN:
            tags.append("extended")
    s["tags"] = tags


def _scan_slim(rec: dict[str, Any] | None) -> dict[str, Any] | None:
    if not rec:
        return None
    ses = rec.get("session") or {}
    return {"score": rec["score"], "lead": rec["lead_timeframe"], "direction": rec["direction"], "qualifies": rec["qualifies"],
            "rvol_tod": ses.get("rvol_time_of_day"), "above_vwap": ses.get("above_vwap"), "range_pos": ses.get("range_pos"),
            "timeframes": {k: {"score": v["score"], "vol_ratio_3bar": v["vol_ratio_3bar"], "building_bars": v["building_bars"],
                               "chg_3bar_pct": v["chg_3bar_pct"], "breakout": v["breakout"], "breakdown": v["breakdown"]} for k, v in rec["timeframes"].items()},
            "read": ((rec.get("ai") or {}).get("read") or {}).get("choice")}


def _scan_state(r: dict[str, Any], mstate: str) -> dict[str, Any]:
    ses = r["session"]
    return {"ticker": r["ticker"], "name": r["name"], "price": _r(r["price"]), "chg_pct": r["chg_pct"], "market_state": mstate,
            "session": {k: ses.get(k) for k in ("rvol_time_of_day", "above_vwap", "range_pos", "chg_from_open_pct", "session_volume", "avg_session_volume", "bars_today")},
            "timeframes": {k: {kk: (_r(vv) if isinstance(vv, float) else vv) for kk, vv in v.items() if kk not in ("bar_time", "vol_last", "vol_avg20")}
                           for k, v in r["timeframes"].items()},
            "daily": r["daily"], "score_0_100": r["score"], "lead_timeframe": r["lead_timeframe"]}


def _low_float_state(r: dict[str, Any], mstate: str) -> dict[str, Any]:
    it = r.get("intraday") or {}
    ses = it.get("session") or {}
    keys = ("ticker", "name", "sector", "price", "chg_pct", "volume", "avg_volume", "rel_volume", "float", "shares_outstanding", "float_turnover",
            "short_pct_float", "days_to_cover", "insiders_pct", "institutions_pct", "market_cap", "range_pos", "pct_from_hi52")
    return {k: r.get(k) for k in keys} | {
        "market_state": mstate,
        "intraday": ({"rvol_time_of_day": ses.get("rvol_time_of_day"), "above_vwap": ses.get("above_vwap"),
                      "timeframes": {k: {kk: v.get(kk) for kk in ("vol_ratio_3bar", "building_bars", "chg_3bar_pct", "breakout", "breakdown", "close_location")}
                                     for k, v in (it.get("timeframes") or {}).items()}} if it else None)}


def _lite(symbols: list[str], snapshot: dict[str, Any], history: pd.DataFrame, sym_names: dict[str, tuple[str, str]],
          scan_stats: dict[str, Any], theme: set[str]) -> dict[str, Any]:
    """Quote + daily technicals for every symbol the build touched, so a ticker added to a
    watchlist on the page shows real numbers instantly even without a full analysis."""
    out: dict[str, Any] = {}
    keep = ("trend", "rsi14", "atr14", "atr_pct", "sma20", "sma50", "above_sma20", "above_sma50", "above_sma200", "dist_sma20_pct",
            "ret_5d", "ret_1m", "ret_3m", "hi20", "lo20", "prev_high", "prev_low", "pct_from_hi52", "new_high_20d", "new_low_20d")
    for t in symbols:
        s = snapshot.get(t)
        if not s or not s.get("last_price") or t.startswith("^") or "=" in t:
            continue
        tech = s.get("technicals")
        if not tech:
            f = fetch.frame_for(history, t)
            if f is None:
                continue
            tech = T.summarize(f, s["last_price"])
        name, kind = sym_names.get(t, (config.INDEX_ETFS.get(t) or config.SECTOR_ETFS.get(t) or t, "ETF" if t in config.INDEX_ETFS or t in config.SECTOR_ETFS else "Stock"))
        out[t] = {"name": name, "kind": kind, "last_price": s["last_price"], "chg_pct": s["gap_pct"], "rel_volume": s["rel_volume"],
                  "avg_dollar_volume": s["avg_dollar_volume"], "technicals": {k: tech.get(k) for k in keep},
                  "scan": _scan_slim(scan_stats.get(t)), "on_theme": t in theme}
    return out


def _plan(s: dict[str, Any]) -> dict[str, Any] | None:
    a, t, px = s.get("ai"), s["technicals"], s["last_price"]
    if not a or not px:
        return None
    lean, atr = a["bias"]["choice"], t.get("atr14") or px * 0.02
    if lean == "neutral":
        return None
    if lean == "long":
        below = [v for v in (t.get("prev_low"), t.get("sma20")) if isinstance(v, (int, float)) and v < px]
        stop = max(below) if below else px - 1.5 * atr
        if px - stop > 2 * atr:
            stop = px - 2 * atr
        target = t["hi20"] if isinstance(t.get("hi20"), (int, float)) and t["hi20"] > px * 1.01 else px + 2 * atr
    else:
        above = [v for v in (t.get("prev_high"), t.get("sma20")) if isinstance(v, (int, float)) and v > px]
        stop = min(above) if above else px + 1.5 * atr
        if stop - px > 2 * atr:
            stop = px + 2 * atr
        target = t["lo20"] if isinstance(t.get("lo20"), (int, float)) and t["lo20"] < px * 0.99 else px - 2 * atr
    risk, reward = abs(px - stop), abs(target - px)
    return {"stop": round(stop, 2), "target": round(target, 2), "stop_pct": round((stop / px - 1) * 100, 1),
            "target_pct": round((target / px - 1) * 100, 1), "reward_to_risk": round(reward / risk, 2) if risk else None}

def _checklist(s: dict[str, Any], tone: str) -> dict[str, Any] | None:
    a, t, pa, f = s.get("ai"), s["technicals"], s.get("price_action") or {}, s["fundamentals"]
    if not a or a["bias"]["choice"] == "neutral":
        return None
    long = a["bias"]["choice"] == "long"
    pl = s.get("plan") or {}
    rsi, d20, atrp = t.get("rsi14"), t.get("dist_sma20_pct"), t.get("atr_pct")
    items = [
        ("trend agrees", t.get("trend") == ("up" if long else "down")),
        ("structure agrees", pa.get("structure") == ("uptrend_hh_hl" if long else "downtrend_lh_ll")),
        ("market mood agrees", tone == ("risk_on" if long else "risk_off")),
        ("not chasing", a["extended"]["p"] < 0.6 and isinstance(d20, (int, float)) and isinstance(atrp, (int, float)) and abs(d20) <= 2 * atrp),
        ("last candle agrees", pa.get("direction") == ("up" if long else "down") and ((pa.get("close_location") or 0) >= 0.6 if long else (pa.get("close_location") or 1) <= 0.4)),
        ("volume backs it", isinstance(pa.get("volume_vs_avg"), (int, float)) and pa["volume_vs_avg"] >= 1.0),
        ("room to run", isinstance(pl.get("reward_to_risk"), (int, float)) and pl["reward_to_risk"] >= 1.5),
        ("no event this week", a["event_risk"]["p"] < 0.6 and not (isinstance(f.get("days_to_earnings"), int) and 0 <= f["days_to_earnings"] <= 5)),
        ("rsi not extreme", isinstance(rsi, (int, float)) and ((rsi < 70) if long else (rsi > 30))),
        ("clean entry", (a.get("entry_quality") or {}).get("score", 0) >= 2),
    ]
    return {"passed": sum(ok for _, ok in items), "total": len(items), "failed": [n for n, ok in items if not ok]}



LARGE_CAP = 10e9
_ETF_KINDS = {"ETF", "Index", "Fund"}


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and x == x


def _why_bullets(s: dict[str, Any], with_model_reason: bool = True) -> list[str]:
    """Two to four plain-word reasons behind the verdict, from the data itself. The model's own
    'main reason' only makes sense under the model's stance, so funds and large caps (which show a
    trend or momentum read instead) skip it."""
    t = s.get("technicals") or {}
    f = s.get("fundamentals") or {}
    a = s.get("ai") or {}
    sc = s.get("scan") or {}
    sm = s.get("smart") or {}
    out: list[str] = []
    reason = ((a.get("main_reason") or {}).get("choice")) if with_model_reason else None
    bearish = ((a.get("stance") or {}).get("choice")) in ("avoid", "short_setup", "hold_dont_add")
    reason_words = {"trend_and_entry": "The trend and the entry point argue against buying here." if bearish else "The trend and the entry point line up.", "extended": "It has run a long way from its usual range, so chasing is risky.",
                    "resistance": "There is a price ceiling just overhead where sellers showed up before.", "event_risk": "A dated event (earnings or a decision) is close and can move it either way.",
                    "smart_money": "What insiders and big holders are doing matters here.", "options_flow": "Options traders are placing unusually large bets.",
                    "volume": "Today's trading activity is the tell.", "market_tone": "The overall market mood is doing most of the work.", "poor_reward": "The potential gain is small next to what you would risk."}
    if reason in reason_words:
        out.append(reason_words[reason])
    tr = t.get("trend")
    if tr == "up" and t.get("above_sma50"):
        out.append("Trend up: it trades above its 20- and 50-day averages.")
    elif tr == "down" and t.get("above_sma50") is False:
        out.append("Trend down: it trades below its 20- and 50-day averages.")
    elif tr:
        out.append("The trend is mixed: short and medium averages disagree.")
    d20 = t.get("dist_sma20_pct")
    if _num(d20) and abs(d20) >= 8:
        out.append(f"{'Stretched' if d20 > 0 else 'Oversold'}: {abs(d20):.0f}% {'above' if d20 > 0 else 'below'} its 20-day average.")
    rv = sc.get("rvol_tod") if _num(sc.get("rvol_tod")) else s.get("rel_volume")
    if _num(rv) and rv >= 1.5:
        vw = " and it is holding above the day's average price" if sc.get("above_vwap") else (" but it is below the day's average price" if sc.get("above_vwap") is False else "")
        out.append(f"Trading activity is {rv:.1f}x normal for this time of day{vw}.")
    elif _num(rv) and rv < 0.6:
        out.append("Trading activity is light: fewer shares than usual are changing hands.")
    ins = (sm.get("insider") or {})
    buys = len(ins.get("open_market_buys_90d") or [])
    sells = len(ins.get("open_market_sales_90d") or [])
    if buys and not sells:
        out.append(f"Insiders bought shares with their own money ({buys} purchase{'s' if buys > 1 else ''} in 90 days).")
    elif sells and not buys and (ins.get("sell_value_90d") or 0) > 0:
        out.append("Insiders have been selling, beyond routine sales.")
    de = f.get("days_to_earnings")
    if isinstance(de, int) and 0 <= de <= 10:
        out.append(f"Earnings in {de} day{'s' if de != 1 else ''}: expect a big move either way.")
    pl = s.get("plan") or {}
    rr = pl.get("reward_to_risk")
    if _num(rr) and len(out) < 4:
        out.append(f"Potential gain is {rr:.1f}x the amount at risk {'(good odds)' if rr >= 2 else '(thin odds)' if rr < 1.2 else '(fair odds)'}.")
    seen: list[str] = []
    for x in out:
        if x not in seen:
            seen.append(x)
    if len(seen) < 2:
        r5, r1 = t.get("ret_5d"), t.get("ret_1m")
        if _num(r5):
            month = f", {'up' if r1 >= 0 else 'down'} {abs(r1):.0f}% over the month" if _num(r1) else ""
            seen.append(f"{'Up' if r5 >= 0 else 'Down'} {abs(r5):.1f}% over the past week{month}.")
        elif _num(s.get("rel_volume")):
            seen.append(f"Trading activity is {s['rel_volume']:.1f}x its normal level.")
    return seen[:4]


def _conviction(c: Any) -> str:
    return "high" if _num(c) and c >= 0.7 else "med" if _num(c) and c >= 0.5 else "low"


def _verdict(s: dict[str, Any]) -> dict[str, Any]:
    """One verdict per name, chosen by what the thing is. ETFs and indexes never get AVOID:
    they get a trend or range bias. Large caps get a momentum-plus-volume read. Everything
    else keeps the model's stance."""
    t = s.get("technicals") or {}
    f = s.get("fundamentals") or {}
    a = s.get("ai") or {}
    st = (a.get("stance") or {})
    kind = s.get("kind") or "Stock"
    ticker = s.get("ticker")
    is_etf = kind in _ETF_KINDS or ticker in config.INDEX_ETFS or ticker in config.SECTOR_ETFS
    mcap = f.get("market_cap")
    tr = t.get("trend")
    d20 = t.get("dist_sma20_pct")
    if is_etf:
        if tr == "up":
            code, word, cls, plain = "trend_up", "TREND UP", "up", "Rising trend. Buying dips toward the 20-day average has worked; do not chase a spike."
        elif tr == "down":
            code, word, cls, plain = "trend_down", "TREND DOWN", "down", "Falling trend. Bounces have been sold; wait for it to reclaim its averages."
        else:
            code, word, cls, plain = "range", "RANGE", "flat", "Moving sideways. Buy near the low end of the range, sell near the top, or wait for a break."
        return {"kind": "etf", "code": code, "word": word, "cls": cls, "plain": plain, "conviction": "high" if tr in ("up", "down") else "med", "why": _why_bullets(s, False)}
    adv = s.get("avg_dollar_volume")
    if (_num(mcap) and mcap >= LARGE_CAP) or (not _num(mcap) and _num(adv) and adv >= 2e9):   # no market cap from the feed: $2B+ traded a day is large by any measure
        r5 = t.get("ret_5d"); today = s.get("chg_pct")
        rv = max([x for x in (s.get("rel_volume"), (s.get("scan") or {}).get("rvol_tod")) if _num(x)], default=None)   # same activity number the bullets quote
        strong_vol = _num(rv) and rv >= 1.3
        if _num(today) and today <= -3 and strong_vol:
            code, word, cls, plain = "selling_today", "HEAVY SELLING TODAY", "down", "Down hard today on far more trading than usual: sellers are in charge right now, whatever the longer trend says."
        elif _num(today) and today >= 3 and strong_vol:
            code, word, cls, plain = "buying_today", "HEAVY BUYING TODAY", "up", "Up hard today on far more trading than usual: buyers are in charge right now."
        elif _num(r5) and r5 >= 2 and tr != "down":
            code, word, cls = ("momentum_up", "MOMENTUM UP", "up") if strong_vol else ("drifting_up", "DRIFTING UP", "up2")
            plain = "Moving up on heavy trading: buyers are committed." if strong_vol else "Moving up on light trading: fine to hold, not a reason to chase."
        elif _num(r5) and r5 <= -2 and tr != "up":
            code, word, cls = ("momentum_down", "MOMENTUM DOWN", "down") if strong_vol else ("drifting_down", "DRIFTING DOWN", "flat")
            plain = "Falling on heavy trading: sellers are committed." if strong_vol else "Falling on light trading: a drift, not a rush for the exits."
        elif _num(d20) and d20 < -3 and tr == "up":
            code, word, cls, plain = "pullback_in_uptrend", "PULLBACK", "up2", "A dip inside a rising trend. The usual spot where buyers step back in."
        else:
            code, word, cls, plain = "flat", "FLAT", "flat", "Going nowhere in particular. No edge either way right now."
        conv = "high" if (strong_vol and code in ("momentum_up", "momentum_down", "selling_today", "buying_today")) else "med" if code != "flat" else "low"
        why = _why_bullets(s, False)
        if code in ("selling_today", "buying_today"):
            after = f", after a {abs(r5):.0f}% {'rise' if r5 > 0 else 'fall'} over the past five sessions" if _num(r5) and abs(r5) >= 3 else ""
            why.insert(0, f"{'Down' if today < 0 else 'Up'} {abs(today):.1f}% today on {rv:.1f}x the usual trading{after}.")
        elif _num(r5):
            why.insert(0, f"{'Up' if r5 >= 0 else 'Down'} {abs(r5):.1f}% over the past five sessions on {'heavy' if strong_vol else 'ordinary'} trading.")
        return {"kind": "large", "code": code, "word": word, "cls": cls, "plain": plain, "conviction": conv, "why": why[:4], "model": st.get("choice")}
    if st.get("choice"):
        words = {"buy_now": ("BUY", "up", "Trend, chart and entry all agree, with room to run to the next level."), "buy_the_dip": ("BUY THE DIP", "up2", "Strong stock that has run too far to chase. Wait for a pullback toward its 20-day average."),
                 "wait_for_breakout": ("WAIT FOR BREAKOUT", "flat", "Looks constructive but is capped under a price ceiling. A close above it is the trigger."), "hold_dont_add": ("HOLD, DON'T ADD", "flat", "If you own it, keep it with a stop. New money has no edge here."),
                 "avoid": ("AVOID", "down", "The reads conflict, an event is near, or informed money is selling. No trade."), "short_setup": ("SHORT SETUP", "down", "Falling trend with sellers in control and a clean entry for a short.")}
        w, cls, plain = words.get(st["choice"], (st["choice"].upper(), "flat", ""))
        return {"kind": "stock", "code": st["choice"], "word": w, "cls": cls, "plain": plain, "conviction": _conviction(st.get("confidence")), "why": _why_bullets(s)}
    return {"kind": "stock", "code": None, "word": "NO VERDICT", "cls": "none", "plain": "The model returned no stance for this build.", "conviction": "low", "why": _why_bullets(s)}


def _stance_state(s: dict[str, Any], tone_now: str, mstate: str) -> dict[str, Any]:
    a = s["ai"]; sm = (s.get("smart") or {}); smi = sm.get("insider", {}); sma = sm.get("ai") or {}
    return {"ticker": s["ticker"], "name": s["name"], "market_tone": tone_now,
            "lean": {"choice": a["bias"]["choice"], "confidence": _r(a["bias"]["confidence"])}, "setup": a["setup"]["choice"],
            "control": a["price_action"]["choice"], "entry_quality": _r(a["entry_quality"]["score"], 1),
            "day_fit": _r(a["day_trade_fit"]["score"], 1), "swing_fit": _r(a["swing_fit"]["score"], 1),
            "extended_p": _r(a["extended"]["p"]), "event_risk_p": _r(a["event_risk"]["p"]), "days_to_earnings": s["fundamentals"].get("days_to_earnings"),
            "plan": {k: (s.get("plan") or {}).get(k) for k in ("stop_pct", "target_pct", "reward_to_risk")},
            "intraday": {"rel_volume": s["rel_volume"] if s["rel_volume"] is not None else "unavailable", "atr_pct": _r(s["technicals"].get("atr_pct")),
                         "prev_high": _r(s["technicals"].get("prev_high")), "prev_low": _r(s["technicals"].get("prev_low")),
                         "pivot": _r((s["technicals"].get("pivots") or {}).get("p")), "last": _r(s["last_price"]), "gap_pct": s["chg_pct"],
                         "prev_day_range_pct": _r(s["technicals"].get("prev_range_pct")), "volume_vs_avg_yesterday": (s.get("price_action") or {}).get("volume_vs_avg"),
                         "session_state": mstate,
                         "volume_scan": ({"score_0_100": s["scan"]["score"], "lead_timeframe": s["scan"]["lead"], "direction": s["scan"]["direction"],
                                          "rvol_time_of_day": s["scan"]["rvol_tod"], "read": s["scan"].get("read")} if s.get("scan") else None)},
            "checklist": s.get("checklist") or {"passed": None, "total": None, "failed": ["no lean"]},
            "smart_money": {"conviction": _r((sma.get("conviction") or {}).get("score"), 1), "who": (sma.get("who") or {}).get("choice"),
                            "insider_buy_value_90d": smi.get("buy_value_90d"), "insider_buyers": smi.get("distinct_buyers_90d"),
                            "insider_sell_value_90d": smi.get("sell_value_90d"), "institutions_top10_change": _r((sm.get("institutions") or {}).get("top10_avg_change"), 3),
                            "short_change_pct": (sm.get("short") or {}).get("change_pct"), "congress_buys": sum(1 for c in sm.get("congress", []) if c.get("type") == "buy"),
                            "options": {"read": ((s.get("options") or {}).get("ai") or {}).get("read", {}).get("choice"), "intensity": _r(((s.get("options") or {}).get("ai") or {}).get("intensity", {}).get("score"), 1),
                                        "put_call_volume": (s.get("options") or {}).get("pc_volume"), "call_share_of_notional": (s.get("options") or {}).get("call_share")}}}


def _sm_state(t: str, row: dict[str, Any], name: str, tech: dict[str, Any]) -> dict[str, Any]:
    ins = row.get("insider", {}); inst = row.get("institutions", {}); sh = row.get("short", {})
    return {"ticker": t, "name": name, "price_1m_pct": _r(tech.get("ret_1m")),
            "insider": {k: ins.get(k) for k in ("buy_trans_6m", "sell_trans_6m", "net_shares_6m", "buy_value_90d", "sell_value_90d", "distinct_buyers_90d")}
                       | {"open_market_buys_90d": [{k: b[k] for k in ("date", "insider", "position", "shares", "value")} for b in ins.get("open_market_buys_90d", [])[:5]],
                          "open_market_sales_90d": [{k: b[k] for k in ("date", "insider", "position", "shares", "value")} for b in ins.get("open_market_sales_90d", [])[:5]]},
            "institutions": {k: inst.get(k) for k in ("pct_held", "top10_avg_change", "as_of")},
            "short": {k: sh.get(k) for k in ("change_pct", "short_pct_float", "days_to_cover")},
            "congress": row.get("congress", [])}


def _opt_state(t: str, o: dict[str, Any], name: str, snap: dict[str, Any]) -> dict[str, Any]:
    tech = snap.get("technicals") or {}
    slim = lambda c: {k: c[k] for k in ("side", "strike", "otm_pct", "dte", "volume", "oi", "notional") if k in c}
    return {"ticker": t, "name": name, "spot": _r(o.get("spot")), "chg_pct": snap.get("gap_pct"),
            "trend": tech.get("trend"), "nearest_expiries": o.get("expiries"),
            "call_volume": o.get("call_volume"), "put_volume": o.get("put_volume"), "put_call_volume": o.get("pc_volume"), "put_call_open_interest": o.get("pc_oi"),
            "call_notional": o.get("call_notional"), "put_notional": o.get("put_notional"), "call_share_of_notional": o.get("call_share"), "atm_iv": o.get("atm_iv"),
            "volume_to_open_interest": o.get("volume_to_oi"), "open_interest_posted": o.get("oi_posted"),
            "note": "Open interest updates overnight; contracts with oi 0 are new listings, not evidence of aggression. Use volume_to_open_interest and the unusual list, which already requires established open interest.",
            "top_calls": [slim(c) for c in o.get("top_calls", [])], "top_puts": [slim(c) for c in o.get("top_puts", [])],
            "unusual": [{**slim(c), "vol_oi": c.get("vol_oi"), "basis": c.get("basis"), "share_of_side_volume": c.get("share_of_side_volume")} for c in o.get("unusual", [])],
            "unusual_call_notional": o.get("unusual_call_notional"), "unusual_put_notional": o.get("unusual_put_notional")}



def _weekly_levels(f: pd.DataFrame, last: float | None) -> dict[str, Any]:
    """Nearest weekly swing support and resistance plus the 52-week extremes, for a clean weekly chart."""
    d = f.dropna(subset=["Close"])
    if d.empty:
        return {}
    wk = d.resample("W-FRI").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}).dropna(subset=["Close"]).tail(104)
    try:
        sp = T.swing_points(wk, lookback=2, bars=104)
    except Exception:  # noqa: BLE001
        sp = {}
    px = last if isinstance(last, (int, float)) and last == last and last > 0 else float(wk["Close"].iloc[-1])
    out = {"support": sp.get("nearest_support"), "resistance": sp.get("nearest_resistance"),
           "hi52": _r(float(wk["High"].tail(52).max()), 2), "lo52": _r(float(wk["Low"].tail(52).min()), 2), "structure": sp.get("structure")}
    out["support_pct"] = _r((out["support"] / px - 1) * 100, 1) if out["support"] and px else None
    out["resistance_pct"] = _r((out["resistance"] / px - 1) * 100, 1) if out["resistance"] and px else None
    return out


async def social_snapshot(judge: "Judge") -> dict[str, Any]:
    """Free public voices: Trump's posts (read once each by the model, reads kept on disk) and the
    Reddit crowd's ticker mentions. Nothing here needs a paid key."""
    trump = fetch.fetch_trump_posts(25)
    crowd = fetch.fetch_reddit_crowd()
    reads: dict[str, Any] = fetch._cache_get("trump_reads", 14 * 86400) or {}
    fresh = [p for p in trump.get("posts", []) if p.get("has_text") and p["id"] not in reads]
    if fresh:
        ans = await judge.run_many([{"text": p["text"][:1500], "posted_at": p.get("posted"), "has_media": bool(p.get("media")), "reposts": p.get("reposts")} for p in fresh], J.TRUMP_QUESTIONS)
        changed = False
        for p, a in zip(fresh, ans):
            if a:
                reads[p["id"]] = a
                changed = True
        if changed:
            fetch._cache_put("trump_reads", reads)
    for p in trump.get("posts", []):
        p["ai"] = reads.get(p["id"])
    return _clean({"trump": trump, "crowd": crowd, "as_of": datetime.now(tz=config.ET).isoformat()})


async def build_report(use_ai: bool = True, max_cards: int | None = None) -> dict[str, Any]:
    t0 = time.time()
    session = fetch.next_session_date()
    mstate = fetch.market_state()
    max_cards = max_cards or config.MAX_STOCK_CARDS
    watch = config.load_watchlist()
    universe = list(dict.fromkeys(config.UNIVERSE + watch))
    theme_symbols = [t for g in config.THEME["groups"].values() for t in g]
    all_symbols = list(dict.fromkeys(universe + list(config.INDEX_ETFS) + list(config.SECTOR_ETFS) + config.AUX_SYMBOLS + theme_symbols))

    log.info("fetching history for %d symbols", len(all_symbols))
    history = fetch.fetch_history(all_symbols, "1y")
    snapshot = fetch.fetch_snapshot(all_symbols, history)
    macro = fetch.fetch_macro_tape()
    world = fetch.fetch_world_tape()
    rates = fetch.fetch_fred_curve()
    live_yields = fetch.fetch_live_yields()
    calendar = fetch.fetch_calendar(session)
    earnings = fetch.fetch_earnings(session)

    # ---- indices ------------------------------------------------------------
    indices = []
    for sym, name in config.INDEX_ETFS.items():
        f = fetch.frame_for(history, sym)
        s = snapshot.get(sym)
        if f is None or s is None:
            continue
        tech = T.summarize(f, s["last_price"])
        indices.append({"symbol": sym, "name": name, "last": s["last_price"], "prev_close": s["prev_close"],
                        "chg_pct": s["gap_pct"], "rel_volume": s["rel_volume"], "technicals": tech,
                        "price_action": T.price_action(f),
                        "ohlc": T.ohlc_records(f, config.OHLC_DAYS_INDEX),
                        "weekly": T.weekly_ohlc(f, 52), "weekly_levels": _weekly_levels(f, s["last_price"])})

    # ---- big picture: multi-horizon assets --------------------------------------
    horizon_assets = []
    for sym, label, kind in config.HORIZON_ASSETS:
        f = fetch.frame_for(history, sym)
        if f is None or len(f) < 30:
            continue
        is_yield = kind == "yield"
        tech = T.summarize(f)
        hz = {k: T.horizon_stats(f, n, is_yield) for k, n in config.HORIZONS.items()}
        q = snapshot.get(sym) or {}
        horizon_assets.append({
            "symbol": sym, "label": label, "kind": kind,
            "last": q.get("last_price") or tech.get("last_close"), "chg_pct": q.get("gap_pct"),
            "sma50": tech.get("sma50"), "sma200": tech.get("sma200"),
            "above_sma50": tech.get("above_sma50"), "above_sma200": tech.get("above_sma200"), "rsi14": tech.get("rsi14"),
            "horizons": hz, "weekly": T.weekly_ohlc(f, 52),
            "closes_12m": [round(float(x), 4) for x in f["Close"].dropna().tail(252).tolist()[::3]],
        })

    # ---- theme screen: AI data-center buildout ----------------------------------
    spy_f = fetch.frame_for(history, "SPY")
    spy_ret = {n: T.pct_return(spy_f["Close"].dropna(), n) for n in (21, 63)} if spy_f is not None else {21: None, 63: None}
    theme_rows: list[dict[str, Any]] = []
    for group, tickers in config.THEME["groups"].items():
        for t in tickers:
            f = fetch.frame_for(history, t)
            q = snapshot.get(t)
            if f is None or q is None or not q.get("last_price") or len(f) < 30:
                continue
            tech = T.summarize(f, q["last_price"])
            pa = T.price_action(f)
            r1, r3 = tech.get("ret_1m"), tech.get("ret_3m")
            theme_rows.append({
                "ticker": t, "group": group, "last_price": q["last_price"], "chg_pct": q["gap_pct"],
                "technicals": tech, "price_action": pa,
                "rel_1m": round(r1 - spy_ret[21], 2) if (r1 is not None and spy_ret[21] is not None) else None,
                "rel_3m": round(r3 - spy_ret[63], 2) if (r3 is not None and spy_ret[63] is not None) else None,
                "session_closes": q["session_closes"][-40:],
            })
    theme_info = fetch.fetch_info([x["ticker"] for x in theme_rows][: config.THEME_MAX_JUDGED])
    for x in theme_rows:
        m = theme_info.get(x["ticker"], {})
        x["name"] = m.get("name", x["ticker"])
        x["fundamentals"] = {k: m.get(k) for k in ("market_cap", "beta", "forward_pe", "trailing_pe", "rev_growth", "eps_growth", "short_float", "next_earnings", "days_to_earnings")}

    # ---- flows --------------------------------------------------------------
    gauges = fetch.ratio_gauges(history, snapshot)
    sectors = fetch.sector_table(history, snapshot)
    n = above20 = above50 = above200 = adv = dec = nh = nl = 0
    for t in universe:
        f = fetch.frame_for(history, t)
        s = snapshot.get(t)
        if f is None or s is None or not s["last_price"]:
            continue
        tech = T.summarize(f, s["last_price"])
        s["technicals"] = tech
        n += 1
        above20 += bool(tech.get("above_sma20")); above50 += bool(tech.get("above_sma50")); above200 += bool(tech.get("above_sma200"))
        adv += s["gap_pct"] > 0; dec += s["gap_pct"] < 0
        nh += bool(tech.get("new_high_20d")); nl += bool(tech.get("new_low_20d"))
    breadth = {"n": n, "above20": above20, "above50": above50, "above200": above200,
               "adv": adv, "dec": dec, "unch": n - adv - dec, "new_high_20d": nh, "new_low_20d": nl}

    # ---- automatic scans: intraday volume build (30m / 1h / 2h) and low float ------
    sym_names = {row[0]: (row[1], row[2]) for row in fetch.fetch_symbol_index()}
    low_float = fetch.fetch_low_float()
    lf_tickers = [r["ticker"] for r in low_float["rows"]]
    scan_universe = list(dict.fromkeys(universe + lf_tickers))
    log.info("intraday scan over %d symbols", len(scan_universe))
    scan = scanner.scan(fetch.fetch_intraday(scan_universe), snapshot, scan_universe, mstate)
    for r in scan["rows"]:
        r["name"] = sym_names.get(r["ticker"], (r["ticker"],))[0]
    for r in low_float["rows"]:
        r["intraday"] = scan["by_ticker"].get(r["ticker"])

    # ---- stock selection: watchlist + gappers + volatility ranking ----------------
    liquid = [snapshot[t] for t in universe if t in snapshot and snapshot[t].get("technicals")
              and snapshot[t]["last_price"] and snapshot[t]["last_price"] >= config.MIN_PRICE
              and (snapshot[t]["avg_dollar_volume"] >= config.MIN_AVG_DOLLAR_VOLUME or t in watch)]
    liquid_set = {s["ticker"] for s in liquid}
    by_atr = sorted(liquid, key=lambda s: s["technicals"].get("atr_pct") or 0, reverse=True)
    gappers = sorted([s for s in liquid if abs(s["gap_pct"]) >= config.GAP_MIN_PCT], key=lambda s: abs(s["gap_pct"]), reverse=True)
    watch_rows = [snapshot[t] for t in watch if t in liquid_set]
    picked: list[str] = []
    for s in watch_rows + gappers + by_atr:
        if s["ticker"] not in picked:
            picked.append(s["ticker"])
        if len(picked) >= max_cards:
            break
    vol_rank = {s["ticker"]: i + 1 for i, s in enumerate(by_atr)}

    log.info("building %d stock cards", len(picked))
    info = fetch.fetch_info(picked)
    stocks: list[dict[str, Any]] = [
        _stock_record(t, snapshot[t], fetch.frame_for(history, t), info.get(t, {}), mstate, on_watchlist=t in watch,
                      is_gapper=abs(snapshot[t]["gap_pct"]) >= config.GAP_MIN_PCT, vol_rank=vol_rank.get(t), n_universe=len(by_atr))
        for t in picked]

    # ---- smart money: insiders, institutions, shorts, Congress -------------------
    sm_tickers = list(dict.fromkeys([t for t in picked] + [x["ticker"] for x in theme_rows[:20]]))
    smart = fetch.fetch_smart_money(sm_tickers)
    congress = fetch.fetch_congress_trades()
    for t, row in smart.items():
        row["congress"] = [c for c in congress.get("by_ticker", {}).get(t, [])][:8]

    # ---- options flow: calls, puts, heavy buying ------------------------------------
    opt_tickers = list(dict.fromkeys(["SPY", "QQQ", "IWM"] + sm_tickers))
    options = fetch.fetch_options_flow(opt_tickers)
    cboe = fetch.fetch_cboe_daily()

    # ---- market-wide headlines ---------------------------------------------------
    seeds = config.NEWS_SEED_SYMBOLS + [s["ticker"] for s in stocks[:6]]
    headlines = fetch.fetch_news(seeds, per_symbol=10)[: config.MAX_HEADLINES_TO_JUDGE]

    # ---- TypeSafe round 1: everything independent, concurrently ------------------
    judge = Judge(enabled=use_ai)
    cal_states = calendar[: config.MAX_CALENDAR_TO_JUDGE]
    earn_states = earnings[: config.MAX_EARNINGS_TO_JUDGE]
    log.info("judging %d headlines, %d stocks, %d calendar, %d earnings", len(headlines), len(stocks), len(cal_states), len(earn_states))
    def _hz_state(a: dict[str, Any]) -> dict[str, Any]:
        keep = ("return_pct", "change_bp", "range_pos", "from_high_pct", "from_high_bp", "max_drawdown_pct", "max_runup_pct", "structure")
        return {"asset": a["label"], "kind": a["kind"], "last": _r(a["last"]), "sma50": _r(a["sma50"]), "sma200": _r(a["sma200"]),
                "above_sma50": a["above_sma50"], "above_sma200": a["above_sma200"], "rsi14": _r(a["rsi14"], 1),
                "horizons": {k: {kk: (_r(vv, 2) if isinstance(vv, float) else vv) for kk, vv in v.items() if kk in keep} for k, v in a["horizons"].items()}}
    cross_state = {
        "assets": [{"asset": a["label"], "kind": a["kind"],
                    **{f"move_{k}": (a["horizons"][k].get("change_bp") if a["kind"] == "yield" else a["horizons"][k].get("return_pct")) for k in config.HORIZONS},
                    "unit": "bp" if a["kind"] == "yield" else "pct", "range_pos_12m": _r(a["horizons"]["12m"].get("range_pos"), 2),
                    "structure_3m": a["horizons"]["3m"].get("structure")} for a in horizon_assets],
        "rates": {"spread_2s10s_bp": (rates.get("spreads", {}).get("2s10s") or {}).get("latest"),
                  "chg_10y_1m_bp": _r(rates.get("chg_10y_1m_bp"), 1), "chg_2y_1m_bp": _r(rates.get("chg_2y_1m_bp"), 1)},
    }
    def _theme_state(x: dict[str, Any]) -> dict[str, Any]:
        t, f, pa = x["technicals"], x["fundamentals"], x["price_action"]
        return {"ticker": x["ticker"], "name": x["name"], "group": x["group"], "theme": config.THEME["name"], "market_tone": mstate,
                "price": {"last": _r(x["last_price"]), "chg_pct": x["chg_pct"]},
                "technicals": {"trend": t.get("trend"), "structure": pa.get("structure"), "atr_pct": _r(t.get("atr_pct")), "rsi14": _r(t.get("rsi14"), 1),
                               "dist_sma20_pct": _r(t.get("dist_sma20_pct"), 1), "ret_1m": _r(t.get("ret_1m"), 1), "ret_3m": _r(t.get("ret_3m"), 1),
                               "rel_vs_spy_1m": x["rel_1m"], "rel_vs_spy_3m": x["rel_3m"], "pct_from_52w_high": _r(t.get("pct_from_hi52"), 1),
                               "new_high_20d": t.get("new_high_20d"), "last_candle": pa.get("pattern"), "volume_vs_avg": pa.get("volume_vs_avg")},
                "fundamentals": {"market_cap": f.get("market_cap"), "beta": _r(f.get("beta")), "forward_pe": _r(f.get("forward_pe"), 1),
                                 "rev_growth": _r(f.get("rev_growth"), 3), "eps_growth": _r(f.get("eps_growth"), 3), "short_float": _r(f.get("short_float"), 3),
                                 "days_to_earnings": f.get("days_to_earnings")}}
    group_stats = []
    for group in config.THEME["groups"]:
        rows = [x for x in theme_rows if x["group"] == group]
        if not rows:
            continue
        def avg(key):
            vals = [x[key] if key in x else x["technicals"].get(key) for x in rows]
            vals = [v for v in vals if isinstance(v, (int, float))]
            return round(sum(vals) / len(vals), 2) if vals else None
        group_stats.append({"group": group, "n": len(rows), "avg_ret_1m": avg("ret_1m"), "avg_ret_3m": avg("ret_3m"), "avg_rel_vs_spy_1m": avg("rel_1m"),
                            "share_in_uptrend": round(sum(x["technicals"].get("trend") == "up" for x in rows) / len(rows), 2),
                            "share_extended": round(sum((x["technicals"].get("dist_sma20_pct") or 0) > 2 * (x["technicals"].get("atr_pct") or 99) for x in rows) / len(rows), 2)})
    theme_group_state = {"theme": config.THEME["name"], "market_tone": mstate, "groups": group_stats}
    sm_keys = [t for t in sm_tickers if t in smart]
    opt_keys = [t for t in opt_tickers if options.get(t, {}).get("ok")]
    _name_of = lambda t: (info.get(t) or theme_info.get(t) or {}).get("name") or sym_names.get(t, (t,))[0]
    h_ans, s_ans, c_ans, e_ans, hz_ans, cross_ans, th_ans, tg_ans, sm_ans, op_ans, sc_ans, lf_ans = await asyncio.gather(
        judge.run_many([_headline_state(h) for h in headlines], J.HEADLINE_QUESTIONS),
        judge.run_many([_stock_state(s, mstate) for s in stocks], J.STOCK_QUESTIONS),
        judge.run_many(cal_states, J.CALENDAR_QUESTIONS),
        judge.run_many([_earnings_state(e) for e in earn_states], J.EARNINGS_QUESTIONS),
        judge.run_many([_hz_state(a) for a in horizon_assets], J.HORIZON_ASSET_QUESTIONS),
        judge.run_many([cross_state] if horizon_assets else [], J.HORIZON_CROSS_QUESTIONS),
        judge.run_many([_theme_state(x) for x in theme_rows[: config.THEME_MAX_JUDGED]], J.THEME_STOCK_QUESTIONS),
        judge.run_many([theme_group_state] if group_stats else [], J.THEME_GROUP_QUESTIONS),
        judge.run_many([_sm_state(t, smart[t], _name_of(t), (snapshot.get(t) or {}).get("technicals") or {}) for t in sm_keys], J.SMART_MONEY_QUESTIONS),
        judge.run_many([_opt_state(t, options[t], _name_of(t), snapshot.get(t) or {}) for t in opt_keys], J.OPTIONS_QUESTIONS),
        judge.run_many([_scan_state(r, mstate) for r in scan["rows"][: config.SCAN_MAX_JUDGED]], J.SCAN_QUESTIONS),
        judge.run_many([_low_float_state(r, mstate) for r in low_float["rows"][: config.LOW_FLOAT_MAX_JUDGED]], J.LOW_FLOAT_QUESTIONS),
    )
    for t, ans in zip(opt_keys, op_ans):
        options[t]["ai"] = ans
    for r, ans in zip(scan["rows"], sc_ans):
        r["ai"] = ans
    for r, ans in zip(low_float["rows"], lf_ans):
        r["ai"] = ans
    for s in stocks:
        s["scan"] = _scan_slim(scan["by_ticker"].get(s["ticker"]))
    for s in stocks:
        s["options"] = options.get(s["ticker"])
        if s.get("options") and s["options"].get("ai") and s["options"]["ai"]["intensity"]["score"] >= J.OPTIONS_INTENSITY_FLAG:
            s.setdefault("tags", [])
    for x in theme_rows:
        x["options"] = options.get(x["ticker"])
    opt_rows = sorted([options[t] for t in opt_keys], key=lambda o: -(o.get("total_notional") or 0))
    group_of = {t: g for g, ts in config.THEME["groups"].items() for t in ts}
    opt_market_state = {
        "cboe": {"as_of": cboe.get("as_of"), "ratios": cboe.get("ratios", {}),
                 "volumes": {k: {"call": v[0].get("call"), "put": v[0].get("put")} for k, v in cboe.items()
                             if k in ("SUM OF ALL PRODUCTS", "INDEX OPTIONS", "EXCHANGE TRADED PRODUCTS", "EQUITY OPTIONS", "CBOE VOLATILITY INDEX (VIX)", "SPX + SPXW")
                             and isinstance(v, list) and v and isinstance(v[0], dict)}},
        "scanned": {"n": len(opt_rows), "aggregate_call_volume": sum(o.get("call_volume") or 0 for o in opt_rows), "aggregate_put_volume": sum(o.get("put_volume") or 0 for o in opt_rows),
                    "aggregate_put_call": round(sum(o.get("put_volume") or 0 for o in opt_rows) / max(1, sum(o.get("call_volume") or 0 for o in opt_rows)), 2)},
        "leaders": [{"ticker": o["ticker"], "group": "index_etfs" if o["ticker"] in ("SPY", "QQQ", "IWM") else group_of.get(o["ticker"], "other"),
                     "total_notional": o.get("total_notional"), "call_share": o.get("call_share"),
                     "read": (o.get("ai") or {}).get("read", {}).get("choice"), "intensity": _r((o.get("ai") or {}).get("intensity", {}).get("score"), 1)} for o in opt_rows[:15]],
        "market_tone": mstate,
    }
    opt_market = (await judge.run_many([opt_market_state], J.OPTIONS_MARKET_QUESTIONS))[0] if opt_rows else None
    for t, ans in zip(sm_keys, sm_ans):
        smart[t]["ai"] = ans
    # attach to stock cards and theme rows so the page can badge them
    for s in stocks:
        s["smart"] = smart.get(s["ticker"])
    for x in theme_rows:
        x["smart"] = smart.get(x["ticker"])
    for x, ans in zip(theme_rows, th_ans):
        x["ai"] = ans
        t = x["technicals"]
        agree = [v for v in (t.get("above_sma20"), t.get("above_sma50"), t.get("above_sma200")) if v is not None]
        align = ((max(sum(agree), len(agree) - sum(agree)) / len(agree)) - 0.5) * 2 if agree else 0.0
        if agree and sum(agree) < len(agree) / 2:
            align = -align                                      # aligned to the downside counts against a long theme
        lev = ans["theme_leverage"]["score"] if ans else None
        mv = ans["move_potential"]["score"] if ans else None
        x["rank"] = round(J.theme_rank(lev, mv, max(0.0, align), t.get("atr_pct"), x["fundamentals"].get("beta"), x["rel_1m"]), 3)
        x["tags"] = []
        if ans and ans["phase"]["choice"] == "extended":
            x["tags"].append("extended")
        if isinstance(x["fundamentals"].get("days_to_earnings"), int) and 0 <= x["fundamentals"]["days_to_earnings"] <= 10:
            x["tags"].append("earnings_soon")
        if t.get("new_high_20d"):
            x["tags"].append("new_high")
        if isinstance(x["fundamentals"].get("short_float"), (int, float)) and x["fundamentals"]["short_float"] >= 0.10:
            x["tags"].append("high_short")
    theme_rows.sort(key=lambda x: x["rank"], reverse=True)
    for x in theme_rows:
        x["technicals"] = {k: v for k, v in x["technicals"].items() if k in ("trend", "sma20", "sma50", "sma200", "above_sma20", "above_sma50", "above_sma200",
                                                                              "dist_sma20_pct", "rsi14", "atr14", "atr_pct", "ret_5d", "ret_1m", "ret_3m", "hi52", "lo52",
                                                                              "pct_from_hi52", "hi20", "lo20", "prev_high", "prev_low", "new_high_20d")}
        x["price_action"] = {k: v for k, v in x["price_action"].items() if k in ("structure", "pattern", "close_location", "volume_vs_avg", "nearest_resistance", "nearest_support", "broke_last_swing_high")}
    theme_block = {"name": config.THEME["name"], "key": config.THEME["key"], "groups": group_stats, "rows": theme_rows,
                   "ai": tg_ans[0] if tg_ans else None, "spy_ret_1m": _r(spy_ret[21]), "spy_ret_3m": _r(spy_ret[63])}
    for a, ans in zip(horizon_assets, hz_ans):
        a["ai"] = ans
    horizons_block = {"assets": horizon_assets, "windows": config.HORIZONS, "ai": cross_ans[0] if cross_ans else None}

    # ---- compose headlines --------------------------------------------------------
    for h, a in zip(headlines, h_ans):
        h["ai"] = a
        h["rank"] = J.headline_rank(a["actionable"]["p"], a["impact"]["score"]) if a else 0.0
        h["keep"] = (a["actionable"]["p"] >= J.HEADLINE_ACTIONABLE_MIN) if a else True
    kept = sorted([h for h in headlines if h["keep"]], key=lambda h: h["rank"], reverse=True)

    # ---- compose stocks -------------------------------------------------------------
    for s, a in zip(stocks, s_ans):
        _compose_stock(s, a)
    stocks.sort(key=lambda s: max(s["scores"]["day"], s["scores"]["swing"]), reverse=True)

    # ---- compose calendar / earnings --------------------------------------------------
    for c, a in zip(cal_states, c_ans):
        c["ai"] = a
        c["relevance"] = a["equity_relevance"]["score"] if a else (2.0 if c["ff_impact"] == "High" else 1.0)
    calendar_kept = [c for c in cal_states if c["relevance"] >= J.CALENDAR_SHOW_MIN]
    for e, a in zip(earn_states, e_ans):
        e["ai"] = a
        e["attention"] = a["attention"]["score"] if a else 1.0
    ranked = sorted(earn_states, key=lambda e: (e["attention"], e["market_cap"] or 0), reverse=True)
    earnings_kept = [e for e in ranked if e["attention"] >= J.EARNINGS_SHOW_MIN]
    if len(earnings_kept) < config.MIN_EARNINGS_SHOWN:
        earnings_kept = ranked[: config.MIN_EARNINGS_SHOWN]
    earnings_kept = earnings_kept[: config.MAX_EARNINGS_SHOWN]

    # ---- TypeSafe round 2: regime over the composed picture ---------------------------
    regime = None
    if use_ai:
        sp = rates.get("spreads", {})
        regime_state = {
            "session_date": session.isoformat(), "market_state": mstate,
            "macro_tape": [{"asset": r["label"], "last": r.get("last"), "change_pct": r.get("change_pct")} for r in macro],
            "indices": [{"index": i["name"], "chg_pct": i["chg_pct"], "trend": i["technicals"].get("trend"),
                         "rsi14": _r(i["technicals"].get("rsi14"), 1), "pct_from_52w_high": _r(i["technicals"].get("pct_from_hi52"), 1),
                         "ret_5d": _r(i["technicals"].get("ret_5d")), "ret_1m": _r(i["technicals"].get("ret_1m"))} for i in indices],
            "rates": {"as_of": rates.get("as_of"),
                      "curve_today_vs_month_ago": [{"tenor": c["label"], "today": c["today"], "month_ago": c["month_ago"]} for c in rates.get("curve", [])],
                      "spread_2s10s_bp": (sp.get("2s10s") or {}).get("latest"),
                      "spread_3m10y_bp": (sp.get("3m10y") or {}).get("latest"),
                      "chg_10y_1m_bp": _r(rates.get("chg_10y_1m_bp"), 1), "chg_2y_1m_bp": _r(rates.get("chg_2y_1m_bp"), 1),
                      "live_yields": [{"tenor": y["label"], "yield": y["last"], "change_bp_today": y["change_bp"]} for y in live_yields]},
            "flows": {"gauges": [{"gauge": g["label"], "rising_means": g["up_means"], "chg_1d": g["chg_1d"], "chg_5d": g["chg_5d"], "chg_1m": g["chg_1m"]} for g in gauges],
                      "breadth": breadth,
                      "sectors": [{"sector": s["label"], "chg_1d": s["chg_1d"], "chg_5d": s["chg_5d"], "chg_1m": s["chg_1m"]} for s in sectors]},
            "top_headlines": [h["headline"] for h in kept[:12]],
            "calendar_today": [f'{c["time_et"]} ET {c["country"]} {c["title"]}' for c in calendar_kept[:12]],
        }
        regime = await judge.run_one(regime_state, J.REGIME_QUESTIONS)

    # ---- round 2: stance per stock over the composed picture ----------------------------
    tone_now = regime["tone"]["choice"] if regime else "mixed"
    for s in stocks:
        s["plan"] = _plan(s)
        s["checklist"] = _checklist(s, tone_now)
    stance_stocks = [s for s in stocks if s.get("ai")]
    stance_ans = await judge.run_many([_stance_state(s, tone_now, mstate) for s in stance_stocks], J.STANCE_QUESTIONS)
    for s, ans in zip(stance_stocks, stance_ans):
        if ans:
            s["ai"]["stance"] = ans["stance"]
            s["ai"]["main_reason"] = ans["main_reason"]
            s["ai"]["intraday"] = ans["intraday"]
    for s in stocks:
        oa = ((s.get("options") or {}).get("ai") or {})
        if oa and oa["intensity"]["score"] >= J.OPTIONS_INTENSITY_FLAG and "heavy_options" not in s["tags"]:
            s["tags"].append("heavy_options")
        s["verdict"] = _verdict(s)


    try:
        social = await social_snapshot(judge)
    except Exception as e:  # noqa: BLE001
        log.warning("social snapshot failed: %s", e)
        social = None

    return _clean({
        "social": social,
        "build_id": uuid.uuid4().hex[:12],
        "generated_at": datetime.now(tz=config.ET).isoformat(),
        "session_date": session.isoformat(),
        "session_label": session.strftime("%A, %B %d, %Y"),
        "market_state": mstate,
        "ai_enabled": use_ai and (judge.calls > 0 or judge.rule_answers > 0),
        "ai_source": judge.source,
        "ai_stats": {"calls": judge.calls, "failures": judge.failures, "rule_answers": judge.rule_answers, "last_error": judge.last_error,
                     "input_tokens": judge.input_tokens, "output_tokens": judge.output_tokens},
        "regime": regime,
        "macro": macro,
        "world": world,
        "indices": indices,
        "rates": {**rates, "live": live_yields},
        "flows": {"gauges": gauges, "breadth": breadth, "sectors": sectors},
        "horizons": horizons_block,
        "theme": theme_block,
        "options": {"cboe": cboe, "rows": opt_rows, "ai": opt_market, "scanned": opt_market_state["scanned"],
                    "heavy": sorted([{**u, "ticker": o["ticker"]} for o in opt_rows for u in o.get("unusual", [])], key=lambda u: -u["notional"])[:20]},
        "smart_money": {"rows": [smart[t] for t in sm_keys], "congress_top": congress.get("top_buys", []), "congress_status": congress.get("status", "unavailable"),
                        "congress_as_of": congress.get("as_of")},
        "headlines": kept[: config.MAX_HEADLINES_SHOWN],
        "headlines_dropped": len(headlines) - len(kept),
        "headlines_judged": len(headlines),
        "stocks": stocks,
        "stocks_scanned": len(by_atr),
        "scan": {k: v for k, v in scan.items() if k != "by_ticker"} | {"judged": min(len(scan["rows"]), config.SCAN_MAX_JUDGED)},
        "low_float": {k: v for k, v in low_float.items()} | {"rows": [{k: v for k, v in r.items() if k != "intraday"} | {"intraday": _scan_slim(r.get("intraday"))} for r in low_float["rows"]],
                      "judged": min(len(low_float["rows"]), config.LOW_FLOAT_MAX_JUDGED)},
        "lite": _lite(all_symbols, snapshot, history, sym_names, scan["by_ticker"], set(theme_symbols)),
        "symbols_indexed": len(sym_names),
        "calendar": calendar_kept,
        "earnings": earnings_kept,
        "earnings_total": len(earnings),
        "watchlist": watch,
        "default_watchlist": config.DEFAULT_WATCHLIST,
        "elapsed_s": round(time.time() - t0, 1),
    })


def _clean(obj: Any) -> Any:
    """Strict-JSON safe: NaN/inf -> None, numpy scalars -> Python, tuples -> lists."""
    import math
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, bool) or obj is None or isinstance(obj, (str, int)):
        return obj
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if hasattr(obj, "item"):
        try:
            return _clean(obj.item())
        except Exception:  # noqa: BLE001
            return str(obj)
    return str(obj)


async def analyze_ticker(ticker: str, market_tone: str = "mixed", use_ai: bool = True) -> dict[str, Any] | None:
    """Full stock record for one ticker on demand (server mode: a name added from the page).
    Same pipeline as a build: technicals, price action, news, smart money, options, the
    round-1 stock read, then the stance round over the composed picture."""
    t = ticker.upper().strip()
    mstate = fetch.market_state()
    history = fetch.fetch_history([t], "1y")
    snapshot = fetch.fetch_snapshot([t], history)
    f = fetch.frame_for(history, t)
    s0 = snapshot.get(t)
    if f is None or not s0 or not s0.get("last_price"):
        return None
    s0["technicals"] = T.summarize(f, s0["last_price"])
    if not s0["technicals"]:
        return None
    meta = fetch.fetch_info([t]).get(t, {})
    s = _stock_record(t, s0, f, meta, mstate, on_watchlist=True, is_gapper=abs(s0["gap_pct"]) >= config.GAP_MIN_PCT, vol_rank=None, n_universe=None)
    smart = fetch.fetch_smart_money([t])
    if t in smart:
        smart[t]["congress"] = fetch.fetch_congress_trades().get("by_ticker", {}).get(t, [])[:8]
    options = fetch.fetch_options_flow([t])
    s["scan"] = _scan_slim(scanner.scan(fetch.fetch_intraday([t]), {t: s0}, [t], mstate)["by_ticker"].get(t))
    judge = Judge(enabled=use_ai)
    a, sm_a, op_a = await asyncio.gather(
        judge.run_one(_stock_state(s, mstate), J.STOCK_QUESTIONS),
        judge.run_many([_sm_state(t, smart[t], s["name"], s["technicals"])] if t in smart else [], J.SMART_MONEY_QUESTIONS),
        judge.run_many([_opt_state(t, options[t], s["name"], s0)] if options.get(t, {}).get("ok") else [], J.OPTIONS_QUESTIONS),
    )
    _compose_stock(s, a)
    s["smart"] = smart.get(t)
    if s["smart"] is not None:
        s["smart"]["ai"] = sm_a[0] if sm_a else None
    s["options"] = options.get(t)
    if s["options"] and op_a:
        s["options"]["ai"] = op_a[0]
    s["plan"] = _plan(s)
    s["checklist"] = _checklist(s, market_tone)
    if a:
        st = await judge.run_one(_stance_state(s, market_tone, mstate), J.STANCE_QUESTIONS)
        if st:
            s["ai"]["stance"], s["ai"]["main_reason"], s["ai"]["intraday"] = st["stance"], st["main_reason"], st["intraday"]
    oa = ((s.get("options") or {}).get("ai") or {})
    if oa and oa["intensity"]["score"] >= J.OPTIONS_INTENSITY_FLAG:
        s["tags"].append("heavy_options")
    s["verdict"] = _verdict(s)
    s["analyzed_at"] = datetime.now(tz=config.ET).isoformat()
    s["ai_stats"] = {"calls": judge.calls, "failures": judge.failures, "rule_answers": judge.rule_answers}
    s["ai_source"] = judge.source
    return _clean(s)


# ---------------------------------------------------------------------------
# Morning briefing, generated once a day at 07:00 ET for everyone
# ---------------------------------------------------------------------------
MEGA_CAPS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK-B", "JPM"]


def _hourly_read(sym: str, f: pd.DataFrame | None) -> dict[str, Any] | None:
    if f is None or "Close" not in f:
        return None
    d = f.dropna(subset=["Close"]).tail(160)
    if len(d) < 30:
        return None
    close = d["Close"]
    last = float(close.iloc[-1])
    sma20 = float(close.tail(20).mean())
    sma50 = float(close.tail(50).mean()) if len(close) >= 50 else None
    sma20_prev = float(close.iloc[-25:-5].mean()) if len(close) >= 25 else sma20
    sp = T.swing_points(d, lookback=3, bars=80)
    highs = [x["v"] for x in sp.get("swing_highs", [])]
    lows = [x["v"] for x in sp.get("swing_lows", [])]
    res = min([v for v in highs if v > last], default=None)
    sup = max([v for v in lows if v < last], default=None)
    ret24 = (last / float(close.iloc[-25]) - 1) * 100 if len(close) >= 25 else None
    # "yesterday" is the last completed session BEFORE today (ET), whether or not today's bars exist yet.
    today_et = datetime.now(tz=config.ET).date()
    days = sorted(set(d.index.date))
    before = [x for x in days if x < today_et]
    prev_day = before[-1] if before else None
    prev_day_close = None
    if prev_day is not None:
        if days[-1] > prev_day:                     # today's bars are in: change is today vs yesterday's close
            prev_day_close = float(d[d.index.date == prev_day]["Close"].iloc[-1])
        elif len(before) >= 2:                      # no bars today yet: the chart's last session IS yesterday; its change is vs the day before
            prev_day_close = float(d[d.index.date == before[-2]]["Close"].iloc[-1])
    return {
        "symbol": sym, "last": _r(last), "change_1d_pct": _r((last / prev_day_close - 1) * 100) if prev_day_close else None,
        "ret_24_bars_pct": _r(ret24), "rsi_1h": _r(T.rsi(close, 14), 1), "sma20": _r(sma20), "sma50": _r(sma50),
        "above_20_bar_avg": last > sma20, "above_50_bar_avg": (last > sma50) if sma50 else None,
        "avg20_slope_pct": _r((sma20 / sma20_prev - 1) * 100) if sma20_prev else None,
        "structure": sp.get("structure"), "nearest_support": _r(sup), "nearest_resistance": _r(res),
        "dist_support_pct": _r((last / sup - 1) * 100) if sup else None, "dist_resistance_pct": _r((res / last - 1) * 100) if res else None,
        "range_24_bars": [_r(float(d["Low"].tail(24).min())), _r(float(d["High"].tail(24).max()))],
        "prev_high": _r(float(d[d.index.date == prev_day]["High"].max())) if prev_day is not None else None,
        "prev_low": _r(float(d[d.index.date == prev_day]["Low"].min())) if prev_day is not None else None,
        "prev_day": prev_day.isoformat() if prev_day is not None else None,
        "bars": [{"t": ts.isoformat(), "o": _r(float(o)), "h": _r(float(h)), "l": _r(float(lo)), "c": _r(float(c))} for ts, o, h, lo, c in
                 zip(d.index[-48:], d["Open"].tail(48), d["High"].tail(48), d["Low"].tail(48), d["Close"].tail(48))],
    }


def _index_plan(x: dict[str, Any]) -> dict[str, Any]:
    """What we see, what we think, what could happen in the next 1-4 hours: written from the levels, in plain words."""
    last, sup, res = x.get("last"), x.get("nearest_support"), x.get("nearest_resistance")
    ph, pl = x.get("prev_high"), x.get("prev_low")
    a = x.get("ai") or {}
    see = []
    if x.get("above_20_bar_avg") is not None:
        see.append(f"price is {'above' if x['above_20_bar_avg'] else 'below'} its 20-bar average" + (f" and {'above' if x['above_50_bar_avg'] else 'below'} the 50-bar" if x.get("above_50_bar_avg") is not None else ""))
    if x.get("structure"):
        see.append({"uptrend_hh_hl": "higher highs and higher lows on the 1-hour chart", "downtrend_lh_ll": "lower highs and lower lows on the 1-hour chart"}.get(x["structure"], str(x["structure"]).replace("_", " ")))
    if isinstance(x.get("rsi_1h"), (int, float)):
        r = x["rsi_1h"]; see.append(f"1-hour RSI {r:.0f}" + (" (overbought)" if r >= 70 else " (oversold)" if r <= 30 else ""))
    if ph and pl:
        see.append(f"{x.get('prev_day') or 'yesterday'} range {pl:,.2f} to {ph:,.2f}")
    levels = []
    if res:
        levels.append(f"Above {res:,.2f}: the ceiling gives way and a push toward the next high is on.")
    if ph and res and abs(ph - res) / (last or 1) > 0.002:
        levels.append(f"{x.get('prev_day') or 'Yesterday'} high {ph:,.2f} is the first test on the way up.")
    if sup:
        levels.append(f"Below {sup:,.2f}: the trend read flips lower and sellers get the ball.")
    if pl and sup and abs(pl - sup) / (last or 1) > 0.002:
        levels.append(f"{x.get('prev_day') or 'Yesterday'} low {pl:,.2f} is the line the bulls must hold.")
    if sup and res:
        levels.append(f"Between {sup:,.2f} and {res:,.2f}: expect two-way trade until one side breaks.")
    if isinstance(x.get("now_price"), (int, float)) and isinstance(x.get("now_chg_pct"), (int, float)):
        gap = x["now_chg_pct"]
        see.insert(0, f"trading {x['now_price']:,.2f} right now, {'up' if gap >= 0 else 'down'} {abs(gap):.2f}% from yesterday's close" + (", above the resistance the chart closed under" if x.get("now_vs_resistance") == "above" else ", already under support" if x.get("now_vs_support") == "below" else ""))
    nh = (a.get("next_hours") or {}).get("choice")
    shape = {"push_and_extend": "the likelier shape for the first hours is an open above the prior high that keeps going",
             "fade_after_open": "the likelier shape is an early push that fails at resistance and gives the gain back",
             "chop_then_trend": "the likelier shape is two-way trade inside yesterday's range, then a move once a level breaks",
             "sell_off_early": "the likelier shape is an open under support with sellers pressing from the start"}.get(nh)
    return {"see": see, "levels": levels, "shape": shape, "next_hours": nh}


def _brief_inputs(report: dict[str, Any]) -> dict[str, Any]:
    """Everything the briefing needs, fetched synchronously (run in a thread)."""
    by_ticker = {s["ticker"]: s for s in report.get("stocks", [])}
    lite = report.get("lite") or {}
    missing = [t for t in MEGA_CAPS if not (lite.get(t) or {}).get("last_price") and not (by_ticker.get(t) or {}).get("last_price")]
    quotes = fetch.fetch_quotes(missing + ["^FVX"])
    mega = []
    for t in MEGA_CAPS:
        s = by_ticker.get(t); l = lite.get(t) or {}; q = quotes.get(t) or {}
        # the report's snapshot includes pre-market prints and the change against the prior close; fast_info is only a fallback
        last = (s or {}).get("last_price") or l.get("last_price") or q.get("last")
        chg = (s or {}).get("chg_pct") if s and s.get("chg_pct") is not None else (l.get("chg_pct") if l.get("chg_pct") is not None else q.get("change_pct"))
        mega.append({"ticker": t, "name": (s or {}).get("name") or l.get("name") or t, "last": last, "chg_pct": chg,
                     "verdict": (s or {}).get("verdict"), "market_cap": ((s or {}).get("fundamentals") or {}).get("market_cap")})
    macro = {m["symbol"]: m for m in report.get("macro", [])}
    tape = []
    for sym, label in (("ES=F", "S&P 500 futures"), ("NQ=F", "Nasdaq 100 futures"), ("^VIX", "VIX"), ("CL=F", "Oil (WTI)"), ("GC=F", "Gold"), ("BTC-USD", "Bitcoin"), ("DX-Y.NYB", "Dollar")):
        m = macro.get(sym)
        if m:
            tape.append({"symbol": sym, "label": label, "last": m.get("last"), "chg_pct": m.get("change_pct"), "kind": m.get("kind")})
    y10 = macro.get("^TNX") or {}
    y5 = quotes.get("^FVX") or {}
    yields = {"10y": _r(y10.get("last")), "10y_chg_bp": _r((y10.get("change") or 0) * 100, 0) if y10.get("change") is not None else None,
              "5y": _r(y5.get("last")), "5y_chg_bp": _r((y5.get("change") or 0) * 100, 0) if y5.get("change") is not None else None}
    hourly = fetch.download(["SPY", "QQQ"], period="1mo", interval="1h")
    idx = {sym: _hourly_read(sym, fetch.frame_for(hourly, sym)) for sym in ("SPY", "QQQ")}
    # the 1-hour chart stops at the last regular close; add where the index trades NOW (pre-market or live) and the gap
    for sym, x in idx.items():
        if not x:
            continue
        l = lite.get(sym) or {}
        ind = next((i for i in report.get("indices", []) if i.get("symbol") == sym), None) or {}
        now_px = l.get("last_price") or ind.get("last")
        now_chg = l.get("chg_pct") if l.get("chg_pct") is not None else ind.get("chg_pct")
        x["as_of_close"] = x.get("bars", [{}])[-1].get("t") if x.get("bars") else None
        x["now_price"] = _r(now_px); x["now_chg_pct"] = _r(now_chg)
        x["now_vs_resistance"] = "above" if now_px and x.get("nearest_resistance") and now_px > x["nearest_resistance"] else ("below" if now_px and x.get("nearest_resistance") else None)
        x["now_vs_support"] = "below" if now_px and x.get("nearest_support") and now_px < x["nearest_support"] else ("above" if now_px and x.get("nearest_support") else None)
    social = report.get("social") or {}
    cutoff = (datetime.now(tz=config.ET) - timedelta(hours=24)).isoformat()
    trump = [p for p in (social.get("trump") or {}).get("posts", []) if p.get("ai") and ((p["ai"].get("market_relevance") or {}).get("p", 0) >= 0.5) and (p.get("posted") or "") >= cutoff[:19]]
    events = [c for c in report.get("calendar", []) if (c.get("relevance") or 0) >= 1.5][:6] or report.get("calendar", [])[:4]
    # the session so far: index ETFs, sector leaders and laggards, the biggest movers among analysed names, scanner count
    ind = {i["symbol"]: i for i in report.get("indices", [])}
    session = {"indexes": [{"symbol": k, "name": v.get("name"), "last": v.get("last"), "chg_pct": v.get("chg_pct")} for k, v in ind.items() if k in ("SPY", "QQQ", "IWM", "DIA")]}
    secs = sorted([x for x in ((report.get("flows") or {}).get("sectors") or []) if isinstance(x.get("chg_1d"), (int, float))], key=lambda x: -x["chg_1d"])
    session["leaders"] = [{"label": x["label"], "chg_pct": x["chg_1d"]} for x in secs[:3]]
    session["laggards"] = [{"label": x["label"], "chg_pct": x["chg_1d"]} for x in secs[-3:]][::-1]
    movers = sorted([s for s in report.get("stocks", []) if isinstance(s.get("chg_pct"), (int, float))], key=lambda s: -abs(s["chg_pct"]))[:6]
    session["movers"] = [{"ticker": s["ticker"], "name": s.get("name"), "chg_pct": s["chg_pct"], "read": (s.get("verdict") or {}).get("word")} for s in movers]
    session["scan_qualified"] = (report.get("scan") or {}).get("qualified")
    session["breadth"] = (report.get("flows") or {}).get("breadth")
    return {"mega": mega, "tape": tape, "yields": yields, "indexes": idx, "trump": trump[:5], "events": events, "session": session}


def _pct_word(x: float) -> str:
    return f"{'up' if x >= 0 else 'down'} {abs(x):.1f}%"


def _brief_summary(b: dict[str, Any], slot: str = "morning") -> str:
    bits = []
    if slot in ("midday", "close"):
        ses = b.get("session") or {}
        idx = {x["symbol"]: x for x in ses.get("indexes", [])}
        parts = [f"{n} {_pct_word(idx[s]['chg_pct'])}" for s, n in (("SPY", "S&P 500"), ("QQQ", "Nasdaq 100"), ("IWM", "small caps")) if idx.get(s) and isinstance(idx[s].get("chg_pct"), (int, float))]
        if parts:
            bits.append(("At 1 pm: " if slot == "midday" else "At the close: ") + ", ".join(parts))
        if ses.get("leaders"):
            bits.append(f"leading: {', '.join(x['label'] for x in ses['leaders'][:2])}; lagging: {', '.join(x['label'] for x in ses['laggards'][:2])}")
        if ses.get("movers"):
            bits.append("biggest moves among analysed names: " + ", ".join(f"{m['ticker']} {_pct_word(m['chg_pct'])}" for m in ses["movers"][:3]))
        if isinstance(ses.get("scan_qualified"), int):
            bits.append(f"{ses['scan_qualified']} names trading far above normal")
        reads = {k: (v or {}).get("ai") for k, v in b["indexes"].items()}
        words = {"push_higher": "pointing higher", "pullback_then_higher": "stretched, a dip is likelier first", "range_bound": "range-bound", "break_lower": "at risk of breaking lower", "rebound": "set up for a rebound"}
        for sym in ("SPY", "QQQ"):
            a = reads.get(sym)
            if a and a.get("next_move"):
                bits.append(f"{sym} 1-hour chart {('into ' + _next_session_name() + ' ') if slot == 'close' else ''}{words.get(a['next_move']['choice'], a['next_move']['choice'])}")
        return ". ".join(x[0].upper() + x[1:] for x in bits) + "." if bits else "No session data yet."

    t = {x["symbol"]: x for x in b["tape"]}
    es = t.get("ES=F")
    if es and isinstance(es.get("chg_pct"), (int, float)):
        bits.append(f"S&P futures {'up' if es['chg_pct'] >= 0 else 'down'} {abs(es['chg_pct']):.1f}%")
    for sym, name in (("CL=F", "oil"), ("GC=F", "gold"), ("BTC-USD", "bitcoin")):
        m = t.get(sym)
        if m and isinstance(m.get("chg_pct"), (int, float)) and abs(m["chg_pct"]) >= 0.8:
            bits.append(f"{name} {'up' if m['chg_pct'] >= 0 else 'down'} {abs(m['chg_pct']):.1f}%")
    y = b["yields"]
    if isinstance(y.get("10y"), (int, float)):
        bits.append(f"10-year at {y['10y']:.2f}%")
    for sym in ("SPY", "QQQ"):
        x = b["indexes"].get(sym) or {}
        if isinstance(x.get("now_chg_pct"), (int, float)) and abs(x["now_chg_pct"]) >= 0.15:
            bits.append(f"{sym} {'up' if x['now_chg_pct'] >= 0 else 'down'} {abs(x['now_chg_pct']):.1f}% pre-market")
    reads = {k: (v or {}).get("ai") for k, v in b["indexes"].items()}
    words = {"push_higher": "pointing higher", "pullback_then_higher": "stretched, a dip is likelier first", "range_bound": "range-bound", "break_lower": "at risk of breaking lower", "rebound": "set up for a rebound"}
    for sym in ("SPY", "QQQ"):
        a = reads.get(sym)
        if a and a.get("next_move"):
            bits.append(f"{sym} 1-hour chart {words.get(a['next_move']['choice'], a['next_move']['choice'])}")
    if b["trump"]:
        bits.append(f"{len(b['trump'])} market-relevant Trump post{'s' if len(b['trump']) > 1 else ''} overnight")
    return ". ".join(x[0].upper() + x[1:] for x in bits) + "." if bits else "Quiet overnight."


async def morning_brief(report: dict[str, Any], judge: "Judge", slot: str = "morning") -> dict[str, Any]:
    b = await asyncio.to_thread(_brief_inputs, report)
    b["slot"] = slot
    b["title"] = {"morning": "Morning briefing", "close": "After the close"}.get(slot, slot)
    states = [{k: v for k, v in (b["indexes"][sym] or {}).items() if k != "bars"} | {"name": {"SPY": "S&P 500 ETF", "QQQ": "Nasdaq 100 ETF"}[sym], "note": "the 1-hour facts describe the chart at the last regular close; now_price / now_chg_pct is where it trades at this moment (pre-market when before 09:30)"} for sym in ("SPY", "QQQ") if b["indexes"].get(sym)]
    ans = await judge.run_many(states, J.BRIEF_INDEX_QUESTIONS)
    b["source"] = judge.source
    for st, a in zip(states, ans):
        if b["indexes"].get(st["symbol"]) is not None:
            b["indexes"][st["symbol"]]["ai"] = a
            b["indexes"][st["symbol"]]["plan"] = _index_plan(b["indexes"][st["symbol"]])
    now = datetime.now(tz=config.ET)
    b["date"] = now.date().isoformat()
    b["generated_at"] = now.isoformat()
    b["summary"] = _brief_summary(b, slot)
    b["note"] = "For monitoring only. Reads come from textbook technicals and public data; nothing here is financial advice."
    return _clean(b)


# ---------------------------------------------------------------------------
# Intraday direction: every 15 minutes of the regular session, technicals plus mood, stored for scoring
# ---------------------------------------------------------------------------
def _intraday_inputs(report: dict[str, Any]) -> dict[str, Any]:
    intraday = fetch.fetch_intraday(["SPY", "QQQ"])
    hourly = fetch.download(["SPY", "QQQ"], period="1mo", interval="1h")
    out: dict[str, Any] = {}
    for sym in ("SPY", "QQQ"):
        f15 = fetch.frame_for(intraday, sym)
        ses = scanner._session_stats(scanner._regular(f15)) if f15 is not None and "Close" in f15 else {}
        h = _hourly_read(sym, fetch.frame_for(hourly, sym)) or {}
        out[sym] = {"last": _r(ses.get("last")) if ses else h.get("last"), "chg_day_pct": ses.get("chg_pct") if ses else h.get("change_1d_pct"),
                    "above_vwap": ses.get("above_vwap"), "vwap": _r(ses.get("vwap")), "range_pos": ses.get("range_pos"), "chg_from_open_pct": ses.get("chg_from_open_pct"),
                    "hourly": {k: h.get(k) for k in ("rsi_1h", "above_20_bar_avg", "above_50_bar_avg", "avg20_slope_pct", "structure", "nearest_support", "nearest_resistance", "dist_support_pct", "dist_resistance_pct")}}
    social = report.get("social") or {}
    crowd = {x["ticker"]: x for x in ((social.get("crowd") or {}).get("rows") or [])}
    cutoff = (datetime.now(tz=config.ET) - timedelta(hours=6)).isoformat()[:19]
    posts = [p for p in ((social.get("trump") or {}).get("posts") or []) if p.get("ai") and ((p["ai"].get("market_relevance") or {}).get("p", 0) >= 0.5) and (p.get("posted") or "") >= cutoff]
    leans = [((p["ai"].get("direction") or {}).get("choice")) for p in posts]
    st_snap = fetch._cache_get("stocktwits_snapshot", 3 * 3600) or {}
    st_m = st_snap.get("moods") or {}
    trump_lean = "none" if not leans else ("bullish" if leans.count("bullish_for_stocks") > leans.count("bearish_for_stocks") else "bearish" if leans.count("bearish_for_stocks") > leans.count("bullish_for_stocks") else "mixed")
    B = (report.get("flows") or {}).get("breadth") or {}
    now = datetime.now(tz=config.ET)
    from . import db as _db
    st = _db.direction_stats(30)
    hist = {"reads_scored": (st.get("totals") or {}).get("scored") or 0,
            "hit_rate_by_answer": {x["expected"]: (round(x["hits"] / x["scored"] * 100) if x.get("scored") else None) for x in st.get("by_expected", []) if x.get("expected")}}
    return {"time_et": now.strftime("%H:%M"), "minutes_to_close": max(0, 16 * 60 - (now.hour * 60 + now.minute)), "history": hist,
            "spy": out["SPY"], "qqq": out["QQQ"], "breadth_pct_above_20d": _r(B["above20"] / B["n"] * 100, 0) if B.get("n") else None,
            "sentiment": {"reddit_spy": (crowd.get("SPY") or {}).get("wsb_sentiment") or "none", "reddit_qqq": (crowd.get("QQQ") or {}).get("wsb_sentiment") or "none",
                          "stocktwits_spy": {"label": (st_m.get("SPY") or {}).get("label"), "score_0_100": (st_m.get("SPY") or {}).get("score"), "bullish_pct": (st_m.get("SPY") or {}).get("bullish_pct")} if st_m.get("SPY") else "not connected",
                          "stocktwits_qqq": {"label": (st_m.get("QQQ") or {}).get("label"), "score_0_100": (st_m.get("QQQ") or {}).get("score"), "bullish_pct": (st_m.get("QQQ") or {}).get("bullish_pct")} if st_m.get("QQQ") else "not connected",
                          "trump_lean_recent": trump_lean, "trump_posts_6h": len(posts)}}


async def intraday_read(report: dict[str, Any], judge: "Judge") -> dict[str, Any]:
    st = await asyncio.to_thread(_intraday_inputs, report)
    ans = await judge.run_one(st, J.INTRADAY_DIRECTION_QUESTIONS)
    return _clean({"at": datetime.now(tz=config.ET).isoformat(), "date": datetime.now(tz=config.ET).date().isoformat(), "facts": st, "ai": ans,
                   "expected": (ans or {}).get("direction", {}).get("choice"), "confidence": (ans or {}).get("direction", {}).get("confidence"),
                   "driver": (ans or {}).get("driver", {}).get("choice"), "source": judge.source})


def score_direction(expected: str, move_pct: float | None, flat_band: float = 0.15) -> int | None:
    """1 hit / 0 miss for one read against the move from the read's price to the close."""
    if move_pct is None or not expected:
        return None
    if expected == "higher":
        return 1 if move_pct > 0 else 0
    if expected == "lower":
        return 1 if move_pct < 0 else 0
    return 1 if abs(move_pct) <= flat_band else 0


def _next_session_name() -> str:
    d = datetime.now(tz=config.ET).date() + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.strftime("%A")


def week_and_mood(report: dict[str, Any], desk: dict[str, Any] | None = None) -> dict[str, Any]:
    """Extras for the after-the-close email: the week so far for SPY and QQQ, the crowd's mood, and the next session's name."""
    now = datetime.now(tz=config.ET)
    nxt = now.date() + timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)
    next_session = nxt.strftime("%A")
    week: dict[str, Any] = {}
    try:
        hist = fetch.download(["SPY", "QQQ"], period="1mo", interval="1d", prepost=False)
        monday = now.date() - timedelta(days=now.weekday())
        for sym in ("SPY", "QQQ"):
            f = fetch.frame_for(hist, sym)
            if f is None or "Close" not in f:
                continue
            days = [(i.date(), float(o), float(h), float(lo), float(c)) for i, o, h, lo, c in zip(f.index, f["Open"], f["High"], f["Low"], f["Close"])]
            this = [d for d in days if d[0] >= monday]
            before = [d for d in days if d[0] < monday]
            if not this or not before:
                continue
            base = before[-1][4]
            hi = max(this, key=lambda d: d[2]); lo = min(this, key=lambda d: d[3])
            close = this[-1][4]
            rng = hi[2] - lo[3]
            pos = (close - lo[3]) / rng if rng else 0.5
            chg = [(d[0], (d[4] / p[4] - 1) * 100) for p, d in zip(before[-1:] + this[:-1], this)]
            best = max(chg, key=lambda x: x[1]); worst = min(chg, key=lambda x: x[1])
            ret = (close / base - 1) * 100
            if ret > 0.3 and pos >= 0.7:
                shape = "up on the week and finishing near the highs: buyers stayed in control into the close"
            elif ret > 0.3:
                shape = "up on the week but off the highs: gains were given back late"
            elif ret < -0.3 and pos <= 0.3:
                shape = "down on the week and finishing near the lows: sellers had the last word"
            elif ret < -0.3:
                shape = "down on the week but well off the lows: dip buyers showed up"
            else:
                shape = "a flat week inside a range: neither side won"
            week[sym] = {"ret_pct": round(ret, 2), "base": round(base, 2), "close": round(close, 2), "high": round(hi[2], 2), "high_day": hi[0].strftime("%A"),
                         "low": round(lo[3], 2), "low_day": lo[0].strftime("%A"), "range_pos": round(pos, 2), "days": len(this),
                         "best_day": (best[0].strftime("%A"), round(best[1], 2)), "worst_day": (worst[0].strftime("%A"), round(worst[1], 2)), "shape": shape}
    except Exception as e:  # noqa: BLE001
        log.warning("week summary failed: %s", e)
    # ---- mood ----
    st = fetch._cache_get("stocktwits_snapshot", 12 * 3600) or {}
    moods = st.get("moods") or {}
    lab = {"EXTREMELY_BULLISH": "very bullish", "BULLISH": "bullish", "NEUTRAL": "neutral", "BEARISH": "bearish", "EXTREMELY_BEARISH": "very bearish"}
    crowd = {x["ticker"]: x for x in (((report.get("social") or {}).get("crowd") or {}).get("rows") or [])}
    trump = (report.get("social") or {}).get("trump") or {}
    posts = [p for p in (trump.get("posts") or []) if p.get("ai") and ((p["ai"].get("market_relevance") or {}).get("p", 0) >= 0.5)]
    bull = sum(1 for p in posts if (p["ai"].get("direction") or {}).get("choice") == "bullish_for_stocks")
    bear = sum(1 for p in posts if (p["ai"].get("direction") or {}).get("choice") == "bearish_for_stocks")
    macro = (desk or {}).get("macro") or {}
    sent = {"stocktwits": {s: {"label": lab.get((moods.get(s) or {}).get("label"), "no read"), "bullish_pct": (moods.get(s) or {}).get("bullish_pct"), "score": (moods.get(s) or {}).get("score"), "delta": (moods.get(s) or {}).get("bullish_delta")} for s in ("SPY", "QQQ") if moods.get(s)},
            "reddit": {s: {"sentiment": (crowd.get(s) or {}).get("wsb_sentiment"), "mentions": (crowd.get(s) or {}).get("mentions")} for s in ("SPY", "QQQ") if crowd.get(s)},
            "reddit_top": [(x["ticker"], x.get("mentions"), x.get("wsb_sentiment")) for x in list(crowd.values())[:5]],
            "trump": {"bullish": bull, "bearish": bear, "n": len(posts)},
            "backdrop": {"headline": macro.get("headline"), "verdict": (macro.get("verdict") or {}).get("word"), "text": (macro.get("verdict") or {}).get("text")}}
    scores = [v["score"] for v in sent["stocktwits"].values() if isinstance(v.get("score"), (int, float))]
    avg = sum(scores) / len(scores) if scores else None
    tone = "hot" if avg is not None and avg >= 80 else "warm" if avg is not None and avg >= 60 else "cool" if avg is not None and avg >= 40 else "cold" if avg is not None else "unknown"
    bits = []
    if sent["stocktwits"]:
        bits.append("StockTwits is " + " and ".join(f"{v['label']} on {s}" + (f" ({v['bullish_pct']:.0f}% bullish{', rising' if (v.get('delta') or 0) > 2 else ', fading' if (v.get('delta') or 0) < -2 else ''})" if isinstance(v.get("bullish_pct"), (int, float)) else "") for s, v in sent["stocktwits"].items()))
    if sent["reddit"]:
        bits.append("Reddit leans " + " and ".join(f"{(v['sentiment'] or 'neutral').lower()} on {s}" for s, v in sent["reddit"].items()))
    if posts:
        bits.append(f"the President's market posts split {bull} bullish, {bear} bearish")
    if macro.get("headline"):
        bits.append(f"the backdrop gauges read '{macro['headline'].lower()}', {str((macro.get('verdict') or {}).get('word', '')).lower()} for buyers")
    meaning = {"hot": "Sentiment is running hot: crowded optimism is when pullbacks surprise people, so keep stops honest.",
               "warm": "Sentiment is warm but not euphoric: room left before the crowd is all-in.",
               "cool": "Sentiment is cool: the crowd is not chasing, which is usually healthier for the next leg.",
               "cold": "Sentiment is cold: fear is high, and that is where rebounds start.", "unknown": ""}[tone]
    sent["tone"] = tone; sent["summary"] = "; ".join(bits) + ("." if bits else ""); sent["meaning"] = meaning
    return {"next_session": next_session, "week": week, "sentiment": sent, "week_complete": now.weekday() == 4}


def close_whatsapp_text(brief: dict[str, Any], keep_url: str = "", site_url: str = "") -> str:
    """Short after-the-close post for the WhatsApp group: the close, our reads, the week, the mood, the levels."""
    ses = brief.get("session") or {}
    idx = {x.get("symbol"): x for x in ses.get("indexes") or []}
    sc = brief.get("scorecard") or {}
    ex = brief.get("extras") or {}
    nxt = ex.get("next_session") or "tomorrow"
    pct = lambda x: ("+" if x >= 0 else "−") + f"{abs(x):.1f}%" if isinstance(x, (int, float)) else "–"
    names = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Small caps", "DIA": "Dow"}
    date_label = datetime.strptime(brief["date"], "%Y-%m-%d").strftime("%A %b %d")
    L = ([site_url, ""] if site_url else []) + [f"*OneView · After the close · {date_label}*", ""]   # link first so WhatsApp shows the preview card
    L.append(" · ".join(f"{names.get(k, k)} {pct((idx.get(k) or {}).get('chg_pct'))}" for k in ("SPY", "QQQ", "IWM", "DIA") if idx.get(k)))
    leaders = ", ".join(f"{x.get('label')} {pct(x.get('chg_pct'))}" for x in (ses.get("leaders") or [])[:2])
    laggards = ", ".join(f"{x.get('label')} {pct(x.get('chg_pct'))}" for x in (ses.get("laggards") or [])[:2])
    if leaders:
        L.append(f"Leading: {leaders}. Lagging: {laggards}.")
    movers = (ses.get("movers") or [])[:4]
    if movers:
        L.append("Big moves: " + ", ".join(f"{x.get('ticker')} {pct(x.get('chg_pct'))}" for x in movers))
    if sc.get("scored"):
        L += ["", f"*Our 15-minute reads:* {sc.get('hits', 0)} of {sc['scored']} right ({sc.get('hit_rate')}%)"]
    week = ex.get("week") or {}
    if week:
        L += ["", "*The week*"] + [f"{names.get(s, s)} {pct((week.get(s) or {}).get('ret_pct'))} · high {(week.get(s) or {}).get('high')} ({(week.get(s) or {}).get('high_day')}) · low {(week.get(s) or {}).get('low')} ({(week.get(s) or {}).get('low_day')})" for s in ("SPY", "QQQ") if week.get(s)]
        shape = (week.get("SPY") or {}).get("shape")
        if shape:
            L.append(shape[0].upper() + shape[1:] + ".")
    mood = ex.get("sentiment") or {}
    if mood.get("summary"):
        L += ["", "*Market mood*", mood["summary"]]
        if mood.get("meaning"):
            L.append(mood["meaning"])
    plans = []
    for sym in ("SPY", "QQQ"):
        x = (brief.get("indexes") or {}).get(sym) or {}
        pl = x.get("plan") or {}
        if pl:
            plans.append((sym, x.get("last"), (pl.get("levels") or [])[:3]))
    if plans:
        L += ["", f"*Into {nxt}*"]
        for sym, last, levels in plans:
            L.append(f"{sym} {last:.2f}" if isinstance(last, (int, float)) else sym)
            L += [f"• {l}" for l in levels]
    L += [""]
    if site_url:
        L.append("Sign in at the link above for the full read and your own watchlist.")
    if keep_url:
        L.append(f"Emails landing in junk? Tap once: {keep_url}")
    L.append("_Information, not advice._")
    return "\n".join(L)
