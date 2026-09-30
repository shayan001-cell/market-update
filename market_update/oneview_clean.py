"""OneView Clean on OneView's own data: the same logic as pine/oneview_clean.pine, for the Charts page when no
TradingView alert is feeding a symbol.

It follows the Pine script step by step:
  - trend engine: ATR supertrend, factor 3.5 and length 10
  - higher-timeframe trend: the next timeframe up
  - swing structure: pivots of 20 bars
  - momentum: a double-smoothed range position, as HyperWave
  - order flow
  - location in the swing range
Five checks come out of that, a signal needs 3 of them, and the trade is then tracked: stop, targets 1 and 2
(1R and 2R), stop to entry at target 1, and an exit on the trailing stop.

Differences from TradingView:
  - the data is Yahoo's, not TradingView's
  - order flow uses each bar's direction times its volume, because there are no lower-timeframe bars
So its signals can differ a little from the chart.
"""
from __future__ import annotations

import math
import time
from typing import Any

import numpy as np
import pandas as pd

from . import fetch

FACTOR, ATR_LEN, SW, MIN_SCORE = 3.5, 10, 20, 3
TRAIL_MULT = FACTOR + 1.5
# chart timeframe -> (yahoo interval, period, resample rule or None, higher timeframe)
TF = {
    "15": ("15m", "30d", None, "60"),
    "60": ("60m", "180d", None, "240"),
    "240": ("60m", "360d", "4h", "D"),
    "D": ("1d", "3y", None, "W"),
    "W": ("1wk", "10y", None, None),
}
_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


