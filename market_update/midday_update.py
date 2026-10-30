"""The 1 pm midday update: what has happened since the open, what is moving the market, who said what, and
what is on the clock into the close. Numbers come from the report; the short written read comes from the AI
provider (DeepSeek today) and is checked for advice language before it is used, with a rule-written fallback.

build(report)  -> data dict (all facts, no model call)
write(data)    -> {headline, so_far, drivers, voices, into_close, engine}
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from . import db, morning_update as MU

ET = ZoneInfo("America/New_York")
# words that turn a description into a recommendation: the written read is rejected if it uses any
ADVICE = re.compile(r"\b(buy|buying opportunity|sell|short (it|the)|go long|go short|target|stop[- ]loss|stops?\b|entry|enter|exit|recommend\w*|should|must|consider|opportunit\w+|load up|take profits?)\b", re.I)


def _pct(v: Any) -> float | None:
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def build(report: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(ET)
    base = MU.build(report)
    idx = {x["symbol"]: x for x in report.get("indices") or []}
    macro = {m.get("symbol"): m for m in (report.get("macro") or [])} if isinstance(report.get("macro"), list) else {}
    indexes = [{"symbol": s, "name": n, "last": (idx.get(s) or {}).get("last"), "chg": _pct((idx.get(s) or {}).get("chg_pct"))}
               for s, n in (("SPY", "S&P 500"), ("QQQ", "Nasdaq 100"), ("IWM", "Russell 2000"), ("DIA", "Dow"))]
    vix = macro.get("^VIX") or {}
    # biggest moves among companies worth $10B or more
    lite = [dict(v, ticker=k) for k, v in (report.get("lite") or {}).items() if (v.get("market_cap") or 0) >= 10e9 and v.get("chg_pct") is not None and v.get("kind") == "Stock"]
    up = sorted(lite, key=lambda x: -x["chg_pct"])[:4]
    down = sorted(lite, key=lambda x: x["chg_pct"])[:4]
    mover = lambda x: {"ticker": x["ticker"], "name": x.get("name") or "", "chg": _pct(x["chg_pct"]), "cap": x.get("market_cap")}
    # the 15-minute direction reads taken since the open
    reads = db.day_directions(now.date().isoformat())
    last_read = reads[-1] if reads else None
    tally = {k: sum(1 for r in reads if r.get("expected") == k) for k in ("higher", "lower", "sideways")}
    # events still ahead today, and results due after the close
    ahead = [{"time": c.get("time_et"), "title": c.get("title"), "forecast": c.get("forecast")} for c in report.get("calendar") or []
             if (c.get("time_et") or "") >= now.strftime("%H:%M") and (c.get("relevance") or 0) >= 2][:4]
    after_close = [x for x in base.get("earn_today") or [] if "after" in (x.get("when") or "")][:4]
    # headlines since the open
    opened = now.replace(hour=9, minute=30, second=0, microsecond=0)
    since = []
    for h in report.get("headlines") or []:
        try:
            t = datetime.fromisoformat(h.get("published")).astimezone(ET)
        except Exception:  # noqa: BLE001
            continue
        if t >= opened and h.get("keep", True):
            since.append({"title": h.get("headline"), "source": h.get("source"), "at": t.strftime("%H:%M"), "tickers": (h.get("related_tickers") or [])[:3]})
    spy_t = ((idx.get("SPY") or {}).get("technicals") or {})
    return {
        "date": now.date().isoformat(), "time": now.strftime("%H:%M"),
        "indexes": indexes, "vix": {"last": vix.get("last"), "chg": _pct(vix.get("chg_pct"))},
        "up": [mover(x) for x in up], "down": [mover(x) for x in down],
        "lead": base.get("lead") or [], "lag": base.get("lag") or [],
        "reads": {"count": len(reads), "tally": tally, "latest": {k: last_read.get(k) for k in ("ts", "expected", "confidence", "driver")} if last_read else None},
        "spy_levels": {"prev_high": spy_t.get("prev_high"), "prev_low": spy_t.get("prev_low"), "sma20": spy_t.get("sma20")},
        "headlines": since[:6], "posts": base.get("posts") or [], "crowd": base.get("crowd") or [], "spy_mood": base.get("spy_mood") or {},
        "heavy": base.get("heavy") or [], "ahead": ahead, "after_close": after_close,
    }


SYSTEM = (
    "You write OneView's 1 pm midday market note for a WhatsApp group of retail traders. Use ONLY the facts in the JSON "
    "you are given; never invent prices, news, quotes or events. Describe what happened and what is scheduled; never tell "
    "anyone what to do. Do not use the words buy, sell, short, long, target, stop, entry, exit, recommend, should, must, "
    "consider or opportunity. Plain English, short sentences, no emoji, no dashes. Numbers as given, with % where they are percentages.\n"
    "Return JSON only: {\"headline\": at most 12 words, \"so_far\": 2 sentences on the session so far, "
    "\"drivers\": 2 sentences on what is moving it (sectors, the biggest movers), \"voices\": 1 to 2 sentences on who said what "
    "(the President's posts, headlines since the open, the crowd), \"into_close\": 2 sentences on the levels and scheduled events "
    "still ahead today, written as facts (for example: yesterday's high is 774.4; the Fed's Waller speaks at 14:00)}."
)


def _fallback(d: dict[str, Any]) -> dict[str, Any]:
    spy = next((x for x in d["indexes"] if x["symbol"] == "SPY"), {})
    qqq = next((x for x in d["indexes"] if x["symbol"] == "QQQ"), {})
    f = lambda v: "flat" if not v else f"{'up' if v > 0 else 'down'} {abs(v):.1f}%"
    lead, lag = (d["lead"] or [{}])[0], (d["lag"] or [{}])[0]
    lv = d["spy_levels"]
    n2 = lambda v: "n/a" if v is None else f"{v:.2f}"
    return {
        "headline": f"Midday: S&P 500 {f(spy.get('chg'))}, Nasdaq 100 {f(qqq.get('chg'))}",
        "so_far": f"The S&P 500 is {f(spy.get('chg'))} and the Nasdaq 100 {f(qqq.get('chg'))} at {d['time']} ET. The VIX is {d['vix'].get('last') or 'n/a'}.",
        "drivers": (f"{lead.get('label', 'n/a')} leads ({lead.get('chg_1d', 0):+.1f}%) and {lag.get('label', 'n/a')} lags ({lag.get('chg_1d', 0):+.1f}%)."
                    + (f" Biggest big-cap moves: {d['up'][0]['ticker']} {d['up'][0]['chg']:+.1f}% and {d['down'][0]['ticker']} {d['down'][0]['chg']:+.1f}%." if d["up"] and d["down"] else "")),
        "voices": ((f"The President posted: \"{d['posts'][0]['text'][:120]}\". " if d["posts"] else "No market-moving posts from the President today. ")
                   + (f"The crowd on the S&P 500 reads {d['spy_mood'].get('score')}/100, {d['spy_mood'].get('label')}." if d["spy_mood"].get("score") is not None else "")),
        "into_close": (f"Yesterday's S&P 500 high and low were {n2(lv.get('prev_high'))} and {n2(lv.get('prev_low'))}."
                       + (f" Still ahead today: {'; '.join(str(x['time']) + ' ' + str(x['title']) for x in d['ahead'][:2])}." if d["ahead"] else " Nothing major left on the calendar today.")
                       + (f" Reporting after the close: {', '.join(x['symbol'] for x in d['after_close'])}." if d["after_close"] else "")),
        "engine": "rules",
    }


def _clean(t: str) -> str:
    return re.sub(r"\s*[–—]\s*", ", ", str(t or "")).strip()


def write(d: dict[str, Any]) -> dict[str, Any]:
    """Ask the AI provider for the short read; reject anything that sounds like advice."""
    try:
        import openai
        from .openai_judge import settings, EXTRA_BODY
        from . import config
        base_url, key, model = settings()
        client = openai.OpenAI(base_url=base_url, api_key=key, timeout=60, max_retries=1)
        facts = json.dumps(d, default=str)
        for attempt in range(2):
            r = client.chat.completions.create(model=model, max_tokens=700, temperature=0.3,
                                               messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": facts}],
                                               response_format={"type": "json_object"}, extra_body=EXTRA_BODY.get(config.AI_PROVIDER) or None)
            out = json.loads(r.choices[0].message.content)
            out = {k: _clean(out.get(k, "")) for k in ("headline", "so_far", "drivers", "voices", "into_close")}
            if all(out.values()) and not any(ADVICE.search(v) for v in out.values()):
                return {**out, "engine": config.AI_PROVIDER}
    except Exception:  # noqa: BLE001
        pass
    return _fallback(d)
