"""Intraday volume scanner. Runs automatically inside every build over
30-minute regular-session bars, which are also rolled up into 1-hour and
2-hour bars. No AI here: the scores are arithmetic over volume, range and
price; TypeSafe reads the top names afterwards (judgments.SCAN_QUESTIONS).

Settings live in config (SCAN_*). What a day trader usually screens for:
  * relative volume by time of day (today's volume so far vs the same clock
    time over the prior sessions), not just vs a full-day average
  * volume building bar over bar on the timeframe, with the last three bars
    well above the 20-bar norm
  * range expansion (the bar's range vs the timeframe's ATR)
  * price confirming: above session VWAP, breaking the 20-bar high or low
"""
from __future__ import annotations

from datetime import time
from typing import Any

import numpy as np
import pandas as pd

from . import config
from . import fetch
from . import technicals as T

REGULAR_OPEN, REGULAR_CLOSE = time(9, 30), time(16, 0)
MOMENTUM_CAP = {1: 1.5, 2: 2.0, 4: 3.0, 8: 4.0}      # |3-bar move| in % that scores full marks, by 15-minute bars per candle


def _regular(df: pd.DataFrame) -> pd.DataFrame:
    idx = df.index
    idx = idx.tz_localize("UTC") if idx.tz is None else idx
    df = df.copy()
    df.index = idx.tz_convert(config.ET)
    df = df.dropna(subset=["Close"])
    return df[(df.index.time >= REGULAR_OPEN) & (df.index.time < REGULAR_CLOSE)]


def _roll_up(df30: pd.DataFrame, n: int) -> pd.DataFrame:
    """Group n consecutive 30-minute bars within each session into one candle."""
    if n == 1:
        return df30
    d = df30.copy()
    pos = d.groupby(d.index.date).cumcount() // n
    key = pd.Series(list(zip(d.index.date, pos)), index=d.index)
    g = d.groupby(key.values, sort=False)
    out = g.agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
    first = g.apply(lambda x: x.index[0])
    out.index = pd.DatetimeIndex(first.values).tz_localize("UTC").tz_convert(config.ET)   # .values drops the tz; restore it
    out = out.sort_index()
    return out


def _tf_stats(bars: pd.DataFrame, look: int = 20) -> dict[str, Any] | None:
    if len(bars) < look + 4:
        return None
    v = bars["Volume"].astype(float)
    last = bars.iloc[-1]
    prior = v.iloc[-(look + 1):-1]
    avg = float(prior.mean()) if len(prior) else 0.0
    if not avg:
        return None
    last3 = v.iloc[-3:]
    building = 0
    for i in range(len(v) - 1, 0, -1):
        if v.iloc[i] > v.iloc[i - 1] and v.iloc[i] > 0:
            building += 1
        else:
            break
        if building >= 5:
            break
    tr = T.true_range(bars)
    atr = float(tr.rolling(14).mean().iloc[-1]) if len(tr) >= 14 else float(tr.mean())
    rng = float(last["High"] - last["Low"])
    close = float(last["Close"])
    chg3 = (close / float(bars["Close"].iloc[-4]) - 1) * 100
    hi20 = float(bars["High"].iloc[-(look + 1):-1].max())
    lo20 = float(bars["Low"].iloc[-(look + 1):-1].min())
    return {
        "bar_time": bars.index[-1].isoformat(),
        "vol_last": float(last["Volume"]), "vol_avg20": avg,
        "vol_ratio_last": round(float(last["Volume"]) / avg, 2),
        "vol_ratio_3bar": round(float(last3.mean()) / avg, 2),
        "building_bars": building,
        "range_vs_atr": round(rng / atr, 2) if atr else None,
        "chg_3bar_pct": round(chg3, 2),
        "rsi14": T.rsi(bars["Close"], 14),
        "breakout": close > hi20, "breakdown": close < lo20,
        "close_location": round((close - float(last["Low"])) / rng, 2) if rng else None,
        "direction": "up" if chg3 > 0 else ("down" if chg3 < 0 else "flat"),
    }


def _score_tf(s: dict[str, Any] | None, n: int, above_vwap: bool | None) -> float:
    if not s:
        return 0.0
    vol = min(s["vol_ratio_3bar"], 4.0) / 4.0 * 40
    build = min(s["building_bars"], 3) / 3 * 15
    rng = min(s["range_vs_atr"] or 0, 2.5) / 2.5 * 15
    cap = MOMENTUM_CAP.get(n, 4.0)
    mom = min(abs(s["chg_3bar_pct"]), cap) / cap * 15
    confirm = (10 if (s["breakout"] or s["breakdown"]) else 0) + (5 if above_vwap is not None and (above_vwap == (s["direction"] != "down")) else 0)
    return round(vol + build + rng + mom + confirm, 1)


