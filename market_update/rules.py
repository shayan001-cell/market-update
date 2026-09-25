"""Backup judge: plain rules that answer every TypeSafe question set from the same
facts the model sees, so the site keeps working when the model service is down or
out of credits.

Every answer comes back in exactly the shape `analyze._answers_to_dict` produces
(`{"type": "choice", "choice", "confidence", "probabilities"}`, `{"type": "score",
"score", ...}`, `{"type": "noul", "p"}`) plus `"rules": True`, so nothing downstream
has to know which engine answered. Confidence is capped at MED (0.62): rules are a
fallback, never a claim of model-grade judgment.
"""
from __future__ import annotations

import re
from typing import Any, Callable

from . import judgments as J

CAP = 0.62          # highest confidence a rule may claim (-> "med" conviction)
LOW = 0.38          # weak evidence


# ---------------------------------------------------------------------------
# Answer builders (same shapes as the SDK answers after _answers_to_dict)
# ---------------------------------------------------------------------------
def _n(x: Any) -> float | None:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) and x == x else None


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def choice(q: Any, pick: str, conf: float = 0.5) -> dict[str, Any]:
    opts = list(q.criteria.keys()) if isinstance(q.criteria, dict) else [str(o) for o in q.criteria]
    if pick not in opts:
        pick = opts[-1]
    conf = _clamp(conf, 0.2, CAP)
    rest = (1 - conf) / max(1, len(opts) - 1)
    probs = {o: round(conf if o == pick else rest, 4) for o in opts}
    return {"type": "choice", "choice": pick, "confidence": round(conf, 3), "probabilities": probs, "rules": True}


def score(q: Any, value: float, conf: float = 0.5) -> dict[str, Any]:
    n = len(q.criteria)
    value = _clamp(float(value), 0, n - 1)
    conf = _clamp(conf, 0.2, CAP)
    lo, hi = int(value), min(n - 1, int(value) + 1)
    frac = value - lo
    probs = {str(i): 0.0 for i in range(n)}
    probs[str(lo)] += (1 - frac) * conf
    probs[str(hi)] += frac * conf
    spread = (1 - conf) / n
    probs = {k: round(v + spread, 4) for k, v in probs.items()}
    return {"type": "score", "score": round(value, 3), "confidence": round(conf, 3), "probabilities": probs, "rules": True}


def noul(p: float) -> dict[str, Any]:
    return {"type": "noul", "p": round(_clamp(p, 0.02, 0.95), 3), "rules": True}


def _has(text: str, *words: str) -> bool:
    t = text.lower()
    return any(w in t for w in words)


def _count(text: str, words: tuple[str, ...]) -> int:
    t = text.lower()
    return sum(t.count(w) for w in words)


# ---------------------------------------------------------------------------
# Keyword tables shared by headlines, regime driver and Trump posts
# ---------------------------------------------------------------------------
THEME_WORDS: dict[str, tuple[str, ...]] = {
    "fed_rates": ("fed ", "federal reserve", "powell", "fomc", "rate cut", "rate hike", "interest rate", "treasury yield", "yields", "bond market"),
    "macro_data": ("cpi", "inflation", "jobs report", "payroll", "unemployment", "gdp", "pmi", "ism", "retail sales", "consumer confidence", "housing starts", "pce"),
    "earnings": ("earnings", "guidance", "quarterly results", "revenue beat", "profit", "eps", "outlook"),
    "ai_tech": ("nvidia", "ai ", "artificial intelligence", "chip", "semiconductor", "openai", "microsoft", "apple", "alphabet", "google", "meta", "amazon", "cloud", "data center", "capex"),
    "geopolitics": ("tariff", "trade war", "sanction", "china", "iran", "russia", "ukraine", "israel", "election", "war ", "missile", "geopolit"),
    "energy_commodities": ("oil", "crude", "opec", "natural gas", "gold", "copper", "commodit", "brent", "wti"),
    "crypto": ("bitcoin", "crypto", "ether", "stablecoin", "coinbase", "blockchain"),
    "deals": ("acquire", "acquisition", "merger", "takeover", "buyout", "ipo", "buyback", "stake", "deal "),
    "regulatory_legal": ("antitrust", "fda", "lawsuit", "regulator", "doj", "ftc", "sec ", "probe", "investigation", "ban ", "ruling"),
}
BULL_WORDS = ("rally", "rallies", "surge", "jump", "soar", "record high", "beat", "beats", "raise", "raises", "upgrade", "gain", "rebound", "climb", "strong", "boost", "approve", "approval", "cut rates", "rate cut", "deal reached", "truce")
BEAR_WORDS = ("fall", "falls", "drop", "plunge", "sink", "slump", "tumble", "miss", "misses", "cut", "cuts guidance", "downgrade", "warn", "lawsuit", "tariff", "sanction", "recession", "layoff", "weak", "selloff", "sell-off", "crash", "halt", "probe", "delay")
MARKET_WIDE_WORDS = ("stocks", "wall street", "s&p", "nasdaq", "dow", "market", "investors", "fed", "treasur", "yield", "tariff", "economy", "inflation", "jobs")

GROUP_WORDS: dict[str, tuple[str, ...]] = {
    "mega_cap_tech": ("apple", "microsoft", "nvidia", "amazon", "alphabet", "google", "meta", "tesla", "nasdaq 100", "big tech"),
    "semis": ("semiconductor", "chip", "nvidia", "amd", "broadcom", "micron", "tsmc", "asml", "intel"),
    "small_caps_cyclicals": ("russell", "small cap", "small-cap", "industrial", "transport", "regional bank"),
    "financials": ("bank", "jpmorgan", "goldman", "morgan stanley", "citi", "wells fargo", "insurer", "visa", "mastercard"),
    "energy_materials": ("oil", "crude", "exxon", "chevron", "mining", "miner", "steel", "copper", "chemical"),
    "healthcare_biotech": ("pharma", "biotech", "fda", "drug", "medical", "unitedhealth", "pfizer", "merck", "lilly"),
    "consumer": ("retail", "restaurant", "airline", "travel", "auto", "walmart", "target", "nike", "starbucks"),
    "defensives": ("utility", "utilities", "staples", "real estate", "reit", "gold"),
    "crypto_linked": ("bitcoin", "crypto", "coinbase", "microstrategy", "strategy inc", "miner"),
}

