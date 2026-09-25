"""Preview or post the after-the-close WhatsApp summary.
  python scripts/whatsapp_close.py 2026-09-25            # print the text
  python scripts/whatsapp_close.py 2026-09-25 --post     # post to the MU_WA_GROUP group through the linked account
"""
import argparse, json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
from market_update import config, server
from market_update.analyze import close_whatsapp_text
ap = argparse.ArgumentParser(); ap.add_argument("day"); ap.add_argument("--post", action="store_true"); a = ap.parse_args()
b = json.loads(server._brief_file(a.day, "close").read_text())
base = os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL
text = close_whatsapp_text(b, keep_url=f"{server._api_root()}/keep-in-inbox", site_url=base)
print(text)
if a.post:
    (server._brief_dir() / f"{a.day}-close.whatsapp").unlink(missing_ok=True)
    server._post_whatsapp(b, a.day)
    print("posted:", (server._brief_dir() / f"{a.day}-close.whatsapp").exists())
