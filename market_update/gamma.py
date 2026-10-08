"""Options map: VIX, dealer gamma and put/call for ES, NQ and SPY, refreshed every 10 minutes in the session.

No model calls. Everything comes from Yahoo option chains and quotes:
  - ES is read from SPX options and NQ from QQQ options (futures options are on CME and not available here);
    levels are converted to futures points with the live futures / index ratio.
  - Net gamma uses the standard public convention: dealers long the calls and short the puts customers trade.
    Gamma per contract is Black-Scholes with each option's own implied vol; before the open the chains carry no
    vol, so the VIX curve (VXN for the Nasdaq) stands in.
  - Flip: the price where net gamma changes sign. Call wall: the strike above price with the most call gamma.
    Put wall: the put strike below price with the most open interest.
Open interest is as of the previous close; volume is today's in the session, otherwise the last session's.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime
from typing import Any

import numpy as np
import pandas as pd
import yfinance as yf

from . import config, fetch

log = logging.getLogger(__name__)

# what is normal for each product's put/call volume ratio: funds hedge with index products, so they run above 1
PC_BANDS = {  # very_low, low, high, very_high
    "SPX": (0.8, 1.0, 1.5, 2.0),
    "SPY": (0.8, 1.1, 1.5, 2.0),
    "QQQ": (0.7, 1.0, 1.4, 1.9),
}
PRODUCTS = [  # shown as, options read from, price shown, put/call band
    {"key": "ES", "name": "S&P 500 futures", "chain": "^SPX", "price": "ES=F", "band": "SPX", "max_days": 45},
    {"key": "NQ", "name": "Nasdaq-100 futures", "chain": "QQQ", "price": "NQ=F", "band": "QQQ", "max_days": 45},
    {"key": "SPY", "name": "S&P 500 ETF", "chain": "SPY", "price": "SPY", "band": "SPY", "max_days": 45},
]


def _last(sym: str) -> tuple[float | None, float | None]:
    try:
        fi = yf.Ticker(sym).fast_info
        return float(fi["last_price"]), float(fi["previous_close"])
    except Exception:  # noqa: BLE001
        return None, None


def _vol_curve(v: dict[str, Any]):
    pts = [(d, v[s]["last"]) for d, s in ((9, "VIX9D"), (30, "VIX"), (93, "VIX3M")) if v.get(s, {}).get("last")]
    def iv(days: float, nasdaq: bool) -> float:
        if not pts:
            return 0.2
        xs, ys = zip(*pts)
        x = float(np.interp(days, xs, ys))
        if nasdaq and v.get("VXN", {}).get("last") and v.get("VIX", {}).get("last"):
            x *= v["VXN"]["last"] / v["VIX"]["last"]
        return x / 100
    return iv


def _chain(sym: str, spot: float, max_days: int, iv_fallback, nasdaq: bool) -> pd.DataFrame:
    tk = yf.Ticker(sym)
    now = fetch.now_et()
    today = now.date()
    hours_left = max(0.5, 16 - (now.hour + now.minute / 60)) if fetch.market_state() == "open" else 6.5
    frames = []
    for e in tk.options:
        dte = (date.fromisoformat(e) - today).days
        if dte < 0 or dte > max_days:
            continue
        days = dte + hours_left / 24
        ch = None
        for attempt in range(2):                     # Yahoo now and then answers an expiry with nothing: ask once more
            try:
                ch = tk.option_chain(e)
                if ch is not None and ch.calls is not None and ch.puts is not None:
                    break
            except Exception:  # noqa: BLE001
                ch = None
            time.sleep(0.5)
        if ch is None or ch.calls is None or ch.puts is None:
            continue
        for side, d in (("C", ch.calls), ("P", ch.puts)):
            d = d[(d.strike > spot * 0.88) & (d.strike < spot * 1.12)]
            if d.empty:
                continue
            ivs = d.impliedVolatility.fillna(0).values.astype(float)
            ivs = np.where((ivs > 0.03) & (ivs < 3), ivs, iv_fallback(days, nasdaq))
            frames.append(pd.DataFrame({"exp": e, "side": side, "K": d.strike.values.astype(float),
                                        "oi": d.openInterest.fillna(0).values.astype(float),
                                        "vol": d.volume.fillna(0).values.astype(float), "T": days / 365, "iv": ivs}))
    if not frames:
        raise ValueError(f"no option chain for {sym}")
    return pd.concat(frames, ignore_index=True)


def _gex(df: pd.DataFrame, spot: float) -> pd.Series:
    sign = np.where(df.side == "C", 1.0, -1.0)
    sq = df.iv * np.sqrt(df["T"])
    d1 = (np.log(spot / df.K) + 0.5 * df.iv ** 2 * df["T"]) / sq
    g = np.exp(-0.5 * d1 ** 2) / np.sqrt(2 * np.pi) / (spot * sq)
    return g * df.oi * 100 * spot * spot * 0.01 * sign          # dollars of hedging per 1% move


def _pc_mood(pc: float | None, band: str) -> str | None:
    if pc is None:
        return None
    vl, lo, hi, vh = PC_BANDS[band]
    return "greed" if pc < vl else "calls" if pc < lo else "normal" if pc <= hi else "hedging" if pc <= vh else "fear"


def _product(p: dict[str, Any], iv_fallback) -> dict[str, Any]:
    chain_spot, _ = _last(p["chain"])
    price, prev = _last(p["price"]) if p["price"] != p["chain"] else _last(p["chain"])
    if not chain_spot or not price:
        raise ValueError(f"no quote for {p['key']}")
    df = _chain(p["chain"], chain_spot, p["max_days"], iv_fallback, p["key"] == "NQ")
    df["gex"] = _gex(df, chain_spot)
    # Walls by open interest, not gamma: gamma always peaks at the strike next to price, which put the "walls" a point
    # away. The ceiling is the call strike above price (0.25% to 2.5% away, expiries within 10 days) with the most contracts open,
    # the floor the put strike below price with the most. The magnet is the strike within 1% carrying the most gamma.
    # Only expiries in the next 10 days and strikes within 2.5% count: a day trader's levels, not quarterly round numbers.
    near = df[pd.to_datetime(df.exp) <= pd.Timestamp(fetch.now_et().date()) + pd.Timedelta(days=10)]
    oi = (near if len(near) else df).groupby(["side", "K"]).oi.sum()
    c_oi = oi.get("C", pd.Series(dtype=float)); p_oi = oi.get("P", pd.Series(dtype=float))
    up = c_oi[(c_oi.index >= chain_spot * 1.0025) & (c_oi.index <= chain_spot * 1.025)]
    dn = p_oi[(p_oi.index <= chain_spot * 0.9975) & (p_oi.index >= chain_spot * 0.975)]
    call_wall = float(up.idxmax()) if len(up) and up.max() > 0 else None
    put_wall = float(dn.idxmax()) if len(dn) and dn.max() > 0 else None
    tot = df.assign(a=df.gex.abs()).groupby("K").a.sum()
    tot = tot[(tot.index > chain_spot * 0.99) & (tot.index < chain_spot * 1.01)]
    magnet = float(tot.idxmax()) if len(tot) else None
    lv = np.linspace(chain_spot * 0.94, chain_spot * 1.06, 121)
    vals = [_gex(df, x).sum() for x in lv]
    flips = [(lv[i] + lv[i + 1]) / 2 for i in range(len(lv) - 1) if (vals[i] < 0) != (vals[i + 1] < 0)]
    flip = min(flips, key=lambda x: abs(x - chain_spot)) if flips else None
    c, pu = df[df.side == "C"], df[df.side == "P"]
    first = df[df.exp == df.exp.min()]
    cv, pv = float(c.vol.sum()), float(pu.vol.sum())
    pc = round(pv / cv, 2) if cv else None
    pc_0 = round(float(first[first.side == "P"].vol.sum()) / float(first[first.side == "C"].vol.sum()), 2) if first[first.side == "C"].vol.sum() else None
    # the chain may be a different instrument from the one shown (SPX for ES, QQQ for NQ): scale its levels by the
    # live price ratio, which carries the futures premium over the index
    scale = price / chain_spot
    conv = lambda x: round(x * scale, 2) if x is not None else None  # noqa: E731
    net = float(df.gex.sum())
    return {
        "key": p["key"], "name": p["name"], "from": p["chain"].lstrip("^"), "price": round(price, 2),
        "chg_pct": round((price / prev - 1) * 100, 2) if prev else None,
        "net_gamma_bn": round(net / 1e9, 2), "regime": "positive" if net >= 0 else "negative",
        "flip": conv(flip), "call_wall": conv(call_wall), "put_wall": conv(put_wall), "magnet": conv(magnet),
        "above_flip": bool(price >= conv(flip)) if flip else None,
        "chain_levels": {"spot": round(chain_spot, 2), "flip": round(flip, 2) if flip else None, "call_wall": call_wall, "put_wall": put_wall, "magnet": magnet},
        "pc_volume": pc, "pc_oi": round(float(pu.oi.sum()) / float(c.oi.sum()), 2) if c.oi.sum() else None,
        "pc_today_expiry": pc_0, "calls": int(cv), "puts": int(pv),
        "pc_band": list(PC_BANDS[p["band"]]), "pc_mood": _pc_mood(pc, p["band"]), "scale": round(scale, 5),
    }


def snapshot() -> dict[str, Any]:
    t0 = time.time()
    vix: dict[str, Any] = {}
    for k, s in (("VIX", "^VIX"), ("VIX9D", "^VIX9D"), ("VIX3M", "^VIX3M"), ("VXN", "^VXN")):
        last, prev = _last(s)
        if last:
            vix[k] = {"last": round(last, 2), "prev": round(prev, 2) if prev else None}
    v = vix.get("VIX", {}).get("last")
    if v:
        vix["mood"] = "calm" if v < 16 else "normal" if v < 20 else "nervous" if v < 28 else "stressed"
        nine, three = vix.get("VIX9D", {}).get("last"), vix.get("VIX3M", {}).get("last")
        vix["curve"] = "inverted" if nine and nine > v else "inverted" if three and v > three else "normal"
    iv_fallback = _vol_curve(vix)
    products = []
    for p in PRODUCTS:
        try:
            products.append(_product(p, iv_fallback))
        except Exception as e:  # noqa: BLE001
            log.warning("options map %s failed: %s", p["key"], e)
    mstate = fetch.market_state()
    return {"at": datetime.now(config.ET).isoformat(timespec="seconds"), "market_state": mstate,
            "volume_is": "today" if mstate == "open" else "last session",
            "vix": vix, "products": products, "interval_s": 600, "elapsed_s": round(time.time() - t0, 1)}