SECTOR_TO_GROUP = {"Tech": "mega_cap_tech", "Comm": "mega_cap_tech", "Semis": "semis", "Cons Disc": "consumer", "Staples": "defensives",
                   "Financials": "financials", "Energy": "energy_materials", "Materials": "energy_materials", "Health": "healthcare_biotech",
                   "Industrials": "small_caps_cyclicals", "Utilities": "defensives", "Real Estate": "defensives", "Gold ETF": "defensives",
                   "ARK Innov": "mega_cap_tech", "20Y Bonds": None, "HY Credit": None}

MEGA = {"AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO", "NFLX"}
SEMI = {"NVDA", "AMD", "AVGO", "MU", "TSM", "ASML", "INTC", "QCOM", "ARM", "MRVL", "LRCX", "AMAT", "KLAC", "TXN"}
BANKS = {"JPM", "BAC", "GS", "MS", "C", "WFC", "SCHW", "BLK", "AXP", "V", "MA"}
ENERGY = {"XOM", "CVX", "COP", "OXY", "SLB", "FCX", "NEM"}
HEALTH = {"UNH", "LLY", "PFE", "MRK", "JNJ", "ABBV", "AMGN"}
CONSUMER = {"WMT", "TGT", "COST", "NKE", "SBUX", "MCD", "HD", "LOW", "DAL", "UAL"}


def _theme_of(text: str, default: str) -> tuple[str, int]:
    best, n = default, 0
    for k, words in THEME_WORDS.items():
        c = _count(text, words)
        if c > n:
            best, n = k, c
    return best, n


def _group_of(text: str, default: str) -> str:
    best, n = default, 0
    for k, words in GROUP_WORDS.items():
        c = _count(text, words)
        if c > n:
            best, n = k, c
    return best


