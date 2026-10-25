"""What the big funds hold in options: calls and puts from each fund's latest SEC 13F filing.

13F filings are quarterly and land up to 45 days after the quarter ends, so this is a delayed but real view of
who holds what. Only directional funds are tracked: market makers (Susquehanna, Jane Street, Optiver ...) hold
huge option books as hedges for making markets, which would drown the signal.
Each position is compared with the fund's previous filing (new, added, cut, closed). Values are the dollar value
of the shares the options control (the 13F rule), not the premium paid, and a 13F shows long positions only: a
fund holding puts may be hedging shares it owns rather than betting on a fall.
CUSIPs are mapped to tickers with OpenFIGI (free, cached for good).
"""
from __future__ import annotations

import json
import logging
import time
import xml.etree.ElementTree as ET
from typing import Any

import requests

from . import config, fetch
from .company import _sec_get

log = logging.getLogger(__name__)

FUNDS: list[tuple[str, int]] = [
    ("Citadel Advisors", 1423053), ("Millennium Management", 1273087), ("Bridgewater Associates", 1350694),
    ("Renaissance Technologies", 1037389), ("Two Sigma Investments", 1179392), ("Point72", 1603466),
    ("Tiger Global", 1167483), ("Pershing Square", 1336528), ("Coatue", 1135730), ("D. E. Shaw", 1009207),
    ("Elliott", 1791786), ("Third Point", 1040273), ("Appaloosa", 1656456), ("Duquesne Family Office", 1536411),
    ("Scion (Michael Burry)", 1649339), ("Soros Fund Management", 1029160), ("Viking Global", 1103804),
    ("Lone Pine", 1061165), ("Greenlight Capital", 1079114), ("Balyasny", 1218710), ("Marshall Wace", 1318757),
]
# Multi-strategy and quant giants run huge two-way option books (calls and puts nearly equal): mostly hedges and
# relative-value trades. They are shown on their own so they never drown the conviction funds' real bets.
MULTI = {"Citadel Advisors", "Millennium Management", "D. E. Shaw", "Balyasny", "Point72", "Marshall Wace", "Two Sigma Investments", "Renaissance Technologies", "Bridgewater Associates"}
STORE = config.OUTPUT_DIR / "funds13f.json"


def _filings(cik: int) -> list[dict[str, Any]]:
    j = _sec_get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", 30).json()
    r = j.get("filings", {}).get("recent", {})
    out = []
    for i, form in enumerate(r.get("form", [])):
        if form == "13F-HR":
            out.append({"acc": r["accessionNumber"][i], "filed": r["filingDate"][i], "period": r["reportDate"][i]})
    return out, j.get("name")


def _table(cik: int, acc: str) -> list[dict[str, Any]]:
    """The information table of one 13F: option rows only."""
    key = f"13f_{acc}"
    hit = fetch._cache_get(key, -1)
    if hit is not None:
        return hit
    base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}"
    idx = _sec_get(f"{base}/index.json", 30).json()
    names = [x["name"] for x in idx.get("directory", {}).get("item", []) if x["name"].lower().endswith(".xml") and "primary_doc" not in x["name"].lower()]
    if not names:
        return []
    raw = _sec_get(f"{base}/{names[0]}", 120).content
    rows = []
    for _, el in ET.iterparse(__import__("io").BytesIO(raw), events=("end",)):
        if not el.tag.endswith("infoTable"):
            continue
        g = {c.tag.split("}")[-1]: c for c in el.iter()}
        pc = (g.get("putCall").text or "").strip().lower() if g.get("putCall") is not None else ""
        if pc in ("put", "call"):
            try:
                rows.append({"issuer": (g["nameOfIssuer"].text or "").strip(), "cusip": (g["cusip"].text or "").strip().upper(),
                             "type": pc, "value": float(g["value"].text or 0), "shares": float(g["sshPrnamt"].text or 0)})
            except Exception:  # noqa: BLE001
                pass
        el.clear()
    fetch._cache_put(key, rows)
    return rows


