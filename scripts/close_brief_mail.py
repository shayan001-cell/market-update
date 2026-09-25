"""Preview or send the after-the-close email for a day.

  python scripts/close_brief_mail.py 2026-09-25 --preview out.html       # render one sample (admin's watchlist)
  python scripts/close_brief_mail.py 2026-09-25 --to you@example.com     # send to one address
  python scripts/close_brief_mail.py 2026-09-25 --all                    # send to every signed-in user (writes the .mailed marker)
"""
import argparse, json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
from market_update import config, db, mail, server

ap = argparse.ArgumentParser(); ap.add_argument("day"); ap.add_argument("--preview"); ap.add_argument("--to"); ap.add_argument("--all", action="store_true"); ap.add_argument("--as", dest="as_email", default=(sorted(config.ADMIN_EMAILS) or [""])[0])
a = ap.parse_args()
b = json.loads(server._brief_file(a.day, "close").read_text())
try:
    server.state["report"] = json.loads((server.DATA_DIR / "report.json").read_text())
except Exception:
    server.state["report"] = {}
if not b.get("extras"):
    from market_update.analyze import week_and_mood
    desk = None
    try:
        desk = json.loads((server.DATA_DIR / "desk.json").read_text())
    except Exception:
        pass
    b["extras"] = week_and_mood(server.state["report"], desk)
    server._brief_file(a.day, "close").write_text(json.dumps(b, default=str))
base = os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL
site, record = base + "/#view=home&brief=1", base + "/#view=record"
from market_update.analyze import _brief_summary
b["summary"] = _brief_summary(b, "close")
def _rows(email):
    tickers = ((db.profile(email) or {}).get("tickers") or [])[:8]
    return server._watch_for_email(email, server.state["report"], server._closing_quotes(tickers))
if a.preview:
    u = db.profile(a.as_email) or {}
    subject, text, html = mail.close_email(u.get("name") or "", b, _rows(a.as_email), site, record, "#")
    Path(a.preview).write_text(html); print("subject:", subject); print("written", a.preview)
elif a.to:
    u = db.profile(a.to) or {}
    unsub = f"{server._api_root()}/brief/unsubscribe?t={server._sign(a.to)}"
    subject, text, html = mail.close_email(u.get("name") or "", b, _rows(a.to), site, record, unsub)
    print("sent via", mail.send(a.to, subject, text, html), "->", a.to)
elif a.all:
    server._mail_close(b, a.day); print("done; marker:", (server._brief_dir() / f"{a.day}-close.mailed").exists())
