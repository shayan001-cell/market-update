"""Send the morning update email to every registered account, one at a time, so no provider sees a burst.

  .venv/bin/python scripts/send_morning_update.py --preview          # writes marketing/morning-update-preview.html, sends nothing
  .venv/bin/python scripts/send_morning_update.py --test you@x.com   # one copy to one address
  .venv/bin/python scripts/send_morning_update.py --send --start-in 300 --gap 45
  .venv/bin/python scripts/send_morning_update.py --dry-run          # today's plan, sends nothing

Skips anyone who unsubscribed (brief_opt_out). Sends at most the warm-up cap per day (see below). Writes output/briefs/<day>.morning-update.sent with every address done, so
a re-run sends only to the rest. Stops at once if the mail provider pushes back.
"""
import argparse, json, random, re, sys, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv
load_dotenv(ROOT / ".env")
from market_update import config, db, mail, morning_update as MU
from market_update.server import _api_root, _sign

ap = argparse.ArgumentParser()
ap.add_argument("--preview", action="store_true"); ap.add_argument("--test"); ap.add_argument("--send", action="store_true")
ap.add_argument("--start-in", type=int, default=300); ap.add_argument("--gap", type=int, default=45)
ap.add_argument("--max", type=int, help="override today's warm-up cap")
ap.add_argument("--jitter", type=int, default=10, help="random extra seconds on top of --gap")
ap.add_argument("--dry-run", action="store_true", help="print who would get it today and stop")
a = ap.parse_args()
REPORT = config.OUTPUT_DIR / "report.json"
if a.send:
    # automatic runs (launchd, weekdays 08:00 ET): only on a trading day, only before the open, only from a fresh report
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    from market_update.ai_budget import is_trading_day
    ET = ZoneInfo("America/New_York")
    now = datetime.now(ET)
    if not is_trading_day(now.date()):
        sys.exit(f"{now:%a %Y-%m-%d}: market closed today, no morning email")
    def fresh() -> bool:
        try: built = datetime.fromisoformat(json.loads(REPORT.read_text())["generated_at"]).astimezone(ET)
        except Exception: return False  # noqa: BLE001
        return datetime.now(ET) - built < timedelta(hours=3)
    for _ in range(30):
        if fresh(): break
        print("report is older than 3 hours; waiting for the morning build", flush=True); time.sleep(60)
    if not fresh():
        sys.exit("no fresh report by now: skipping today's email rather than sending old news")
    if datetime.now(ET).time() >= datetime.strptime("09:30", "%H:%M").time():
        sys.exit("past 09:30 ET (the Mac was probably asleep at 08:00): skipping today's email")
report = json.loads(REPORT.read_text())
data = MU.build(report)
site = (__import__("os").environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL) + "/"
unsub_for = lambda email: f"{_api_root()}/brief/unsubscribe?t={_sign(email)}"
if a.preview:
    s, t, h = MU.email("", data, site, "#unsubscribe")
    h = re.sub(r'src="cid:[^"]+"', 'src="../market_update/static/brand/oneview-logo-email.png"', h)
    (ROOT / "marketing" / "morning-update-preview.html").write_text(h); print("preview written:", s); sys.exit()
if not mail.status().get("configured"):
    sys.exit("No mail service is configured.")
if a.test:
    s, t, h = MU.email("", data, site, unsub_for(a.test)); mail.send(a.test, s, t, h, unsubscribe_url=unsub_for(a.test)); print("sent test to", a.test); sys.exit()
if not (a.send or a.dry_run):
    sys.exit("Nothing to do: pass --preview, --test or --send.")
marker = config.OUTPUT_DIR / "briefs" / f"{data['date']}.morning-update.sent"
marker.parent.mkdir(parents=True, exist_ok=True)
done = set(json.loads(marker.read_text())) if marker.exists() else set()

# Sender reputation guard. A new sender that jumps to a full list gets blocked (Zoho did, 2026-10-30), so:
#   warm-up: the daily cap starts at 20 and grows by 20 after each clean day; a refusal halves it
#   pacing:  --gap plus up to --jitter seconds between emails, never a fixed beat
#   one refusal stops the run; the cap for tomorrow is halved and the reason is kept
#   only real-looking addresses; most recently active members first
WARM = config.OUTPUT_DIR / "briefs" / "sender-warmup.json"
warm = json.loads(WARM.read_text()) if WARM.exists() else {"cap": 20, "step": 20, "last_day": None, "last_result": None}
if warm.get("last_day") and warm["last_day"] != data["date"] and warm.get("last_result") == "clean":
    warm["cap"] = warm["cap"] + warm["step"]
cap = a.max if a.max is not None else warm["cap"]
ok_addr = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)
skip_domains = ("example.com", "example.org", "test.com", "mailinator.com")
people = [u for u in db.brief_recipients() if u["email"] not in done and not u["email"].startswith("zz-")
          and ok_addr.match(u["email"]) and not u["email"].lower().endswith(skip_domains)]
already_today = len(done)
room = max(0, cap - already_today)
batch = people[:room]
print(f"{len(people)} waiting, cap today {cap} (already sent {already_today}), sending {len(batch)}; first in {a.start_in}s, "
      f"then every {a.gap}-{a.gap + a.jitter}s (about {round((a.start_in + (a.gap + a.jitter / 2) * max(0, len(batch) - 1)) / 60)} min)", flush=True)
if not batch or a.dry_run:
    sys.exit()
time.sleep(a.start_in)
result = "clean"
for i, u in enumerate(batch):
    try:
        unsub = unsub_for(u["email"])
        s, t, h = MU.email((u.get("name") or "").split(" ")[0], data, site, unsub)
        mail.send(u["email"], s, t, h, unsubscribe_url=unsub)
        done.add(u["email"]); marker.write_text(json.dumps(sorted(done)))
        print(f"{i + 1}/{len(batch)} sent {time.strftime('%H:%M:%S')}", flush=True)
    except Exception as e:  # noqa: BLE001
        result = f"refused: {str(e)[:200]}"
        warm["cap"] = max(10, warm["cap"] // 2)
        print(f"stopped at {i + 1}: {str(e)[:160]}", flush=True)
        break
    if i < len(batch) - 1:
        time.sleep(a.gap + random.uniform(0, a.jitter))
warm.update(last_day=data["date"], last_result=result, last_sent=len(done))
WARM.write_text(json.dumps(warm, indent=2))
print(f"done: {len(done)} sent today, result {result}, cap next time {warm['cap'] + (warm['step'] if result == 'clean' else 0)}", flush=True)