def _session_stats(df30: pd.DataFrame, prior_sessions: int = 10) -> dict[str, Any]:
    days = sorted(set(df30.index.date))
    if not days:
        return {}
    today = days[-1]
    cur = df30[df30.index.date == today]
    k = len(cur)
    tp = (cur["High"] + cur["Low"] + cur["Close"]) / 3
    vol_sum = float(cur["Volume"].sum())
    vwap = float((tp * cur["Volume"]).sum() / vol_sum) if vol_sum else None
    prior = [df30[df30.index.date == d] for d in days[-(prior_sessions + 1):-1]]
    same_time = [float(p["Volume"].iloc[:k].sum()) for p in prior if len(p) >= k]
    full = [float(p["Volume"].sum()) for p in prior]
    rvol_tod = round(vol_sum / (sum(same_time) / len(same_time)), 2) if same_time and sum(same_time) else None
    last = float(cur["Close"].iloc[-1])
    hod, lod = float(cur["High"].max()), float(cur["Low"].min())
    prev_close = float(prior[-1]["Close"].iloc[-1]) if prior and len(prior[-1]) else None
    return {"session_date": today.isoformat(), "bars_today": k, "session_volume": vol_sum,
            "prev_close": prev_close, "chg_pct": round((last / prev_close - 1) * 100, 2) if prev_close else None,
            "avg_session_volume": round(sum(full) / len(full)) if full else None,
            "rvol_time_of_day": rvol_tod, "vwap": round(vwap, 4) if vwap else None,
            "above_vwap": (last > vwap) if vwap else None, "hod": hod, "lod": lod,
            "range_pos": round((last - lod) / (hod - lod), 2) if hod > lod else None,
            "open": float(cur["Open"].iloc[0]), "last": last,
            "chg_from_open_pct": round((last / float(cur["Open"].iloc[0]) - 1) * 100, 2) if float(cur["Open"].iloc[0]) else None}


def scan(intraday: pd.DataFrame, snapshot: dict[str, dict[str, Any]], tickers: list[str], market_state: str) -> dict[str, Any]:
    stats: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    for t in tickers:
        f = fetch.frame_for(intraday, t)
        if f is None or "Close" not in f:
            continue
        df30 = _regular(f)
        if len(df30) < 40:
            continue
        ses = _session_stats(df30)
        tfs: dict[str, Any] = {}
        for name, n in config.SCAN_TIMEFRAMES.items():
            st = _tf_stats(_roll_up(df30, n))
            if st:
                st["score"] = _score_tf(st, n, ses.get("above_vwap"))
                tfs[name] = st
        if not tfs:
            continue
        overall = round(sum(config.SCAN_TF_WEIGHTS[k] * tfs[k]["score"] for k in tfs) / sum(config.SCAN_TF_WEIGHTS[k] for k in tfs), 1)
        snap = snapshot.get(t) or {}
        price = snap.get("last_price") or ses.get("last")
        passed = {
            "price": bool(price and price >= config.SCAN_MIN_PRICE),
            "volume": bool((ses.get("session_volume") or 0) >= config.SCAN_MIN_SESSION_VOLUME),
            "rvol": bool((ses.get("rvol_time_of_day") or 0) >= config.SCAN_MIN_RVOL or any(x["vol_ratio_3bar"] >= 2.0 for x in tfs.values())),
        }
        lead = max(tfs, key=lambda k: tfs[k]["score"])
        rec = {"ticker": t, "name": None, "price": price, "chg_pct": snap.get("gap_pct") if snap.get("gap_pct") is not None else ses.get("chg_pct"),
               "session": ses, "timeframes": tfs, "score": overall, "lead_timeframe": lead,
               "direction": tfs[lead]["direction"], "passed": passed, "qualifies": all(passed.values()),
               "daily": {k: (snap.get("technicals") or {}).get(k) for k in ("trend", "atr_pct", "rsi14", "prev_high", "prev_low", "hi20", "lo20", "dist_sma20_pct")},
               "rel_volume_day": snap.get("rel_volume")}
        stats[t] = rec
        if rec["qualifies"]:
            rows.append(rec)
    rows.sort(key=lambda r: -r["score"])
    as_of = max((r["session"].get("session_date") for r in stats.values() if r["session"].get("session_date")), default=None)
    last_bar = max((x["bar_time"] for r in stats.values() for x in r["timeframes"].values()), default=None)
    return {"rows": rows[: config.SCAN_ROWS], "by_ticker": stats, "scanned": len(stats), "qualified": len(rows),
            "as_of": as_of, "last_bar": last_bar, "market_state": market_state,
            "settings": {"timeframes": list(config.SCAN_TIMEFRAMES), "min_price": config.SCAN_MIN_PRICE,
                         "min_session_volume": config.SCAN_MIN_SESSION_VOLUME, "min_rvol": config.SCAN_MIN_RVOL, "weights": config.SCAN_TF_WEIGHTS}}
