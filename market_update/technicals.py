"""Pure-code technical calculations on daily OHLCV frames. No AI, no I/O."""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd


def _f(x: Any) -> float | None:
    try:
        if x is None or (isinstance(x, float) and math.isnan(x)) or pd.isna(x):
            return None
        return float(x)
    except Exception:  # noqa: BLE001
        return None


def sma(close: pd.Series, n: int) -> float | None:
    if len(close) < n:
        return None
    return _f(close.tail(n).mean())


def rsi(close: pd.Series, n: int = 14) -> float | None:
    if len(close) < n + 1:
        return None
    delta = close.diff().dropna()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / n, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    val = 100 - 100 / (1 + rs)
    return _f(val.iloc[-1])


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["Close"].shift()
    return pd.concat([
        df["High"] - df["Low"],
        (df["High"] - prev_close).abs(),
        (df["Low"] - prev_close).abs(),
    ], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> float | None:
    if len(df) < n + 1:
        return None
    return _f(true_range(df).tail(n).mean())


def realized_vol(close: pd.Series, n: int = 20) -> float | None:
    """Annualised close-to-close volatility in percent."""
    if len(close) < n + 1:
        return None
    r = np.log(close / close.shift()).dropna().tail(n)
    return _f(r.std() * math.sqrt(252) * 100)


def pct_return(close: pd.Series, n: int) -> float | None:
    if len(close) < n + 1:
        return None
    a, b = close.iloc[-1 - n], close.iloc[-1]
    return _f((b / a - 1) * 100) if a else None


def pivots(prev: pd.Series) -> dict[str, float | None]:
    h, l, c = _f(prev["High"]), _f(prev["Low"]), _f(prev["Close"])
    if None in (h, l, c):
        return {"p": None, "r1": None, "s1": None, "r2": None, "s2": None}
    p = (h + l + c) / 3
    return {"p": p, "r1": 2 * p - l, "s1": 2 * p - h, "r2": p + (h - l), "s2": p - (h - l)}


def range_position(value: float | None, lo: float | None, hi: float | None) -> float | None:
    if value is None or lo is None or hi is None or hi == lo:
        return None
    return max(0.0, min(1.0, (value - lo) / (hi - lo)))


def summarize(df: pd.DataFrame, last_price: float | None = None) -> dict[str, Any]:
    """Everything a stock card needs from a ~1y daily frame.

    `last_price` (live or extended-hours) overrides the last close for
    'distance from' style metrics while averages stay close-based.
    """
    df = df.dropna(subset=["Close"])
    if df.empty:
        return {}
    close = df["Close"]
    last_close = _f(close.iloc[-1])
    px = last_price or last_close
    prev = df.iloc[-1]
    s20, s50, s200 = sma(close, 20), sma(close, 50), sma(close, 200)
    a14 = atr(df, 14)
    hi52 = _f(df["High"].tail(252).max())
    lo52 = _f(df["Low"].tail(252).min())
    hi20 = _f(df["High"].tail(20).max())
    lo20 = _f(df["Low"].tail(20).min())
    above = [px > s for s in (s20, s50, s200) if s is not None and px is not None]
    trend = "up" if above and all(above) else ("down" if above and not any(above) else "mixed")
    avg_vol10 = _f(df["Volume"].tail(10).mean())
    out = {
        "last_close": last_close,
        "last_close_date": df.index[-1].date().isoformat(),
        "sma20": s20, "sma50": s50, "sma200": s200,
        "above_sma20": (px > s20) if (s20 and px) else None,
        "above_sma50": (px > s50) if (s50 and px) else None,
        "above_sma200": (px > s200) if (s200 and px) else None,
        "trend": trend,
        "dist_sma20_pct": _f((px / s20 - 1) * 100) if (s20 and px) else None,
        "dist_sma50_pct": _f((px / s50 - 1) * 100) if (s50 and px) else None,
        "dist_sma200_pct": _f((px / s200 - 1) * 100) if (s200 and px) else None,
        "rsi14": rsi(close, 14),
        "atr14": a14,
        "atr_pct": _f(a14 / px * 100) if (a14 and px) else None,
        "rv20": realized_vol(close, 20),
        "ret_5d": pct_return(close, 5),
        "ret_1m": pct_return(close, 21),
        "ret_3m": pct_return(close, 63),
        "ret_6m": pct_return(close, 126),
        "ret_12m": pct_return(close, 252),
        "hi52": hi52, "lo52": lo52,
        "pct_from_hi52": _f((px / hi52 - 1) * 100) if (hi52 and px) else None,
        "pct_from_lo52": _f((px / lo52 - 1) * 100) if (lo52 and px) else None,
        "range_pos_52w": range_position(px, lo52, hi52),
        "hi20": hi20, "lo20": lo20,
        "prev_open": _f(prev["Open"]), "prev_high": _f(prev["High"]), "prev_low": _f(prev["Low"]), "prev_close": last_close,
        "prev_range_pct": _f((prev["High"] - prev["Low"]) / prev["Close"] * 100) if _f(prev["Close"]) else None,
        "pivots": pivots(prev),
        "avg_vol10": avg_vol10,
        "last_vol": _f(prev["Volume"]),
        "rel_vol_last": _f(prev["Volume"] / avg_vol10) if avg_vol10 else None,
        "new_high_20d": bool(px is not None and hi20 is not None and px >= hi20 * 0.999),
        "new_low_20d": bool(px is not None and lo20 is not None and px <= lo20 * 1.001),
    }
    return out


def ohlc_records(df: pd.DataFrame, n: int = 90) -> list[dict[str, Any]]:
    df = df.dropna(subset=["Close"]).tail(n)
    recs = []
    for ts, row in df.iterrows():
        recs.append({
            "t": ts.date().isoformat(),
            "o": round(float(row["Open"]), 4), "h": round(float(row["High"]), 4),
            "l": round(float(row["Low"]), 4), "c": round(float(row["Close"]), 4),
            "v": int(row["Volume"]) if not pd.isna(row["Volume"]) else 0,
        })
    return recs


# ---------------------------------------------------------------------------
# Price action: candle anatomy, patterns, market structure
# ---------------------------------------------------------------------------
def _candle(row: pd.Series) -> dict[str, Any]:
    o, h, l, c = (float(row["Open"]), float(row["High"]), float(row["Low"]), float(row["Close"]))
    rng = h - l
    body = abs(c - o)
    upper = h - max(o, c)
    lower = min(o, c) - l
    return {
        "open": o, "high": h, "low": l, "close": c, "range": rng, "body": body,
        "body_pct": (body / rng) if rng else 0.0,
        "upper_wick_pct": (upper / rng) if rng else 0.0,
        "lower_wick_pct": (lower / rng) if rng else 0.0,
        "close_loc": ((c - l) / rng) if rng else 0.5,   # 0 = closed at low, 1 = closed at high
        "bull": c > o, "bear": c < o,
    }


def candle_pattern(df: pd.DataFrame) -> dict[str, Any]:
    """Name the last candle (and 2-bar patterns) in plain trader language."""
    d = df.dropna(subset=["Close"])
    if len(d) < 3:
        return {}
    cur, prev = _candle(d.iloc[-1]), _candle(d.iloc[-2])
    atr_val = atr(d, 14) or (cur["range"] or 1.0)
    pat, read = "ordinary", "no strong single-candle signal"
    if cur["range"] and cur["body_pct"] <= 0.1:
        pat, read = "doji", "indecision: buyers and sellers finished where they started"
    elif cur["lower_wick_pct"] >= 0.6 and cur["body_pct"] <= 0.35:
        pat, read = "hammer", "sellers pushed it down but buyers took it back; possible bottom if it follows through"
    elif cur["upper_wick_pct"] >= 0.6 and cur["body_pct"] <= 0.35:
        pat, read = "shooting_star", "buyers pushed it up but sellers took it back; possible top if it follows through"
    elif cur["bull"] and prev["bear"] and cur["close"] > prev["open"] and cur["open"] < prev["close"]:
        pat, read = "bullish_engulfing", "today's up candle swallowed yesterday's down candle; buyers took control"
    elif cur["bear"] and prev["bull"] and cur["close"] < prev["open"] and cur["open"] > prev["close"]:
        pat, read = "bearish_engulfing", "today's down candle swallowed yesterday's up candle; sellers took control"
    elif cur["high"] < prev["high"] and cur["low"] > prev["low"]:
        pat, read = "inside_bar", "a quiet bar inside yesterday's range; energy building for a break"
    elif cur["high"] > prev["high"] and cur["low"] < prev["low"]:
        pat, read = "outside_bar", "a wide bar that swept both sides of yesterday's range; volatility expanding"
    elif cur["body_pct"] >= 0.75 and cur["bull"]:
        pat, read = "strong_bull_close", "a full-bodied up candle closing near the high; conviction buying"
    elif cur["body_pct"] >= 0.75 and cur["bear"]:
        pat, read = "strong_bear_close", "a full-bodied down candle closing near the low; conviction selling"
    closes = d["Close"].tail(6).tolist()
    streak = 0
    for i in range(len(closes) - 1, 0, -1):
        if closes[i] > closes[i - 1] and streak >= 0:
            streak += 1
        elif closes[i] < closes[i - 1] and streak <= 0:
            streak -= 1
        else:
            break
    vol = d["Volume"]
    avg_vol = float(vol.tail(20).mean()) if len(vol) >= 5 else None
    last_vol = float(vol.iloc[-1])
    gap_open_pct = _f((cur["open"] / prev["close"] - 1) * 100) if prev["close"] else None
    return {
        "pattern": pat, "pattern_read": read,
        "direction": "up" if cur["bull"] else ("down" if cur["bear"] else "flat"),
        "close_location": round(cur["close_loc"], 2),
        "body_pct": round(cur["body_pct"], 2),
        "range_vs_atr": round(cur["range"] / atr_val, 2) if atr_val else None,
        "volume_vs_avg": round(last_vol / avg_vol, 2) if avg_vol else None,
        "streak_days": streak,
        "gap_open_pct": round(gap_open_pct, 2) if gap_open_pct is not None else None,
        "prev_close": prev["close"],
    }


def swing_points(df: pd.DataFrame, lookback: int = 3, bars: int = 60) -> dict[str, Any]:
    """Recent swing highs/lows (pivot detection) and the structure they describe."""
    d = df.dropna(subset=["Close"]).tail(bars)
    highs, lows = d["High"].tolist(), d["Low"].tolist()
    dates = [ts.date().isoformat() for ts in d.index]
    sh, sl = [], []
    for i in range(lookback, len(d) - lookback):
        if highs[i] == max(highs[i - lookback:i + lookback + 1]):
            sh.append({"t": dates[i], "v": round(highs[i], 4)})
        if lows[i] == min(lows[i - lookback:i + lookback + 1]):
            sl.append({"t": dates[i], "v": round(lows[i], 4)})
    structure = "undefined"
    if len(sh) >= 2 and len(sl) >= 2:
        hh, hl = sh[-1]["v"] > sh[-2]["v"], sl[-1]["v"] > sl[-2]["v"]
        lh, ll = sh[-1]["v"] < sh[-2]["v"], sl[-1]["v"] < sl[-2]["v"]
        structure = ("uptrend_hh_hl" if hh and hl else "downtrend_lh_ll" if lh and ll
                     else "expanding_hh_ll" if hh and ll else "contracting_lh_hl" if lh and hl else "mixed")
    last = float(d["Close"].iloc[-1])
    res = [p["v"] for p in sh if p["v"] > last]
    sup = [p["v"] for p in sl if p["v"] < last]
    # A confirmed swing needs `lookback` bars on each side, so a fresh breakout is not yet a swing.
    # If price is already beyond the last swing extreme, that break is the newest structural fact.
    broke_high = bool(sh and last > sh[-1]["v"])
    broke_low = bool(sl and last < sl[-1]["v"])
    if broke_high and not broke_low:
        structure = "uptrend_hh_hl" if structure in ("uptrend_hh_hl", "mixed", "contracting_lh_hl", "undefined") else "breakout_from_" + structure
    elif broke_low and not broke_high:
        structure = "downtrend_lh_ll" if structure in ("downtrend_lh_ll", "mixed", "contracting_lh_hl", "undefined") else "breakdown_from_" + structure
    return {
        "structure": structure,
        "swing_highs": sh[-3:], "swing_lows": sl[-3:],
        "nearest_resistance": round(min(res), 4) if res else None,
        "nearest_support": round(max(sup), 4) if sup else None,
        "broke_last_swing_high": broke_high,
        "broke_last_swing_low": broke_low,
    }


def price_action(df: pd.DataFrame) -> dict[str, Any]:
    out = candle_pattern(df)
    out.update(swing_points(df))
    return out


# ---------------------------------------------------------------------------
# Multi-horizon stats for the big-picture assets
# ---------------------------------------------------------------------------
def horizon_stats(df: pd.DataFrame, n: int, is_yield: bool = False) -> dict[str, Any]:
    d = df.dropna(subset=["Close"])
    if len(d) < 5:
        return {}
    w = d.tail(n + 1) if len(d) > n else d
    start, end = float(w["Close"].iloc[0]), float(w["Close"].iloc[-1])
    hi, lo = float(w["High"].max()), float(w["Low"].min())
    peak = w["Close"].cummax()
    dd = float(((w["Close"] / peak) - 1).min() * 100)
    trough = w["Close"].cummin()
    du = float(((w["Close"] / trough) - 1).max() * 100)
    sw = swing_points(w, lookback=max(2, n // 30), bars=len(w))
    out = {
        "bars": len(w) - 1,
        "start": start, "end": end, "high": hi, "low": lo,
        "range_pos": range_position(end, lo, hi),
        "max_drawdown_pct": round(dd, 2), "max_runup_pct": round(du, 2),
        "structure": sw["structure"],
        "realized_vol_pct": realized_vol(w["Close"], min(len(w) - 1, 20)) if not is_yield else None,
    }
    if is_yield:
        out["change_bp"] = round((end - start) * 100, 1)
        out["from_high_bp"] = round((end - hi) * 100, 1)
        out["from_low_bp"] = round((end - lo) * 100, 1)
    else:
        out["return_pct"] = round((end / start - 1) * 100, 2) if start else None
        out["from_high_pct"] = round((end / hi - 1) * 100, 2) if hi else None
        out["from_low_pct"] = round((end / lo - 1) * 100, 2) if lo else None
    return out


def weekly_ohlc(df: pd.DataFrame, weeks: int = 52) -> list[dict[str, Any]]:
    d = df.dropna(subset=["Close"])
    if d.empty:
        return []
    w = d.resample("W-FRI").agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"}).dropna(subset=["Close"]).tail(weeks)
    return [{"t": ts.date().isoformat(), "o": round(float(r["Open"]), 4), "h": round(float(r["High"]), 4),
             "l": round(float(r["Low"]), 4), "c": round(float(r["Close"]), 4), "v": int(r["Volume"]) if not pd.isna(r["Volume"]) else 0}
            for ts, r in w.iterrows()]
