"""Print a one-time admin sign-in link. Nothing is emailed.

Email-only sign-in never gives admin rights, so the owner signs in as admin with this instead. It runs only on the
machine that hosts the server, so only someone with access to that Mac can make one.

  .venv/bin/python scripts/admin_link.py                 # link for the first admin email
  .venv/bin/python scripts/admin_link.py you@example.com # a specific admin email

Open the link in a browser on this Mac within 10 minutes. It works once, then sends you to the public site signed in
as admin (verified session).
"""
import secrets, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
from market_update import config, db

MINUTES = 10
email = (sys.argv[1] if len(sys.argv) > 1 else (sorted(config.ADMIN_EMAILS) or [""])[0]).strip().lower()
if email not in config.ADMIN_EMAILS:
    sys.exit(f"{email or '(none)'} is not an admin email (MU_ADMIN_EMAILS).")
token = secrets.token_urlsafe(32)
db.create_token(token, email, MINUTES * 60)
db.log_activity(email, "admin_link", "made on the server machine")
print(f"Admin sign-in link for {email} (works once, valid {MINUTES} minutes):")
print(f"http://127.0.0.1:8000/auth/verify?token={token}")
