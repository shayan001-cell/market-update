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
    html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head><body style="margin:0;padding:0;background:#050505;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#E6EAF2">
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


LOGO_CID = "oneview-logo"
LOGO_PATH = config.STATIC_DIR / "brand" / "oneview-logo-email.png"


def logo_url() -> str:
    """Hosted copy of the email logo, used by API providers and as the fallback for clients that skip inline images."""
    return (os.environ.get("MU_SITE_URL", "").rstrip("/") or config.PUBLIC_URL).rstrip("/") + "/static/brand/oneview-logo-email.png"


def logo_img(width: int = 150) -> str:
    return f'<img src="cid:{LOGO_CID}" width="{width}" alt="OneView" style="display:block;width:{width}px;height:auto;border:0;outline:none">'


def send(to: str, subject: str, text: str, html: str | None = None, unsubscribe_url: str | None = None) -> str:
    """Send one message. Returns the transport used; raises on failure or when unconfigured.
    `unsubscribe_url` adds the List-Unsubscribe headers that Gmail and Outlook use for inbox placement."""
    p = provider()
    name, addr = _from()
    extra = {"List-Unsubscribe": f"<{unsubscribe_url}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"} if unsubscribe_url else {}
    if not p:
        raise RuntimeError("no mail transport configured (set MU_RESEND_API_KEY, MU_SENDGRID_API_KEY or MU_SMTP_*)")
    if not addr:
        raise RuntimeError("MU_MAIL_FROM is not set")
    sender = formataddr((name, addr))
    if html and p in ("resend", "sendgrid"):
        html = html.replace(f"cid:{LOGO_CID}", logo_url())
    if p == "resend":
        r = requests.post("https://api.resend.com/emails", timeout=20,
                          headers={"Authorization": f"Bearer {os.environ['MU_RESEND_API_KEY']}", "Content-Type": "application/json"},
                          json={"from": sender, "to": [to], "subject": subject, "text": text, "html": html or text, "headers": extra})
        if r.status_code >= 300:
            raise RuntimeError(f"Resend {r.status_code}: {r.text[:200]}")
        return p
    if p == "sendgrid":
        r = requests.post("https://api.sendgrid.com/v3/mail/send", timeout=20,
                          headers={"Authorization": f"Bearer {os.environ['MU_SENDGRID_API_KEY']}", "Content-Type": "application/json"},
                          json={"personalizations": [{"to": [{"email": to}]}], "from": {"email": addr, "name": name}, "subject": subject, "headers": extra,
                                "content": [{"type": "text/plain", "value": text}] + ([{"type": "text/html", "value": html}] if html else [])})
        if r.status_code >= 300:
            raise RuntimeError(f"SendGrid {r.status_code}: {r.text[:200]}")
        return p
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, sender, to
    for k, v in extra.items():
        msg[k] = v
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
        if f"cid:{LOGO_CID}" in html and LOGO_PATH.exists():
            msg.get_payload()[1].add_related(LOGO_PATH.read_bytes(), maintype="image", subtype="png", cid=f"<{LOGO_CID}>", filename="oneview-logo.png")
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
    num_rows = "".join(f'<tr><td style="padding:6px 0;color:#A8B4C8;font-size:13px">{e(k)}</td><td style="padding:6px 0;text-align:right;font-size:13px;font-weight:600;color:#F5F7FC;font-variant-numeric:tabular-nums">{e(v)}</td></tr>' for k, v in rows)
    watch_rows = "".join(f'<tr><td style="padding:7px 0;border-top:1px solid #29364C"><b>{e(w["ticker"])}</b> <span style="color:#A8B4C8;font-size:12px">{e((w.get("name") or "")[:28])}</span></td><td style="padding:7px 0;border-top:1px solid #29364C;text-align:right;font-variant-numeric:tabular-nums">{e(_fmt_num(w.get("last")))} <span style="color:{"#66D9A6" if isinstance(w.get("chg_pct"), (int, float)) and w["chg_pct"] >= 0 else "#FF8F9B"}">{e(_fmt_pct(w.get("chg_pct")))}</span></td><td style="padding:7px 0 7px 12px;border-top:1px solid #29364C;font-size:12.5px"><b>{e(w.get("read") or "no read yet")}</b>{(" · " + e(w["why"])) if w.get("why") else ""}</td></tr>' for w in watch)
    html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head><body style="margin:0;background:#080E1D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#F5F7FC">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#080E1D" style="padding:28px 16px;background:#080E1D">
