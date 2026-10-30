"""The morning update email: what to watch, the news that can move prices, earnings, the President's posts, the crowd,
the big money and where money is moving. One email for everyone, built from the latest report and the stored feeds.
Rules only, no model calls. Every line describes the market; nothing tells the reader to buy or sell.
"""
from __future__ import annotations

import html as html_mod
import json
import re
from datetime import datetime
from typing import Any

from . import config, fetch, rules
from .mail import logo_img

_SKIP_SOURCES = {"motley fool", "simply wall st.", "simply wall st", "zacks", "seeking alpha", "insidermonkey", "gurufocus"}
_SHARE_CLASS = {"GOOG": "GOOGL", "BRK-A": "BRK-B", "FOXA": "FOX", "NWSA": "NWS"}
_SKIP_NEWS = re.compile(r"undervalued|should you|is it time|top \d|\d+ (stocks|reasons|ways)|buy now|best stocks|millionaire|motley", re.I)
_DIR = {"bullish_for_stocks": ("Good for stocks", "#0F8F5F"), "bearish_for_stocks": ("Bad for stocks", "#C43B4E"), "mixed_or_unclear": ("Mixed for stocks", "#6B7280")}
_THEME = {"tariffs_trade": "tariffs and trade", "fed_rates": "the Fed and rates", "taxes_spending": "taxes and spending", "geopolitics": "geopolitics",
          "energy_oil": "energy and oil", "specific_company_or_sector": "one company or sector", "crypto": "crypto", "immigration_labor": "immigration and jobs"}
_WHO = {"broad_market": "the whole market", "large_cap_tech": "big tech", "chips_semis": "chip makers", "industrials_manufacturing": "industrials", "autos": "car makers",
        "energy": "energy", "banks_financials": "banks", "defense": "defense", "healthcare_pharma": "healthcare", "crypto_linked": "crypto stocks", "retail_consumer": "retail"}
_GAUGE = {"size": ("Small caps beat big caps", "Big caps beat small caps"), "offense": ("Offense over defense", "Defense over offense"),
          "credit": ("Bond market relaxed", "Bond market nervous"), "breadth": ("More stocks joining in", "Only the giants carrying it")}


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and x == x


def _pct(x: Any, nd: int = 1) -> str:
    return "–" if not _num(x) else f"{'+' if x > 0 else ''}{x:.{nd}f}%".replace("-", "−")


def _cap(x: Any) -> str:
    if not _num(x):
        return ""
    for d, s in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if x >= d:
            return f"${x / d:.1f}{s}"
    return f"${x:,.0f}"


def _macro(report: dict[str, Any], sym: str) -> dict[str, Any]:
    m = next((x for x in report.get("macro") or [] if x.get("symbol") == sym), None) or {}
    chg = m.get("change_pct")
    if not _num(chg) and _num(m.get("last")) and _num(m.get("prev_close")) and m["prev_close"]:
        chg = (m["last"] / m["prev_close"] - 1) * 100
    return {"last": m.get("last"), "chg": chg}


def _clean_post(t: str) -> str:
    """The post's words, without links, trailing @handles or the RT prefix."""
    t = re.sub(r"^RT\s*@\w+\s*", "", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"(\s*@\w+)+\s*$", "", t)
    return re.sub(r"\s+", " ", t).strip()[:240]


def _short(name: str) -> str:
    return re.sub(r"\s+(Holdings\s+)?(Corporation|Corp\.?|Inc\.?|PLC|p\.l\.c\.|plc|Ltd\.?|Limited|S\.A\.|N\.V\.|AG|SE|Co\.?)$", "", name.strip(), flags=re.I).strip(" ,")


