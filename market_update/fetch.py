"""Data fetchers. No AI here: prices, history, news, calendars, rates.

Sources (all keyless):
  - Yahoo Finance via yfinance: quotes, daily history, extended-hours bars, news, fundamentals
  - FRED: Treasury yield curve (daily, one-day lag)
  - ForexFactory weekly calendar JSON: economic events
  - Nasdaq earnings calendar JSON: earnings by date
"""
from __future__ import annotations

import io
import json
import re
import logging
import time as _clock
import warnings
from datetime import date, datetime, time, timedelta
from typing import Any

import pandas as pd
import requests
import yfinance as yf

from . import config
from .config import ET

warnings.filterwarnings("ignore")
logging.getLogger("yfinance").setLevel(logging.CRITICAL)
log = logging.getLogger(__name__)

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "application/json, text/plain, */*"}

CACHE_DIR = config.CACHE_DIR


def _cache_get(name: str, ttl_s: int) -> Any | None:
    """Return cached JSON if younger than ttl_s; with ttl_s < 0 return it at any age."""
    p = CACHE_DIR / f"{name}.json"
    if not p.exists():
        return None
    age = datetime.now().timestamp() - p.stat().st_mtime
    if ttl_s >= 0 and age > ttl_s:
        return None
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return None


def _cache_put(name: str, data: Any) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / f"{name}.json").write_text(json.dumps(data, default=str))
    except Exception:  # noqa: BLE001
        log.debug("cache write failed for %s", name)


PRE_OPEN = time(4, 0)
REGULAR_OPEN = time(9, 30)
REGULAR_CLOSE = time(16, 0)
POST_CLOSE = time(20, 0)


# ---------------------------------------------------------------------------
# Session / clock
# ---------------------------------------------------------------------------
def now_et() -> datetime:
    return datetime.now(tz=ET)


def market_state(now: datetime | None = None) -> str:
    """'pre' | 'open' | 'post' | 'closed' (exchange holidays not modelled)."""
    now = now or now_et()
    if now.weekday() >= 5:
        return "closed"
    t = now.time()
    if PRE_OPEN <= t < REGULAR_OPEN:
        return "pre"
    if REGULAR_OPEN <= t < REGULAR_CLOSE:
        return "open"
    if REGULAR_CLOSE <= t < POST_CLOSE:
        return "post"
    return "closed"


def next_session_date(now: datetime | None = None) -> date:
    """The US session this preview is for: today if it has not closed yet,
    otherwise the next weekday."""
    now = now or now_et()
    d = now.date()
    if now.weekday() < 5 and now.time() < REGULAR_CLOSE:
        return d
    d += timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def _to_float(x: Any) -> float | None:
    try:
        if x is None or pd.isna(x):
            return None
        return float(x)
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Batch bars
# ---------------------------------------------------------------------------
def download(tickers: list[str], **kw) -> pd.DataFrame:
    kw.setdefault("group_by", "ticker")
    kw.setdefault("progress", False)
    kw.setdefault("threads", True)
    kw.setdefault("auto_adjust", False)
    tickers = list(dict.fromkeys(tickers))
    df = yf.download(tickers, **kw)
    if df is None or df.empty:
        return pd.DataFrame()
    if not isinstance(df.columns, pd.MultiIndex):
        df = pd.concat({tickers[0]: df}, axis=1)
    return df


def frame_for(df: pd.DataFrame, t: str) -> pd.DataFrame | None:
    if df.empty or t not in df.columns.get_level_values(0):
        return None
    sub = df[t].dropna(how="all")
    return sub if not sub.empty else None


def fetch_history(tickers: list[str], period: str = "1y") -> pd.DataFrame:
    """Daily OHLCV for many tickers in one call."""
    return download(tickers, period=period, interval="1d")


# ---------------------------------------------------------------------------
# Live snapshot: last print (incl. extended hours) vs last regular close
# ---------------------------------------------------------------------------
def fetch_snapshot(tickers: list[str], history: pd.DataFrame | None = None) -> dict[str, dict[str, Any]]:
    """Per ticker: prev_close, last_price, gap_pct, session volume, sparkline of
    the current/extended session. `history` (daily frame) avoids a second download."""
    daily = history if history is not None else fetch_history(tickers, "1mo")
    minute = download(tickers, period="1d", interval="1m", prepost=True)
    state = market_state()
    out: dict[str, dict[str, Any]] = {}
    for t in tickers:
        d = frame_for(daily, t)
        if d is None or "Close" not in d:
            continue
        d = d.dropna(subset=["Close"])
        if d.empty:
            continue
        # The daily frame can already carry TODAY's partial bar during and after the session; the
        # prior close must be the last COMPLETED session, or every change reads 0.00%.
        today_et = now_et().date()
        k = -2 if (len(d) >= 2 and d.index[-1].date() >= today_et) else -1
        prev_close = _to_float(d["Close"].iloc[k])
        prev_date = d.index[k].date()
        avg_volume = _to_float(d["Volume"].tail(10).mean()) or 0.0

        m = frame_for(minute, t)
        last_price, last_ts, ext_volume, session_volume, closes = prev_close, None, 0.0, 0.0, []
        session_day = None
        if m is not None and "Close" in m:
            m = m.dropna(subset=["Close"])
            if not m.empty:
                idx = m.index
                idx = idx.tz_localize("UTC") if idx.tz is None else idx
                m = m.copy()
                m.index = idx.tz_convert(ET)
                session_day = m.index[-1].date()
                close_ts = datetime.combine(prev_date, REGULAR_CLOSE, tzinfo=ET)
                ext = m[m.index > close_ts]
                if ext.empty and session_day > prev_date:
                    ext = m
                last_price = _to_float(m["Close"].iloc[-1]) or prev_close
                last_ts = m.index[-1].isoformat()
                if not ext.empty:
                    ext_volume = _to_float(ext["Volume"].sum()) or 0.0
                    closes = [round(float(x), 4) for x in ext["Close"].tail(120).tolist()]
                if session_day > prev_date:
                    reg = m[(m.index.time >= REGULAR_OPEN) & (m.index.time < REGULAR_CLOSE)]
                    session_volume = _to_float(reg["Volume"].sum()) or 0.0
        # Relative volume: today's regular-session volume against the average,
        # scaled by how much of the session has elapsed when the market is open.
        rel_vol = None
        if session_volume and avg_volume:
            frac = 1.0
            if state == "open":
                now = now_et()
                elapsed = (now.hour * 60 + now.minute) - (9 * 60 + 30)
                frac = max(0.05, min(1.0, elapsed / 390))
            rel_vol = round(session_volume / (avg_volume * frac), 2)
        gap_pct = ((last_price / prev_close) - 1.0) * 100.0 if prev_close and last_price else 0.0
        out[t] = {
            "ticker": t,
            "prev_close": prev_close,
            "prev_close_date": prev_date.isoformat(),
            "last_price": last_price,
            "last_ts": last_ts,
            "gap_pct": round(gap_pct, 2),
            "ext_volume": ext_volume,
            "session_volume": session_volume,
            "avg_volume": avg_volume,
            "avg_dollar_volume": avg_volume * (prev_close or 0.0),
            "rel_volume": rel_vol,
            "session_closes": closes,
        }
    return out