<table role="presentation" width="560" style="max-width:560px;background:#101A2B;border:1px solid #29364C;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px 28px 8px">
  {logo_img(150)}
  <div style="margin-top:12px;font-size:12px;letter-spacing:.14em;color:#85A7FF;font-weight:700">ONEVIEW · MORNING BRIEFING</div>
  <h1 style="margin:10px 0 4px;font-size:22px;letter-spacing:-.02em">{e(date_label)}</h1>
  <p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#A8B4C8">Good morning{(", " + e(name)) if name else ""}. Here is what matters before the open, in three minutes.</p>
  <p style="margin:-6px 0 14px;font-size:12px;line-height:1.5;color:#8E9BB4">First time seeing this address? Add {e(_from()[1])} to your contacts so the briefings land in your inbox.</p>
  <p style="margin:0 0 18px;font-size:15px;line-height:1.55">{e(brief.get("summary", ""))}</p>
  <h2 style="margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#A8B4C8">NUMBERS TO KNOW</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">{num_rows}</table>
  {"<h2 style='margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#A8B4C8'>SPY AND QQQ, 1-HOUR CHART</h2>" + "".join(f"<p style='margin:0 0 6px;font-size:14px;line-height:1.5'>{e(l)}</p>" for l in idx_lines) if idx_lines else ""}
  {"<h2 style='margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#A8B4C8'>YOUR WATCHLIST</h2><table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='font-size:14px'>" + watch_rows + "</table>" if watch else "<p style='margin:18px 0 0;font-size:13px;color:#A8B4C8'>Add names to your watchlist on the desk and they will appear here with their reads.</p>"}
  {"<h2 style='margin:18px 0 6px;font-size:14px;letter-spacing:.04em;color:#A8B4C8'>TODAY</h2>" + "".join(f"<div style='font-size:13.5px;line-height:1.5'>{e(x)}</div>" for x in ev) if ev else ""}
  {f"<p style='margin:14px 0 0;font-size:13.5px;line-height:1.5'><b>{len(trump)} market-relevant post{'s' if len(trump) > 1 else ''} from the President overnight.</b> The read on each is on the desk.</p>" if trump else ""}
  <p style="margin:22px 0 6px"><a href="{e(site_url)}" style="display:inline-block;background:#245BFF;color:#FFFFFF;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:8px;font-size:15px">Open today's briefing</a></p>
  <p style="margin:0 0 4px;font-size:12.5px;line-height:1.55;color:#A8B4C8">Why this lands at 7:00: the overnight tape, the yields and the first posts of the day set the tone before the open. Five minutes on the desk now saves a rushed decision at 9:31.</p>
  <p style="margin:18px 0 0;font-size:11.5px;line-height:1.6;color:#8E9BB4">OneView is information, not advice. Reads come from public data and textbook technicals, never a guarantee. You receive this because you signed in to OneView. <a href="{e(unsubscribe_url)}" style="color:#8E9BB4">Stop these emails</a>.</p>
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
    html = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head><body style="margin:0;background:#080E1D;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#F5F7FC">
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


