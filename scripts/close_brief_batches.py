"""Send the after-the-close email to everyone still waiting, in small batches with pauses (for providers that throttle).

  python scripts/close_brief_batches.py 2026-09-25 --batch 4 --wait 300 --wait-throttle 900
"""
import argparse, json, os, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
from market_update import config, db, mail, server

ap = argparse.ArgumentParser(); ap.add_argument("day"); ap.add_argument("--batch", type=int, default=4); ap.add_argument("--wait", type=int, default=300); ap.add_argument("--wait-throttle", type=int, default=900)
a = ap.parse_args()
b = json.loads(server._brief_file(a.day, "close").read_text())
server.state["report"] = json.loads((server.DATA_DIR / "report.json").read_text())
marker = server._brief_dir() / f"{a.day}-close.mailed"
data = json.loads(marker.read_text()) if marker.exists() and marker.read_text().strip().startswith("{") else {"sent": []}
done = set(data.get("sent", []))
base = os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL
site, record = base + "/#view=home&brief=1", base + "/#view=record"
def save(throttled=False, manual=True):
    total = len(db.brief_recipients())
    marker.write_text(json.dumps({"sent": sorted(done), "remaining": total - len(done), "throttled": throttled, "manual": manual}))
save()
while True:
    remaining = [u for u in db.brief_recipients() if u["email"] not in done]
    if not remaining:
        break
    batch = remaining[: a.batch]
    tickers = sorted({t for u in batch for t in ((db.profile(u["email"]) or {}).get("tickers") or [])[:8]})
    closing = server._closing_quotes(tickers)
    throttled = False
    for u in batch:
        try:
            unsub = f"{server._api_root()}/brief/unsubscribe?t={server._sign(u['email'])}"
            subject, text, html = mail.close_email(u.get("name") or "", b, server._watch_for_email(u["email"], server.state["report"], closing), site, record, unsub)
            mail.send(u["email"], subject, text, html, unsubscribe_url=unsub)
            done.add(u["email"]); print(time.strftime("%H:%M:%S"), "sent ->", u["email"], flush=True)
            time.sleep(2)
        except Exception as e:
            msg = str(e); print(time.strftime("%H:%M:%S"), "failed ->", u["email"], msg[:120], flush=True)
            if "Unusual sending activity" in msg or "5.4.6" in msg:
                throttled = True; break
    save(throttled)
    left = len(db.brief_recipients()) - len(done)
    print(time.strftime("%H:%M:%S"), f"{len(done)} done, {left} remaining", flush=True)
    if not left:
        break
    time.sleep(a.wait_throttle if throttled else a.wait)
save(False, manual=False)
print(time.strftime("%H:%M:%S"), "finished:", len(done), "sent in total", flush=True)