# ---------------------------------------------------------------------------
# Fundamentals / meta (slow: one request per ticker; keep the list short)
# ---------------------------------------------------------------------------
INFO_FIELDS = {
    "name": ("shortName", "longName"),
}


_INFO_KEEP = 30 * 86400          # a company profile that is a month old beats an empty one


def fetch_info(tickers: list[str]) -> dict[str, dict[str, Any]]:
    """Company profile per ticker. Yahoo's profile endpoint is rate-limited and sometimes blocked
    outright; when it returns nothing, reuse the last good profile for that name (marked stale)
    and take the market cap from the lighter fast_info feed."""
    out = {}
    store = _cache_get("info_last_good", _INFO_KEEP) or {}
    dirty = False
    for t in tickers:
        stale = False
        try:
            info = yf.Ticker(t).info or {}
        except Exception as e:  # noqa: BLE001
            log.warning("info failed for %s: %s", t, e)
            info = {}
        if info.get("marketCap") or info.get("sector") or info.get("quoteType"):
            store[t] = {"info": info, "at": _clock.time()}
            dirty = True
        elif store.get(t):
            info = dict(store[t]["info"])
            stale = True
        if not info.get("marketCap"):
            try:
                mc = yf.Ticker(t).fast_info.get("marketCap")
                if mc:
                    info["marketCap"] = mc
            except Exception:  # noqa: BLE001
                pass
        qt = info.get("quoteType")
        earn_ts = info.get("earningsTimestampStart") or info.get("earningsTimestamp")
        next_earnings = None
        days_to_earnings = None
        if earn_ts:
            try:
                ed = datetime.fromtimestamp(int(earn_ts), tz=ET).date()
                next_earnings = ed.isoformat()
                days_to_earnings = (ed - now_et().date()).days
            except Exception:  # noqa: BLE001
                pass
        out[t] = {
            "name": info.get("shortName") or info.get("longName") or t,
            "sector": info.get("sector") or {"ETF": "ETF", "CRYPTOCURRENCY": "Crypto", "INDEX": "Index"}.get(qt, "Unknown"),
            "industry": info.get("industry") or {"ETF": "ETF", "CRYPTOCURRENCY": "Cryptocurrency"}.get(qt, ""),
            "market_cap": info.get("marketCap"),
            "beta": info.get("beta"),
            "short_float": info.get("shortPercentOfFloat"),
            "trailing_pe": info.get("trailingPE"),
            "forward_pe": info.get("forwardPE"),
            "ps": info.get("priceToSalesTrailing12Months"),
            "rev_growth": info.get("revenueGrowth"),
            "eps_growth": info.get("earningsGrowth"),
            "margins": info.get("profitMargins"),
            "analyst": info.get("recommendationKey"),
            "target": info.get("targetMeanPrice"),
            "next_earnings": next_earnings,
            "days_to_earnings": days_to_earnings,
            "quote_type": qt,
            "profile_stale": stale,
            "profile_as_of": (store.get(t) or {}).get("at"),
        }
    if dirty:
        _cache_put("info_last_good", store)
    return out


# ---------------------------------------------------------------------------
# Macro tape, gauges
# ---------------------------------------------------------------------------
def fetch_quotes(symbols: list[str]) -> dict[str, dict[str, Any]]:
    """fast_info quotes: last, prev close, change."""
    out = {}
    for sym in symbols:
        last = prev = None
        try:
            fi = yf.Ticker(sym).fast_info
            last = _to_float(fi.last_price)
            prev = _to_float(fi.regular_market_previous_close) or _to_float(fi.previous_close)
        except Exception as e:  # noqa: BLE001
            log.warning("fast_info failed for %s: %s", sym, e)
        change = (last - prev) if (last is not None and prev is not None) else None
        out[sym] = {"last": last, "prev_close": prev, "change": change,
                    "change_pct": round(change / prev * 100, 2) if (change is not None and prev) else None}
    return out


def fetch_world_tape() -> list[dict[str, Any]]:
    """Major world indices: last and change, for the around-the-world strip."""
    symbols = [x[0] for x in config.WORLD_TAPE]
    try:
        quotes = fetch_quotes(symbols)
    except Exception as e:  # noqa: BLE001
        log.warning("world tape failed: %s", e)
        quotes = {}
    return [{"symbol": sym, "label": label, "region": region, **(quotes.get(sym) or {})} for sym, label, region in config.WORLD_TAPE]


def fetch_macro_tape() -> list[dict[str, Any]]:
    symbols = [s for s, _, _ in config.MACRO_TAPE]
    bars = download(symbols, period="5d", interval="15m", prepost=True)
    quotes = fetch_quotes(symbols)
    rows = []
    for sym, label, kind in config.MACRO_TAPE:
        q = quotes.get(sym, {})
        spark: list[float] = []
        f = frame_for(bars, sym)
        if f is not None and "Close" in f:
            closes = f["Close"].dropna()
            spark = [round(float(x), 4) for x in closes.tail(96).tolist()]
            if q.get("last") is None and not closes.empty:
                q["last"] = float(closes.iloc[-1])
        rows.append({"symbol": sym, "label": label, "kind": kind, **q, "spark": spark})
    return rows


# ---------------------------------------------------------------------------
# Rates: FRED curve + live yields
# ---------------------------------------------------------------------------
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
# FRED stalls on browser-like user agents; a plain client UA answers in well under a second.
FRED_UA = {"User-Agent": "market-update/0.2 (+https://github.com)", "Accept": "text/csv"}
CURVE = [("DGS1MO", "1M", 1 / 12), ("DGS3MO", "3M", 0.25), ("DGS6MO", "6M", 0.5), ("DGS1", "1Y", 1.0),
         ("DGS2", "2Y", 2.0), ("DGS3", "3Y", 3.0), ("DGS5", "5Y", 5.0), ("DGS7", "7Y", 7.0),
         ("DGS10", "10Y", 10.0), ("DGS20", "20Y", 20.0), ("DGS30", "30Y", 30.0)]


