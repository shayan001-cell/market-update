"""Static configuration: symbols, universe, gauges, and limits.

Anything a human might want to tune lives here or in judgments.py.
"""
from __future__ import annotations

import os
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# When the package is pip-installed (GitHub Actions, Docker) PROJECT_ROOT is inside
# site-packages, so data paths can be pointed elsewhere with env vars.
OUTPUT_DIR = Path(os.environ.get("MU_DATA_DIR", PROJECT_ROOT / "output"))
CACHE_DIR = Path(os.environ.get("MU_CACHE_DIR", OUTPUT_DIR / ".cache"))
STATIC_DIR = PROJECT_ROOT / "market_update" / "static"
WATCHLIST_FILE = Path(os.environ.get("MU_WATCHLIST", PROJECT_ROOT / "watchlist.txt"))

# ---------------------------------------------------------------------------
# Macro tape (yahoo symbol, display label, kind)
# ---------------------------------------------------------------------------
MACRO_TAPE: list[tuple[str, str, str]] = [
    ("ES=F", "S&P 500 fut", "index"),
    ("NQ=F", "Nasdaq 100 fut", "index"),
    ("YM=F", "Dow fut", "index"),
    ("RTY=F", "Russell 2000 fut", "index"),
    ("^VIX", "VIX", "vol"),
    ("^TNX", "10Y yield", "yield"),
    ("DX-Y.NYB", "Dollar index", "fx"),
    ("CL=F", "WTI crude", "commodity"),
    ("GC=F", "Gold", "commodity"),
    ("BTC-USD", "Bitcoin", "crypto"),
]
INVERSE_RISK = {"^VIX", "^TNX", "DX-Y.NYB"}

# Live Treasury yields from Yahoo (intraday), complementing FRED's daily curve.
LIVE_YIELDS = [("^IRX", "13W"), ("^FVX", "5Y"), ("^TNX", "10Y"), ("^TYX", "30Y")]

# Index ETFs with full technical cards.
INDEX_ETFS = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Russell 2000", "DIA": "Dow 30"}

# Sector / theme ETFs.
SECTOR_ETFS: dict[str, str] = {
    "XLK": "Tech", "SMH": "Semis", "XLC": "Comm", "XLY": "Cons Disc", "XLP": "Staples",
    "XLF": "Financials", "XLE": "Energy", "XLV": "Health", "XLI": "Industrials", "XLB": "Materials",
    "XLU": "Utilities", "XLRE": "Real Estate", "ARKK": "ARK Innov", "TLT": "20Y Bonds",
    "HYG": "HY Credit", "GLD": "Gold ETF",
}

# Money-flow ratio gauges. "up_means" is what a rising ratio says about positioning.
FLOW_GAUGES = [
    {"key": "breadth", "label": "Equal vs cap weight", "num": "RSP", "den": "SPY", "up_means": "participation broadening beyond mega caps"},
    {"key": "size", "label": "Small vs large", "num": "IWM", "den": "SPY", "up_means": "risk appetite for small caps"},
    {"key": "offense", "label": "Discretionary vs staples", "num": "XLY", "den": "XLP", "up_means": "offense over defense"},
    {"key": "credit", "label": "High yield vs Treasuries", "num": "HYG", "den": "TLT", "up_means": "credit risk being bought"},
    {"key": "growth", "label": "Copper vs gold", "num": "HG=F", "den": "GC=F", "up_means": "growth over fear"},
    {"key": "semis", "label": "Semis vs market", "num": "SMH", "den": "SPY", "up_means": "AI/cyclical tech leadership"},
    {"key": "vixterm", "label": "VIX vs 3M VIX", "num": "^VIX", "den": "^VIX3M", "up_means": "near-term stress (above 1 = backwardation)"},
]

NEWS_SEED_SYMBOLS = ["SPY", "QQQ", "DIA", "IWM", "TLT", "USO", "NVDA", "AAPL"]

