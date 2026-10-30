"""Morning brief picture for the WhatsApp group: one 1080x1350 image with what matters before the open.

  .venv/bin/python scripts/morning_card.py          # writes marketing/morning-card.html and marketing/morning-card-<date>.png

Built from the same data as the morning email (market_update/morning_update.build), so the two never disagree.
Rendered with the installed Google Chrome in headless mode.
"""
import html, json, re, subprocess, sys
from datetime import date
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from market_update import config, morning_update as MU

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
e = html.escape


def pct(v, d=1):
    return "n/a" if v is None else f"{'+' if v > 0 else '−' if v < 0 else ''}{abs(v):.{d}f}%"


def tone(v):
    return "up" if (v or 0) > 0 else "down" if (v or 0) < 0 else "flat"


def money(v):
    v = float(v or 0)
    return f"${v / 1e12:.1f}T" if v >= 1e12 else f"${v / 1e9:.0f}B" if v >= 1e9 else f"${v / 1e6:.0f}M"


def story(d):
    first = (d.get("watch") or [""])[0]
    m = re.search(r"The story:\s*(.+)$", first)
    s = (m.group(1) if m else (d.get("news") or [{}])[0].get("title", "")).strip().rstrip(".")
    return re.sub(r"\s*[–—]\s*", ": ", s)


def calendar(d):
    for w in d.get("watch") or []:
        m = re.search(r"On the calendar \(ET\):\s*(.+)$", w)
        if m:
            return [x.strip().rstrip(".") for x in m.group(1).split(";") if x.strip()][:2]
    return []


