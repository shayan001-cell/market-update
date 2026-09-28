"""The Company map: one company's money, customers, connections and weak points.

Sources, all read at request time and cached: Yahoo Finance statements and profile, the company's latest
10-K from SEC EDGAR (customer concentration and foreign revenue, quoted from the filing), the capital
spending of its biggest customers (Yahoo), and the curated AI map in ai_map.py for who is connected.
Nothing here is a forecast; the "critical / vulnerable" read is arithmetic on those facts plus the map.
"""
from __future__ import annotations

import logging
import math
import re
import time
from typing import Any

import requests

from . import ai_map, fetch

log = logging.getLogger(__name__)
SEC_UA = {"User-Agent": "OneView Market Desk oneview-desk@zohomailcloud.ca", "Accept-Encoding": "gzip, deflate"}
_sec_last = [0.0]


def _sec_get(url: str, timeout: int = 40) -> requests.Response:
    wait = _sec_last[0] + 0.15 - time.time()            # SEC fair access: well under 10 requests a second
    if wait > 0:
        time.sleep(wait)
    _sec_last[0] = time.time()
    r = requests.get(url, headers=SEC_UA, timeout=timeout)
    r.raise_for_status()
    return r


def _num(x: Any) -> float | None:
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _row(df: Any, *names: str) -> list[float | None]:
    for n in names:
        if df is not None and n in getattr(df, "index", []):
            return [_num(v) for v in df.loc[n].tolist()]
    return []


def statements(tk: Any) -> dict[str, Any]:
    """Four fiscal years, newest first, of the lines the map needs."""
    inc, cf, bs = tk.income_stmt, tk.cashflow, tk.balance_sheet
    years = [str(c)[:10] for c in getattr(inc, "columns", [])][:4]
    n = len(years)

    def take(df: Any, *names: str) -> list[float | None]:
        v = _row(df, *names)[:n]
        return v + [None] * (n - len(v))
    out = {"years": years,
           "revenue": take(inc, "Total Revenue", "Operating Revenue"),
           "cost": take(inc, "Cost Of Revenue", "Reconciled Cost Of Revenue"),
           "gross": take(inc, "Gross Profit"),
           "rnd": take(inc, "Research And Development"),
           "sga": take(inc, "Selling General And Administration"),
           "op_income": take(inc, "Operating Income", "Total Operating Income As Reported"),
           "tax": take(inc, "Tax Provision"),
           "net_income": take(inc, "Net Income", "Net Income Common Stockholders"),
           "ocf": take(cf, "Operating Cash Flow"),
           "capex": take(cf, "Capital Expenditure"),
           "buybacks": take(cf, "Repurchase Of Capital Stock"),
           "dividends": take(cf, "Cash Dividends Paid", "Common Stock Dividend Paid"),
           "acquisitions": take(cf, "Net Business Purchase And Sale", "Purchase Of Business"),
           "sbc": take(cf, "Stock Based Compensation"),
           "fcf": take(cf, "Free Cash Flow"),
           "cash": take(bs, "Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"),
           "debt": take(bs, "Total Debt"),
           "receivables": take(bs, "Accounts Receivable", "Receivables"),
           "inventory": take(bs, "Inventory"),
           "equity": take(bs, "Stockholders Equity", "Common Stock Equity"),
           "assets": take(bs, "Total Assets")}
    return out


