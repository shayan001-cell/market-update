"""Outbound email for sign-in links.

One of three transports, picked from the environment (or a `.env` file next to the
project, loaded by config):

    MU_RESEND_API_KEY      Resend (https://resend.com): HTTPS API, one key, no SMTP
    MU_SENDGRID_API_KEY    SendGrid v3 API
    MU_SMTP_HOST + MU_SMTP_PORT + MU_SMTP_USER + MU_SMTP_PASS
                           Any SMTP server with STARTTLS: Gmail (smtp.gmail.com:587 with an
                           app password), Outlook/Microsoft 365 (smtp.office365.com:587),
                           Webex-hosted mailboxes, Amazon SES, etc.

    MU_MAIL_FROM           the sender, e.g. "Webex Market Update <alerts@yourdomain.com>"
                           (defaults to MU_SMTP_USER)
"""
from __future__ import annotations

import logging
import os
import smtplib
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

import requests

from . import config

log = logging.getLogger("market_update.mail")
SENDER_NAME = config.SITE_NAME


def _from() -> tuple[str, str]:
    raw = os.environ.get("MU_MAIL_FROM") or os.environ.get("MU_SMTP_FROM") or os.environ.get("MU_SMTP_USER") or ""
    name, addr = parseaddr(raw)
    return (name or SENDER_NAME, addr)


def provider() -> str | None:
    if os.environ.get("MU_RESEND_API_KEY"):
        return "resend"
    if os.environ.get("MU_SENDGRID_API_KEY"):
        return "sendgrid"
    if os.environ.get("MU_SMTP_HOST"):
        return "smtp"
    return None


def status() -> dict[str, object]:
    name, addr = _from()
    p = provider()
    host = os.environ.get("MU_SMTP_HOST", "")
    label = {"resend": "Resend API", "sendgrid": "SendGrid API", "smtp": f"SMTP via {host}"}.get(p or "", "not configured")
    return {"configured": bool(p and addr), "provider": p, "transport": label, "from_name": name, "from_address": addr,
            "problem": None if (p and addr) else ("MU_MAIL_FROM (or MU_SMTP_USER) is not set" if p else "no mail transport is configured")}


def signin_email(link: str, minutes: int) -> tuple[str, str, str]:
    """(subject, text, html) for a sign-in link, branded gold-on-black."""
    subject = f"Your {SENDER_NAME} sign-in link"
    text = (f"Sign in to {SENDER_NAME}\n\nOpen this link within {minutes} minutes to sign in:\n{link}\n\n"
            f"The link works once. If it has expired, opening it sends you a fresh one.\n"
            f"If you did not request this, you can ignore this email.\n")
    html = f"""<!doctype html><html><body style="margin:0;padding:0;background:#050505;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#E6EAF2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0B0F17;border:1px solid #262B36;border-radius:20px">
<tr><td style="padding:32px 32px 8px">
  <div style="font-size:11px;letter-spacing:.28em;color:#F5C542;font-weight:700">WEBEX</div>
  <div style="font-size:20px;font-weight:800;color:#F2F4F8;margin-top:2px">MARKET UPDATE</div>
</td></tr>
<tr><td style="padding:16px 32px 0">
  <div style="display:inline-block;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9CA3AF;border:1px solid #262B36;border-radius:999px;padding:4px 10px">Passwordless access</div>
  <h1 style="margin:14px 0 8px;font-size:24px;line-height:1.15;color:#F2F4F8">Your sign-in link</h1>
  <p style="margin:0;font-size:15px;line-height:1.6;color:#A3ADBF">Open the button below within <b style="color:#F2F4F8">{minutes} minutes</b>. It works once and signs you in on the device you open it on. Your session then stays active until you sign out.</p>
</td></tr>
<tr><td style="padding:24px 32px">
  <a href="{link}" style="display:inline-block;background:linear-gradient(90deg,#FFE38A,#F5C542 55%,#B8860B);background-color:#F5C542;color:#050505;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px">Sign in to {SENDER_NAME} &nbsp;&rarr;</a>
</td></tr>
<tr><td style="padding:0 32px 32px">
  <p style="margin:0;font-size:12.5px;line-height:1.6;color:#6B7280">If the button does not work, paste this into your browser:<br><a href="{link}" style="color:#F5C542;word-break:break-all">{link}</a></p>
  <p style="margin:12px 0 0;font-size:12.5px;line-height:1.6;color:#6B7280">If the link has expired, opening it sends you a fresh one. If you did not request this, ignore this email. Nothing on {SENDER_NAME} is financial advice.</p>
</td></tr></table></td></tr></table></body></html>"""
    return subject, text, html


def send(to: str, subject: str, text: str, html: str | None = None) -> str:
    """Send one message. Returns the transport used; raises on failure or when unconfigured."""
    p = provider()
    name, addr = _from()
    if not p:
        raise RuntimeError("no mail transport configured (set MU_RESEND_API_KEY, MU_SENDGRID_API_KEY or MU_SMTP_*)")
    if not addr:
        raise RuntimeError("MU_MAIL_FROM is not set")
    sender = formataddr((name, addr))
    if p == "resend":
        r = requests.post("https://api.resend.com/emails", timeout=20,
                          headers={"Authorization": f"Bearer {os.environ['MU_RESEND_API_KEY']}", "Content-Type": "application/json"},
                          json={"from": sender, "to": [to], "subject": subject, "text": text, "html": html or text})
        if r.status_code >= 300:
            raise RuntimeError(f"Resend {r.status_code}: {r.text[:200]}")
        return p
    if p == "sendgrid":
        r = requests.post("https://api.sendgrid.com/v3/mail/send", timeout=20,
                          headers={"Authorization": f"Bearer {os.environ['MU_SENDGRID_API_KEY']}", "Content-Type": "application/json"},
                          json={"personalizations": [{"to": [{"email": to}]}], "from": {"email": addr, "name": name}, "subject": subject,
                                "content": [{"type": "text/plain", "value": text}] + ([{"type": "text/html", "value": html}] if html else [])})
        if r.status_code >= 300:
            raise RuntimeError(f"SendGrid {r.status_code}: {r.text[:200]}")
        return p
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, sender, to
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    host, port = os.environ["MU_SMTP_HOST"], int(os.environ.get("MU_SMTP_PORT", "587"))
    user, pw = os.environ.get("MU_SMTP_USER"), os.environ.get("MU_SMTP_PASS", "")
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=25) as smtp:
            if user:
                smtp.login(user, pw)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=25) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.ehlo()
            if user:
                smtp.login(user, pw)
            smtp.send_message(msg)
    return p