def build(d):
    day = date.fromisoformat(d["date"])
    tape = [("S&P 500 futures", d["es"], True), ("Nasdaq futures", d["nq"], True), ("VIX fear gauge", d["vix"], False),
            ("10-year yield", d["tnx"], False), ("Oil", d["oil"], False)]
    def tile(k, q, big):
        # futures lead with the move; the VIX, the yield and oil lead with the level and show the move under it
        main = (f'<b class="{tone(q.get("chg"))}">{pct(q.get("chg"))}</b>' if big else
                f'<b>{"n/a" if q.get("last") is None else format(q["last"], ".2f")}{"%" if k.startswith("10") else ""}</b>')
        sub = "" if big else f'<span class="{tone(q.get("chg"))}">{pct(q.get("chg"))}</span>'
        return f'<div class="t {"big" if big else ""}"><small>{e(k)}</small>{main}{sub}</div>'
    tape_html = "".join(tile(k, q, big) for k, q, big in tape if q)
    earn = sorted(d.get("earn_today") or [], key=lambda x: -(x.get("cap") or 0))[:4]
    earn_html = "".join(f'<li><b>{e(x["symbol"])}</b><span>{e(x.get("name") or "")}</span><em>{e(x.get("when") or "")}</em></li>' for x in earn)
    rep = sorted(d.get("reported") or [], key=lambda x: -(x.get("cap") or 0))[:3]
    rep_html = "".join(
        f'<li><b>{e(x["symbol"])}</b><span class="{"up" if x["result"] == "beat" else "down"}">{"Beat" if x["result"] == "beat" else "Missed"} by {abs(x.get("surprise") or 0):.0f}%</span>'
        f'<em class="{tone(x.get("move"))}">{pct(x["move"]) if x.get("move") is not None else "at the open"}</em></li>' for x in rep)
    cal = calendar(d)
    cal_html = "".join(f'<li class="cal">{e(c)}</li>' for c in cal)
    lead, lag = (d.get("lead") or [None])[0], (d.get("lag") or [None])[0]
    post = (d.get("posts") or [None])[0]
    read = {"bullish_for_stocks": ("Good for stocks", "up"), "bearish_for_stocks": ("Bad for stocks", "down")}.get((post or {}).get("direction"), ("Mixed for stocks", "flat"))
    mood = d.get("spy_mood") or {}
    crowd_html = "".join(f'<div class="c"><b>{e(c["ticker"])}</b><span>{int(c.get("mentions") or 0)} mentions</span><i class="{"up" if c.get("mood") == "Bullish" else "down" if c.get("mood") == "Bearish" else "flat"}">{e(c.get("mood") or "")}</i></div>' for c in (d.get("crowd") or [])[:4]) or '<p class="none">Quiet on the forums.</p>'
    post_html = (f'<div class="post"><p>{e(post["text"][:150])}</p><span><i class="{read[1]}">{read[0]}</i>'
                 f'{" · " + e(post["theme"].replace("_", " ")) if post.get("theme") else ""}</span></div>') if post else '<p class="none">No market-moving posts in the last 24 hours.</p>'
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OneView morning brief</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@500;600&family=Sora:wght@600;650&display=swap" rel="stylesheet">
<style>
:root{{--bg:#09090B;--plate:#121216;--raised:#17171C;--hair:rgba(255,255,255,.08);--ink:#F4F4F5;--soft:#CFCFD6;--quiet:#8A8A96;--blue:#3B7BFF;--blue2:#8FB0FF;--up:#3DDC97;--down:#FF6B85;--warn:#F7C85A}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:1080px;height:1350px;background:var(--bg);overflow:hidden}}
body{{font-variant-numeric:tabular-nums;font-family:"Geist",system-ui,sans-serif;color:var(--ink);padding:56px 60px 44px;display:flex;flex-direction:column;gap:22px;position:relative}}
.glow{{position:absolute;inset:0;pointer-events:none;background:radial-gradient(680px 460px at 0% -8%,rgba(36,91,255,.30),transparent 62%)}}
.z{{position:relative}}
.top{{display:flex;justify-content:space-between;align-items:center}}
.top img{{width:210px;display:block}}
.when{{text-align:right}} .when b{{display:block;font-family:"Sora",sans-serif;font-weight:650;font-size:34px;letter-spacing:-.03em}}
.when span{{font-size:19px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--blue2)}}
.tape{{display:grid;grid-template-columns:1.25fr 1.25fr 1fr 1fr 1fr;gap:10px}}
.t{{padding:16px 16px 14px;border-radius:20px;background:var(--raised);box-shadow:inset 0 0 0 1.5px var(--hair)}}
.t small{{display:block;font-size:16px;color:var(--quiet);margin-bottom:8px}}
.t b{{display:block;font-weight:650;font-size:32px;letter-spacing:-.02em}}
.t.big b{{font-size:46px}}
.t span{{display:block;margin-top:6px;font-size:18px;font-weight:600}}
.story{{padding:22px 26px;border-radius:24px;background:linear-gradient(180deg,rgba(36,91,255,.16),rgba(36,91,255,.06));box-shadow:inset 0 0 0 1.5px rgba(143,176,255,.28)}}
.story small,.k{{display:block;font-size:16px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--blue2);margin-bottom:10px}}
.story p{{font-family:"Sora",sans-serif;font-weight:600;font-size:33px;line-height:1.22;letter-spacing:-.025em}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.box{{padding:20px 22px;border-radius:24px;background:var(--plate);box-shadow:inset 0 0 0 1.5px var(--hair)}}
.k{{color:var(--quiet)}}
ul{{list-style:none;display:grid;gap:10px}}
li{{display:grid;grid-template-columns:88px 1fr auto;align-items:baseline;gap:10px;font-size:22px}}
li b{{font-family:"Geist",system-ui,sans-serif;font-weight:600}}
li span{{color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
li em{{font-style:normal;font-size:18px;color:var(--quiet);white-space:nowrap}}
li.cal{{display:block;font-size:20px;color:var(--soft);padding-top:8px;border-top:1.5px solid var(--hair)}}
li.cal:first-of-type{{margin-top:4px}}
.flow{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}}
.f small{{display:block;font-size:16px;color:var(--quiet);margin-bottom:6px}}
.f b{{display:block;font-size:25px;font-weight:600}} .f i{{font-style:normal;font-family:"Geist",system-ui,sans-serif;font-size:22px}}
.post p{{font-size:23px;line-height:1.35;color:var(--ink)}}
.post span{{display:block;margin-top:10px;font-size:18px;color:var(--quiet)}}
.post i{{font-style:normal;font-weight:600}}
.none{{font-size:21px;color:var(--quiet)}}
.crowd{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}}
.c{{padding:12px 14px;border-radius:16px;background:var(--raised);box-shadow:inset 0 0 0 1.5px var(--hair)}}
.c b{{display:block;font-size:24px;font-weight:650}} .c span{{display:block;font-size:16px;color:var(--quiet);margin:4px 0}} .c i{{font-style:normal;font-size:17px;font-weight:600}}
.up{{color:var(--up)}} .down{{color:var(--down)}} .flat{{color:var(--soft)}}
.foot{{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:20px;font-size:17px;color:var(--quiet)}}
.foot b{{color:var(--blue2);font-weight:600;font-size:20px}}
</style></head><body><div class="glow"></div>
<div class="z top"><img src="../market_update/static/brand/oneview-logo.png" alt="OneView"><div class="when"><span>Morning brief</span><b>{day:%A, %B} {day.day}</b></div></div>
<div class="z tape">{tape_html}</div>
<div class="z story"><small>The story this morning</small><p>{e(story(d))}</p></div>
<div class="z two">
  <div class="box"><span class="k">Reporting today</span><ul>{earn_html or '<li class="cal">No big names report today.</li>'}{cal_html}</ul></div>
  <div class="box"><span class="k">Last night's results</span><ul>{rep_html or '<li class="cal">No big results last night.</li>'}</ul></div>
</div>
<div class="z box"><span class="k">Where money moved yesterday</span><div class="flow">
  <div class="f"><small>Led</small><b>{e(lead["label"]) if lead else "n/a"} <i class="up">{pct(lead["chg_1d"]) if lead else ""}</i></b></div>
  <div class="f"><small>Lagged</small><b>{e(lag["label"]) if lag else "n/a"} <i class="down">{pct(lag["chg_1d"]) if lag else ""}</i></b></div>
  <div class="f"><small>The crowd on the S&amp;P 500</small><b>{mood.get("score", "n/a")}<i class="flat">/100</i> <i class="{"up" if mood.get("label") == "bullish" else "down" if mood.get("label") == "bearish" else "flat"}">{e((mood.get("label") or "").capitalize())}</i></b></div>
</div></div>
<div class="z box"><span class="k">What the President posted</span>{post_html}</div>
<div class="z box"><span class="k">Most talked-about on Reddit</span><div class="crowd">{crowd_html}</div></div>
<div class="z foot"><span>Information and entertainment only. Not financial advice.</span><b>Full desk: OneView</b></div>
</body></html>"""


def main():
    d = MU.build(json.loads((config.OUTPUT_DIR / "report.json").read_text()))
    page = ROOT / "marketing" / "morning-card.html"
    page.write_text(build(d))
    out = ROOT / "marketing" / f"morning-card-{d['date']}.png"
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1080,1350",
                    "--virtual-time-budget=6000", f"--screenshot={out}", page.as_uri()], check=True, capture_output=True)
    print("wrote", out.relative_to(ROOT))


if __name__ == "__main__":
    main()