def fetch_fred_curve() -> dict[str, Any]:
    cached = _cache_get("fred_curve", 6 * 3600)
    if cached:
        return cached
    result = _fetch_fred_curve_live()
    if result:
        _cache_put("fred_curve", result)
        return result
    return _cache_get("fred_curve", -1) or {}


def _fetch_fred_curve_live() -> dict[str, Any]:
    ids = ",".join(c[0] for c in CURVE)
    df = None
    for attempt in range(3):
        try:
            r = requests.get(FRED_URL, params={"id": ids}, headers=FRED_UA, timeout=20 + 20 * attempt)
            r.raise_for_status()
            df = pd.read_csv(io.StringIO(r.text), na_values=["."])
            break
        except Exception as e:  # noqa: BLE001
            log.warning("FRED fetch failed (attempt %d): %s", attempt + 1, e)
    if df is None:
        return {}
    df = df.rename(columns={df.columns[0]: "date"})
    df["date"] = pd.to_datetime(df["date"])
    df = df.dropna(subset=["DGS10"]).set_index("date").sort_index()
    if df.empty:
        return {}
    latest = df.iloc[-1]
    as_of = df.index[-1].date()

    def row_at(days_back: int) -> pd.Series:
        target = df.index[-1] - pd.Timedelta(days=days_back)
        sub = df[df.index <= target]
        return sub.iloc[-1] if not sub.empty else latest

    m_ago, y_ago = row_at(30), row_at(365)
    curve = []
    for fid, label, yrs in CURVE:
        curve.append({"label": label, "tenor_years": yrs,
                      "today": _to_float(latest.get(fid)), "month_ago": _to_float(m_ago.get(fid)),
                      "year_ago": _to_float(y_ago.get(fid))})
    hist = df.tail(260)
    spreads = {
        "2s10s": {"latest": _to_float((latest["DGS10"] - latest["DGS2"]) * 100),
                  "history": [{"t": ts.date().isoformat(), "v": round(float(v) * 100, 1)}
                              for ts, v in (hist["DGS10"] - hist["DGS2"]).dropna().items()]},
        "3m10y": {"latest": _to_float((latest["DGS10"] - latest["DGS3MO"]) * 100),
                  "history": [{"t": ts.date().isoformat(), "v": round(float(v) * 100, 1)}
                              for ts, v in (hist["DGS10"] - hist["DGS3MO"]).dropna().items()]},
    }
    ten_hist = [{"t": ts.date().isoformat(), "v": round(float(v), 3)} for ts, v in hist["DGS10"].dropna().items()]
    return {"as_of": as_of.isoformat(), "curve": curve, "spreads": spreads, "ten_year_history": ten_hist,
            "chg_10y_1m_bp": _to_float((latest["DGS10"] - m_ago["DGS10"]) * 100),
            "chg_2y_1m_bp": _to_float((latest["DGS2"] - m_ago["DGS2"]) * 100)}


def fetch_live_yields() -> list[dict[str, Any]]:
    q = fetch_quotes([s for s, _ in config.LIVE_YIELDS])
    rows = []
    for sym, label in config.LIVE_YIELDS:
        d = q.get(sym, {})
        rows.append({"symbol": sym, "label": label, "last": d.get("last"),
                     "change_bp": round(d["change"] * 100, 1) if d.get("change") is not None else None})
    return rows


