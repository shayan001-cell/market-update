"""Outbound email for sign-in links.

One of three transports, picked from the environment (or a `.env` file next to the
project, loaded by config):

    MU_RESEND_API_KEY      Resend (https://resend.com): HTTPS API, one key, no SMTP
    MU_SENDGRID_API_KEY    SendGrid v3 API
    MU_SMTP_HOST + MU_SMTP_PORT + MU_SMTP_USER + MU_SMTP_PASS
                           Any SMTP server with STARTTLS: Gmail (smtp.gmail.com:587 with an
                           app password), Outlook/Microsoft 365 (smtp.office365.com:587),
                           hosted mailboxes, Amazon SES, etc.

    MU_MAIL_FROM           the sender, e.g. "OneView <alerts@yourdomain.com>"
                           (defaults to MU_SMTP_USER)
"""
from __future__ import annotations

import logging
import html as html_mod
import os
from datetime import datetime
import smtplib
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

import requests

from . import config

log = logging.getLogger("market_update.mail")
SENDER_NAME = os.environ.get("MU_MAIL_SENDER_NAME", "OneView")     # the display name people see in their inbox


def _from() -> tuple[str, str]:
    raw = os.environ.get("MU_MAIL_FROM") or os.environ.get("MU_SMTP_FROM") or ""
    name, addr = parseaddr(raw)
    if not addr or "YOUR-ADDRESS" in addr:            # unfilled template: send as the SMTP login itself
        addr = os.environ.get("MU_SMTP_USER", "")
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
    placeholder = "YOUR-ADDRESS" in addr or os.environ.get("MU_SMTP_PASS", "").startswith("xxxx")
    ok = bool(p and addr) and not placeholder
    return {"configured": ok, "provider": p, "transport": label, "from_name": name, "from_address": addr,
            "problem": None if ok else ("the .env file still has the placeholder address or app password" if placeholder
                                        else "MU_MAIL_FROM (or MU_SMTP_USER) is not set" if p else "no mail transport is configured")}


