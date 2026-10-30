"""1 pm midday update picture for the WhatsApp groups (1080x1350): the session so far, what is moving it,
who said what, and what is still ahead into the close.

  .venv/bin/python scripts/midday_card.py      # writes marketing/midday-card.html, marketing/midday-card-<date>.png, prints the JSON it used
"""
import json, subprocess, sys
from datetime import date
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "scripts"))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env")
from market_update import config, midday_update as MD
from morning_card import CHROME, e, pct, tone, money


def build(d, w):
    day = date.fromisoformat(d["date"])
    tiles = "".join(f'<div class="t big"><small>{e(x["name"])}</small><b class="{tone(x["chg"])}">{pct(x["chg"])}</b><span>{"n/a" if x["last"] is None else format(x["last"], ".2f")}</span></div>' for x in d["indexes"])
    tiles += f'<div class="t"><small>VIX fear gauge</small><b>{"n/a" if d["vix"]["last"] is None else format(d["vix"]["last"], ".2f")}</b><span class="{tone(d["vix"]["chg"])}">{pct(d["vix"]["chg"]) if d["vix"]["chg"] is not None else ""}</span></div>'
    mv = lambda xs: "".join(f'<li><b>{e(x["ticker"])}</b><span>{e(x["name"][:22])}</span><em class="{tone(x["chg"])}">{pct(x["chg"])}</em></li>' for x in xs[:3])
    lead, lag = (d["lead"] or [None])[0], (d["lag"] or [None])[0]
    heads = "".join(f'<li class="h"><span>{e(h["at"])}</span>{e(h["title"][:96])}</li>' for h in d["headlines"][:2])
    ahead = [f'{x["time"]} {x["title"]}' for x in d["ahead"][:2]] + ([f'After the close: {", ".join(x["symbol"] for x in d["after_close"])}'] if d["after_close"] else [])
    ahead_html = "".join(f'<li class="h">{e(a)}</li>' for a in ahead)
    who = "Written by AI from the data above" if w.get("engine") != "rules" else "Written from the data above"
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OneView midday update</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Sora:wght@600;650&display=swap" rel="stylesheet">
<style>
:root{{--bg:#09090B;--plate:#121216;--raised:#17171C;--hair:rgba(255,255,255,.08);--ink:#F4F4F5;--soft:#CFCFD6;--quiet:#8A8A96;--blue2:#8FB0FF;--up:#3DDC97;--down:#FF6B85}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:1080px;height:1350px;background:var(--bg);overflow:hidden}}
body{{font-family:"Geist",system-ui,sans-serif;font-variant-numeric:tabular-nums;color:var(--ink);padding:52px 60px 40px;display:flex;flex-direction:column;gap:18px;position:relative}}
.glow{{position:absolute;inset:0;pointer-events:none;background:radial-gradient(680px 460px at 100% -8%,rgba(36,91,255,.28),transparent 62%)}}
.z{{position:relative}}
.top{{display:flex;justify-content:space-between;align-items:center}} .top img{{width:200px;display:block}}
.when{{text-align:right}} .when b{{display:block;font-family:"Sora",sans-serif;font-weight:650;font-size:32px;letter-spacing:-.03em}}
.when span{{font-size:18px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--blue2)}}
.tape{{display:grid;grid-template-columns:repeat(4,minmax(0,1.15fr)) minmax(0,1fr);gap:10px}}
.t{{padding:14px 14px 12px;border-radius:18px;background:var(--raised);box-shadow:inset 0 0 0 1.5px var(--hair)}}
.t small{{display:block;font-size:15px;color:var(--quiet);margin-bottom:6px;white-space:nowrap}}
.t b{{display:block;font-weight:650;font-size:30px;letter-spacing:-.02em}} .t span{{display:block;margin-top:4px;font-size:16px;color:var(--soft);font-weight:600}}
.story{{padding:20px 24px;border-radius:22px;background:linear-gradient(180deg,rgba(36,91,255,.16),rgba(36,91,255,.06));box-shadow:inset 0 0 0 1.5px rgba(143,176,255,.28)}}
.k{{display:block;font-size:15px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--quiet);margin-bottom:8px}}
.story .k{{color:var(--blue2)}}
.story h1{{font-family:"Sora",sans-serif;font-weight:600;font-size:31px;line-height:1.2;letter-spacing:-.025em;margin-bottom:10px}}
p{{font-size:21px;line-height:1.4;color:var(--soft)}}
.box{{padding:18px 22px;border-radius:22px;background:var(--plate);box-shadow:inset 0 0 0 1.5px var(--hair)}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px}}
ul{{list-style:none;display:grid;gap:8px}}
li{{display:grid;grid-template-columns:74px 1fr auto;align-items:baseline;gap:8px;font-size:20px}}
li b{{font-weight:650}} li span{{color:var(--soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}} li em{{font-style:normal;font-weight:650}}
li.h{{display:block;font-size:19px;color:var(--soft);line-height:1.35}} li.h span{{color:var(--quiet);margin-right:8px}}
.sub{{font-size:15px;color:var(--quiet);margin-bottom:6px;letter-spacing:.06em;text-transform:uppercase}}
.sec{{display:flex;gap:28px;margin-top:10px;font-size:20px}} .sec i{{font-style:normal;font-weight:650}}
.up{{color:var(--up)}} .down{{color:var(--down)}} .flat{{color:var(--soft)}}
.foot{{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:20px;font-size:16px;color:var(--quiet)}} .foot b{{color:var(--blue2);font-weight:600;font-size:19px}}
</style></head><body><div class="glow"></div>
<div class="z top"><img src="../market_update/static/brand/oneview-logo.png" alt="OneView"><div class="when"><span>Midday update · {e(d["time"])} ET</span><b>{day:%A, %B} {day.day}</b></div></div>
<div class="z tape">{tiles}</div>
<div class="z story"><span class="k">The session so far</span><h1>{e(w["headline"])}</h1><p>{e(w["so_far"])}</p></div>
<div class="z box"><span class="k">What is moving it</span><p>{e(w["drivers"])}</p>
  <div class="two"><div><div class="sub">Up the most, $10B+</div><ul>{mv(d["up"])}</ul></div><div><div class="sub">Down the most, $10B+</div><ul>{mv(d["down"])}</ul></div></div>
  <div class="sec"><span>Leading: <b>{e(lead["label"]) if lead else "n/a"}</b> <i class="up">{pct(lead["chg_1d"]) if lead else ""}</i></span><span>Lagging: <b>{e(lag["label"]) if lag else "n/a"}</b> <i class="down">{pct(lag["chg_1d"]) if lag else ""}</i></span></div></div>
<div class="z box"><span class="k">Who said what</span><p>{e(w["voices"])}</p>{f'<ul style="margin-top:10px">{heads}</ul>' if heads else ""}</div>
<div class="z box"><span class="k">Into the close</span><p>{e(w["into_close"])}</p>{f'<ul style="margin-top:10px">{ahead_html}</ul>' if ahead_html else ""}</div>
<div class="z foot"><span>{who}. Information and entertainment only. Not financial advice.</span><b>Full desk: OneView</b></div>
</body></html>"""


def main():
    d = MD.build(json.loads((config.OUTPUT_DIR / "report.json").read_text()))
    w = MD.write(d)
    page = ROOT / "marketing" / "midday-card.html"
    page.write_text(build(d, w))
    out = ROOT / "marketing" / f"midday-card-{d['date']}.png"
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1080,1350",
                    "--virtual-time-budget=6000", f"--screenshot={out}", page.as_uri()], check=True, capture_output=True)
    print(json.dumps({"png": str(out.relative_to(ROOT)), "engine": w["engine"], "headline": w["headline"]}))
    return d, w, out


if __name__ == "__main__":
    main()
