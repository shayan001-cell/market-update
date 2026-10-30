"""Send the morning update email to every registered account, one at a time, so no provider sees a burst.

  .venv/bin/python scripts/send_morning_update.py --preview          # writes marketing/morning-update-preview.html, sends nothing
  .venv/bin/python scripts/send_morning_update.py --test you@x.com   # one copy to one address
  .venv/bin/python scripts/send_morning_update.py --send --start-in 300 --gap 45

Skips anyone who unsubscribed (brief_opt_out). Writes output/briefs/<day>.morning-update.sent with every address done, so
a re-run sends only to the rest. Stops at once if the mail provider pushes back.
"""
import argparse, json, re, sys, time
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
a = ap.parse_args()
report = json.loads((config.OUTPUT_DIR / "report.json").read_text())
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
if not a.send:
    sys.exit("Nothing to do: pass --preview, --test or --send.")
marker = config.OUTPUT_DIR / "briefs" / f"{data['date']}.morning-update.sent"
marker.parent.mkdir(parents=True, exist_ok=True)
done = set(json.loads(marker.read_text())) if marker.exists() else set()
people = [u for u in db.brief_recipients() if u["email"] not in done and not u["email"].startswith("zz-")]
print(f"{len(people)} to send, first in {a.start_in}s, then one every {a.gap}s (about {round((a.start_in + a.gap * max(0, len(people) - 1)) / 60)} min)", flush=True)
time.sleep(a.start_in)
for i, u in enumerate(people):
    try:
        unsub = unsub_for(u["email"])
        s, t, h = MU.email((u.get("name") or "").split(" ")[0], data, site, unsub)
        mail.send(u["email"], s, t, h, unsubscribe_url=unsub)
        done.add(u["email"]); marker.write_text(json.dumps(sorted(done)))
        print(f"{i + 1}/{len(people)} sent {time.strftime('%H:%M:%S')}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"stopped at {i + 1}: {str(e)[:160]}", flush=True); break
    if i < len(people) - 1:
        time.sleep(a.gap)