def signin_email(link: str, minutes: int) -> tuple[str, str, str]:
    """(subject, text, html) for a sign-in link, branded gold-on-black."""
    subject = "Your OneView sign-in link"
    text = (f"Sign in to OneView\n\nOpen this link within {minutes} minutes to sign in:\n{link}\n\n"
            f"The link works once. If it has expired, opening it sends you a fresh one.\n"
            f"If you did not request this, you can ignore this email.\n")
    html = f"""<!doctype html><html><body style="margin:0;padding:0;background:#050505;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#E6EAF2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#0B0F17;border:1px solid #262B36;border-radius:20px">
<tr><td style="padding:32px 32px 8px">
  <div style="font-size:11px;letter-spacing:.28em;color:#85A7FF;font-weight:700">ONEVIEW</div>
  <div style="font-size:20px;font-weight:800;color:#F2F4F8;margin-top:2px">MARKET UPDATE</div>
</td></tr>
<tr><td style="padding:16px 32px 0">
  <div style="display:inline-block;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#9CA3AF;border:1px solid #262B36;border-radius:999px;padding:4px 10px">Passwordless access</div>
  <h1 style="margin:14px 0 8px;font-size:24px;line-height:1.15;color:#F2F4F8">Your sign-in link</h1>
  <p style="margin:0;font-size:15px;line-height:1.6;color:#A3ADBF">Open the button below within <b style="color:#F2F4F8">{minutes} minutes</b>. It works once and signs you in on the device you open it on. Your session then stays active until you sign out.</p>
</td></tr>
<tr><td style="padding:24px 32px">
  <a href="{link}" style="display:inline-block;background:#245BFF;background-color:#245BFF;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:999px">Sign in to Market Update &nbsp;&rarr;</a>
</td></tr>
<tr><td style="padding:0 32px 32px">
  <p style="margin:0;font-size:12.5px;line-height:1.6;color:#6B7280">If the button does not work, paste this into your browser:<br><a href="{link}" style="color:#85A7FF;word-break:break-all">{link}</a></p>
  <p style="margin:12px 0 0;font-size:12.5px;line-height:1.6;color:#6B7280">If the link has expired, opening it sends you a fresh one. If you did not request this, ignore this email. Nothing on OneView is financial advice.</p>
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


def _fmt_pct(x: Any) -> str:
    return "–" if not isinstance(x, (int, float)) else f"{'+' if x >= 0 else '−'}{abs(x):.1f}%"


def _fmt_num(x: Any, nd: int = 2) -> str:
    return "–" if not isinstance(x, (int, float)) else f"{x:,.{nd}f}"


def brief_email(name: str, brief: dict[str, Any], watch: list[dict[str, Any]], site_url: str, unsubscribe_url: str) -> tuple[str, str, str]:
    """Short, professional morning email: the summary, the numbers, SPY/QQQ 1-hour reads, the reader's own names, one link."""
    date_label = datetime.strptime(brief["date"], "%Y-%m-%d").strftime("%A, %B %d")
    first = (brief.get("summary") or "").split(". ")[0].rstrip(".")
    subject = f"OneView briefing · {date_label}" + (f" · {first}" if first and len(first) < 60 else "")
    tape = {x["symbol"]: x for x in brief.get("tape", [])}
    y = brief.get("yields") or {}
    rows = [("S&P 500 futures", _fmt_pct((tape.get("ES=F") or {}).get("chg_pct"))), ("Nasdaq 100 futures", _fmt_pct((tape.get("NQ=F") or {}).get("chg_pct"))),
            ("Oil", _fmt_pct((tape.get("CL=F") or {}).get("chg_pct"))), ("Gold", _fmt_pct((tape.get("GC=F") or {}).get("chg_pct"))), ("Bitcoin", _fmt_pct((tape.get("BTC-USD") or {}).get("chg_pct"))),
            ("10-year yield", f"{_fmt_num(y.get('10y'))}%"), ("5-year yield", f"{_fmt_num(y.get('5y'))}%"), ("VIX", _fmt_num((tape.get("^VIX") or {}).get("last"), 1))]
    words = {"push_higher": "pointing higher", "pullback_then_higher": "stretched; a dip toward the 20-bar average is likelier first", "range_bound": "range-bound between support and resistance",
             "break_lower": "at risk of breaking lower", "rebound": "set up for a rebound off support"}
    idx_lines = []
    for sym in ("SPY", "QQQ"):
        x = (brief.get("indexes") or {}).get(sym) or {}
        a = (x.get("ai") or {}).get("next_move")
        if a:
            idx_lines.append(f"{sym} at {_fmt_num(x.get('last'))}: {words.get(a['choice'], a['choice'])} (1-hour RSI {_fmt_num(x.get('rsi_1h'), 0)}, support {_fmt_num(x.get('nearest_support'))}, resistance {_fmt_num(x.get('nearest_resistance'))}).")
    ev = [f"{c.get('time_et', '')} {c.get('title', '')}".strip() for c in brief.get("events", [])[:3]]
    trump = brief.get("trump") or []
    text_lines = [f"Good morning{', ' + name if name else ''}.", "", brief.get("summary", ""), "", "Numbers to know:"] + [f"  {k}: {v}" for k, v in rows]
    if idx_lines:
        text_lines += ["", "SPY and QQQ on the 1-hour chart:"] + [f"  {l}" for l in idx_lines]
    if watch:
        text_lines += ["", "Your watchlist:"] + [f"  {w['ticker']}: {_fmt_num(w.get('last'))} ({_fmt_pct(w.get('chg_pct'))}) · {w.get('read') or 'no read yet'}" + (f" · {w['why']}" if w.get('why') else "") for w in watch]
    if ev:
        text_lines += ["", "Today:"] + [f"  {e}" for e in ev]
    if trump:
        text_lines += ["", f"{len(trump)} market-relevant post{'s' if len(trump) > 1 else ''} from the President overnight; details on the desk."]
    text_lines += ["", f"Open today's briefing: {site_url}", "", "OneView is information, not advice. You receive this because you signed in to OneView.", f"Stop these emails: {unsubscribe_url}"]
    text = "\n".join(text_lines)
    e = lambda x: html_mod.escape(str(x))
    num_rows = "".join(f'<tr><td style="padding:6px 0;color:#5B6478;font-size:13px">{e(k)}</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#0A1220;font-variant-numeric:tabular-nums">{e(v)}</td></tr>' for k, v in rows)
    watch_rows = "".join(f'<tr><td style="padding:7px 0;border-top:1px solid #E6E9F0"><b>{e(w["ticker"])}</b> <span style="color:#5B6478;font-size:12px">{e((w.get("name") or "")[:28])}</span></td><td style="padding:7px 0;border-top:1px solid #E6E9F0;text-align:right;font-variant-numeric:tabular-nums">{e(_fmt_num(w.get("last")))} <span style="color:{"#0F8F5F" if isinstance(w.get("chg_pct"), (int, float)) and w["chg_pct"] >= 0 else "#C43B4E"}">{e(_fmt_pct(w.get("chg_pct")))}</span></td><td style="padding:7px 0 7px 12px;border-top:1px solid #E6E9F0;font-size:12.5px"><b>{e(w.get("read") or "no read yet")}</b>{(" · " + e(w["why"])) if w.get("why") else ""}</td></tr>' for w in watch)
    html = f"""<!doctype html><html><body style="margin:0;background:#F3F5F9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#0A1220">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 16px">
<table role="presentation" width="560" style="max-width:560px;background:#fff;border:1px solid #E6E9F0;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 28px 8px">
  <div style="font-size:12px;letter-spacing:.14em;color:#245BFF;font-weight:700">ONEVIEW · MORNING BRIEFING</div>
  <h1 style="margin:10px 0 4px;font-size:22px;letter-spacing:-.02em">{e(date_label)}</h1>
  <p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#5B6478">Good morning{(", " + e(name)) if name else ""}. Here is what matters before the open, in three minutes.</p>
  <p style="margin:0 0 18px;font-size:15px;line-height:1.55">{e(brief.get("summary", ""))}</p>
  <h2 style="margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#5B6478">NUMBERS TO KNOW</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{num_rows}</table>
  {"<h2 style='margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#5B6478'>SPY AND QQQ, 1-HOUR CHART</h2>" + "".join(f"<p style='margin:0 0 6px;font-size:14px;line-height:1.5'>{e(l)}</p>" for l in idx_lines) if idx_lines else ""}
  {"<h2 style='margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#5B6478'>YOUR WATCHLIST</h2><table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='font-size:14px'>" + watch_rows + "</table>" if watch else "<p style='margin:18px 0 0;font-size:13px;color:#5B6478'>Add names to your watchlist on the desk and they will appear here with their reads.</p>"}
  {"<h2 style='margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#5B6478'>TODAY</h2>" + "".join(f"<div style='font-size:13.5px;line-height:1.5'>{e(x)}</div>" for x in ev) if ev else ""}
  {f"<p style='margin:14px 0 0;font-size:13.5px;line-height:1.5'><b>{len(trump)} market-relevant post{'s' if len(trump) > 1 else ''} from the President overnight.</b> The read on each is on the desk.</p>" if trump else ""}
  <p style="margin:22px 0 6px"><a href="{e(site_url)}" style="display:inline-block;background:#245BFF;color:#fff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:8px;font-size:15px">Open today's briefing</a></p>
  <p style="margin:0 0 4px;font-size:12.5px;line-height:1.55;color:#5B6478">Why this lands at 7:00: the overnight tape, the yields and the first posts of the day set the tone before the open. Five minutes on the desk now saves a rushed decision at 9:31.</p>
  <p style="margin:18px 0 0;font-size:11.5px;line-height:1.6;color:#8A93A6">OneView is information, not advice. Reads come from public data and textbook technicals, never a guarantee. You receive this because you signed in to OneView. <a href="{e(unsubscribe_url)}" style="color:#8A93A6">Stop these emails</a>.</p>
</td></tr></table></td></tr></table></body></html>"""
    return subject, text, html


