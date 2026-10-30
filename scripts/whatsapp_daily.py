"""Post the daily OneView picture to the WhatsApp groups in output/wa-daily-groups.tsv (id, name, members).

  .venv/bin/python scripts/whatsapp_daily.py morning            # 09:00 ET: the morning brief picture
  .venv/bin/python scripts/whatsapp_daily.py midday             # 13:00 ET: the midday update picture
  .venv/bin/python scripts/whatsapp_daily.py midday --dry-run   # build the picture and caption, post nothing
  .venv/bin/python scripts/whatsapp_daily.py morning --only "<group id>"   # one group, for a check

Guards: trading days only; once per slot per day (output/briefs/<date>-<slot>.whatsapp-groups lists the groups done,
so a re-run only posts to the rest); the report must be fresh; never after the slot's last useful minute;
20 to 40 seconds between groups so WhatsApp does not see a burst; stops if the bridge fails twice in a row.
"""
import argparse, json, os, random, subprocess, sys, tempfile, time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "scripts"))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env")
from market_update import config
from market_update.ai_budget import is_trading_day

ET = ZoneInfo("America/New_York")
SLOTS = {"morning": {"fresh_h": 3, "last": "10:30"}, "midday": {"fresh_h": 1, "last": "15:00"}}
BRIDGE = ROOT / "tools" / "whatsapp" / "wab.js"
GROUPS = config.OUTPUT_DIR / "wa-daily-groups.tsv"

ap = argparse.ArgumentParser()
ap.add_argument("slot", choices=SLOTS); ap.add_argument("--dry-run", action="store_true"); ap.add_argument("--only")
a = ap.parse_args()
now = datetime.now(ET)
REPORT = config.OUTPUT_DIR / "report.json"


def fresh() -> bool:
    try:
        built = datetime.fromisoformat(json.loads(REPORT.read_text())["generated_at"]).astimezone(ET)
    except Exception:  # noqa: BLE001
        return False
    return datetime.now(ET) - built < timedelta(hours=SLOTS[a.slot]["fresh_h"])


if not a.dry_run:
    if not is_trading_day(now.date()):
        sys.exit(f"{now:%a %Y-%m-%d}: market closed, no {a.slot} post")
    for _ in range(20):
        if fresh(): break
        print("report not fresh yet; waiting", flush=True); time.sleep(60)
    if not fresh():
        sys.exit(f"no fresh report: skipping the {a.slot} post rather than posting old numbers")
    if datetime.now(ET).strftime("%H:%M") >= SLOTS[a.slot]["last"]:
        sys.exit(f"past {SLOTS[a.slot]['last']} ET: too late for the {a.slot} post today")

site = (os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL)
if a.slot == "morning":
    import morning_card as C
    from market_update import morning_update as MU
    d = MU.build(json.loads(REPORT.read_text()))
    page = ROOT / "marketing" / "morning-card.html"; page.write_text(C.build(d))
    png = ROOT / "marketing" / f"morning-card-{d['date']}.png"
    es, nq = d["es"].get("chg"), d["nq"].get("chg")
    caption = (f"OneView morning brief · {now:%a %b} {now.day}\n"
               f"S&P 500 futures {C.pct(es)}, Nasdaq futures {C.pct(nq)}. {C.story(d)}.\n\n"
               f"Full desk, free: {site}\nInformation and entertainment only. Not financial advice.")
else:
    import morning_card as C
    import midday_card as M
    from market_update import midday_update as MD
    d = MD.build(json.loads(REPORT.read_text())); w = MD.write(d)
    page = ROOT / "marketing" / "midday-card.html"; page.write_text(M.build(d, w))
    png = ROOT / "marketing" / f"midday-card-{d['date']}.png"
    caption = (f"OneView midday update · {now:%a %b} {now.day}, {d['time']} ET\n{w['headline']}.\n{w['so_far']}\n\n"
               f"Full desk, free: {site}\nInformation and entertainment only. Not financial advice.")
subprocess.run([C.CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1080,1350",
                "--virtual-time-budget=6000", f"--screenshot={png}", page.as_uri()], check=True, capture_output=True)
print("picture:", png.relative_to(ROOT)); print("caption:\n" + caption, flush=True)

groups = [l.rstrip("\n").split("\t") for l in GROUPS.read_text().splitlines() if l.strip()] if GROUPS.exists() else []
if a.only:
    groups = [g for g in groups if g[0] == a.only] or [[a.only, a.only, "?"]]
if a.dry_run:
    print(f"dry run: would post to {len(groups)} groups:", ", ".join(g[1] for g in groups)); sys.exit()

marker = config.OUTPUT_DIR / "briefs" / f"{now.date().isoformat()}-{a.slot}.whatsapp-groups"
marker.parent.mkdir(parents=True, exist_ok=True)
done = set(json.loads(marker.read_text())) if marker.exists() else set()
todo = [g for g in groups if g[0] not in done]
print(f"{len(todo)} groups to post ({len(done)} already done today)", flush=True)
with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
    f.write(caption); cap_path = f.name
fails = 0
for i, (gid, name, _n) in enumerate(todo):
    r = subprocess.run(["node", str(BRIDGE), "send", gid, str(png), cap_path], capture_output=True, text=True, timeout=240)
    if r.returncode == 0:
        done.add(gid); marker.write_text(json.dumps(sorted(done))); fails = 0
        print(f"{i + 1}/{len(todo)} posted to {name} {datetime.now(ET):%H:%M:%S}", flush=True)
    else:
        fails += 1
        print(f"{i + 1}/{len(todo)} FAILED for {name}: {(r.stderr or r.stdout).strip()[-200:]}", flush=True)
        if fails >= 2:
            print("two failures in a row: stopping (is the WhatsApp link still connected?)", flush=True); break
    if i < len(todo) - 1:
        time.sleep(random.uniform(20, 40))
os.unlink(cap_path)
print(f"done: {len(done)} of {len(groups)} groups have today's {a.slot} post", flush=True)
