"""One-time sign-in of the OneView Outlook account for sending mail (device code).

  python scripts/outlook_signin.py        # prints a code; open microsoft.com/devicelogin, enter it, sign in as the OneView account
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parents[1] / ".env")
from market_update import mail
print(mail.ms_signin())