def announcement_email(name: str, site_url: str, group_url: str, unsubscribe_url: str) -> tuple[str, str, str]:
    """One-time announcement: Webex Traders is now OneView. Bold, colourful, still professional."""
    e = lambda x: html_mod.escape(str(x))
    hi = f"Hi {e(name)}," if name else "Hi,"
    subject = "Webex Traders is now OneView: your desk just got a serious upgrade"
    changes = [
        ("Three briefings a day", "07:00 morning briefing, 13:00 midday check, 16:30 after the close. Futures, oil, gold, bitcoin, the 10- and 5-year yields, the mega caps, and a possible next move for SPY and QQQ from the 1-hour chart."),
        ("A briefing in your inbox", "Every morning at 7:00, short and personal: the numbers, the reads on the names you follow, one link to the desk."),
        ("Reads in plain words", "Every name gets a verdict with two to four reasons and a LOW, MED or HIGH conviction. No percentages, no jargon."),
        ("Where the big money is moving", "SPY, QQQ, DIA and IWM activity against normal, the largest companies trading unusually heavily, and the groups leading or lagging."),
        ("Voices moving the tape", "The President's market-relevant posts, read once each, and where the Reddit crowd is piling in."),
        ("Only news that can move prices", "Every headline is read once; the noise is dropped before you see it."),
        ("A public track record", "Every verdict is logged with its price and scored later. The desk keeps itself honest."),
        ("Day, swing or long term", "One switch changes the analysis horizon on your watchlist and the stocks table."),
    ]
    text = "\n".join([hi, "", "Webex Traders is now OneView: same team, new name, and a rebuilt desk.", "", "What changed:"] + [f"- {t}: {d}" for t, d in changes] +
                      ["", f"Open OneView: {site_url}", f"Join the OneView WhatsApp group: {group_url}", "", "OneView is information, not advice.", f"Stop these emails: {unsubscribe_url}"])
    cards = "".join(f"""<tr><td style="padding:0 0 10px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:14px;overflow:hidden;background:#101A2B;border:1px solid #29364C"><tr>
      <td style="width:6px;background:{c}"></td><td style="padding:14px 16px"><div style="font-size:15px;font-weight:800;color:#F5F7FC;letter-spacing:-.01em">{e(t)}</div><div style="font-size:13.5px;line-height:1.5;color:#A8B4C8;margin-top:4px">{e(d)}</div></td></tr></table></td></tr>"""
                    for (t, d), c in zip(changes, ["#245BFF", "#66D9A6", "#E8BD68", "#FF8F9B", "#85A7FF", "#66D9A6", "#245BFF", "#E8BD68"]))
    html = f"""<!doctype html><html><body style="margin:0;background:#080E1D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#F5F7FC">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080E1D"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="600" style="max-width:600px" cellpadding="0" cellspacing="0">
<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:18px;overflow:hidden;background:linear-gradient(135deg,#245BFF 0%,#1747D1 45%,#0B1220 100%);background-color:#245BFF"><tr><td style="padding:34px 30px">
  <div style="display:inline-block;background:#FFD66B;color:#0A1220;font-size:11px;font-weight:800;letter-spacing:.16em;padding:6px 10px;border-radius:999px">NEW NAME · NEW DESK</div>
  <h1 style="margin:16px 0 8px;font-size:34px;line-height:1.05;letter-spacing:-.04em;color:#FFFFFF">Webex Traders is now <span style="color:#FFD66B">OneView</span>.</h1>
  <p style="margin:0;font-size:16px;line-height:1.55;color:#DCE6FF">{hi} same team, sharper tools. Read the market in one glance, then own your next move.</p>
  <p style="margin:22px 0 0"><a href="{e(site_url)}" style="display:inline-block;background:#FFFFFF;color:#0A1220;text-decoration:none;font-weight:800;padding:13px 22px;border-radius:10px;font-size:15px">Open OneView →</a></p>
</td></tr></table></td></tr>
<tr><td style="padding:6px 4px 12px"><div style="font-size:12px;letter-spacing:.16em;color:#85A7FF;font-weight:800">WHAT CHANGED, AND WHY IT HELPS</div></td></tr>
{cards}
<tr><td style="padding:8px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:14px;overflow:hidden;background:#12332A;border:1px solid #1F5A46"><tr><td style="padding:16px 18px">
  <div style="font-size:15px;font-weight:800;color:#66D9A6">Same crew, one group</div>
  <div style="font-size:13.5px;line-height:1.5;color:#CFE9DD;margin-top:4px">The team's moves, posted as they happen, live in the OneView WhatsApp group.</div>
  <p style="margin:12px 0 0"><a href="{e(group_url)}" style="display:inline-block;background:#25D366;color:#06110B;text-decoration:none;font-weight:800;padding:11px 18px;border-radius:10px;font-size:14px">Join the group</a></p>
</td></tr></table></td></tr>
<tr><td style="padding:22px 4px 0"><p style="margin:0;font-size:13px;line-height:1.6;color:#A8B4C8">Your sign-in and your watchlists carry over. Nothing to set up: open the desk, sign in with your email, and your names are there.</p>
<p style="margin:14px 0 0;font-size:11.5px;line-height:1.6;color:#6B7690">OneView is information, not advice. Reads come from public data and typed questions to a model; nothing here is a recommendation or a guarantee. You receive this because you signed in to the desk. <a href="{e(unsubscribe_url)}" style="color:#6B7690">Stop these emails</a>.</p></td></tr>
</table></td></tr></table></body></html>"""
    return subject, text, html