def money_flow(st: dict[str, Any]) -> dict[str, Any] | None:
    """The latest year as a flow: revenue -> costs and profit -> taxes and net income -> what the cash was used for."""
    g = lambda k: (st.get(k) or [None])[0]  # noqa: E731
    rev, cost, gross, rnd, sga, op, tax, ni = g("revenue"), g("cost"), g("gross"), g("rnd"), g("sga"), g("op_income"), g("tax"), g("net_income")
    if not rev:
        return None
    if gross is None and cost is not None:
        gross = rev - cost
    if cost is None and gross is not None:
        cost = rev - gross
    ocf, capex, bb, dv, acq = g("ocf"), abs(g("capex") or 0), abs(g("buybacks") or 0), abs(g("dividends") or 0), abs(g("acquisitions") or 0)
    other_op = max(0.0, (gross or 0) - (rnd or 0) - (sga or 0) - (op or 0)) if gross and op is not None else 0.0
    nodes = [["rev", "Revenue"], ["cost", "Cost of making it"], ["gross", "Gross profit"], ["rnd", "Research"], ["sga", "Sales & admin"], ["oth", "Other costs"],
             ["op", "Operating profit"], ["tax", "Taxes"], ["ni", "Net income"], ["capex", "Building capacity"], ["bb", "Buybacks"], ["dv", "Dividends"], ["acq", "Acquisitions"], ["kept", "Kept as cash"]]
    links = [("rev", "cost", cost), ("rev", "gross", gross), ("gross", "rnd", rnd), ("gross", "sga", sga), ("gross", "oth", other_op), ("gross", "op", op),
             ("op", "tax", tax), ("op", "ni", ni)]
    if ocf:
        used = capex + bb + dv + acq
        links += [("ni", "capex", capex), ("ni", "bb", bb), ("ni", "dv", dv), ("ni", "acq", acq), ("ni", "kept", max(0.0, ocf - used))]
    links = [{"s": a, "t": b, "v": v} for a, b, v in links if v and v > 0]
    used_ids = {x for l in links for x in (l["s"], l["t"])}
    return {"year": st["years"][0] if st.get("years") else None, "nodes": [{"id": i, "label": l} for i, l in nodes if i in used_ids], "links": links,
            "revenue": rev, "ocf": ocf}


_cik_map: dict[str, int] = {}


def sec_customers(sym: str) -> dict[str, Any] | None:
    """Quotes from the latest 10-K about customer concentration and foreign revenue, plus the percentages in them."""
    ck = f"sec10k_{sym}"
    hit = fetch._cache_get(ck, 30 * 86400)
    if hit:
        return hit
    try:
        if not _cik_map:
            j = _sec_get("https://www.sec.gov/files/company_tickers.json", 30).json()
            _cik_map.update({v["ticker"].upper(): int(v["cik_str"]) for v in j.values()})
        cik = _cik_map.get(sym.upper().replace("-", "."))  or _cik_map.get(sym.upper())
        if not cik:
            return None
        sub = _sec_get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", 30).json()
        rec = sub["filings"]["recent"]
        i = next((k for k, f in enumerate(rec["form"]) if f in ("10-K", "20-F")), None)
        if i is None:
            return None
        acc = rec["accessionNumber"][i].replace("-", "")
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{rec['primaryDocument'][i]}"
        html = _sec_get(url, 60).text
    except Exception as e:  # noqa: BLE001
        log.warning("sec 10-K %s: %s", sym, e)
        return None
    import html as _h
    txt = re.sub(r"<[^>]+>", " ", html)
    txt = _h.unescape(re.sub(r"&#160;|&nbsp;", " ", txt))
    txt = re.sub(r"\s+", " ", txt)
    sents = re.split(r"(?<=[.;])\s+(?=[A-Z(])", txt)
    seen, conc, foreign = set(), [], []
    for s in sents:
        if len(s) > 420:
            continue
        low = s.lower()
        if "customer" in low and re.search(r"\d+(\.\d+)?\s?%", s) and "revenue" in low and not re.search(r"risk|could|may |might", low[:40]):
            key = s[:90]
            if key not in seen:
                seen.add(key); conc.append(s.strip())
        elif re.search(r"(outside (of )?the united states|international|foreign)", low) and "revenue" in low and re.search(r"\d+\s?%", s):
            key = s[:90]
            if key not in seen and len(foreign) < 3:
                seen.add(key); foreign.append(s.strip())
    # the percentages for the latest year: "one direct customer represented 22%" and "another ... 14%"
    top = []
    for s in conc[:6]:
        yr = re.search(r"fiscal (year )?(\d{4})", s, re.I)
        for m in re.finditer(r"(\d+(?:\.\d+)?)\s?%\s*(?:of (?:our |total |net )*revenue)", s, re.I):
            top.append({"pct": float(m.group(1)), "year": yr.group(2) if yr else None, "quote": s[:300]})
    latest = None
    if top:
        yrs = [t["year"] for t in top if t["year"]]
        latest = max(yrs) if yrs else None
        cand = [t for t in top if t["year"] == latest] if latest else top
        first_quote = cand[0]["quote"]                         # filings repeat the same sentence: count one sentence only
        top = [t for t in cand if t["quote"] == first_quote][:5]
    out = {"filed": rec["filingDate"][i], "form": rec["form"][i], "url": url, "quotes": conc[:4], "foreign": foreign[:2],
           "top": [{"pct": t["pct"]} for t in top[:5]], "top_year": latest}
    fetch._cache_put(ck, out)
    return out