def close_email(name: str, brief: dict[str, Any], watch: list[dict[str, Any]], site_url: str, record_url: str, unsubscribe_url: str) -> tuple[str, str, str]:
    """After the close: what the market did, how our 15-minute reads went, the week so far, the crowd's mood,
    what moved, and the levels into the next session."""
    date_label = datetime.strptime(brief["date"], "%Y-%m-%d").strftime("%A, %B %d")
    ses = brief.get("session") or {}
    idx = {x.get("symbol"): x for x in ses.get("indexes") or []}
    sc = brief.get("scorecard") or {}
    ex = brief.get("extras") or {}
    next_session = ex.get("next_session") or "tomorrow"
    week = ex.get("week") or {}
    mood = ex.get("sentiment") or {}
    e = lambda x: html_mod.escape(str(x))
    names = {"SPY": "S&P 500", "QQQ": "Nasdaq 100", "IWM": "Small caps", "DIA": "Dow 30"}
    pct = _fmt_pct
    def col(x: Any) -> str:
        return "#66D9A6" if isinstance(x, (int, float)) and x > 0 else "#FF8F9B" if isinstance(x, (int, float)) and x < 0 else "#A8B4C8"
    spy = (idx.get("SPY") or {}).get("chg_pct")
    subject = f"OneView after the close · {date_label} · S&P 500 {pct(spy)}"
    hit_rate = sc.get("hit_rate")
    scored, hits = sc.get("scored") or 0, sc.get("hits") or 0
    if not scored:
        verdict = "No reads to score today."
    elif (hit_rate or 0) >= 60:
        verdict = "The 15-minute reads were on the right side of the tape most of the day. Every read is logged and scored so the process keeps sharpening."
    elif (hit_rate or 0) >= 45:
        verdict = "A split day for the reads: the tape changed its mind more than once. All of it is logged and scored so the process keeps sharpening."
    else:
        verdict = "A hard tape for short reads today. Every one is logged and scored, which is exactly how the process gets better."
    timeline = sc.get("timeline") or []
    def tcell(r: dict[str, Any]) -> str:
        h = r.get("hit"); c = "#66D9A6" if h == 1 else "#FF8F9B" if h == 0 else "#34435C"
        t = datetime.fromtimestamp(float(r.get("at") or 0)).strftime("%H:%M") if r.get("at") else ""
        return '<td style="padding:0 1px"><div title="' + e(t) + ' ' + e(r.get("expected") or "") + '" style="height:14px;background:' + c + ';border-radius:2px"></div></td>'
    strip = ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 2px"><tr>' + "".join(tcell(r) for r in timeline) + '</tr></table>'
             '<div style="font-size:11px;color:#8E9BB4">Each block is one 15-minute read, 09:30 on the left to the close on the right. Green right, red wrong, grey not scored.</div>') if timeline else ""
    leaders = ", ".join(f"{x.get('label')} {pct(x.get('chg_pct'))}" for x in (ses.get("leaders") or [])[:3])
    laggards = ", ".join(f"{x.get('label')} {pct(x.get('chg_pct'))}" for x in (ses.get("laggards") or [])[:3])
    mega = brief.get("mega") or []
    movers = (ses.get("movers") or [])[:6]
    B = ses.get("breadth") or {}
    breadth = f"{B.get('adv', 0)} of the {B.get('n', 0)} names we track closed up, {B.get('dec', 0)} down; {B.get('above20', 0)} sit above their 20-day average." if B.get("n") else ""
    plans = []
    for sym in ("SPY", "QQQ"):
        x = (brief.get("indexes") or {}).get(sym) or {}
        pl = x.get("plan") or {}
        if pl:
            plans.append((sym, x.get("last"), pl.get("shape") or "", (pl.get("levels") or [])[:3]))
    trump = brief.get("trump") or []
    y = brief.get("yields") or {}
    week_title = "The week" if ex.get("week_complete") else "The week so far"
    def week_line(sym: str) -> str:
        w = week.get(sym) or {}
        if not w:
            return ""
        return (f"{names.get(sym, sym)} {pct(w.get('ret_pct'))} on the week ({w.get('base')} to {w.get('close')}). High {w.get('high')} on {w.get('high_day')}, low {w.get('low')} on {w.get('low_day')}; "
                f"best day {w.get('best_day', ['', 0])[0]} {pct(w.get('best_day', ['', 0])[1])}, worst {w.get('worst_day', ['', 0])[0]} {pct(w.get('worst_day', ['', 0])[1])}. {w.get('shape')}.")
    week_lines = [week_line(s) for s in ("SPY", "QQQ") if week.get(s)]
    # ---- text ----
    lines = [f"Good evening{', ' + name if name else ''}.", "", brief.get("summary", ""), "",
             "The close: " + " · ".join(f"{names.get(k, k)} {pct((idx.get(k) or {}).get('chg_pct'))}" for k in ("SPY", "QQQ", "IWM", "DIA") if idx.get(k)), "",
             f"Our 15-minute reads: {hits} of {scored} right ({hit_rate if hit_rate is not None else '-'}%). {verdict}", ""]
    if week_lines:
        lines += [f"{week_title}:"] + [f"  {l}" for l in week_lines] + [""]
    if mood.get("summary"):
        lines += ["Market mood: " + mood["summary"], f"  {mood.get('meaning', '')}", ""]
    if leaders:
        lines += [f"Leading: {leaders}. Lagging: {laggards}."]
    if mega:
        lines += ["Mega caps: " + ", ".join(f"{x.get('ticker')} {pct(x.get('chg_pct'))}" for x in mega[:8])]
    if movers:
        lines += ["Biggest moves among analysed names: " + ", ".join(f"{x.get('ticker')} {pct(x.get('chg_pct'))}" for x in movers)]
    if breadth:
        lines += [breadth]
    if plans:
        lines += ["", f"Into {next_session}:"]
        for sym, last, shape, levels in plans:
            lines += [f"  {sym} {_fmt_num(last)}: {shape}"] + [f"    - {l}" for l in levels]
    if watch:
        lines += ["", "Your watchlist at the close:"] + [f"  {w['ticker']}: {_fmt_num(w.get('last'))} ({pct(w.get('chg_pct'))}) · {w.get('read') or 'no read yet'}" for w in watch]
    if trump:
        lines += ["", f"{len(trump)} market-relevant post{'s' if len(trump) > 1 else ''} from the President today; the read on each is on OneView."]
    lines += ["", f"Open OneView: {site_url}", "", "OneView is information, not advice. You receive this because you signed in to OneView.", f"Stop these emails: {unsubscribe_url}"]
    text = "\n".join(lines)
    # ---- html ----
    def tile(k: str) -> str:
        x = idx.get(k) or {}
        return ('<td style="padding:0 4px;width:25%"><div style="background:#131F33;border:1px solid #29364C;border-radius:10px;padding:10px 12px">'
                '<div style="font-size:11px;letter-spacing:.08em;color:#A8B4C8;text-transform:uppercase">' + e(names.get(k, k)) + '</div>'
                '<div style="font-size:20px;font-weight:700;color:' + col(x.get("chg_pct")) + ';font-variant-numeric:tabular-nums">' + e(pct(x.get("chg_pct"))) + '</div>'
                '<div style="font-size:12px;color:#A8B4C8">' + e(_fmt_num(x.get("last"))) + '</div></div></td>')
    tiles = "".join(tile(k) for k in ("SPY", "QQQ", "IWM", "DIA") if idx.get(k))
    def h2(t: str) -> str:
        return '<h2 style="margin:20px 0 8px;font-size:13px;letter-spacing:.06em;color:#A8B4C8;text-transform:uppercase">' + e(t) + '</h2>'
    rate_col = "#66D9A6" if (hit_rate or 0) >= 60 else "#FF8F9B" if (hit_rate or 0) < 45 else "#F5F7FC"
    reads = ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">'
             '<tr><td style="padding:8px 0;border-top:1px solid #29364C">Our 15-minute reads: <b>' + str(hits) + ' of ' + str(scored) + ' right</b><div style="font-size:12.5px;color:#A8B4C8">each scored against the close</div></td>'
             '<td style="padding:8px 0;border-top:1px solid #29364C;text-align:right;vertical-align:top"><span style="font-size:22px;font-weight:700;color:' + rate_col + '">' + e(hit_rate if hit_rate is not None else "–") + '%</span></td></tr></table>'
             + strip + '<p style="margin:10px 0 0;font-size:14px;line-height:1.55">' + e(verdict) + '</p>')
    def week_card(sym: str) -> str:
        w = week.get(sym) or {}
        if not w:
            return ""
        pos = max(0.0, min(1.0, float(w.get("range_pos") or 0)))
        bar = ('<div style="position:relative;height:8px;background:#29364C;border-radius:4px;margin:8px 0 4px"><div style="position:absolute;left:0;top:0;bottom:0;width:' + str(int(pos * 100)) + '%;background:' + col(w.get("ret_pct")) + ';border-radius:4px"></div></div>'
               '<div style="display:flex;justify-content:space-between;font-size:11px;color:#8E9BB4"><span>low ' + e(w.get("low")) + ' (' + e(w.get("low_day")) + ')</span><span>close ' + e(w.get("close")) + '</span><span>high ' + e(w.get("high")) + ' (' + e(w.get("high_day")) + ')</span></div>')
        bd, wd = w.get("best_day", ["", 0]), w.get("worst_day", ["", 0])
        return ('<td style="padding:0 4px;width:50%;vertical-align:top"><div style="background:#131F33;border:1px solid #29364C;border-radius:10px;padding:10px 12px">'
                '<div style="font-size:12px;color:#A8B4C8">' + e(names.get(sym, sym)) + '</div><div style="font-size:20px;font-weight:700;color:' + col(w.get("ret_pct")) + ';font-variant-numeric:tabular-nums">' + e(pct(w.get("ret_pct"))) + ' <span style="font-size:12px;font-weight:500;color:#A8B4C8">on the week</span></div>'
                + bar + '<div style="font-size:12.5px;line-height:1.5;margin-top:6px">Best day ' + e(bd[0]) + ' <span style="color:' + col(bd[1]) + '">' + e(pct(bd[1])) + '</span>, worst ' + e(wd[0]) + ' <span style="color:' + col(wd[1]) + '">' + e(pct(wd[1])) + '</span>.</div>'
                '<div style="font-size:12.5px;line-height:1.5;color:#C7D0E0">' + e(str(w.get("shape") or "").capitalize()) + '.</div></div></td>')
    week_html = ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' + week_card("SPY") + week_card("QQQ") + '</tr></table>') if week else ""
    def mood_chip(label: str, value: str, c: str) -> str:
        return '<td style="padding:0 3px"><div style="background:#131F33;border:1px solid #29364C;border-radius:10px;padding:8px 10px"><div style="font-size:10.5px;letter-spacing:.08em;color:#A8B4C8;text-transform:uppercase">' + e(label) + '</div><div style="font-size:13px;font-weight:700;color:' + c + '">' + e(value) + '</div></div></td>'
    chips = []
    for s2, v in (mood.get("stocktwits") or {}).items():
        lbl = v.get("label") or "no read"; c = "#66D9A6" if "bullish" in lbl else "#FF8F9B" if "bearish" in lbl else "#F5F7FC"
        chips.append(mood_chip("StockTwits " + s2, lbl.capitalize() + (f" · {v['bullish_pct']:.0f}%" if isinstance(v.get("bullish_pct"), (int, float)) else ""), c))
    for s2, v in (mood.get("reddit") or {}).items():
        lbl = (v.get("sentiment") or "neutral"); c = "#66D9A6" if lbl.lower() == "bullish" else "#FF8F9B" if lbl.lower() == "bearish" else "#F5F7FC"
        chips.append(mood_chip("Reddit " + s2, lbl.capitalize() + (f" · {v['mentions']} mentions" if v.get("mentions") else ""), c))
    tr = mood.get("trump") or {}
    if tr.get("n"):
        chips.append(mood_chip("President", f"{tr.get('bullish', 0)} bullish · {tr.get('bearish', 0)} bearish", "#F5F7FC"))
    bdp = mood.get("backdrop") or {}
    if bdp.get("headline"):
        chips.append(mood_chip("Backdrop", f"{bdp['headline']} · {bdp.get('verdict') or ''}", "#F5F7FC"))
    mood_html = (('<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' + "".join(chips[:4]) + '</tr></table>' if chips else "")
                 + (('<p style="margin:10px 0 0;font-size:14px;line-height:1.55">' + e(mood.get("meaning") or "") + '</p>') if mood.get("meaning") else "")) if mood else ""
    mega_rows = "".join('<td style="padding:4px 2px;width:12.5%"><div style="background:#131F33;border-radius:8px;padding:6px 4px;text-align:center"><div style="font-size:12px;font-weight:700">' + e(x.get("ticker")) + '</div><div style="font-size:12px;color:' + col(x.get("chg_pct")) + ';font-variant-numeric:tabular-nums">' + e(pct(x.get("chg_pct"))) + '</div></div></td>' for x in mega[:8])
    mover_rows = "".join('<tr><td style="padding:6px 0;border-top:1px solid #29364C"><b>' + e(x.get("ticker")) + '</b> <span style="color:#A8B4C8;font-size:12px">' + e((x.get("name") or "")[:30]) + '</span></td><td style="padding:6px 0;border-top:1px solid #29364C;text-align:right;font-weight:600;color:' + col(x.get("chg_pct")) + ';font-variant-numeric:tabular-nums">' + e(pct(x.get("chg_pct"))) + '</td></tr>' for x in movers)
    plan_html = "".join('<div style="margin:0 0 10px"><div style="font-size:14px"><b>' + e(sym) + ' ' + e(_fmt_num(last)) + '</b> · ' + e(shape) + '</div><ul style="margin:4px 0 0;padding-left:18px;font-size:13px;line-height:1.5;color:#C7D0E0">' + "".join('<li>' + e(l) + '</li>' for l in levels) + '</ul></div>' for sym, last, shape, levels in plans)
    watch_rows = "".join('<tr><td style="padding:7px 0;border-top:1px solid #29364C"><b>' + e(w["ticker"]) + '</b> <span style="color:#A8B4C8;font-size:12px">' + e((w.get("name") or "")[:28]) + '</span></td><td style="padding:7px 0;border-top:1px solid #29364C;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">' + e(_fmt_num(w.get("last"))) + ' <span style="color:' + col(w.get("chg_pct")) + '">' + e(pct(w.get("chg_pct"))) + '</span></td><td style="padding:7px 0 7px 10px;border-top:1px solid #29364C;font-size:12.5px;color:#C7D0E0">' + e(w.get("read") or "no read yet") + '</td></tr>' for w in watch)
    parts = [
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head><body style="margin:0;background:#080E1D;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;color:#F5F7FC">',
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#080E1D" style="padding:28px 16px;background:#080E1D">',
        '<table role="presentation" width="600" style="max-width:600px;background:#101A2B;border:1px solid #29364C;border-radius:14px" cellpadding="0" cellspacing="0">',
        '<tr><td style="padding:22px 28px 14px;background:#0F1B36;border-radius:14px 14px 0 0">',
        logo_img(150),
        '<div style="margin-top:12px;font-size:11px;letter-spacing:.16em;color:#85A7FF;font-weight:700">ONEVIEW · AFTER THE CLOSE</div>',
        '<h1 style="margin:8px 0 2px;font-size:22px;letter-spacing:-.02em;color:#F5F7FC">' + e(date_label) + '</h1>',
        '<div style="font-size:13px;color:#A8B4C8">What the market did, how the week went, the mood, and the levels into ' + e(next_session) + '.</div></td></tr>',
        '<tr><td style="padding:18px 24px 8px">',
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' + tiles + '</tr></table>',
        '<p style="margin:16px 4px 0;font-size:15px;line-height:1.55">' + e(brief.get("summary", "")) + '</p>',
        '<p style="margin:8px 4px 0;font-size:12px;line-height:1.5;color:#8E9BB4">First time seeing this address? Add ' + e(_from()[1]) + ' to your contacts so the briefings land in your inbox.</p>',
        '<div style="padding:0 4px">' + h2("How our reads went") + reads + '</div>',
        ('<div style="padding:0 4px">' + h2(week_title + ": S&P 500 and Nasdaq 100") + week_html + '</div>') if week_html else "",
        ('<div style="padding:0 4px">' + h2("Market mood") + mood_html + '</div>') if mood_html else "",
        '<div style="padding:0 4px">' + h2("What moved") +
        ('<p style="margin:0 0 8px;font-size:14px;line-height:1.5"><b>Leading:</b> ' + e(leaders) + '. <b>Lagging:</b> ' + e(laggards) + '.</p>' if leaders else "") +
        ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' + mega_rows + '</tr></table>' if mega else "") +
        ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:6px">' + mover_rows + '</table>' if movers else "") +
        ('<p style="margin:8px 0 0;font-size:13px;color:#A8B4C8;line-height:1.5">' + e(breadth) + ' 10-year yield ' + e(_fmt_num(y.get("10y"))) + '%.</p>' if breadth else "") + '</div>',
        ('<div style="padding:0 4px">' + h2("Into " + next_session) + plan_html + '</div>') if plans else "",
        ('<div style="padding:0 4px">' + h2("Your watchlist at the close") + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">' + watch_rows + '</table></div>') if watch else "",
        ('<p style="margin:14px 4px 0;font-size:13.5px;line-height:1.5"><b>' + str(len(trump)) + ' market-relevant post' + ('s' if len(trump) > 1 else '') + ' from the President today.</b> The read on each is on OneView.</p>') if trump else "",
        '<p style="margin:22px 4px 6px"><a href="' + e(site_url) + '" style="display:inline-block;background:#245BFF;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;font-size:14px">Open OneView</a></p>',
        '<p style="margin:14px 4px 0;font-size:11.5px;line-height:1.6;color:#8E9BB4">OneView is information, not advice. Reads come from public data, fixed rules and typed model judgments, scored every day against what the market actually did, never a guarantee. You receive this because you signed in to OneView. <a href="' + e(unsubscribe_url) + '" style="color:#8E9BB4">Stop these emails</a>.</p>',
        '</td></tr></table></td></tr></table></body></html>']
    return subject, text, "".join(parts)