# ---------------------------------------------------------------------------
# Question-set answerers. Each takes the same state dict the model would see.
# ---------------------------------------------------------------------------
def headline(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.HEADLINE_QUESTIONS
    text = f"{st.get('headline') or ''}. {st.get('summary') or ''}"
    theme, hits = _theme_of(text, "other")
    tickers = st.get("related_tickers") or []
    wide = _count(text, MARKET_WIDE_WORDS)
    if theme in ("fed_rates", "macro_data", "geopolitics") or wide >= 2:
        scope = "market_wide"
    elif theme in ("ai_tech", "energy_commodities", "crypto", "regulatory_legal") and len(tickers) != 1:
        scope = "sector"
    elif len(tickers) >= 1 or theme in ("earnings", "deals"):
        scope = "single_stock"
    elif hits == 0:
        scope = "not_market"
    else:
        scope = "sector"
    impact = {"market_wide": 2.0 + min(0.6, 0.2 * hits), "sector": 1.4, "single_stock": 1.0, "not_market": 0.2}[scope]
    bull, bear = _count(text, BULL_WORDS), _count(text, BEAR_WORDS)
    direction = "bullish" if bull > bear else "bearish" if bear > bull else ("mixed" if bull else "none")
    actionable = {"market_wide": 0.72, "sector": 0.58, "single_stock": 0.4, "not_market": 0.08}[scope]
    return {"actionable": noul(actionable), "direction": choice(Q["direction"], direction, 0.5 if bull != bear else LOW),
            "scope": choice(Q["scope"], scope, 0.55), "impact": score(Q["impact"], impact, 0.5), "theme": choice(Q["theme"], theme, 0.55 if hits else LOW)}


def stock(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.STOCK_QUESTIONS
    t, p, v, f = st.get("trend") or {}, st.get("price") or {}, st.get("volatility") or {}, st.get("fundamentals") or {}
    trend = t.get("trend"); rsi = _n(t.get("rsi14")) or 50.0
    chg = _n(p.get("chg_pct")) or 0.0
    atr = _n(v.get("atr_pct")) or 2.0
    d20 = _n(t.get("dist_sma20_pct")) or 0.0
    rvol = _n(v.get("rel_volume")) or 1.0
    up, down = trend == "up", trend == "down"
    a20, a50, a200 = t.get("above_sma20"), t.get("above_sma50"), t.get("above_sma200")
    stretched = abs(d20) > 2.5 * atr or rsi > 76 or rsi < 24
    dte = f.get("days_to_earnings") if isinstance(f.get("days_to_earnings"), int) else None
    text = " ".join(f"{h.get('headline') or ''} {h.get('summary') or ''}" for h in (st.get("headlines") or [])[:6])

    # setup
    if abs(chg) >= 4 and rvol >= 1.5:
        setup = "news_gap"
    elif t.get("new_high_20d") and rvol >= 1.1:
        setup = "breakout"
    elif t.get("new_low_20d"):
        setup = "breakdown"
    elif up and d20 > 2.5 * atr:
        setup = "extended_reversal_risk"
    elif up and (rsi < 48 or (a20 is False and a50)):
        setup = "pullback_in_uptrend"
    elif down and rsi < 35 and chg > 0:
        setup = "bounce_in_downtrend"
    elif trend == "range" or (a50 is not None and a200 is not None and a50 != a200):
        setup = "range"
    elif up:
        setup = "breakout" if chg > 1.5 and rvol > 1.2 else "pullback_in_uptrend" if d20 < 0 else "no_clear_setup"
    elif down:
        setup = "breakdown" if chg < -1.5 else "no_clear_setup"
    else:
        setup = "no_clear_setup"
    # bias
    if up and rsi < 78 and (a20 or setup == "pullback_in_uptrend"):
        bias = "long"
    elif down and rsi > 22 and not a20:
        bias = "short"
    elif abs(chg) >= 4 and rvol >= 2:
        bias = "long" if chg > 0 else "short"
    else:
        bias = "neutral"
    bias_conf = 0.58 if (up and a20 and a50) or (down and not a20 and not a50) else 0.45
    # fits
    day_fit = _clamp(J._sat(atr, J.ATR_PCT_SATURATION) * 1.4 + J._sat(abs(chg), J.GAP_SATURATION) * 0.9 + J._sat(rvol, J.REL_VOL_SATURATION) * 0.9, 0, 3)
    align = sum(1 for x in (a20, a50, a200) if x) if bias == "long" else sum(1 for x in (a20, a50, a200) if x is False)
    swing_fit = _clamp(align * 0.6 + (1.0 if setup in ("breakout", "pullback_in_uptrend", "breakdown") else 0.3) + (0.5 if 40 <= rsi <= 68 else 0), 0, 3)
    if bias == "neutral":
        swing_fit = min(swing_fit, 1.2)
    # catalyst
    if dte is not None and -1 <= dte <= 1:
        cat = "earnings"
    elif _has(text, "upgrade", "downgrade", "price target", "initiat"):
        cat = "analyst_action"
    elif _has(text, "offering", "convertible", "dilut", "secondary", "lockup"):
        cat = "offering_dilution"
    elif _has(text, "acquire", "merger", "takeover", "contract", "partnership", "stake"):
        cat = "deal"
    elif _has(text, "fda", "lawsuit", "antitrust", "regulator", "trial data", "approval"):
        cat = "regulatory_legal"
    elif _has(text, "guidance", "preannounce", "pre-announce", "outlook"):
        cat = "preannouncement_guidance"
    elif _has(text, "earnings", "quarter", "results"):
        cat = "earnings"
    elif _has(text, "sector", "peer", "rotation", "rebalance", "macro", "tariff", "fed"):
        cat = "sympathy_macro"
    else:
        cat = "technical_only"
    event_p = 0.85 if dte is not None and 0 <= dte <= 5 else 0.5 if dte is not None and 5 < dte <= 10 else 0.3 if cat in ("regulatory_legal", "deal") else 0.15
    ext_p = 0.82 if (abs(d20) > 3 * atr or rsi > 78 or rsi < 22) else 0.55 if stretched else 0.35 if abs(d20) > 1.5 * atr else 0.18
    if chg > 0.5:
        pa = "buyers_exhausting" if rsi > 78 or (d20 > 3 * atr) else "buyers_in_control"
    elif chg < -0.5:
        pa = "sellers_exhausting" if rsi < 24 else "sellers_in_control"
    else:
        pa = "indecision"
    # long term
    r6, r12 = _n(t.get("ret_6m")), _n(t.get("ret_12m"))
    if a200 is None:
        lt = "no_view"
    elif a200 and (r6 is None or r6 >= 0):
        lt = "hold" if stretched else "accumulate"
    elif a200:
        lt = "hold"
    elif down and (r6 is not None and r6 < -15):
        lt = "avoid"
    else:
        lt = "trim" if (_n(t.get("ret_1m")) or 0) < -8 else "hold"
    rg, mg, pe = _n(f.get("rev_growth")), _n(f.get("profit_margin")), _n(f.get("forward_pe"))
    ltq = 1.0 + (0.7 if rg is not None and rg > 0.1 else 0.3 if rg is not None and rg > 0 else -0.3 if rg is not None else 0) \
        + (0.6 if mg is not None and mg > 0.15 else 0.2 if mg is not None and mg > 0 else -0.4 if mg is not None else 0) \
        + (0.3 if pe is not None and 8 < pe < 35 else 0)
    entry = {"pullback_in_uptrend": 2.2, "breakout": 1.9 if rvol > 1.2 else 1.4, "bounce_in_downtrend": 1.2, "breakdown": 1.6 if bias == "short" else 0.8,
             "extended_reversal_risk": 0.6, "news_gap": 1.0, "range": 1.2, "no_clear_setup": 0.9}[setup]
    if stretched:
        entry = min(entry, 0.9)
    return {"bias": choice(Q["bias"], bias, bias_conf), "setup": choice(Q["setup"], setup, 0.52), "day_trade_fit": score(Q["day_trade_fit"], day_fit, 0.5),
            "swing_fit": score(Q["swing_fit"], swing_fit, 0.5), "catalyst": choice(Q["catalyst"], cat, 0.5 if cat != "technical_only" else LOW),
            "event_risk": noul(event_p), "extended": noul(ext_p), "price_action": choice(Q["price_action"], pa, 0.5),
            "long_term": choice(Q["long_term"], lt, 0.48), "long_term_quality": score(Q["long_term_quality"], ltq, 0.42),
            "entry_quality": score(Q["entry_quality"], entry, 0.5)}


def calendar(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.CALENDAR_QUESTIONS
    title, imp, ctry = (st.get("title") or "").lower(), st.get("ff_impact") or "", st.get("country") or ""
    tier1 = _has(title, "cpi", "fomc", "fed ", "nonfarm", "non-farm", "payroll", "pce", "gdp", "ism", "unemployment", "powell", "rate decision", "interest rate")
    if ctry == "USD":
        rel = 2.7 if tier1 else 2.0 if imp == "High" else 1.2 if imp == "Medium" else 0.6
    else:
        rel = 1.4 if imp == "High" and _has(title, "rate", "ecb", "boj", "boe", "cpi", "gdp") else 0.8 if imp == "High" else 0.3
    return {"equity_relevance": score(Q["equity_relevance"], rel, 0.55)}


def earnings(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.EARNINGS_QUESTIONS
    cap = _n(st.get("market_cap")) or 0.0
    sym = (st.get("symbol") or "").upper()
    att = 2.8 if cap >= 2e11 else 2.2 if cap >= 5e10 else 1.6 if cap >= 1e10 else 1.1 if cap >= 2e9 else 0.6
    if sym in MEGA:
        att = max(att, 2.6)
    grp = ("mega_cap_tech" if sym in MEGA else "semis" if sym in SEMI else "financials" if sym in BANKS else "energy_materials" if sym in ENERGY
           else "healthcare_biotech" if sym in HEALTH else "consumer" if sym in CONSUMER else _group_of(st.get("name") or "", "none"))
    return {"attention": score(Q["attention"], att, 0.55), "read_through": choice(Q["read_through"], grp, 0.5 if grp != "none" else LOW)}


def horizon_asset(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.HORIZON_ASSET_QUESTIONS
    hz = st.get("horizons") or {}
    def mv(k: str) -> float | None:
        h = hz.get(k) or {}
        return _n(h.get("change_bp")) if st.get("kind") == "yield" else _n(h.get("return_pct"))
    m1, m3, m12 = mv("1m"), mv("3m"), mv("12m")
    a50, a200, rsi = st.get("above_sma50"), st.get("above_sma200"), _n(st.get("rsi14")) or 50
    pos12 = _n((hz.get("12m") or {}).get("range_pos"))
    if a50 and a200 and (m3 or 0) > 0 and rsi >= 50:
        reg = "strong_uptrend"
    elif a200 and (not a50 or rsi < 48) and (m3 or 0) >= 0:
        reg = "uptrend_pulling_back"
    elif a200 and pos12 is not None and pos12 > 0.9 and (m1 or 0) < 0:
        reg = "topping"
    elif not a200 and not a50 and (m3 or 0) < 0:
        reg = "downtrend"
    elif not a200 and (m1 or 0) > 0 and rsi > 45:
        reg = "bottoming"
    else:
        reg = "range"
    sgn = lambda x: 0 if x is None else (1 if x > 0 else -1 if x < 0 else 0)
    s1, s12 = sgn(m1), sgn(m12)
    align = ("all_up" if s1 > 0 and s12 > 0 else "all_down" if s1 < 0 and s12 < 0 else "short_up_long_down" if s1 > 0 and s12 < 0
             else "short_down_long_up" if s1 < 0 and s12 > 0 else "mixed")
    unit = 25.0 if st.get("kind") == "yield" else 8.0
    strength = _clamp(abs(m3 or 0) / unit * 1.5, 0.3, 3)
    return {"regime": choice(Q["regime"], reg, 0.52), "alignment": choice(Q["alignment"], align, 0.55), "strength": score(Q["strength"], strength, 0.5)}


def horizon_cross(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.HORIZON_CROSS_QUESTIONS
    A = {(a.get("asset") or "").lower(): a for a in st.get("assets") or []}
    def find(*keys: str) -> dict[str, Any]:
        for k, a in A.items():
            if any(x in k for x in keys):
                return a
        return {}
    spx, y10, oil, gold = find("s&p", "spx", "spy"), find("10y", "10-year", "10 yr"), find("crude", "oil", "wti"), find("gold")
    s1, s3 = _n(spx.get("move_1m")) or 0, _n(spx.get("move_3m")) or 0
    y1 = _n(y10.get("move_1m")) or 0
    o1, g1 = _n(oil.get("move_1m")) or 0, _n(gold.get("move_1m")) or 0
    if s1 > 1 and y1 < -5:
        macro = "disinflation_rally"
    elif s1 > 1 and y1 > 5:
        macro = "growth_boom"
    elif s1 < -1 and y1 > 5 and o1 > 5:
        macro = "inflation_scare"
    elif s1 < -1 and y1 < -5:
        macro = "growth_scare"
    elif s1 < -2 and g1 > 2:
        macro = "risk_off"
    elif s1 > 3 and g1 > 3:
        macro = "liquidity_melt_up"
    else:
        macro = "mixed"
    lean = "higher" if s3 > 2 and (spx.get("structure_3m") or "") != "downtrend_lh_ll" else "lower" if s3 < -4 else "sideways"
    pos = _n(spx.get("range_pos_12m"))
    risk = ("rates" if y1 > 25 else "oil" if o1 > 10 else "extension" if pos is not None and pos > 0.95 and s3 > 8
            else "growth" if s1 < -2 and y1 < -10 else "none_obvious")
    return {"macro_read": choice(Q["macro_read"], macro, 0.5 if macro != "mixed" else LOW), "equity_lean_3m": choice(Q["equity_lean_3m"], lean, 0.5),
            "biggest_risk": choice(Q["biggest_risk"], risk, 0.48)}


def theme_stock(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.THEME_STOCK_QUESTIONS
    t, f = st.get("technicals") or {}, st.get("fundamentals") or {}
    group = st.get("group") or ""
    lev = {"compute": 2.5, "memory_storage": 2.2, "networking_optics": 2.3, "servers_cooling": 2.2, "power": 1.9, "semicap": 2.0, "real_estate": 1.4, "platforms": 1.7}.get(group, 1.5)
    r1, r3 = _n(t.get("rel_vs_spy_1m")) or 0, _n(t.get("rel_vs_spy_3m")) or 0
    atr, d20, rsi = _n(t.get("atr_pct")) or 3, _n(t.get("dist_sma20_pct")) or 0, _n(t.get("rsi14")) or 50
    trend = t.get("trend")
    if trend == "down" or (r3 < -15 and r1 < 0):
        phase = "broken"
    elif d20 > 2 * atr or rsi > 76:
        phase = "extended"
    elif r3 > 8 and trend == "up":
        phase = "leader"
    elif r1 > 2 and r3 <= 8:
        phase = "catching_up"
    else:
        phase = "laggard"
    move = _clamp(atr / 2.5 + ((_n(f.get("short_float")) or 0) * 6) + (0.4 if phase == "catching_up" else 0), 0.4, 3)
    rg, eg = _n(f.get("rev_growth")), _n(f.get("eps_growth"))
    fund = _clamp(1.0 + (0.9 if rg and rg > 0.2 else 0.4 if rg and rg > 0.05 else -0.3 if rg is not None else 0) + (0.6 if eg and eg > 0.15 else 0), 0, 3)
    return {"theme_leverage": score(Q["theme_leverage"], lev, 0.5), "phase": choice(Q["phase"], phase, 0.5),
            "move_potential": score(Q["move_potential"], move, 0.45), "fundamental_support": score(Q["fundamental_support"], fund, 0.42)}


def theme_group(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.THEME_GROUP_QUESTIONS
    groups = st.get("groups") or []
    if not groups:
        return {"stage": choice(Q["stage"], "mid", LOW), "next_group": choice(Q["next_group"], "compute", LOW)}
    up = sum(_n(g.get("share_in_uptrend")) or 0 for g in groups) / len(groups)
    ext = sum(_n(g.get("share_extended")) or 0 for g in groups) / len(groups)
    r1 = sum(_n(g.get("avg_ret_1m")) or 0 for g in groups) / len(groups)
    r3 = sum(_n(g.get("avg_ret_3m")) or 0 for g in groups) / len(groups)
    if up < 0.35 and r3 < -8:
        stage = "broken"
    elif up < 0.45 and r1 < -5 and r3 > 5:
        stage = "exhausted"
    elif up >= 0.7 and ext >= 0.4:
        stage = "late"
    elif up >= 0.6:
        stage = "mid"
    else:
        stage = "early"
    cands = [g for g in groups if (_n(g.get("share_extended")) or 0) < 0.5] or groups
    nxt = max(cands, key=lambda g: (_n(g.get("avg_rel_vs_spy_1m")) or -99))["group"]
    return {"stage": choice(Q["stage"], stage, 0.5), "next_group": choice(Q["next_group"], nxt, 0.45)}


def smart_money(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.SMART_MONEY_QUESTIONS
    ins, inst, sh = st.get("insider") or {}, st.get("institutions") or {}, st.get("short") or {}
    buy, sell = _n(ins.get("buy_value_90d")) or 0, _n(ins.get("sell_value_90d")) or 0
    buyers = int(ins.get("distinct_buyers_90d") or 0)
    top10 = _n(inst.get("top10_avg_change"))
    shc = _n(sh.get("change_pct"))
    cong_buys = sum(1 for c in st.get("congress") or [] if (c.get("type") or "").lower() == "buy")
    cands: list[tuple[float, str]] = []
    if buy >= 200_000 and buy >= sell * 0.5:
        cands.append((1.2 + min(1.5, buy / 2e6) + 0.2 * min(buyers, 3), "insiders_buying"))
    if sell >= 2_000_000 and sell > 4 * buy:
        cands.append((1.0 + min(1.5, sell / 2e7), "insiders_selling"))
    if top10 is not None and top10 > 0.02:
        cands.append((1.0 + min(1.5, top10 * 20), "institutions_adding"))
    if top10 is not None and top10 < -0.02:
        cands.append((1.0 + min(1.5, -top10 * 20), "institutions_trimming"))
    if cong_buys >= 2:
        cands.append((1.2 + 0.2 * min(cong_buys, 5), "politicians_buying"))
    if shc is not None and shc > 10:
        cands.append((1.0 + min(1.5, shc / 20), "shorts_pressing"))
    if not cands:
        return {"conviction": score(Q["conviction"], 0.4, 0.5), "who": choice(Q["who"], "nobody", 0.55)}
    conv, who = max(cands)
    return {"conviction": score(Q["conviction"], conv, 0.5), "who": choice(Q["who"], who, 0.52)}


def options(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.OPTIONS_QUESTIONS
    cs = _n(st.get("call_share_of_notional"))
    pc = _n(st.get("put_call_volume"))
    v2o = _n(st.get("volume_to_open_interest")) or 0
    chg = _n(st.get("chg_pct")) or 0
    vol = (_n(st.get("call_volume")) or 0) + (_n(st.get("put_volume")) or 0)
    unusual = st.get("unusual") or []
    uc = sum(1 for u in unusual if u.get("side") == "call"); upv = len(unusual) - uc
    if vol < 2000 and not unusual:
        read = "quiet"
    elif cs is not None and cs > 0.68 and (v2o > 0.4 or uc >= 2):
        read = "aggressive_call_buying"
    elif cs is not None and cs > 0.56:
        read = "call_positioning_measured"
    elif pc is not None and pc > 1.3:
        read = "put_buying_bearish" if chg < -0.5 or upv >= 2 else "put_hedging"
    else:
        read = "two_sided_or_premium_selling"
    intensity = _clamp(min(1.5, v2o * 2) + 0.4 * min(len(unusual), 4) + (0.5 if vol > 100_000 else 0), 0.2, 3)
    return {"read": choice(Q["read"], read, 0.5), "intensity": score(Q["intensity"], intensity, 0.5)}


def options_market(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.OPTIONS_MARKET_QUESTIONS
    pc = _n((st.get("scanned") or {}).get("aggregate_put_call"))
    ratios = (st.get("cboe") or {}).get("ratios") or {}
    cboe_pc = next((_n(v) for k, v in ratios.items() if "total" in str(k).lower() or "all" in str(k).lower()), None)
    x = pc if pc is not None else cboe_pc
    pos = "balanced" if x is None else "complacent" if x < 0.6 else "bullish_healthy" if x < 0.85 else "balanced" if x < 1.05 else "hedged" if x < 1.35 else "fearful"
    tot: dict[str, float] = {}
    for l in st.get("leaders") or []:
        tot[l.get("group") or "other"] = tot.get(l.get("group") or "other", 0) + (_n(l.get("total_notional")) or 0)
    grp_map = {"compute": "semis", "memory_storage": "semis", "networking_optics": "semis", "servers_cooling": "mega_cap_tech", "power": "energy_materials",
               "semicap": "semis", "real_estate": "defensives", "platforms": "mega_cap_tech", "index_etfs": "index_etfs"}
    where = grp_map.get(max(tot, key=tot.get), "index_etfs") if tot else "index_etfs"
    return {"positioning": choice(Q["positioning"], pos, 0.5 if x is not None else LOW), "where_volume_flows": choice(Q["where_volume_flows"], where, 0.48)}


def scan(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.SCAN_QUESTIONS
    ses = st.get("session") or {}
    tfs = st.get("timeframes") or {}
    lead = tfs.get(st.get("lead_timeframe")) or (next(iter(tfs.values())) if tfs else {})
    vol = _n(lead.get("vol_ratio_3bar")) or 1.0
    build = int(lead.get("building_bars") or 0)
    chg3 = _n(lead.get("chg_3bar_pct")) or 0.0
    loc = _n(lead.get("close_location"))
    above = ses.get("above_vwap")
    daily_trend = (st.get("daily") or {}).get("trend")
    sc = _n(st.get("score_0_100")) or 0
    if lead.get("breakout") and vol >= 1.8 and chg3 > 0:
        read = "breakout_with_volume"
    elif vol >= 3 and abs(chg3) > 3 and loc is not None and loc < 0.4:
        read = "climax_or_exhaustion"
    elif lead.get("breakdown") or (chg3 < -0.8 and vol >= 1.8):
        read = "selling_with_volume"
    elif build >= 2 and vol >= 1.3 and chg3 >= 0:
        read = "building_toward_breakout"
    elif chg3 < 0 and vol < 1.0 and daily_trend == "up":
        read = "pullback_on_lighter_volume"
    else:
        read = "noise"
    cont = _clamp(sc / 33 + (0.4 if above and chg3 > 0 else 0) - (0.6 if read in ("climax_or_exhaustion", "noise") else 0), 0, 3)
    play = {"breakout_with_volume": "long_breakout", "building_toward_breakout": "buy_pullback_to_vwap" if above else "no_trade",
            "climax_or_exhaustion": "short_pop", "selling_with_volume": "short_breakdown", "pullback_on_lighter_volume": "buy_pullback_to_vwap", "noise": "no_trade"}[read]
    return {"read": choice(Q["read"], read, 0.52 if read != "noise" else LOW), "continuation": score(Q["continuation"], cont, 0.48), "play": choice(Q["play"], play, 0.48)}


def low_float(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.LOW_FLOAT_QUESTIONS
    chg = _n(st.get("chg_pct")) or 0
    rvol = _n(st.get("rel_volume")) or 1
    short = _n(st.get("short_pct_float")) or 0
    it = st.get("intraday") or {}
    above = it.get("above_vwap")
    locs = [_n(v.get("close_location")) for v in (it.get("timeframes") or {}).values()]
    loc = next((x for x in locs if x is not None), None)
    if chg > 15 and rvol > 5 and short >= 15:
        state = "squeeze_in_progress"
    elif chg > 8 and (above or (loc is not None and loc > 0.6)):
        state = "momentum_run"
    elif chg > 8:
        state = "fading_after_spike"
    elif chg < -5:
        state = "selling_pressure"
    else:
        state = "quiet_low_float"
    risk = {"squeeze_in_progress": 2.7, "momentum_run": 2.1, "fading_after_spike": 2.5, "selling_pressure": 1.8, "quiet_low_float": 1.0}[state]
    play = {"squeeze_in_progress": "wait_for_pullback", "momentum_run": "long_momentum" if rvol > 3 else "wait_for_pullback",
            "fading_after_spike": "short_the_fade", "selling_pressure": "avoid", "quiet_low_float": "avoid"}[state]
    return {"state": choice(Q["state"], state, 0.52), "risk": score(Q["risk"], risk, 0.55), "play": choice(Q["play"], play, 0.5)}


def regime(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.REGIME_QUESTIONS
    idx = st.get("indices") or []
    chgs = [_n(i.get("chg_pct")) for i in idx if _n(i.get("chg_pct")) is not None]
    avg = sum(chgs) / len(chgs) if chgs else 0.0
    fl = st.get("flows") or {}
    B = fl.get("breadth") or {}
    n = _n(B.get("n")) or 0
    b20 = (_n(B.get("above20")) or 0) / n * 100 if n else 50.0
    adv, dec = _n(B.get("adv")) or 0, _n(B.get("dec")) or 0
    ad = adv / (adv + dec) * 100 if adv + dec else 50.0
    vix = next((_n(r.get("last")) for r in st.get("macro_tape") or [] if "vix" in (r.get("label") or "").lower()), None)
    strong = sum(1 for c in chgs if c > 0.3) / len(chgs) if chgs else 0
    weak = sum(1 for c in chgs if c < -0.3) / len(chgs) if chgs else 0
    if (avg > 0.25 and ad >= 55) or strong >= 0.75:
        tone = "risk_on"
    elif (avg < -0.25 and ad <= 45) or weak >= 0.75:
        tone = "risk_off"
    else:
        tone = "mixed"
    vol = (0.5 if vix < 14 else 1.2 if vix < 18 else 2.0 if vix < 25 else 2.8) if vix is not None else _clamp(abs(avg) * 1.5 + 0.8, 0.5, 3)
    text = " ".join(st.get("top_headlines") or []) + " " + " ".join(st.get("calendar_today") or [])
    driver, hits = _theme_of(text, "no_dominant_driver")
    if hits < 2:
        driver = "no_dominant_driver"
    secs = [(s.get("sector") or s.get("label") or "", _n(s.get("chg_1d"))) for s in fl.get("sectors") or []]
    secs = [(l, c) for l, c in secs if c is not None and SECTOR_TO_GROUP.get(l)]
    lead = "unclear"
    if secs:
        top = max(secs, key=lambda x: x[1])
        spread = top[1] - min(c for _, c in secs)
        if spread >= 0.4:
            lead = SECTOR_TO_GROUP.get(top[0]) or "unclear"
    r = st.get("rates") or {}
    y10 = next((_n(y.get("change_bp_today")) for y in r.get("live_yields") or [] if "10" in str(y.get("tenor"))), None)
    y2 = next((_n(y.get("change_bp_today")) for y in r.get("live_yields") or [] if str(y.get("tenor")).startswith(("2", "5", "13"))), None)
    if y10 is None:
        rates_read = "neutral"
    elif y10 > 5 and avg < 0:
        rates_read = "headwind"
    elif y10 < -5 and avg < -0.3 and (y2 is None or y2 <= y10):
        rates_read = "growth_scare"
    elif y10 < -4 and avg > 0:
        rates_read = "tailwind"
    else:
        rates_read = "neutral"
    gauges = {(g.get("gauge") or g.get("label") or ""): _n(g.get("chg_1d")) for g in fl.get("gauges") or []}
    def g(key: str) -> float:
        return next((v for k, v in gauges.items() if key in k.lower() and v is not None), 0.0)
    if tone == "risk_on" and (lead in ("mega_cap_tech", "semis") or g("semis") > 0.3):
        flow = "into_growth_tech"
    elif tone == "risk_on" and (lead == "small_caps_cyclicals" or g("small") > 0.3):
        flow = "into_cyclicals_small_caps"
    elif tone == "risk_on" and b20 >= 60:
        flow = "broad_risk_on"
    elif tone == "risk_off" and lead == "defensives":
        flow = "into_defensives"
    elif tone == "risk_off" and y10 is not None and y10 < -3:
        flow = "into_bonds_cash"
    elif tone == "risk_off" and b20 <= 40:
        flow = "broad_risk_off"
    elif tone == "risk_on":
        flow = "broad_risk_on"
    elif tone == "risk_off":
        flow = "broad_risk_off"
    else:
        flow = "mixed"
    conf = 0.58 if tone != "mixed" and abs(avg) > 0.5 else 0.5 if tone != "mixed" else LOW
    return {"tone": choice(Q["tone"], tone, conf), "volatility": score(Q["volatility"], vol, 0.55 if vix is not None else LOW),
            "driver": choice(Q["driver"], driver, 0.48 if hits >= 3 else LOW), "leadership": choice(Q["leadership"], lead, 0.5 if lead != "unclear" else LOW),
            "rates_read": choice(Q["rates_read"], rates_read, 0.5 if rates_read != "neutral" else LOW), "flow_read": choice(Q["flow_read"], flow, 0.48)}


def stance(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.STANCE_QUESTIONS
    lean = (st.get("lean") or {}).get("choice") or "neutral"
    setup, control = st.get("setup") or "no_clear_setup", st.get("control") or "indecision"
    ext, ev = _n(st.get("extended_p")) or 0, _n(st.get("event_risk_p")) or 0
    rr = _n((st.get("plan") or {}).get("reward_to_risk"))
    entry = _n(st.get("entry_quality")) or 1.0
    tone = st.get("market_tone") or "mixed"
    it = st.get("intraday") or {}
    gap = _n(it.get("gap_pct")) or 0
    rvol = _n(it.get("rel_volume"))
    vs = it.get("volume_scan") or {}
    sm = st.get("smart_money") or {}
    who = sm.get("who")
    opt_read = (sm.get("options") or {}).get("read")
    reason = "trend_and_entry"
    if lean == "short":
        if control == "sellers_in_control" and setup in ("breakdown", "news_gap", "extended_reversal_risk") and ev < 0.6:
            s, reason = "short_setup", "trend_and_entry"
        else:
            s, reason = "avoid", "trend_and_entry"
    elif lean == "long":
        if ev >= 0.6:
            s, reason = "hold_dont_add", "event_risk"
        elif ext >= 0.6:
            s, reason = "buy_the_dip", "extended"
        elif who in ("insiders_selling", "institutions_trimming") and (_n(sm.get("conviction")) or 0) >= 1.8 and entry < 1.8:
            s, reason = "hold_dont_add", "smart_money"
        elif rr is not None and rr < 1.2:
            s, reason = "wait_for_breakout" if setup in ("range", "no_clear_setup") else "hold_dont_add", "poor_reward"
        elif setup == "pullback_in_uptrend":
            s, reason = "buy_the_dip", "trend_and_entry"
        elif setup in ("range", "no_clear_setup", "bounce_in_downtrend"):
            s, reason = "wait_for_breakout", "resistance"
        elif tone == "risk_off" and setup != "breakout":
            s, reason = "wait_for_breakout", "market_tone"
        elif setup in ("breakout", "news_gap") and entry >= 1.4:
            s, reason = "buy_now", "volume" if (rvol or 0) >= 1.5 else "trend_and_entry"
        else:
            s, reason = "buy_now" if entry >= 1.5 else "buy_the_dip", "trend_and_entry"
        if s == "buy_now" and opt_read in ("aggressive_call_buying",) and reason == "trend_and_entry":
            reason = "options_flow"
        if s == "buy_now" and who in ("insiders_buying", "institutions_adding") and reason == "trend_and_entry":
            reason = "smart_money"
    else:
        s, reason = ("wait_for_breakout", "trend_and_entry") if setup == "range" else ("hold_dont_add", "poor_reward")
    scan_dir = vs.get("direction")
    if lean == "long" and scan_dir == "up" and (_n(vs.get("rvol_time_of_day")) or rvol or 0) >= 1.5 and it.get("session_state") == "open":
        intra = "long_momentum"
    elif lean == "short" and scan_dir == "down" and (_n(vs.get("rvol_time_of_day")) or rvol or 0) >= 1.5 and it.get("session_state") == "open":
        intra = "short_momentum"
    elif abs(gap) >= 4 and (rvol or 0) < 1.2:
        intra = "fade_the_gap"
    elif lean == "long" and ev < 0.6:
        intra = "buy_dip_to_support"
    elif setup == "range" and lean == "neutral":
        intra = "range_scalp"
    else:
        intra = "no_trade"
    lc = _n((st.get("lean") or {}).get("confidence")) or 0.45
    return {"stance": choice(Q["stance"], s, _clamp(lc, LOW, 0.6)), "intraday": choice(Q["intraday"], intra, 0.45),
            "main_reason": choice(Q["main_reason"], reason, 0.5)}


def trump(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.TRUMP_QUESTIONS
    text = (st.get("text") or "")
    table = {"tariffs_trade": ("tariff", "trade", "china", "import", "export", "duties"), "fed_rates": ("fed", "powell", "interest rate", "rates", "jerome"),
             "taxes_spending": ("tax", "spending", "budget", "deficit", "bill", "stimulus"), "geopolitics": ("war", "iran", "russia", "ukraine", "israel", "nato", "missile", "peace", "ceasefire"),
             "energy_oil": ("oil", "drill", "gas", "energy", "opec"), "crypto": ("bitcoin", "crypto", "stablecoin"),
             "immigration_labor": ("immigra", "border", "deport", "visa", "workers"),
             "specific_company_or_sector": ("apple", "nvidia", "intel", "tesla", "boeing", "pharma", "drug price", "bank", "automaker", "ford", "gm ")}
    theme, n = "not_market", 0
    for k, words in table.items():
        c = _count(text, words)
        if c > n:
            theme, n = k, c
    rel = 0.75 if n >= 2 else 0.55 if n == 1 else 0.1
    bull, bear = _count(text, BULL_WORDS + ("deal", "great", "booming", "record", "strong", "lower rates", "cut rates")), _count(text, BEAR_WORDS + ("tariff", "war", "fire", "shut"))
    if theme == "tariffs_trade":
        direction = "bullish_for_stocks" if _has(text, "deal", "agreement", "pause", "exempt", "lower") and not _has(text, "raise", "increase", "100%") else "bearish_for_stocks"
    elif theme == "fed_rates":
        direction = "bullish_for_stocks" if _has(text, "cut", "lower") else "mixed_or_unclear"
    elif theme in ("taxes_spending", "energy_oil", "crypto"):
        direction = "bullish_for_stocks" if bull >= bear else "mixed_or_unclear"
    elif theme == "geopolitics":
        direction = "bullish_for_stocks" if _has(text, "peace", "ceasefire", "deal") else "bearish_for_stocks"
    elif theme == "not_market":
        direction = "mixed_or_unclear"
    else:
        direction = "bullish_for_stocks" if bull > bear else "bearish_for_stocks" if bear > bull else "mixed_or_unclear"
    who = {"tariffs_trade": "industrials_manufacturing", "fed_rates": "broad_market", "taxes_spending": "broad_market", "geopolitics": "defense",
           "energy_oil": "energy", "crypto": "crypto_linked", "immigration_labor": "no_clear_group", "not_market": "no_clear_group"}.get(theme, "no_clear_group")
    if theme == "specific_company_or_sector":
        who = ("chips_semis" if _has(text, "nvidia", "intel", "chip") else "large_cap_tech" if _has(text, "apple", "tech") else "autos" if _has(text, "tesla", "ford", "gm ", "automaker")
               else "healthcare_pharma" if _has(text, "pharma", "drug") else "banks_financials" if _has(text, "bank") else "no_clear_group")
    return {"market_relevance": noul(rel), "direction": choice(Q["direction"], direction, 0.5 if n else LOW),
            "theme": choice(Q["theme"], theme, 0.55 if n else 0.5), "who_benefits": choice(Q["who_benefits"], who, 0.45)}


def brief_index(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.BRIEF_INDEX_QUESTIONS
    rsi = _n(st.get("rsi_1h")) or 50
    a20, a50 = st.get("above_20_bar_avg"), st.get("above_50_bar_avg")
    slope = _n(st.get("avg20_slope_pct")) or 0
    struct = st.get("structure") or ""
    dres, dsup = _n(st.get("dist_resistance_pct")), _n(st.get("dist_support_pct"))
    ret24 = _n(st.get("ret_24_bars_pct")) or 0
    now = _n(st.get("now_chg_pct")) or 0
    upt, dnt = "uptrend" in struct, "downtrend" in struct
    if dnt and not a20 and (a50 is False or slope < 0):
        move, driver = "break_lower", "trend_broken"
    elif rsi < 32 or (dsup is not None and dsup < 0.25 and not dnt):
        move, driver = "rebound", "support_nearby"
    elif rsi > 72 or (dres is not None and dres < 0.25 and ret24 > 0.8):
        move, driver = "pullback_then_higher", "overbought" if rsi > 72 else "resistance_overhead"
    elif (upt or a20) and a50 is not False and slope >= 0:
        move, driver = "push_higher", "momentum" if ret24 > 1.0 or now > 0.4 else "trend_intact"
    else:
        move, driver = "range_bound", "resistance_overhead" if dres is not None and dres < 0.6 else "support_nearby" if dsup is not None and dsup < 0.6 else "trend_intact"
    hours = {"push_higher": "push_and_extend", "pullback_then_higher": "fade_after_open", "break_lower": "sell_off_early", "rebound": "chop_then_trend", "range_bound": "chop_then_trend"}[move]
    conf = 0.55 if move in ("push_higher", "break_lower") and (upt or dnt) else 0.45
    return {"next_move": choice(Q["next_move"], move, conf), "next_hours": choice(Q["next_hours"], hours, conf - 0.05), "driver": choice(Q["driver"], driver, 0.5)}


def intraday_direction(st: dict[str, Any]) -> dict[str, Any]:
    Q = J.INTRADAY_DIRECTION_QUESTIONS
    pts = 0.0
    notes: list[str] = []
    for sym in ("spy", "qqq"):
        x = st.get(sym) or {}
        h = x.get("hourly") or {}
        if x.get("above_vwap") is True:
            pts += 1
        elif x.get("above_vwap") is False:
            pts -= 1
        rp = _n(x.get("range_pos"))
        if rp is not None:
            pts += 0.8 if rp > 0.75 else -0.8 if rp < 0.25 else 0
        if h.get("above_20_bar_avg") is True:
            pts += 0.5
        elif h.get("above_20_bar_avg") is False:
            pts -= 0.5
        s = h.get("structure") or ""
        pts += 0.4 if "uptrend" in s else -0.4 if "downtrend" in s else 0
        r = _n(h.get("rsi_1h"))
        if r is not None and (r > 76 or r < 24):
            notes.append("exhaustion")
    b = _n(st.get("breadth_pct_above_20d"))
    if b is not None:
        pts += 0.5 if b > 58 else -0.5 if b < 42 else 0
    sen = st.get("sentiment") or {}
    lean = sen.get("trump_lean_recent")
    pts += 0.3 if lean == "bullish" else -0.3 if lean == "bearish" else 0
    stw = ((sen.get("stocktwits_spy") or {}).get("score_0_100"))
    if _n(stw) is not None:
        pts += 0.2 if stw > 65 else -0.2 if stw < 35 else 0
    direction = "higher" if pts >= 1.6 else "lower" if pts <= -1.6 else "sideways"
    conf = _clamp(0.36 + min(abs(pts), 5) * 0.05, LOW, 0.6)
    # history-aware: if this answer has a poor track record recently, trust it less
    hr = ((st.get("history") or {}).get("hit_rate_by_answer") or {}).get(direction)
    scored = int((st.get("history") or {}).get("reads_scored") or 0)
    if _n(hr) is not None and scored >= 10 and hr < 40:
        conf = max(LOW, conf - 0.1)
    spy = st.get("spy") or {}
    hh = spy.get("hourly") or {}
    if direction == "sideways":
        driver = "exhaustion" if "exhaustion" in notes else "no_edge"
    elif "exhaustion" in notes:
        driver = "exhaustion"
    elif (_n(spy.get("range_pos")) or 0.5) > 0.9 or (_n(spy.get("range_pos")) or 0.5) < 0.1:
        driver = "level_break"
    elif direction == "higher" and _n(hh.get("dist_support_pct")) is not None and hh["dist_support_pct"] < 0.3:
        driver = "level_hold"
    elif abs(pts) < 2.2 and (lean in ("bullish", "bearish")):
        driver = "sentiment"
    else:
        driver = "trend_and_vwap"
    return {"direction": choice(Q["direction"], direction, conf), "driver": choice(Q["driver"], driver, 0.48)}


# ---------------------------------------------------------------------------
# Registry: question set object -> answerer
# ---------------------------------------------------------------------------
_REGISTRY: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {
    id(J.HEADLINE_QUESTIONS): headline, id(J.STOCK_QUESTIONS): stock, id(J.CALENDAR_QUESTIONS): calendar,
    id(J.EARNINGS_QUESTIONS): earnings, id(J.HORIZON_ASSET_QUESTIONS): horizon_asset, id(J.HORIZON_CROSS_QUESTIONS): horizon_cross,
    id(J.THEME_STOCK_QUESTIONS): theme_stock, id(J.THEME_GROUP_QUESTIONS): theme_group, id(J.SMART_MONEY_QUESTIONS): smart_money,
    id(J.OPTIONS_QUESTIONS): options, id(J.OPTIONS_MARKET_QUESTIONS): options_market, id(J.SCAN_QUESTIONS): scan,
    id(J.LOW_FLOAT_QUESTIONS): low_float, id(J.REGIME_QUESTIONS): regime, id(J.STANCE_QUESTIONS): stance,
    id(J.TRUMP_QUESTIONS): trump, id(J.BRIEF_INDEX_QUESTIONS): brief_index, id(J.INTRADAY_DIRECTION_QUESTIONS): intraday_direction,
}


def answerer_for(questions: dict[str, Any]) -> Callable[[dict[str, Any]], dict[str, Any]] | None:
    return _REGISTRY.get(id(questions))


def answer(questions: dict[str, Any], state: dict[str, Any]) -> dict[str, Any] | None:
    """Rule-based answers for one state, or None if the question set has no rules."""
    fn = answerer_for(questions)
    if fn is None:
        return None
    try:
        return fn(state)
    except Exception:  # noqa: BLE001 - a rule bug must never take the build down
        return None