def build(report: dict[str, Any]) -> dict[str, Any]:
    """Everything the email shows, as plain data (so a preview and the send use exactly the same thing)."""
    es, nq, vix, tnx, oil = (_macro(report, s) for s in ("ES=F", "NQ=F", "^VIX", "^TNX", "CL=F"))
    # news that can move prices: the freshest kept headlines, minus listicles
    news = []
    for h in report.get("headlines") or []:
        t = h.get("headline") or ""
        if not h.get("keep", True) or _SKIP_NEWS.search(t) or (h.get("source") or "").strip().lower() in _SKIP_SOURCES or any(t[:50] == n["title"][:50] for n in news):
            continue
        news.append({"title": t, "source": h.get("source") or "", "at": (h.get("published") or "")[11:16], "tickers": list(dict.fromkeys(h.get("related_tickers") or []))[:3], "url": h.get("url") or ""})
        if len(news) >= 5:
            break
    # earnings today, biggest first
    earn = sorted(report.get("earnings") or [], key=lambda e: -(e.get("market_cap") or 0))
    earn_today = [{"symbol": e["symbol"], "name": _short(e.get("name") or ""), "when": e.get("report_time") or "", "cap": e.get("market_cap"),
                   "eps": e.get("eps_forecast") or "", "eps_ly": e.get("last_year_eps") or ""} for e in earn[:8]]
    # last night's results, from the earnings calendar's review
    reported = []
    try:
        from . import earnings as E
        wk = E.week(0)
        today = fetch.now_et().date().isoformat()
        rows = [r for d in wk["days"] for r in d["rows"] if r.get("status") == "reported" and r["date"] < today]
        rows = [r for r in rows if r["date"] == max(x["date"] for x in rows)] if rows else []
        have = {r["symbol"] for r in rows}
        rows = [r for r in rows if not (r["symbol"] in _SHARE_CLASS and _SHARE_CLASS[r["symbol"]] in have)]   # one line per company
        for r in sorted(rows, key=lambda r: -(r.get("market_cap") or 0))[:6]:
            reported.append({"symbol": r["symbol"], "result": r.get("result"), "surprise": r.get("surprise_pct"), "move": r.get("reaction_pct"), "cap": r.get("market_cap")})
    except Exception:  # noqa: BLE001
        pass
    # the President: posts in the last 24 hours that are about money, re-read with the current rules when no model read exists
    soc = report.get("social") or {}
    posts_all = (soc.get("trump") or {}).get("posts") or []
    cutoff = (datetime.now(config.ET).timestamp() - 86400)
    recent, market_posts = 0, []
    for p in posts_all:
        try:
            ts = datetime.fromisoformat((p.get("posted") or "").replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if ts < cutoff or not p.get("has_text"):
            continue
        recent += 1
        ai = p.get("ai") or {}
        if (ai.get("theme") or {}).get("rules") or not ai:
            ai = rules.trump({"text": p.get("text") or ""})
        theme = (ai.get("theme") or {}).get("choice")
        if ((ai.get("market_relevance") or {}).get("p") or 0) >= 0.55 and theme not in (None, "not_market"):
            market_posts.append({"text": _clean_post(p.get("text") or ""), "repost": (p.get("text") or "").startswith("RT"), "direction": (ai.get("direction") or {}).get("choice"), "theme": theme,
                                 "who": (ai.get("who_benefits") or {}).get("choice"), "at": (p.get("posted") or "")[11:16]})
    # the crowd
    crowd = [{"ticker": r.get("ticker"), "mentions": r.get("mentions"), "change": ((r["mentions"] / r["mentions_24h_ago"] - 1) * 100) if r.get("mentions") and r.get("mentions_24h_ago") else None,
              "mood": r.get("wsb_sentiment")} for r in ((soc.get("crowd") or {}).get("rows") or [])[:5]]
    st = fetch._cache_get("stocktwits_snapshot", 12 * 3600) or {}
    spy_mood = ((st.get("moods") or {}).get("SPY") or {}) if isinstance(st, dict) else {}
    # the big money: hedge funds' biggest new or added option bets (13F), today's heaviest option trades, insider buying
    big = []
    try:
        f = json.loads((config.OUTPUT_DIR / "funds13f.json").read_text())
        for m in (f.get("groups") or {}).get("conviction", {}).get("moves", []):
            if m.get("change") in ("new", "added") and m.get("ticker"):
                big.append({"fund": m["fund"], "ticker": m["ticker"], "type": m["type"], "value": m.get("value"), "change": m["change"]})
            if len(big) >= 3:
                break
        period = max((x.get("period") or "" for x in f.get("funds") or []), default="")
    except Exception:  # noqa: BLE001
        period = ""
    heavy = [{"ticker": u["ticker"], "side": u["side"], "strike": u["strike"], "expiry": u["expiry"], "notional": u.get("notional"), "vol_oi": u.get("vol_oi")}
             for u in ((report.get("options") or {}).get("heavy") or [])[:3]]
    insiders = []
    for row in (report.get("smart_money") or {}).get("rows") or []:
        for b in ((row.get("insider") or {}).get("open_market_buys_90d") or [])[:1]:
            insiders.append({"ticker": row["ticker"], "who": b.get("insider"), "role": b.get("position"), "value": b.get("value"), "date": b.get("date")})
    insiders = sorted(insiders, key=lambda x: -(x.get("value") or 0))[:2]
    # where money is moving
    secs = sorted([s for s in (report.get("flows") or {}).get("sectors") or [] if _num(s.get("chg_1d"))], key=lambda s: -s["chg_1d"])
    gauges = []
    for g in (report.get("flows") or {}).get("gauges") or []:
        if g.get("key") in _GAUGE and _num(g.get("chg_5d")):
            gauges.append({"text": _GAUGE[g["key"]][0 if g["chg_5d"] >= 0 else 1], "chg": g["chg_5d"], "up": g["chg_5d"] >= 0, "label": g.get("label")})
    # what to watch: three plain lines from the above
    watch = []
    if _num(es["chg"]):
        lead = news[0]["title"] if news else ""
        nqw = f" and Nasdaq futures {'up' if nq['chg'] >= 0 else 'down'} {abs(nq['chg']):.1f}%" if _num(nq["chg"]) else ""
        watch.append(f"S&P 500 futures are {'up' if es['chg'] >= 0 else 'down'} {abs(es['chg']):.1f}%{nqw}." + (f" The story: {lead.rstrip('.')}." if lead else ""))
    ev = [c for c in report.get("calendar") or [] if c.get("country") == "USD" and c.get("ff_impact") in ("High", "Medium")]
    if ev:
        watch.append("On the calendar (ET): " + "; ".join(f"{c.get('time_et', '')} {c.get('title', '')}" + (f" (forecast {c['forecast']})" if c.get("forecast") else "") for c in ev[:3]) + ".")
    if earn_today:
        bo = [e["symbol"] for e in earn_today if e["when"] == "before open"][:3]
        ac = [e["symbol"] for e in earn_today if e["when"] == "after close"][:3]
        watch.append("Reporting today: " + (f"{', '.join(bo)} before the open" if bo else "") + ("; " if bo and ac else "") + (f"{', '.join(ac)} after the close" if ac else "") + ".")
    session = report.get("session_date") or fetch.now_et().date().isoformat()
    return {"date": session, "es": es, "nq": nq, "vix": vix, "tnx": tnx, "oil": oil, "watch": watch[:3], "news": news, "earn_today": earn_today, "reported": reported,
            "posts": market_posts[:2], "posts_recent": recent, "crowd": crowd, "spy_mood": {"score": spy_mood.get("score"), "label": (spy_mood.get("label") or "").replace("_", " ").lower()} if spy_mood else None,
            "big": big, "period": period, "heavy": heavy, "insiders": insiders, "lead": secs[:3], "lag": secs[-3:][::-1] if len(secs) > 3 else [], "gauges": gauges[:3]}


def email(name: str, d: dict[str, Any], site_url: str, unsubscribe_url: str) -> tuple[str, str, str]:
    e = lambda x: html_mod.escape(str(x))  # noqa: E731
    day = datetime.strptime(d["date"], "%Y-%m-%d").strftime("%A, %B %-d")
    es = d["es"]["chg"]
    mood = "lower" if _num(es) and es < -0.15 else "higher" if _num(es) and es > 0.15 else "flat"
    subject = f"OneView morning update · {datetime.strptime(d['date'], '%Y-%m-%d').strftime('%a %b %-d')} · futures {mood}"
    C = {"ink": "#0B1220", "soft": "#3E4A60", "quiet": "#6B7690", "line": "#E6E9F0", "up": "#0F8F5F", "down": "#C43B4E", "blue": "#245BFF"}
    col = lambda x: C["up"] if _num(x) and x > 0 else C["down"] if _num(x) and x < 0 else C["quiet"]  # noqa: E731

    def section(title: str, accent: str, body: str, note: str = "") -> str:
        return (f'<tr><td style="padding:22px 28px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
                f'<td style="padding:0;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:{C["ink"]}"><span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:{accent};margin:0 8px 1px 0;vertical-align:middle"></span>{e(title)}</td>'
                f'<td align="right" style="font-size:11.5px;color:{C["quiet"]}">{e(note)}</td></tr></table>'
                f'<div style="padding-top:10px">{body}</div></td></tr>')

    def row(cells: list[tuple[str, str]], first: bool = False) -> str:
        return "<tr>" + "".join(f'<td style="padding:9px 0;{"" if first else "border-top:1px solid " + C["line"] + ";"}{style}">{html}</td>' for html, style in cells) + "</tr>"

    def table(rows: list[str]) -> str:
        return f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:{C["ink"]}">{"".join(rows)}</table>'

    tape = [("S&P 500 fut", d["es"]["chg"], None), ("Nasdaq fut", d["nq"]["chg"], None), ("VIX", d["vix"]["chg"], d["vix"]["last"]), ("10-yr yield", d["tnx"]["chg"], d["tnx"]["last"]), ("Oil", d["oil"]["chg"], None)]
    tape_html = "".join(f'<td align="center" style="padding:10px 4px;border-left:{"0" if i == 0 else "1px solid #233154"}"><div style="font-size:11px;color:#9FB0D0">{e(k)}</div>'
                        f'<div style="font-size:15px;font-weight:700;color:{"#FFFFFF" if last is not None else "#5BE3A8" if _num(v) and v > 0 else "#FF8FA3" if _num(v) and v < 0 else "#FFFFFF"}">{e(_pct(v)) if last is None else e(f"{last:.2f}" if _num(last) else "–")}</div></td>'
                        for i, (k, v, last) in enumerate(tape))

    watch = "".join(f'<tr><td valign="top" style="padding:7px 10px 7px 0;width:22px"><div style="width:22px;height:22px;border-radius:11px;background:#EEF3FF;color:{C["blue"]};font-size:12px;font-weight:700;text-align:center;line-height:22px">{i + 1}</div></td>'
                    f'<td style="padding:7px 0;font-size:14.5px;line-height:1.5;color:{C["ink"]}">{e(w)}</td></tr>' for i, w in enumerate(d["watch"]))
    news = table([row([(f'<a href="{e(n["url"])}" style="color:{C["ink"]};text-decoration:none;font-weight:600">{e(n["title"])}</a>'
                        f'<div style="font-size:12px;color:{C["quiet"]};margin-top:2px">{e(n["source"])}{" · " + e(n["at"]) + " ET" if n["at"] else ""}{" · " + e(", ".join(n["tickers"])) if n["tickers"] else ""}</div>', "")], i == 0)
                  for i, n in enumerate(d["news"])]) if d["news"] else f'<p style="margin:0;color:{C["quiet"]};font-size:14px">A quiet night for market news.</p>'
    earn_rows = [row([(f'<b>{e(x["symbol"])}</b> <span style="color:{C["quiet"]};font-size:12.5px">{e(x["name"][:26])}</span>', ""), (e(_cap(x["cap"])), f"color:{C['soft']};font-size:13px"),
                      (e(x["when"]), f"color:{C['soft']};font-size:13px"), (f'EPS est. <b>{e(x["eps"])}</b> <span style="color:{C["quiet"]}">vs {e(x["eps_ly"])}</span>' if x["eps"] else "", "text-align:right;font-size:13px")], i == 0)
                 for i, x in enumerate(d["earn_today"][:6])]
    rep = ""
    if d["reported"]:
        rep = f'<div style="margin-top:12px;font-size:12px;font-weight:700;letter-spacing:.08em;color:{C["quiet"]}">LAST NIGHT\'S RESULTS</div>' + table([row([
            (f'<b>{e(x["symbol"])}</b>', ""), (e({"beat": "Beat", "miss": "Missed", "inline": "In line"}.get(x["result"] or "", "Reported")) + (f' by {abs(x["surprise"]):.0f}%' if _num(x["surprise"]) and x["result"] != "inline" else ""),
             f"color:{C['up'] if x['result'] == 'beat' else C['down'] if x['result'] == 'miss' else C['soft']};font-weight:600;font-size:13.5px"),
            (f'stock {_pct(x["move"])}' if _num(x["move"]) else "reaction at the open", f"text-align:right;font-size:13px;color:{col(x['move'])}")], i == 0) for i, x in enumerate(d["reported"])])
    earn = (table(earn_rows) if earn_rows else f'<p style="margin:0;color:{C["quiet"]};font-size:14px">No large companies report today.</p>') + rep
    repost_tag = f'<div style="font-size:11.5px;color:{C["quiet"]};margin-bottom:4px">Reposted by the President</div>'
    if d["posts"]:
        posts = "".join(f'<div style="padding:12px 14px;border:1px solid {C["line"]};border-radius:10px;margin-bottom:8px">{repost_tag if p.get("repost") else ""}<div style="font-size:14px;line-height:1.5;color:{C["ink"]}">{e(p["text"])}</div>'
                        f'<div style="margin-top:8px;font-size:12px"><span style="color:{C["quiet"]};letter-spacing:.06em">ONEVIEW\'S READ · </span><b style="color:{_DIR.get(p["direction"], _DIR["mixed_or_unclear"])[1]}">{e(_DIR.get(p["direction"], _DIR["mixed_or_unclear"])[0])}</b>'
                        f' <span style="color:{C["soft"]}">· about {e(_THEME.get(p["theme"], "the market"))}{" · touches " + e(_WHO[p["who"]]) if p.get("who") in _WHO else ""}</span></div></div>' for p in d["posts"])
    else:
        posts = f'<p style="margin:0;font-size:14px;line-height:1.5;color:{C["soft"]}">No market-moving posts in the last 24 hours. OneView read {d["posts_recent"]} post{"s" if d["posts_recent"] != 1 else ""}; they were about campaigns, endorsements or the media.</p>'
    crowd_rows = [row([(f'<b>{e(c["ticker"])}</b>', ""), (f'{c["mentions"]:,} mentions' if _num(c["mentions"]) else "", f"font-size:13px;color:{C['soft']}"),
                       (_pct(c["change"], 0) + " vs yesterday" if _num(c["change"]) else "", f"font-size:13px;color:{col(c['change'])}"),
                       (e(c["mood"] or ""), f"text-align:right;font-size:13px;font-weight:600;color:{C['up'] if (c['mood'] or '').lower() == 'bullish' else C['down'] if (c['mood'] or '').lower() == 'bearish' else C['soft']}")], i == 0)
                  for i, c in enumerate(d["crowd"])]
    sm = d.get("spy_mood")
    crowd = (f'<p style="margin:0 0 8px;font-size:14px;color:{C["soft"]}">StockTwits mood on the S&amp;P 500: <b style="color:{C["ink"]}">{round(sm["score"])}</b> / 100 ({e(sm.get("label") or "")}; 50 is normal).</p>' if sm and _num(sm.get("score")) else "") + \
            (f'<div style="font-size:12px;color:{C["quiet"]};margin-bottom:4px">Most-talked-about on Reddit\'s trading forums, last 24 hours</div>' + table(crowd_rows) if crowd_rows else "")
    big_rows = [row([(f'<b>{e(b["fund"])}</b>', ""), (f'{"New" if b["change"] == "new" else "Added to"} <b>{e(b["ticker"])}</b> {e(b["type"])}s', "font-size:13.5px"),
                     (e(_cap(b["value"])), "text-align:right;font-size:13.5px;font-weight:600")], i == 0) for i, b in enumerate(d["big"])]
    heavy_rows = [row([(f'<b>{e(h["ticker"])}</b>', ""), (f'{h["strike"]:g} {e(h["side"])}s · expires {e(h["expiry"][5:])}', "font-size:13px"),
                       (e(_cap(h["notional"])) + (f' · {h["vol_oi"]}× open interest' if h.get("vol_oi") else ""), "text-align:right;font-size:13px")], i == 0) for i, h in enumerate(d["heavy"])]
    ins = "".join(f'<p style="margin:8px 0 0;font-size:13.5px;color:{C["soft"]}">Insider buying in the last 90 days: <b style="color:{C["ink"]}">{e(x["who"])}</b> ({e((x["role"] or "").lower())}) bought {e(_cap(x["value"]))} of <b style="color:{C["ink"]}">{e(x["ticker"])}</b> on {e(x["date"])}.</p>' for x in d["insiders"])
    big = ((f'<div style="font-size:12px;color:{C["quiet"]};margin-bottom:4px">Hedge funds\' biggest new option bets in their latest SEC 13F filings{" (positions as of " + e(datetime.strptime(d["period"], "%Y-%m-%d").strftime("%B %-d")) + "; filings run weeks behind)" if d["period"] else ""}</div>' + table(big_rows)) if big_rows else "") + \
          ((f'<div style="font-size:12px;color:{C["quiet"]};margin:12px 0 4px">Heaviest option trades yesterday</div>' + table(heavy_rows)) if heavy_rows else "") + ins
    sec_rows = []
    for i in range(max(len(d["lead"]), len(d["lag"]))):
        a = d["lead"][i] if i < len(d["lead"]) else None; b = d["lag"][i] if i < len(d["lag"]) else None
        sec_rows.append(row([(e(a["label"]) if a else "", "font-size:13.5px"), (_pct(a["chg_1d"]) if a else "", f"font-size:13.5px;font-weight:600;color:{col(a['chg_1d']) if a else ''}"),
                             (e(b["label"]) if b else "", "font-size:13.5px;padding-left:18px"), (_pct(b["chg_1d"]) if b else "", f"text-align:right;font-size:13.5px;font-weight:600;color:{col(b['chg_1d']) if b else ''}")], i == 0))
    money = (f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;color:{C["quiet"]}"><tr><td>LED YESTERDAY</td><td></td><td style="padding-left:18px">LAGGED</td><td></td></tr></table>' + table(sec_rows) if sec_rows else "") + \
            "".join(f'<p style="margin:8px 0 0;font-size:13.5px;color:{C["soft"]}"><b style="color:{C["up"] if g["up"] else C["down"]}">{"▲" if g["up"] else "▼"}</b> {e(g["text"])} <span style="color:{C["quiet"]}">({e(g["label"])}, {_pct(g["chg"])} this week)</span></p>' for g in d["gauges"])
    body = "".join([
        section("What to watch today", C["blue"], f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">{watch}</table>'),
        section("News that can move prices", "#F59E0B", news),
        section("Earnings", "#8B5CF6", earn, "biggest first"),
        section("What the President is saying", "#EF4444", posts, "Truth Social, last 24 h"),
        section("What people are doing", "#10B981", crowd),
        section("What the big money is doing", "#0EA5E9", big or f'<p style="margin:0;color:{C["quiet"]};font-size:14px">No new filings or heavy trades to show.</p>'),
        section("Where money is moving", "#14B8A6", money, "sectors, yesterday"),
    ])
    html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>{e(subject)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:{C['ink']}">
<div style="display:none;max-height:0;overflow:hidden">{e(d['watch'][0] if d['watch'] else 'The market before the open.')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #DDE2EC">
<tr><td style="background:#0B1220;padding:22px 28px 18px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td>{logo_img(132)}</td><td align="right" style="font-size:11.5px;letter-spacing:.14em;color:#8FB0FF;font-weight:700">MORNING UPDATE</td></tr></table>
  <div style="margin-top:16px;font-size:24px;font-weight:700;letter-spacing:-.02em;color:#FFFFFF">{e(day)}</div>
  <div style="margin-top:4px;font-size:14px;color:#AEB9D0">Good morning{', ' + e(name) if name else ''}. The market before the open, in three minutes.</div>
</td></tr>
<tr><td style="background:#111B30;padding:0 20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>{tape_html}</tr></table></td></tr>
<tr><td style="background:#FFF7E6;border-bottom:1px solid #F3E2B8;padding:9px 28px;font-size:12px;color:#7A5300">For information and entertainment only. Not financial advice, and nothing here is a recommendation to buy, sell or hold.</td></tr>
{body}
<tr><td style="padding:26px 28px 8px" align="left"><a href="{e(site_url)}" style="display:inline-block;background:{C['blue']};color:#FFFFFF;text-decoration:none;font-weight:600;padding:13px 24px;border-radius:999px;font-size:15px">Open the full desk</a></td></tr>
<tr><td style="padding:18px 28px 26px;font-size:11.5px;line-height:1.6;color:{C['quiet']}">OneView provides market data and research for information and entertainment only. It is not financial advice and does not recommend buying, selling or holding any security. OneView is not a registered investment adviser. Data comes from public sources, can be delayed or wrong, and OneView is not affiliated with any of them. You get this email because you signed up at OneView. <a href="{e(unsubscribe_url)}" style="color:{C['quiet']}">Unsubscribe</a>.</td></tr>
</table></td></tr></table></body></html>"""
    lines = [f"OneView morning update · {day}", "", "For information and entertainment only. Not financial advice.", "", "WHAT TO WATCH TODAY"] + [f"{i + 1}. {w}" for i, w in enumerate(d["watch"])]
    lines += ["", "NEWS THAT CAN MOVE PRICES"] + [f"- {n['title']} ({n['source']})" for n in d["news"]]
    lines += ["", "EARNINGS TODAY"] + [f"- {x['symbol']} {x['when']}, EPS est. {x['eps']}" for x in d["earn_today"][:6]]
    lines += ["", "WHAT THE PRESIDENT IS SAYING"] + ([f"- {p['text'][:160]} (read: {_DIR.get(p['direction'], _DIR['mixed_or_unclear'])[0]})" for p in d["posts"]] or ["No market-moving posts in the last 24 hours."])
    lines += ["", "WHAT PEOPLE ARE DOING"] + [f"- {c['ticker']}: {c['mentions']} mentions, {c['mood']}" for c in d["crowd"]]
    lines += ["", "WHAT THE BIG MONEY IS DOING"] + [f"- {b['fund']}: {b['change']} {b['ticker']} {b['type']}s, {_cap(b['value'])}" for b in d["big"]]
    lines += ["", "WHERE MONEY IS MOVING"] + [f"- Led: {s['label']} {_pct(s['chg_1d'])}" for s in d["lead"]] + [f"- Lagged: {s['label']} {_pct(s['chg_1d'])}" for s in d["lag"]]
    lines += ["", f"Open the full desk: {site_url}", "", f"Unsubscribe: {unsubscribe_url}"]
    return subject, "\n".join(lines), html