# ---------------------------------------------------------------------------
# Scan universe (merged with watchlist.txt at runtime)
# ---------------------------------------------------------------------------
UNIVERSE: list[str] = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK-B", "LLY",
    "AMD", "INTC", "MU", "QCOM", "TSM", "ARM", "MRVL", "SMCI", "ASML", "AMAT", "LRCX", "KLAC", "TXN", "ON", "MPWR",
    "CRM", "ORCL", "ADBE", "NOW", "PLTR", "SNOW", "CRWD", "PANW", "ZS", "DDOG", "NET", "SHOP", "UBER", "ABNB",
    "NFLX", "DIS", "SPOT", "RBLX", "COIN", "HOOD", "SQ", "PYPL", "AFRM", "SOFI", "MSTR", "APP", "DUOL", "TTD",
    "JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "BLK", "V", "MA", "AXP",
    "UNH", "JNJ", "PFE", "MRK", "ABBV", "AMGN", "GILD", "REGN", "VRTX", "ISRG", "MRNA", "NVO", "HIMS",
    "WMT", "COST", "HD", "LOW", "NKE", "SBUX", "MCD", "CMG", "LULU", "TGT", "DG", "DLTR", "KO", "PEP", "PG",
    "CAT", "DE", "BA", "GE", "HON", "UPS", "FDX", "LMT", "RTX", "XOM", "CVX", "OXY", "SLB", "FCX", "NEM", "NUE",
    "GM", "F", "RIVN", "LCID", "NIO",
    "GME", "AMC", "IONQ", "RGTI", "QUBT", "SOUN", "BBAI", "OKLO", "SMR", "VST", "CEG", "NRG", "TLN",
    "CVNA", "UPST", "OPEN", "DKNG", "RKLB", "ASTS", "LUNR", "ACHR", "JOBY", "CELH", "ELF",
    "T", "VZ", "TMUS", "CMCSA", "WBD", "PARA", "INTU", "CSCO", "IBM", "DELL", "HPQ", "ANET",
    "TQQQ", "SQQQ", "SOXL", "SOXS", "SLV", "USO", "UVXY", "IBIT",
]

# Multi-horizon "big picture" assets (yahoo symbol, label, kind). kind "yield" reports changes in bp.
HORIZON_ASSETS = [("ES=F", "S&P 500 futures", "index"), ("QQQ", "Nasdaq 100", "index"),
                  ("GC=F", "Gold", "commodity"), ("CL=F", "WTI crude", "commodity"), ("^TNX", "10-year yield", "yield")]
HORIZONS = {"1m": 21, "3m": 63, "6m": 126, "12m": 252}

# Theme screen: the AI data-center buildout, by role in the stack.
THEME = {
    "key": "datacenter",
    "name": "AI data-center buildout",
    "groups": {
        "compute": ["NVDA", "AMD", "AVGO", "ARM", "INTC", "TSM", "MRVL", "ALAB", "CRDO"],
        "memory_storage": ["MU", "SNDK", "WDC", "STX", "PSTG"],
        "networking_optics": ["ANET", "CIEN", "COHR", "LITE", "AAOI", "FN"],
        "servers_cooling": ["SMCI", "DELL", "HPE", "VRT", "MOD", "NVT"],
        "power": ["VST", "CEG", "NRG", "TLN", "GEV", "ETN", "PWR", "OKLO", "SMR", "BE"],
        "semicap": ["ASML", "AMAT", "LRCX", "KLAC", "TER"],
        "real_estate": ["EQIX", "DLR", "IRM"],
        "platforms": ["MSFT", "GOOGL", "AMZN", "META", "ORCL", "CRWV", "NBIS"],
    },
}
THEME_MAX_JUDGED = 60

# Symbols needed for gauges/sectors/indices/horizons that are not in UNIVERSE.
AUX_SYMBOLS = ["RSP", "^VIX", "^VIX3M", "HG=F", "GC=F", "ES=F", "CL=F", "^TNX"]

# Mover / volatility screen filters (pure code).
GAP_MIN_PCT = 1.5
MIN_PRICE = 5.0
MIN_AVG_DOLLAR_VOLUME = 50_000_000
MAX_STOCK_CARDS = 24         # names that get fundamentals, news and TypeSafe analysis
TOP_VOLATILITY = 16          # of those, how many come from the ATR% ranking
OHLC_DAYS_STOCK = 90
OHLC_DAYS_INDEX = 130

# News / calendar / earnings limits.
NEWS_LOOKBACK_HOURS = 36
MAX_HEADLINES_TO_JUDGE = 45
MAX_HEADLINES_SHOWN = 14
MAX_CALENDAR_TO_JUDGE = 40
MAX_EARNINGS_TO_JUDGE = 30
MAX_EARNINGS_SHOWN = 16
MIN_EARNINGS_SHOWN = 5
NEWS_PER_STOCK = 8

# TypeSafe.
TYPESAFE_CONCURRENCY = 8
TYPESAFE_MODEL = "jev-latest"

# Server scheduling (seconds). Overridable with env vars.
REFRESH_COOLDOWN_S = int(os.environ.get("MU_REFRESH_COOLDOWN", "120"))
INTERVAL_MARKET_S = int(os.environ.get("MU_INTERVAL_MARKET", "300"))    # pre-market and regular session
INTERVAL_POST_S = int(os.environ.get("MU_INTERVAL_POST", "900"))        # after-hours
INTERVAL_OFF_S = int(os.environ.get("MU_INTERVAL_OFF", "3600"))         # nights and weekends


def load_watchlist() -> list[str]:
    """Read watchlist.txt from MU_WATCHLIST, the project root, or the current directory."""
    path = next((p for p in (WATCHLIST_FILE, Path.cwd() / "watchlist.txt") if p.exists()), None)
    if path is None:
        return []
    out: list[str] = []
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip().upper()
        if line:
            out.append(line)
    return out