def _bars(sym: str, tf: str) -> pd.DataFrame | None:
    interval, period, rule, _ = TF[tf]
    df = fetch.download([sym], period=period, interval=interval, auto_adjust=False, progress=False, threads=False)
    f = fetch.frame_for(df, sym) if df is not None and not df.empty else None
    if f is None or f.empty:
        return None
    f = f[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])
    if rule:
        f = f.resample(rule, origin="start_day", offset="9h30min" if tf == "240" else None).agg(
            {"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}).dropna(subset=["Close"])
    return f if len(f) >= 60 else None


def _rma(x: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(x), np.nan)
    if len(x) < n:
        return out
    out[n - 1] = np.nanmean(x[:n])
    for i in range(n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def _ema(x: np.ndarray, n: int) -> np.ndarray:
    a = 2 / (n + 1)
    out = np.full(len(x), np.nan)
    prev = np.nan
    for i, v in enumerate(x):
        if np.isnan(v):
            out[i] = prev
            continue
        prev = v if np.isnan(prev) else a * v + (1 - a) * prev
        out[i] = prev
    return out


def _atr(h: np.ndarray, l: np.ndarray, c: np.ndarray, n: int) -> np.ndarray:
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    tr[0] = h[0] - l[0]
    return _rma(tr, n)


def supertrend(h: np.ndarray, l: np.ndarray, c: np.ndarray, factor: float = FACTOR, n: int = ATR_LEN) -> tuple[np.ndarray, np.ndarray]:
    """TradingView's ta.supertrend. Direction -1 = up trend, 1 = down trend."""
    atr = _atr(h, l, c, n)
    hl2 = (h + l) / 2
    st = np.full(len(c), np.nan)
    d = np.ones(len(c))
    lo_p = up_p = np.nan
    for i in range(len(c)):
        if np.isnan(atr[i]):
            continue
        up = hl2[i] + factor * atr[i]
        lo = hl2[i] - factor * atr[i]
        if not np.isnan(lo_p):
            lo = lo if (lo > lo_p or c[i - 1] < lo_p) else lo_p
            up = up if (up < up_p or c[i - 1] > up_p) else up_p
        if i == 0 or np.isnan(atr[i - 1]):
            d[i] = 1
        elif st[i - 1] == up_p:
            d[i] = -1 if c[i] > up else 1
        else:
            d[i] = 1 if c[i] < lo else -1
        st[i] = lo if d[i] == -1 else up
        lo_p, up_p = lo, up
    return st, d


def _htf_dir(sym: str, tf: str | None, index: pd.DatetimeIndex) -> np.ndarray:
    """The higher timeframe's trend direction of the last completed bar, lined up with the chart's bars."""
    if not tf:
        return np.full(len(index), np.nan)
    try:
        f = _bars(sym, tf)
    except Exception:  # noqa: BLE001
        f = None
    if f is None:
        return np.full(len(index), np.nan)
    _, d = supertrend(f["High"].to_numpy(float), f["Low"].to_numpy(float), f["Close"].to_numpy(float), 3.0, 10)
    s = pd.Series(d, index=f.index).shift(1)            # completed bars only, never the one still forming
    s.index = s.index.tz_localize(None) if s.index.tz is not None else s.index
    idx = index.tz_localize(None) if index.tz is not None else index
    return s.reindex(s.index.union(idx)).ffill().reindex(idx).to_numpy(float)


def _pivots(x: np.ndarray, n: int, high: bool) -> np.ndarray:
    """Pivot value confirmed at bar i (the pivot sits at i - n), like ta.pivothigh / ta.pivotlow."""
    out = np.full(len(x), np.nan)
    for i in range(2 * n, len(x)):
        p = i - n
        win = x[p - n: i + 1]
        v = x[p]
        if high and v == win.max() and (win[:n] < v).all() and (win[n + 1:] <= v).all():
            out[i] = v
        if not high and v == win.min() and (win[:n] > v).all() and (win[n + 1:] >= v).all():
            out[i] = v
    return out


def evaluate(sym: str, tf: str = "60") -> dict[str, Any]:
    sym, tf = sym.upper(), tf if tf in TF else "60"
    hit = _cache.get((sym, tf))
    if hit and time.time() - hit[0] < 300:
        return hit[1]
    f = _bars(sym, tf)
    if f is None:
        return {"status": "no_data", "symbol": sym, "tf": tf}
    o, h, l, c, v = (f[k].to_numpy(float) for k in ("Open", "High", "Low", "Close", "Volume"))
    v = np.nan_to_num(v)
    n = len(c)
    st, sd = supertrend(h, l, c)
    atr10 = _atr(h, l, c, 10)
    ema50 = _ema(c, 50)
    d_htf = _htf_dir(sym, TF[tf][3], f.index)

    # structure, zones and range
    ph, pl = _pivots(h, SW, True), _pivots(l, SW, False)
    sw_h = sw_l = np.nan
    sw_hb = sw_lb = 0
    sw_hx = sw_lx = True
    s_trend, s_last, s_last_bar = 0, "none yet", None
    ob = {"bt": np.nan, "bb": np.nan, "st": np.nan, "sb": np.nan}
    r_top = r_bot = np.nan
    s_arr = np.zeros(n)
    pd_arr = np.full(n, 50.0)
    for i in range(n):
        if not np.isnan(ph[i]):
            sw_h, sw_hb, sw_hx, r_top = ph[i], i - SW, False, ph[i]
        if not np.isnan(pl[i]):
            sw_l, sw_lb, sw_lx, r_bot = pl[i], i - SW, False, pl[i]
        if not sw_hx and c[i] > sw_h:
            s_last, s_trend, sw_hx, s_last_bar = ("CHoCH" if s_trend < 0 else "BOS"), 1, True, i
            j = sw_hb + int(np.argmin(l[sw_hb:i])) if i > sw_hb else i - 1
            ob["bt"], ob["bb"] = h[j], l[j]
        if not sw_lx and c[i] < sw_l:
            s_last, s_trend, sw_lx, s_last_bar = ("CHoCH" if s_trend > 0 else "BOS"), -1, True, i
            j = sw_lb + int(np.argmax(h[sw_lb:i])) if i > sw_lb else i - 1
            ob["st"], ob["sb"] = h[j], l[j]
        if not np.isnan(ob["bb"]) and c[i] < ob["bb"]:
            ob["bt"] = ob["bb"] = np.nan
        if not np.isnan(ob["st"]) and c[i] > ob["st"]:
            ob["st"] = ob["sb"] = np.nan
        r_top = r_top if np.isnan(r_top) else max(r_top, h[i])
        r_bot = r_bot if np.isnan(r_bot) else min(r_bot, l[i])
        s_arr[i] = s_trend
        if not (np.isnan(r_top) or np.isnan(r_bot) or r_top == r_bot):
            pd_arr[i] = (c[i] - r_bot) / (r_top - r_bot) * 100

    # momentum
    hi10 = pd.Series(h).rolling(10).max().to_numpy()
    lo10 = pd.Series(l).rolling(10).min().to_numpy()
    mom = _ema(_ema(c - (hi10 + lo10) / 2, 10), 3)
    rng = _ema(_ema(hi10 - lo10, 10), 3)
    with np.errstate(invalid="ignore", divide="ignore"):
        hw = np.clip(np.where(rng == 0, 50.0, 50 + 100 * mom / rng), 0, 100)
    hws = pd.Series(hw).rolling(3).mean().to_numpy()

    # order flow from bar direction (no lower-timeframe bars here)
    delta = np.where(c >= o, v, -v)
    day = pd.Index(f.index).normalize() if tf in ("15", "60", "240") else pd.Index(range(n))
    cvd = pd.Series(delta).groupby(np.asarray(day)).cumsum().to_numpy() if tf in ("15", "60", "240") else np.cumsum(delta)
    has_flow = v.sum() > 0

    # scores, signals, trade tracking
    tr = {"dir": 0, "entry": None, "stop": None, "t1": None, "t2": None, "t1hit": False, "state": "none", "result": "", "exit": None, "bar": None, "end": None, "score": 0}
    trail = np.nan
    events: list[dict[str, Any]] = []
    ts = [t.isoformat() for t in f.index]
    scoreL = scoreS = 0
    checks = {}
    for i in range(1, n):
        up = sd[i] < 0
        flip_up, flip_dn = sd[i] < 0 and sd[i - 1] > 0, sd[i] > 0 and sd[i - 1] < 0
        cs = cvd[i] - (cvd[i - 5] if i >= 5 else 0)
        vL = {"trend": d_htf[i] < 0, "structure": s_arr[i] > 0, "momentum": hw[i] > hws[i],
              "buyers/sellers": (cs > 0) if has_flow else c[i] > ema50[i], "price level": pd_arr[i] < 70}
        vS = {"trend": d_htf[i] > 0, "structure": s_arr[i] < 0, "momentum": hw[i] < hws[i],
              "buyers/sellers": (cs < 0) if has_flow else c[i] < ema50[i], "price level": pd_arr[i] > 30}
        scoreL, scoreS = sum(vL.values()), sum(vS.values())
        checks = {"buy": vL, "sell": vS}
        a = atr10[i] if not np.isnan(atr10[i]) else 0
        t_long, t_short = c[i] - a * TRAIL_MULT, c[i] + a * TRAIL_MULT
        if flip_up or (up and np.isnan(trail)):
            trail = t_long
        elif flip_dn or (not up and np.isnan(trail)):
            trail = t_short
        else:
            trail = max(trail, t_long) if up else min(trail, t_short)
        buy, sell = flip_up and scoreL >= MIN_SCORE, flip_dn and scoreS >= MIN_SCORE
        if buy or sell:
            d = 1 if buy else -1
            risk = max(abs(c[i] - st[i]), 1e-9)
            tr.update(dir=d, entry=c[i], stop=st[i], t1=c[i] + d * risk, t2=c[i] + 2 * d * risk, t1hit=False, state="open", result="", exit=None, bar=i, end=None, score=scoreL if buy else scoreS)
            events.append({"at": ts[i], "event": "buy" if buy else "sell", "price": round(float(c[i]), 4), "score": int(tr["score"])})
        elif tr["state"] == "open":
            d = tr["dir"]
            stop_hit = l[i] <= tr["stop"] if d == 1 else h[i] >= tr["stop"]
            t2_hit = h[i] >= tr["t2"] if d == 1 else l[i] <= tr["t2"]
            t1_hit = h[i] >= tr["t1"] if d == 1 else l[i] <= tr["t1"]
            if stop_hit:
                tr.update(state="closed", result="Closed at entry after target 1" if tr["t1hit"] else "Stopped out", exit=tr["stop"], end=i)
                events.append({"at": ts[i], "event": "exit" if tr["t1hit"] else "stopped", "price": round(float(tr["stop"]), 4)})
            elif t2_hit:
                tr.update(state="closed", result="Target 2 reached, trade done", exit=tr["t2"], end=i)
                events.append({"at": ts[i], "event": "target2", "price": round(float(tr["t2"]), 4)})
            elif t1_hit and not tr["t1hit"]:
                tr.update(t1hit=True, stop=tr["entry"])
                events.append({"at": ts[i], "event": "target1", "price": round(float(tr["t1"]), 4)})
            elif (c[i] < trail) if d == 1 else (c[i] > trail):
                tr.update(state="closed", result="Exited: the trend turned", exit=c[i], end=i)
                events.append({"at": ts[i], "event": "exit", "price": round(float(c[i]), 4)})

    last = n - 1
    in_trade = tr["state"] == "open"
    stop_now = None
    if in_trade:
        stop_now = max(tr["stop"], trail) if tr["dir"] == 1 else min(tr["stop"], trail)
    pnl = None
    if tr["entry"]:
        ref = c[last] if in_trade else tr["exit"]
        pnl = (ref - tr["entry"]) / tr["entry"] * 100 * tr["dir"]
    bias = scoreL - scoreS
    # key levels: yesterday, recent swing, zones
    lv: list[tuple[float, str]] = []
    if tf in ("15", "60", "240"):
        dd = f.groupby(pd.Index(f.index).normalize()).agg({"High": "max", "Low": "min"})
        if len(dd) >= 2:
            lv += [(float(dd["High"].iloc[-2]), "yesterday's high"), (float(dd["Low"].iloc[-2]), "yesterday's low")]
    for val, name in ((sw_h, "recent high"), (sw_l, "recent low"), (ob["st"], "sellers' zone"), (ob["sb"], "sellers' zone"), (ob["bt"], "buyers' zone"), (ob["bb"], "buyers' zone")):
        if not (val is None or (isinstance(val, float) and math.isnan(val))):
            lv.append((float(val), name))
    px = float(c[last])
    above = sorted([x for x in lv if x[0] > px], key=lambda x: x[0] - px)
    below = sorted([x for x in lv if x[0] < px], key=lambda x: px - x[0])
    r = lambda x: None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), 4)  # noqa: E731
    out = {
        "status": "ok", "source": "oneview", "symbol": sym, "tf": tf, "as_of": ts[last], "price": r(px),
        "bias": int(bias), "score_buy": int(scoreL), "score_sell": int(scoreS),
        "checks": {k: {kk: bool(vv) for kk, vv in d.items()} for k, d in checks.items()},
        "structure": {"trend": int(s_trend), "last": s_last, "bars_ago": int(last - s_last_bar) if s_last_bar is not None else None},
        "location_pct": r(pd_arr[last]), "htf_up": None if np.isnan(d_htf[last]) else bool(d_htf[last] < 0),
        "ceiling": {"price": r(above[0][0]), "name": above[0][1]} if above else None,
        "floor": {"price": r(below[0][0]), "name": below[0][1]} if below else None,
        "trade": None if not tr["dir"] else {
            "side": "buy" if tr["dir"] == 1 else "sell", "entry": r(tr["entry"]), "stop": r(stop_now if in_trade else tr["stop"]),
            "t1": r(tr["t1"]), "t2": r(tr["t2"]), "t1_hit": bool(tr["t1hit"]), "open": bool(in_trade), "result": tr["result"],
            "score": int(tr["score"]), "opened_at": ts[tr["bar"]], "bars_ago": int(last - tr["bar"]),
            "closed_at": ts[tr["end"]] if tr["end"] is not None else None, "pnl_pct": r(pnl)},
        "events": events[-12:],
    }
    _cache[(sym, tf)] = (time.time(), out)
    return out