def _tickers(cusips: list[str]) -> dict[str, str]:
    m: dict[str, str] = fetch._cache_get("cusip_ticker", -1) or {}
    todo = [c for c in dict.fromkeys(cusips) if c not in m]
    for i in range(0, len(todo), 10):                 # OpenFIGI without a key: 10 jobs a request, 25 requests a minute
        chunk = todo[i:i + 10]
        try:
            r = requests.post("https://api.openfigi.com/v3/mapping", json=[{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in chunk], timeout=30)
            if r.status_code == 429:
                time.sleep(60); r = requests.post("https://api.openfigi.com/v3/mapping", json=[{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in chunk], timeout=30)
            for c, res in zip(chunk, r.json()):
                data = res.get("data") or []
                m[c] = (data[0].get("ticker") or "") if data else ""
        except Exception as e:  # noqa: BLE001
            log.warning("openfigi: %s", e); break
        time.sleep(2.6)
    fetch._cache_put("cusip_ticker", m)
    return m


def _book(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    b: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        k = (r["cusip"], r["type"])
        x = b.setdefault(k, {"issuer": r["issuer"], "cusip": r["cusip"], "type": r["type"], "value": 0.0, "shares": 0.0})
        x["value"] += r["value"]; x["shares"] += r["shares"]
    return b


def build() -> dict[str, Any]:
    t0 = time.time()
    funds, positions = [], []
    for name, cik in FUNDS:
        try:
            fl, legal = _filings(cik)
            if not fl:
                continue
            cur = _book(_table(cik, fl[0]["acc"]))
            prev = _book(_table(cik, fl[1]["acc"])) if len(fl) > 1 else {}
            time.sleep(0.2)
        except Exception as e:  # noqa: BLE001
            log.warning("13F %s: %s", name, e); continue
        calls = sum(v["value"] for k, v in cur.items() if k[1] == "call"); puts = sum(v["value"] for k, v in cur.items() if k[1] == "put")
        funds.append({"name": name, "legal": legal, "cik": cik, "period": fl[0]["period"], "filed": fl[0]["filed"],
                      "prev_period": fl[1]["period"] if len(fl) > 1 else None, "calls": calls, "puts": puts, "n": len(cur)})
        for k, v in cur.items():
            p = prev.get(k)
            ch = "new" if not p else "added" if v["shares"] > p["shares"] * 1.1 else "cut" if v["shares"] < p["shares"] * 0.9 else "held"
            positions.append({**v, "fund": name, "prev_value": p["value"] if p else None, "prev_shares": p["shares"] if p else None, "change": ch})
        for k, p in prev.items():
            if k not in cur:
                positions.append({**p, "fund": name, "value": 0.0, "shares": 0.0, "prev_value": p["value"], "prev_shares": p["shares"], "change": "closed"})
    tick = _tickers([p["cusip"] for p in positions if p["value"] >= 5e6 or (p["prev_value"] or 0) >= 5e6])
    for p in positions:
        p["ticker"] = tick.get(p["cusip"]) or ""
    for f in funds:
        f["group"] = "multi" if f["name"] in MULTI else "conviction"
    for p in positions:
        p["group"] = "multi" if p["fund"] in MULTI else "conviction"
    groups = {g: _aggregate([p for p in positions if p["group"] == g]) for g in ("conviction", "multi")}
    out = {"as_of": time.time(), "funds": funds, "groups": groups, "elapsed_s": round(time.time() - t0)}
    STORE.write_text(json.dumps(out, default=str))
    return out


def _aggregate(positions: list[dict[str, Any]]) -> dict[str, Any]:
    by: dict[str, dict[str, Any]] = {}
    for p in positions:
        if not p["ticker"] or p["change"] == "closed":
            continue
        a = by.setdefault(p["ticker"], {"ticker": p["ticker"], "issuer": p["issuer"], "calls": 0.0, "puts": 0.0, "funds_calls": set(), "funds_puts": set(), "new_calls": 0.0, "new_puts": 0.0})
        a[p["type"] + "s"] += p["value"]; a["funds_" + p["type"] + "s"].add(p["fund"])
        if p["change"] in ("new", "added"):
            a["new_" + p["type"] + "s"] += p["value"] - (p["prev_value"] or 0)
    tickers = sorted(({**a, "funds_calls": sorted(a["funds_calls"]), "funds_puts": sorted(a["funds_puts"])} for a in by.values()), key=lambda a: -(a["calls"] + a["puts"]))
    top = sorted([p for p in positions if p["ticker"] and p["change"] != "closed"], key=lambda p: -p["value"])[:400]
    moves = sorted([p for p in positions if p["ticker"] and p["change"] in ("new", "added", "closed", "cut")],
                   key=lambda p: -abs(p["value"] - (p["prev_value"] or 0)))[:200]
    return {"tickers": tickers[:300], "top": top, "moves": moves}