def _yf(sym: str) -> Any:
    import yfinance as yf
    return yf.Ticker(sym)


def customer_capex(syms: list[str]) -> list[dict[str, Any]]:
    """Capital spending of the named customers, by fiscal year: the money that flows to their suppliers."""
    out = []
    for s in syms[:6]:
        ck = f"capex_{s}"
        hit = fetch._cache_get(ck, 7 * 86400)
        if not hit:
            try:
                cf = _yf(s).cashflow
                cols = [str(c)[:4] for c in cf.columns][:4]
                vals = [abs(v) if v is not None else None for v in _row(cf, "Capital Expenditure")[:4]]
                hit = {"sym": s, "years": cols, "capex": vals}
                fetch._cache_put(ck, hit)
            except Exception as e:  # noqa: BLE001
                log.info("capex %s: %s", s, e); continue
        out.append(hit)
    return out


def graph(sym: str, info: dict[str, Any], holders: list[dict[str, Any]], peers: list[dict[str, Any]]) -> dict[str, Any]:
    """Nodes and links around one company: the curated AI map where it knows the name, otherwise who owns it
    and its industry peers. Second-degree links (a supplier's supplier) are kept when they are critical."""
    sym = sym.upper()
    nodes: dict[str, dict[str, Any]] = {sym: {"id": sym, "label": ai_map.NODES.get(sym, (info.get("shortName") or sym,))[0], "group": "center",
                                              "role": ai_map.NODES.get(sym, (None, info.get("industry") or ""))[1]}}
    links = []
    first = [e for e in ai_map.EDGES if e[0] == sym or e[1] == sym]
    for a, b, typ, w, why, crit in first:
        other = b if a == sym else a
        if typ == "customer":
            rel = "customer" if b == sym else "supplier"          # a buys from b
        elif typ == "supplies":
            rel = "supplier" if b == sym else "customer"
        else:
            rel = typ
        prev = nodes.get(other)
        if prev and prev["group"] != rel:
            prev["also"] = rel                                    # e.g. Alphabet: customer and rival
        else:
            nodes[other] = {"id": other, "label": ai_map.NODES.get(other, (other,))[0], "group": rel, "role": ai_map.NODES.get(other, (None, ""))[1]}
        links.append({"s": other, "t": sym, "rel": rel, "w": w, "why": why, "critical": bool(crit and (b == sym or rel == "risk"))})
    for a, b, typ, w, why, crit in ai_map.EDGES:                  # second degree: only single points of failure one step out
        if crit and b in nodes and b != sym and a not in nodes and typ in ("supplies", "risk"):
            nodes[a] = {"id": a, "label": ai_map.NODES.get(a, (a,))[0], "group": "second", "role": ai_map.NODES.get(a, (None, ""))[1]}
            links.append({"s": a, "t": b, "rel": "supplier" if typ == "supplies" else "risk", "w": max(1, w - 1), "why": why, "critical": True, "second": True})
    curated = bool(first)
    if not curated:
        for p in peers[:8]:
            nodes[p["sym"]] = {"id": p["sym"], "label": p["name"] or p["sym"], "group": "peer", "role": info.get("industry") or ""}
            links.append({"s": p["sym"], "t": sym, "rel": "peer", "w": 2, "why": f"Same industry ({info.get('industry') or 'peer'}).", "critical": False})
    for h in holders[:5]:
        hid = "H:" + h["name"]
        nodes[hid] = {"id": hid, "label": h["name"], "group": "owner", "role": f"owns {h['pct']:.1f}%" if h.get("pct") else "large holder"}
        links.append({"s": hid, "t": sym, "rel": "owner", "w": 1, "why": f"Holds {h['pct']:.2f}% of the shares." if h.get("pct") else "A large holder.", "critical": False})
    return {"nodes": list(nodes.values()), "links": links, "curated": curated}