# ---------------------------------------------------------------------------
# Flows: ratio gauges from daily closes
# ---------------------------------------------------------------------------
def ratio_gauges(history: pd.DataFrame, snapshot: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for g in config.FLOW_GAUGES:
        a, b = frame_for(history, g["num"]), frame_for(history, g["den"])
        if a is None or b is None:
            continue
        ratio = (a["Close"] / b["Close"]).dropna()
        if len(ratio) < 25:
            continue
        # live ratio from snapshot when available
        sa, sb = snapshot.get(g["num"]), snapshot.get(g["den"])
        live = (sa["last_price"] / sb["last_price"]) if (sa and sb and sa["last_price"] and sb["last_price"]) else float(ratio.iloc[-1])
        def chg(n: int) -> float | None:
            if len(ratio) <= n:
                return None
            base = float(ratio.iloc[-1 - n])
            return round((live / base - 1) * 100, 2) if base else None
        rows.append({
            "key": g["key"], "label": g["label"], "num": g["num"], "den": g["den"],
            "up_means": g["up_means"], "value": round(live, 4),
            "chg_1d": chg(1), "chg_5d": chg(5), "chg_1m": chg(21), "chg_3m": chg(63),
            "spark": [round(float(x), 4) for x in ratio.tail(63).tolist()],
        })
    return rows


def sector_table(history: pd.DataFrame, snapshot: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    spy = frame_for(history, "SPY")
    spy_1m = None
    if spy is not None and len(spy) > 21:
        spy_1m = float(spy["Close"].iloc[-1] / spy["Close"].iloc[-22] - 1) * 100
    rows = []
    for sym, label in config.SECTOR_ETFS.items():
        f = frame_for(history, sym)
        s = snapshot.get(sym)
        if f is None or s is None:
            continue
        c = f["Close"].dropna()
        live = s["last_price"] or float(c.iloc[-1])
        def chg(n: int) -> float | None:
            if len(c) <= n:
                return None
            base = float(c.iloc[-1 - n])
            return round((live / base - 1) * 100, 2) if base else None
        r1m = chg(21)
        rows.append({"symbol": sym, "label": label, "last": live, "chg_1d": s["gap_pct"],
                     "chg_5d": chg(5), "chg_1m": r1m,
                     "rel_1m": round(r1m - spy_1m, 2) if (r1m is not None and spy_1m is not None) else None})
    rows.sort(key=lambda x: x["chg_1d"] if x["chg_1d"] is not None else -999, reverse=True)
    return rows


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------
def fetch_news(symbols: list[str], per_symbol: int = 10, lookback_hours: int = config.NEWS_LOOKBACK_HOURS) -> list[dict[str, Any]]:
    cutoff = now_et() - timedelta(hours=lookback_hours)
    seen: dict[str, dict[str, Any]] = {}
    for s in symbols:
        try:
            items = yf.Ticker(s).news or []
        except Exception as e:  # noqa: BLE001
            log.warning("news failed for %s: %s", s, e)
            continue
        for it in items[:per_symbol]:
            c = it.get("content") or {}
            nid = c.get("id") or it.get("id")
            title = (c.get("title") or "").strip()
            if not nid or not title:
                continue
            pub = c.get("pubDate") or c.get("displayTime")
            try:
                pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00")).astimezone(ET) if pub else None
            except Exception:  # noqa: BLE001
                pub_dt = None
            if pub_dt and pub_dt < cutoff:
                continue
            if nid in seen:
                seen[nid]["related_tickers"].append(s)
                continue
            seen[nid] = {
                "id": nid,
                "headline": title,
                "summary": (c.get("summary") or c.get("description") or "").strip()[:600],
                "source": ((c.get("provider") or {}).get("displayName")) or "",
                "published": pub_dt.isoformat() if pub_dt else (pub or ""),
                "url": ((c.get("canonicalUrl") or {}).get("url")) or ((c.get("clickThroughUrl") or {}).get("url")) or "",
                "related_tickers": [s],
            }
    items = list(seen.values())
    items.sort(key=lambda x: x["published"], reverse=True)
    return items


# ---------------------------------------------------------------------------
# Economic calendar (ForexFactory weekly feed)
# ---------------------------------------------------------------------------
FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"


def fetch_calendar(session: date) -> list[dict[str, Any]]:
    data = _cache_get("ff_calendar", 3600)
    if data is None:
        try:
            r = requests.get(FF_URL, headers=UA, timeout=20)
            r.raise_for_status()
            data = r.json()
            _cache_put("ff_calendar", data)
        except Exception as e:  # noqa: BLE001
            log.warning("calendar fetch failed, using last good copy if any: %s", e)
            data = _cache_get("ff_calendar", -1) or []
    rows = []
    for ev in data:
        try:
            dt = datetime.fromisoformat(ev["date"]).astimezone(ET)
        except Exception:  # noqa: BLE001
            continue
        if dt.date() != session:
            continue
        impact = ev.get("impact") or ""
        country = ev.get("country") or ""
        if country != "USD" and impact != "High":
            continue
        rows.append({"title": ev.get("title") or "", "country": country, "time_et": dt.strftime("%H:%M"),
                     "ff_impact": impact, "forecast": ev.get("forecast") or "", "previous": ev.get("previous") or ""})
    rows.sort(key=lambda x: x["time_et"])
    return rows


# ---------------------------------------------------------------------------
# Earnings calendar (Nasdaq)
# ---------------------------------------------------------------------------
NASDAQ_EARNINGS = "https://api.nasdaq.com/api/calendar/earnings"


def _parse_cap(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(s.replace("$", "").replace(",", ""))
    except ValueError:
        return None


def fetch_earnings(session: date) -> list[dict[str, Any]]:
    try:
        r = requests.get(NASDAQ_EARNINGS, params={"date": session.isoformat()}, headers=UA, timeout=20)
        r.raise_for_status()
        rows = ((r.json() or {}).get("data") or {}).get("rows") or []
    except Exception as e:  # noqa: BLE001
        log.warning("earnings fetch failed: %s", e)
        return []
    out = []
    for row in rows:
        t = row.get("time") or ""
        when = {"time-pre-market": "before open", "time-after-hours": "after close"}.get(t, "unspecified")
        out.append({"symbol": row.get("symbol") or "", "name": row.get("name") or "",
                    "market_cap": _parse_cap(row.get("marketCap")), "report_time": when,
                    "eps_forecast": row.get("epsForecast") or "", "last_year_eps": row.get("lastYearEPS") or "",
                    "num_estimates": row.get("noOfEsts") or ""})
    out.sort(key=lambda x: x["market_cap"] or 0.0, reverse=True)
    return out


# ---------------------------------------------------------------------------
# Smart money: insiders, institutions, short interest (Yahoo via yfinance)
# ---------------------------------------------------------------------------
def fetch_smart_money(tickers: list[str], lookback_days: int = 90) -> dict[str, dict[str, Any]]:
    """Per ticker: insider buy/sell summary (6m), recent open-market purchases, institutional
    ownership and top-holder changes, short interest change. Cached 12h per ticker."""
    out: dict[str, dict[str, Any]] = {}
    cutoff = (now_et() - timedelta(days=lookback_days)).date()
    for t in tickers:
        cached = _cache_get(f"sm_{t}", 12 * 3600)
        if cached:
            out[t] = cached
            continue
        row: dict[str, Any] = {"ticker": t, "insider": {}, "institutions": {}, "short": {}}
        try:
            tk = yf.Ticker(t)
            ip = tk.insider_purchases
            if ip is not None and len(ip) >= 3:
                vals = {str(ip.iloc[i, 0]): ip.iloc[i] for i in range(len(ip))}
                def g(label: str, col: str) -> float | None:
                    r = vals.get(label)
                    return _to_float(r[col]) if r is not None else None
                row["insider"] = {
                    "buy_shares_6m": g("Purchases", "Shares"), "buy_trans_6m": g("Purchases", "Trans"),
                    "sell_shares_6m": g("Sales", "Shares"), "sell_trans_6m": g("Sales", "Trans"),
                    "net_shares_6m": g("Net Shares Purchased (Sold)", "Shares"),
                    "net_pct_6m": g("% Net Shares Purchased (Sold)", "Shares"),
                }
            it = tk.insider_transactions
            buys, sells = [], []
            if it is not None and len(it):
                for _, r in it.iterrows():
                    text = str(r.get("Text") or "")
                    d = r.get("Start Date")
                    try:
                        dd = pd.Timestamp(d).date()
                    except Exception:  # noqa: BLE001
                        continue
                    if dd < cutoff:
                        continue
                    rec = {"date": dd.isoformat(), "insider": str(r.get("Insider") or "").title(), "position": str(r.get("Position") or ""),
                           "shares": _to_float(r.get("Shares")), "value": _to_float(r.get("Value")), "text": text[:80]}
                    if text.startswith("Purchase"):
                        buys.append(rec)
                    elif text.startswith("Sale"):
                        sells.append(rec)
            row["insider"]["open_market_buys_90d"] = buys[:8]
            row["insider"]["open_market_sales_90d"] = sells[:8]
            row["insider"]["buy_value_90d"] = round(sum(b["value"] or 0 for b in buys))
            row["insider"]["sell_value_90d"] = round(sum(s["value"] or 0 for s in sells))
            row["insider"]["distinct_buyers_90d"] = len({b["insider"] for b in buys})
            info = tk.info or {}
            ih = tk.institutional_holders
            top_chg = None
            if ih is not None and len(ih) and "pctChange" in ih:
                pc = pd.to_numeric(ih["pctChange"], errors="coerce").dropna()
                top_chg = _to_float(pc.head(10).mean())
            row["institutions"] = {
                "pct_held": info.get("heldPercentInstitutions"), "pct_insiders": info.get("heldPercentInsiders"),
                "count": None if ih is None else int(len(ih)), "top10_avg_change": round(top_chg, 4) if top_chg is not None else None,
                "top_holders": [] if ih is None else [{"holder": str(r["Holder"]), "pct": _to_float(r.get("pctHeld")), "change": _to_float(r.get("pctChange"))}
                                                     for _, r in ih.head(5).iterrows()],
                "as_of": None if ih is None or not len(ih) else str(ih.iloc[0]["Date Reported"])[:10],
            }
            ss, sp = info.get("sharesShort"), info.get("sharesShortPriorMonth")
            row["short"] = {"shares_short": ss, "prior_month": sp, "change_pct": round((ss / sp - 1) * 100, 1) if (ss and sp) else None,
                            "short_pct_float": info.get("shortPercentOfFloat"), "days_to_cover": info.get("shortRatio")}
        except Exception as e:  # noqa: BLE001
            log.warning("smart money failed for %s: %s", t, e)
        _cache_put(f"sm_{t}", row)
        out[t] = row
    return out


# ---------------------------------------------------------------------------
# Congressional trades (STOCK Act filings). Source is pluggable; see _congress_sources.
# ---------------------------------------------------------------------------
def fetch_congress_trades(lookback_days: int = 90) -> dict[str, Any]:
    cached = _cache_get("congress", 6 * 3600)
    if cached:
        return cached
    result: dict[str, Any] = {"status": "unavailable", "by_ticker": {}, "top_buys": [], "as_of": None}
    for name, fn in _congress_sources():
        try:
            trades = fn(lookback_days)
        except Exception as e:  # noqa: BLE001
            log.warning("congress source %s failed: %s", name, e)
            continue
        if trades:
            by: dict[str, list] = {}
            buys: dict[str, int] = {}
            for tr in trades:
                by.setdefault(tr["ticker"], []).append(tr)
                if tr["type"] == "buy":
                    buys[tr["ticker"]] = buys.get(tr["ticker"], 0) + 1
            result = {"status": f"ok:{name}", "by_ticker": by, "as_of": max(tr["date"] for tr in trades),
                      "top_buys": sorted(({"ticker": k, "buys": v} for k, v in buys.items()), key=lambda x: -x["buys"])[:15]}
            break
    _cache_put("congress", result)
    return result


def _congress_quiver(lookback_days: int) -> list[dict[str, Any]]:
    """Quiver Quant's public congress-trading page embeds a recentTradesData literal:
    [ticker, description, asset_type, transaction, amount, politician, chamber, party, filed, traded, ...]."""
    import ast
    r = requests.get("https://www.quiverquant.com/congresstrading/", headers=UA, timeout=30)
    r.raise_for_status()
    h = r.text
    i = h.find("let recentTradesData = [")
    if i < 0:
        return []
    j = h.find("];", i)
    data = ast.literal_eval(h[i + len("let recentTradesData = "): j + 1])
    cutoff = (now_et() - timedelta(days=lookback_days)).date()
    out = []
    for row in data:
        try:
            ticker, desc, asset_type, tx, amount, pol, chamber, party, filed, traded = row[:10]
        except ValueError:
            continue
        if not ticker or ticker == "-" or asset_type not in ("ST", "GS"):
            continue
        if asset_type == "GS":            # government securities / munis
            continue
        try:
            td = datetime.fromisoformat(str(traded)[:10]).date()
        except ValueError:
            continue
        if td < cutoff:
            continue
        t = tx.lower()
        out.append({"ticker": ticker.upper(), "name": pol, "chamber": chamber, "party": party,
                    "type": "buy" if "purchase" in t else ("sale" if "sale" in t else t), "size": amount,
                    "date": td.isoformat(), "filed": str(filed)[:10], "description": desc[:60]})
    return out


def _congress_sources():
    return [("quiverquant", _congress_quiver)]


# ---------------------------------------------------------------------------
# Options flow: Yahoo option chains (per ticker) + CBOE daily market statistics
# ---------------------------------------------------------------------------
def fetch_options_flow(tickers: list[str], expiries: int = 3, cache_s: int = 1800) -> dict[str, dict[str, Any]]:
    """Per ticker over the nearest `expiries` expirations: call/put volume and open interest, put/call ratios,
    notional traded (volume x last x 100), unusual contracts (volume >= 500 and >= 3x open interest), top strikes,
    ATM implied volatility. Cached 30 minutes per ticker."""
    out: dict[str, dict[str, Any]] = {}
    for t in tickers:
        cached = _cache_get(f"opt_{t}", cache_s)
        if cached:
            out[t] = cached
            continue
        row: dict[str, Any] = {"ticker": t, "ok": False}
        try:
            tk = yf.Ticker(t)
            today = now_et().date()
            after_close = market_state() in ("post", "closed")
            # skip an expiry that has already settled (today's, after the close): its volume is real but its
            # open interest and implied volatility are meaningless for tomorrow
            exps = [e for e in list(tk.options or []) if (datetime.fromisoformat(e).date() - today).days >= (1 if after_close else 0)][:expiries]
            if not exps:
                out[t] = row
                continue
            spot = _to_float(getattr(tk.fast_info, "last_price", None))
            cv = pv = coi = poi = cn = pn = 0.0
            unusual: list[dict[str, Any]] = []
            top_c: list[dict[str, Any]] = []
            top_p: list[dict[str, Any]] = []
            atm_iv: list[float] = []
            for e in exps:
                try:
                    ch = tk.option_chain(e)
                except Exception:  # noqa: BLE001
                    continue
                dte = (datetime.fromisoformat(e).date() - now_et().date()).days
                for side, df in (("call", ch.calls), ("put", ch.puts)):
                    if df is None or df.empty:
                        continue
                    vol = df["volume"].fillna(0).astype(float)
                    oi = df["openInterest"].fillna(0).astype(float)
                    last = df["lastPrice"].fillna(0).astype(float)
                    notional = vol * last * 100
                    if side == "call":
                        cv += float(vol.sum()); coi += float(oi.sum()); cn += float(notional.sum())
                    else:
                        pv += float(vol.sum()); poi += float(oi.sum()); pn += float(notional.sum())
                    d2 = df.assign(_vol=vol, _oi=oi, _last=last, _notional=notional, _side=side, _exp=e, _dte=dte)
                    for _, r in d2.sort_values("_vol", ascending=False).head(3).iterrows():
                        rec = {"side": side, "strike": float(r["strike"]), "expiry": e, "dte": dte, "volume": int(r["_vol"]), "oi": int(r["_oi"]),
                               "last": float(r["_last"]), "notional": round(float(r["_notional"])), "iv": _to_float(r.get("impliedVolatility")),
                               "otm_pct": round((float(r["strike"]) / spot - 1) * 100, 1) if spot else None}
                        (top_c if side == "call" else top_p).append(rec)
                    # "unusual" needs established open interest to compare against; Yahoo posts OI overnight, so
                    # a contract with OI < 50 is simply new, not necessarily aggressive.
                    # Two ways a contract earns "unusual": volume at least 3x established open interest (OI >= 50), or,
                    # when OI has not been posted yet (Yahoo updates it overnight), a single strike carrying a big,
                    # concentrated share of the day's dollars. The `basis` field says which.
                    side_total_vol = float(vol.sum()) or 1.0
                    un_oi = d2[(d2["_vol"] >= 500) & (d2["_oi"] >= 50) & (d2["_vol"] >= 3 * d2["_oi"]) & (d2["_notional"] >= 250_000)]
                    un_conc = d2[(d2["_oi"] < 50) & (d2["_vol"] >= 1000) & (d2["_notional"] >= 1_000_000) & (d2["_vol"] / side_total_vol >= 0.05)]
                    for basis, frame in (("vs_open_interest", un_oi), ("concentrated_new", un_conc)):
                        for _, r in frame.sort_values("_notional", ascending=False).head(4).iterrows():
                            unusual.append({"side": side, "strike": float(r["strike"]), "expiry": e, "dte": dte, "volume": int(r["_vol"]), "oi": int(r["_oi"]),
                                            "last": float(r["_last"]), "notional": round(float(r["_notional"])),
                                            "vol_oi": round(float(r["_vol"]) / float(r["_oi"]), 1) if float(r["_oi"]) >= 50 else None,
                                            "share_of_side_volume": round(float(r["_vol"]) / side_total_vol, 3), "basis": basis,
                                            "otm_pct": round((float(r["strike"]) / spot - 1) * 100, 1) if spot else None})
                    if spot is not None and dte >= 5:
                        near = d2.iloc[(d2["strike"] - spot).abs().argsort()[:2]]
                        atm_iv.extend([float(x) for x in near["impliedVolatility"].dropna().tolist() if 0.05 < float(x) < 5])
            if not atm_iv and spot is not None:
                far = [e for e in list(tk.options or []) if (datetime.fromisoformat(e).date() - today).days >= 7][:1]
                for e in far:
                    try:
                        ch = tk.option_chain(e)
                        for df in (ch.calls, ch.puts):
                            near = df.iloc[(df["strike"] - spot).abs().argsort()[:2]]
                            atm_iv.extend([float(x) for x in near["impliedVolatility"].dropna().tolist() if 0.05 < float(x) < 5])
                    except Exception:  # noqa: BLE001
                        pass
            top_c.sort(key=lambda x: -x["volume"]); top_p.sort(key=lambda x: -x["volume"]); unusual.sort(key=lambda x: -x["notional"])
            row = {
                "ticker": t, "ok": True, "spot": spot, "expiries": exps,
                "call_volume": int(cv), "put_volume": int(pv), "call_oi": int(coi), "put_oi": int(poi),
                "pc_volume": round(pv / cv, 2) if cv else None, "pc_oi": round(poi / coi, 2) if coi else None,
                "call_notional": round(cn), "put_notional": round(pn), "total_notional": round(cn + pn),
                "call_share": round(cn / (cn + pn), 3) if (cn + pn) else None,
                "volume_to_oi": round((cv + pv) / (coi + poi), 2) if (coi + poi) else None,
                "oi_posted": bool((coi + poi) > 0),
                "atm_iv": round(sum(atm_iv) / len(atm_iv), 3) if atm_iv else None,
                "top_calls": top_c[:3], "top_puts": top_p[:3], "unusual": unusual[:6],
                "unusual_call_notional": round(sum(u["notional"] for u in unusual if u["side"] == "call")),
                "unusual_put_notional": round(sum(u["notional"] for u in unusual if u["side"] == "put")),
            }
        except Exception as e:  # noqa: BLE001
            log.warning("options flow failed for %s: %s", t, e)
        _cache_put(f"opt_{t}", row)
        out[t] = row
    return out


CBOE_DAILY = "https://cdn.cboe.com/data/us/options/market_statistics/daily/{d}_daily_options"


def fetch_cboe_daily() -> dict[str, Any]:
    """Cboe daily market statistics (put/call ratios by category, volumes). Tries today then the last 5 sessions."""
    cached = _cache_get("cboe_daily", 3600)
    if cached:
        return cached
    d = now_et().date()
    for back in range(0, 7):
        day = d - timedelta(days=back)
        if day.weekday() >= 5:
            continue
        try:
            r = requests.get(CBOE_DAILY.format(d=day.isoformat()), headers=UA, timeout=20)
            if r.status_code != 200:
                continue
            data = r.json()
            ratios = {x.get("name"): _to_float(x.get("value")) for x in data.get("ratios", []) if isinstance(x, dict)}
            out = {"as_of": day.isoformat(), "ratios": ratios, "raw_keys": list(data.keys())}
            for k, v in data.items():
                if k != "ratios" and isinstance(v, list):
                    out[k] = v[:40]
            _cache_put("cboe_daily", out)
            return out
        except Exception as e:  # noqa: BLE001
            log.warning("cboe daily failed for %s: %s", day, e)
    return {}


# ---------------------------------------------------------------------------
# Symbol directory (search index), intraday bars, low float
# ---------------------------------------------------------------------------
_EXCHANGES = {"N": "NYSE", "Q": "Nasdaq", "P": "NYSE Arca", "Z": "Cboe BZX", "A": "NYSE American", "V": "IEX", "M": "Nasdaq"}
_NAME_NOISE = re.compile(r"\s*-?\s*(Common Stock|Common Shares|Ordinary Shares|Class [A-C] (Common Stock|Ordinary Shares)|"
                         r"American Depositary Shares.*|Depositary Shares.*|Shares of Beneficial Interest|New Common Stock)\s*$", re.I)


def fetch_symbol_index() -> list[list[Any]]:
    """Every US-listed stock and ETF from Nasdaq Trader's daily symbol directory as
    [symbol, name, kind, exchange]; Yahoo-style symbols (BRK-B). Cached 24h."""
    cached = _cache_get("symbols", 24 * 3600)
    if cached:
        return cached
    try:
        r = requests.get("https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqtraded.txt", headers=UA, timeout=25)
        r.raise_for_status()
        lines = r.text.splitlines()
    except Exception as e:  # noqa: BLE001
        log.warning("symbol directory unavailable: %s", e)
        return _cache_get("symbols", -1) or []
    out: list[list[Any]] = []
    for line in lines[1:]:
        p = line.split("|")
        if len(p) < 8 or p[0] != "Y" or p[7] == "Y":
            continue
        sym, name, ex, etf = p[1].strip(), p[2].strip(), p[3].strip(), p[5].strip() == "Y"
        if not sym or "$" in sym or "+" in sym or "=" in sym or sym.endswith((".W", ".U", ".R", ".V")):
            continue
        name = re.sub(r"\s{2,}", " ", _NAME_NOISE.sub("", name)).strip(" -")
        out.append([sym.replace(".", "-"), name[:60], "ETF" if etf else "Stock", _EXCHANGES.get(ex, ex)])
    out.extend([[sym, name, "Crypto", "Crypto"] for sym, name in CRYPTO])
    if out:
        _cache_put("symbols", out)
    return out


CRYPTO = [("BTC-USD", "Bitcoin"), ("ETH-USD", "Ethereum"), ("SOL-USD", "Solana"), ("XRP-USD", "XRP"), ("BNB-USD", "BNB"), ("DOGE-USD", "Dogecoin"),
          ("ADA-USD", "Cardano"), ("TRX-USD", "TRON"), ("AVAX-USD", "Avalanche"), ("LINK-USD", "Chainlink"), ("DOT-USD", "Polkadot"), ("LTC-USD", "Litecoin"),
          ("SHIB-USD", "Shiba Inu"), ("BCH-USD", "Bitcoin Cash"), ("UNI-USD", "Uniswap"), ("XLM-USD", "Stellar"), ("HBAR-USD", "Hedera"), ("SUI-USD", "Sui"),
          ("NEAR-USD", "NEAR Protocol"), ("APT-USD", "Aptos"), ("PEPE-USD", "Pepe"), ("AAVE-USD", "Aave"), ("ETC-USD", "Ethereum Classic"), ("ARB-USD", "Arbitrum")]


def fetch_intraday(tickers: list[str], period: str = config.SCAN_LOOKBACK, interval: str = config.SCAN_INTERVAL) -> pd.DataFrame:
    """Regular-session bars (Yahoo reports no extended-hours volume, so those bars only add noise)."""
    try:
        return download(tickers, period=period, interval=interval, prepost=False)
    except Exception as e:  # noqa: BLE001
        log.warning("intraday download failed: %s", e)
        return pd.DataFrame()


def _float_stats(t: str) -> dict[str, Any]:
    """Float and ownership from the quote summary; changes rarely, so cached 24h per ticker."""
    key = f"float_{t}"
    cached = _cache_get(key, 24 * 3600)
    if cached is not None:
        return cached
    try:
        info = yf.Ticker(t).info or {}
    except Exception as e:  # noqa: BLE001
        log.warning("float lookup failed for %s: %s", t, e)
        info = {}
    out = {"float": info.get("floatShares"), "shares_outstanding": info.get("sharesOutstanding"),
           "short_pct_float": info.get("shortPercentOfFloat"), "days_to_cover": info.get("shortRatio"),
           "insiders_pct": info.get("heldPercentInsiders"), "institutions_pct": info.get("heldPercentInstitutions"),
           "name": info.get("shortName") or info.get("longName"), "sector": info.get("sector"), "industry": info.get("industry"),
           "hi52": info.get("fiftyTwoWeekHigh"), "lo52": info.get("fiftyTwoWeekLow")}
    if info:
        _cache_put(key, out)
    return out


def fetch_low_float(max_candidates: int = config.LOW_FLOAT_MAX_CANDIDATES) -> dict[str, Any]:
    """Low-float movers. Candidates come from Yahoo's screener (a custom small-cap
    movers query plus the gainers / small-cap / most-active lists); float, short
    interest and ownership come from each candidate's quote summary."""
    from yfinance import EquityQuery as Q
    lo, hi = config.LOW_FLOAT_PRICE
    cands: dict[str, dict[str, Any]] = {}
    status = "ok"

    def take(quotes: list[dict[str, Any]]) -> None:
        for q in quotes or []:
            s = q.get("symbol")
            if not s or q.get("quoteType") != "EQUITY" or q.get("region", "US") != "US" or "." in s or "^" in s:
                continue
            px, vol, so = q.get("regularMarketPrice"), q.get("regularMarketVolume"), q.get("sharesOutstanding")
            if not px or not (lo <= px <= hi) or not vol or vol < config.LOW_FLOAT_MIN_VOLUME:
                continue
            if so and so > config.LOW_FLOAT_MAX * 3:      # float cannot exceed shares outstanding
                continue
            cands.setdefault(s, q)
    try:
        base = [Q("eq", ["region", "us"]), Q("btwn", ["intradayprice", lo, hi]), Q("btwn", ["intradaymarketcap", 10_000_000, 2_000_000_000]),
                Q("gt", ["dayvolume", config.LOW_FLOAT_MIN_VOLUME])]
        take(yf.screen(Q("and", base + [Q("gt", ["percentchange", 3])]), sortField="percentchange", sortAsc=False, size=100).get("quotes", []))
        take(yf.screen(Q("and", base + [Q("gt", ["percentchange", 0])]), sortField="dayvolume", sortAsc=False, size=100).get("quotes", []))
        take(yf.screen(Q("and", base + [Q("lt", ["percentchange", -3])]), sortField="percentchange", sortAsc=True, size=40).get("quotes", []))
        for name in ("small_cap_gainers", "aggressive_small_caps", "day_gainers", "most_actives"):
            try:
                take(yf.screen(name, size=50).get("quotes", []))
            except Exception as e:  # noqa: BLE001
                log.warning("screen %s failed: %s", name, e)
    except Exception as e:  # noqa: BLE001
        log.warning("low-float screens failed: %s", e)
        status = f"screens unavailable: {type(e).__name__}"
    # most active first: turnover of shares outstanding, then percent move
    ordered = sorted(cands.values(), key=lambda q: -((q.get("regularMarketVolume") or 0) / max(q.get("sharesOutstanding") or 1e9, 1)))
    rows: list[dict[str, Any]] = []
    for q in ordered[:max_candidates]:
        t = q["symbol"]
        fs = _float_stats(t)
        flt = fs.get("float")
        if not flt or flt > config.LOW_FLOAT_MAX:
            continue
        vol = q.get("regularMarketVolume") or 0
        avg = q.get("averageDailyVolume3Month") or q.get("averageDailyVolume10Day")
        px, dh, dl = q.get("regularMarketPrice"), q.get("regularMarketDayHigh"), q.get("regularMarketDayLow")
        hi52, lo52 = q.get("fiftyTwoWeekHigh") or fs.get("hi52"), q.get("fiftyTwoWeekLow") or fs.get("lo52")
        rows.append({
            "ticker": t, "name": q.get("shortName") or fs.get("name") or t, "exchange": q.get("fullExchangeName"),
            "sector": fs.get("sector"), "industry": fs.get("industry"),
            "price": px, "chg_pct": q.get("regularMarketChangePercent"), "volume": vol, "avg_volume": avg,
            "rel_volume": round(vol / avg, 2) if avg else None,
            "float": flt, "shares_outstanding": fs.get("shares_outstanding") or q.get("sharesOutstanding"),
            "float_turnover": round(vol / flt, 2) if flt else None,
            "short_pct_float": fs.get("short_pct_float"), "days_to_cover": fs.get("days_to_cover"),
            "insiders_pct": fs.get("insiders_pct"), "institutions_pct": fs.get("institutions_pct"),
            "market_cap": q.get("marketCap"), "day_high": dh, "day_low": dl,
            "range_pos": round((px - dl) / (dh - dl), 2) if px and dh and dl and dh > dl else None,
            "hi52": hi52, "lo52": lo52, "pct_from_hi52": round((px / hi52 - 1) * 100, 1) if px and hi52 else None,
            "micro": flt < config.LOW_FLOAT_MICRO, "market_state": q.get("marketState"),
        })
    rows.sort(key=lambda r: -(r["float_turnover"] or 0))
    return {"rows": rows[: config.LOW_FLOAT_ROWS], "candidates": len(cands), "checked": min(len(ordered), max_candidates),
            "status": status, "as_of": now_et().isoformat(),
            "settings": {"max_float": config.LOW_FLOAT_MAX, "micro_float": config.LOW_FLOAT_MICRO, "price": list(config.LOW_FLOAT_PRICE),
                         "min_volume": config.LOW_FLOAT_MIN_VOLUME}}


# ---------------------------------------------------------------------------
# Free public feeds: Trump's Truth Social posts (public archives) and the Reddit crowd
# ---------------------------------------------------------------------------
_TRUTH_JSON = "https://ix.cnn.io/data/truth-social/truth_archive.json"      # public archive, updated every ~5 minutes
_TRUTH_RSS = "https://www.trumpstruth.org/feed"                              # fallback archive with an RSS feed
_APEWISDOM = "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1"        # Reddit ticker mentions, no key
_TRADESTIE = "https://tradestie.com/api/v1/apps/reddit"                       # r/wallstreetbets sentiment, no key
_UA = {"User-Agent": "Mozilla/5.0 (OneView; +https://shayan001-cell.github.io/market-update/)"}


def _strip_html(s: str) -> str:
    s = re.sub(r"<br\s*/?>|</p>", " ", s or "")
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("&amp;", "&").replace("&quot;", '"').replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
    return re.sub(r"\s+", " ", s).strip()


def fetch_trump_posts(limit: int = 25) -> dict[str, Any]:
    """Latest public posts by @realDonaldTrump on Truth Social, newest first, from public archives.
    Returns {posts: [...], source, as_of, status}. Cached 5 minutes."""
    cached = _cache_get("trump_posts", 300)
    if cached:
        return cached
    posts: list[dict[str, Any]] = []
    source, status = None, "ok"
    try:
        r = requests.get(_TRUTH_JSON, headers=_UA, timeout=20)
        r.raise_for_status()
        for x in r.json()[:limit * 2]:
            text = _strip_html(x.get("content") or "")
            media = x.get("media") or []
            if not text and not media:
                continue
            posts.append({"id": str(x.get("id")), "posted": x.get("created_at"), "text": text or ("(video post)" if any(str(m).endswith(".mp4") for m in media) else "(image post)"),
                          "url": x.get("url"), "media": len(media), "reposts": x.get("reblogs_count"), "replies": x.get("replies_count"), "has_text": bool(text)})
        source = "Truth Social via the CNN public archive"
    except Exception as e:  # noqa: BLE001
        log.warning("truth archive failed: %s", e)
    if not posts:
        try:
            import xml.etree.ElementTree as ET_
            r = requests.get(_TRUTH_RSS, headers=_UA, timeout=20)
            r.raise_for_status()
            root = ET_.fromstring(r.content)
            for it in root.iter("item"):
                text = _strip_html(it.findtext("description") or it.findtext("title") or "")
                link = it.findtext("link") or ""
                posts.append({"id": link.rsplit("/", 1)[-1] or text[:40], "posted": it.findtext("pubDate"), "text": text or "(media post)", "url": link, "media": 0, "reposts": None, "replies": None, "has_text": bool(text)})
            source = "Truth Social via trumpstruth.org"
        except Exception as e:  # noqa: BLE001
            log.warning("trumpstruth feed failed: %s", e)
            status = "unavailable"
    out = {"posts": posts[:limit], "source": source, "as_of": now_et().isoformat(), "status": status}
    if posts:
        _cache_put("trump_posts", out)
    return out


def fetch_reddit_crowd() -> dict[str, Any]:
    """Which tickers Reddit is talking about: mention counts (ApeWisdom) plus r/wallstreetbets
    sentiment (Tradestie). Both public, no key. Cached 10 minutes."""
    cached = _cache_get("reddit_crowd", 600)
    if cached:
        return cached
    rows: dict[str, dict[str, Any]] = {}
    sources = []
    try:
        r = requests.get(_APEWISDOM, headers=_UA, timeout=20)
        r.raise_for_status()
        for x in r.json().get("results", [])[:40]:
            t = (x.get("ticker") or "").upper()
            if not t:
                continue
            rows[t] = {"ticker": t, "name": _strip_html(x.get("name") or ""), "rank": x.get("rank"), "mentions": x.get("mentions"), "mentions_24h_ago": x.get("mentions_24h_ago"),
                       "rank_24h_ago": x.get("rank_24h_ago"), "upvotes": x.get("upvotes")}
        sources.append("ApeWisdom (mentions across finance subreddits)")
    except Exception as e:  # noqa: BLE001
        log.warning("apewisdom failed: %s", e)
    try:
        r = requests.get(_TRADESTIE, headers=_UA, timeout=20)
        r.raise_for_status()
        for x in r.json()[:60]:
            t = (x.get("ticker") or "").upper()
            if not t:
                continue
            row = rows.setdefault(t, {"ticker": t, "name": "", "rank": None, "mentions": None})
            row.update(wsb_sentiment=x.get("sentiment"), wsb_score=x.get("sentiment_score"), wsb_comments=x.get("no_of_comments"))
        sources.append("Tradestie (r/wallstreetbets sentiment)")
    except Exception as e:  # noqa: BLE001
        log.warning("tradestie failed: %s", e)
    ordered = sorted(rows.values(), key=lambda x: (-(x.get("mentions") or 0), -(x.get("wsb_comments") or 0)))
    out = {"rows": ordered[:30], "sources": sources, "as_of": now_et().isoformat(), "status": "ok" if sources else "unavailable"}
    if sources:
        _cache_put("reddit_crowd", out)
    return out
