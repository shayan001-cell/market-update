#!/usr/bin/env python3
"""One-time broadcast: the OneView announcement to every signed-in user (once). Run only after the sample is approved.
   Usage: .venv/bin/python scripts/send_announcement.py --really
"""
import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market_update import db, mail, config, server

WA_GROUP = "https://chat.whatsapp.com/C4NROWURa0SI1hoegnfHOc?mode=gi_t"
marker = server.DATA_DIR / "announcement.sent"

def main() -> None:
    if "--really" not in sys.argv:
        print("dry run: add --really to send"); 
    if marker.exists():
        print("already sent on", marker.read_text().strip()); return
    site = config.PUBLIC_URL + "/#view=home"
    n = 0
    for u in db.brief_recipients():
        unsub = f"{server._api_root()}/brief/unsubscribe?t={server._sign(u['email'])}"
        subject, text, html = mail.announcement_email(u.get("name") or "", site, WA_GROUP, unsub)
        if "--really" in sys.argv:
            try:
                mail.send(u["email"], subject, text, html); n += 1; time.sleep(1.5)
            except Exception as e:  # noqa: BLE001
                print("failed", u["email"], e)
        else:
            print("would send to", u["email"])
    if "--really" in sys.argv:
        marker.write_text(f"{time.strftime('%Y-%m-%d %H:%M')} sent={n}")
        print("sent", n)

if __name__ == "__main__":
    main()