def _holders(tk: Any) -> list[dict[str, Any]]:
    try:
        df = tk.institutional_holders
        out = []
        for _, r in df.head(5).iterrows():
            pct = _num(r.get("pctHeld"))
            out.append({"name": str(r.get("Holder")), "pct": pct * 100 if pct is not None and pct < 1 else pct})
        return out
    except Exception:  # noqa: BLE001
        return []


def verdicts(sym: str, info: dict[str, Any], st: dict[str, Any], sec: dict[str, Any] | None, g: dict[str, Any], cap: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    """Why the world needs it (critical) and where it can break (vulnerable), each with the fact behind it."""
    crit, vul = [], []
    L = g["links"]
    cust = [l for l in L if l["rel"] == "customer" and not l.get("second")]
    sup_crit = [l for l in L if l["rel"] == "supplier" and l["critical"] and not l.get("second")]
    rivals = [l for l in L if l["rel"] == "rival"]
    both = [n for n in g["nodes"] if n.get("group") == "customer" and n.get("also") == "rival" or n.get("group") == "rival" and n.get("also") == "customer"]
    downstream_dep = [l for l in ai_map.EDGES if l[0] == sym and l[2] == "supplies" and l[5]]
    gm = info.get("grossMargins")
    if isinstance(gm, (int, float)) and gm >= 0.6:
        crit.append({"t": "Pricing power", "d": f"Keeps {gm * 100:.0f} cents of gross profit on every dollar of sales: customers pay up because there is no easy substitute."})
    if len(cust) >= 5:
        crit.append({"t": "Everyone builds on it", "d": f"{len(cust)} companies on the map buy from it, the biggest clouds and AI labs among them."})
    if downstream_dep:
        crit.append({"t": "Others cannot work without it", "d": "Single source for " + ", ".join(ai_map.NODES.get(e[1], (e[1],))[0] for e in downstream_dep[:4]) + "."})
    cash, debt = (st.get("cash") or [None])[0], (st.get("debt") or [None])[0]
    if cash and debt is not None and cash > debt:
        crit.append({"t": "Net cash", "d": f"${(cash - debt) / 1e9:,.1f}B more cash than debt: it can keep investing through a slowdown."})
    rev = st.get("revenue") or []
    if len(rev) >= 2 and rev[0] and rev[1]:
        gr = (rev[0] / rev[1] - 1) * 100
        if gr >= 25:
            crit.append({"t": "Growing fast", "d": f"Revenue grew {gr:.0f}% in its latest fiscal year."})
    tot_cap = [c for c in cap if c.get("capex") and c["capex"][0] and len(c["capex"]) > 1 and c["capex"][1]]
    if tot_cap:
        now = sum(c["capex"][0] for c in tot_cap); prev = sum(c["capex"][1] for c in tot_cap)
        if prev:
            crit.append({"t": "The spending wave behind it", "d": f"Its biggest customers spent ${now / 1e9:,.0f}B building capacity last year, {(now / prev - 1) * 100:+.0f}% on the year before."})
    if sec and sec.get("top"):
        tops = sorted([t["pct"] for t in sec["top"]], reverse=True)
        s = sum(tops[:2])
        if s >= 20:
            vul.append({"t": "Few customers, big share", "d": f"{'Two customers' if len(tops) > 1 else 'One customer'} bought {s:.0f}% of everything in fiscal {sec.get('top_year') or ''} (10-K). Losing one would hurt."})
    for l in sup_crit[:3]:
        vul.append({"t": f"Depends on {next((n['label'] for n in g['nodes'] if n['id'] == l['s']), l['s'])}", "d": l["why"]})
    for l in [l for l in L if l["rel"] == "risk"][:2]:
        vul.append({"t": next((n["label"] for n in g["nodes"] if n["id"] == l["s"]), l["s"]), "d": l["why"]})
    if both:
        vul.append({"t": "Customers building their own", "d": ", ".join(n["label"] for n in both[:4]) + " buy from it and build rival chips at the same time."})
    elif len(rivals) >= 3:
        vul.append({"t": "Crowded field", "d": f"{len(rivals)} serious rivals on the map."})
    pe = info.get("trailingPE"); g1 = info.get("earningsGrowth") or info.get("revenueGrowth")
    if isinstance(pe, (int, float)) and pe > 30:
        vul.append({"t": "Priced for more growth", "d": f"At {pe:.0f} times earnings, the price needs profits to keep rising fast to hold up."})
    inv, rec_ = st.get("inventory") or [], st.get("receivables") or []
    if len(inv) >= 2 and inv[0] and inv[1] and len(rev) >= 2 and rev[0] and rev[1] and (inv[0] / inv[1]) > (rev[0] / rev[1]) * 1.15:
        vul.append({"t": "Inventory piling up", "d": f"Inventory rose {(inv[0] / inv[1] - 1) * 100:.0f}% while revenue rose {(rev[0] / rev[1] - 1) * 100:.0f}%."})
    if sec and sec.get("foreign"):
        m = re.search(r"(\d+)\s?%", sec["foreign"][0])
        if m:
            vul.append({"t": "Sales abroad", "d": f"{m.group(1)}% of revenue comes from customers based outside the US (10-K), exposed to trade rules."})
    return {"critical": crit[:6], "vulnerable": vul[:6]}


def valuation(info: dict[str, Any]) -> dict[str, Any]:
    pe, fpe, ps = info.get("trailingPE"), info.get("forwardPE"), info.get("priceToSalesTrailing12Months")
    g1 = info.get("earningsGrowth") if isinstance(info.get("earningsGrowth"), (int, float)) else info.get("revenueGrowth")
    years = None
    if isinstance(pe, (int, float)) and pe > 20 and isinstance(g1, (int, float)) and g1 > 0.02:
        years = math.log(pe / 20) / math.log(1 + min(g1, 1.5))    # years of today's growth for the P/E to fall to a market-like 20 at today's price
    return {"market_cap": info.get("marketCap"), "pe": pe, "forward_pe": fpe, "ps": ps, "growth": g1, "years_to_20": round(years, 1) if years else None,
            "gross_margin": info.get("grossMargins"), "op_margin": info.get("operatingMargins"), "net_margin": info.get("profitMargins")}


def company(sym: str, peers: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    sym = sym.upper().strip()
    ck = f"company_{sym}"
    hit = fetch._cache_get(ck, 12 * 3600)
    if hit:
        return hit
    tk = _yf(sym)
    try:
        info = tk.info or {}
    except Exception:  # noqa: BLE001
        info = {}
    if not info.get("shortName") and not info.get("longName"):
        raise ValueError(f"No company found for {sym}")
    st = statements(tk)
    fx = None
    cur = (info.get("financialCurrency") or "USD").upper()
    if cur != "USD":                                   # foreign filers report in their own currency: show everything in dollars
        try:
            fx = float(_yf(f"{cur}USD=X").fast_info.last_price)
        except Exception:  # noqa: BLE001
            fx = None
        if fx:
            for k, v in st.items():
                if k != "years" and isinstance(v, list):
                    st[k] = [x * fx if isinstance(x, (int, float)) else x for x in v]
    holders = _holders(tk)
    g = graph(sym, info, holders, peers or [])
    cust_syms = [l["s"] for l in g["links"] if l["rel"] == "customer" and not l["s"].startswith("H:") and re.fullmatch(r"[A-Z]{1,5}", l["s"])]
    cap = customer_capex(cust_syms) if cust_syms else []
    sec = sec_customers(sym) if re.fullmatch(r"[A-Z.\-]{1,6}", sym) else None
    out = {"symbol": sym, "as_of": time.time(),
           "profile": {"name": info.get("longName") or info.get("shortName"), "sector": info.get("sector"), "industry": info.get("industry"),
                       "employees": info.get("fullTimeEmployees"), "summary": (info.get("longBusinessSummary") or "")[:600], "price": info.get("currentPrice") or info.get("regularMarketPrice"),
                       "country": info.get("country")},
           "currency": {"reported": cur, "usd_rate": fx},
           "statements": st, "flow": money_flow(st), "sec": sec, "capex": cap, "graph": g, "valuation": valuation(info), "holders": holders}
    out["verdicts"] = verdicts(sym, info, st, sec, g, cap)
    fetch._cache_put(ck, out)
    return out
