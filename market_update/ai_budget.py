"""When OneView may call the model (DeepSeek, Claude or any other provider): a fixed schedule, never on demand.

The owner's rule (2026-10-05): spend tokens only on a timetable, and never let a page refresh or a visitor trigger
model calls.
  - Trading days, regular session (09:30-16:00 ET): one model window per hour, starting 09:30, 10:30 ... 15:30.
  - Trading days outside the session: two windows, from 07:00 (pre-market, with the morning brief) and from
    16:30 (after the close, with the close brief).
  - Weekends and NYSE holidays: two windows, from 10:00 and from 16:00.
Inside a window each feature ("report", "intraday", "headlines", ...) gets the model once. Every other run uses
the backup rules or carries the last model reads forward, so nothing on the page goes blank.
The windows used are kept in output/ai_budget.json so a server restart does not hand out a second run.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from . import config

log = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")
_PATH = Path(os.environ.get("MU_DATA_DIR", config.OUTPUT_DIR)) / "ai_budget.json"
_lock = threading.Lock()

# NYSE full-day closures. Early closes (1 pm) count as trading days.
NYSE_HOLIDAYS = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
    "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06",
    "2027-11-25", "2027-12-24",
}


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d.isoformat() not in NYSE_HOLIDAYS


def window(now: datetime | None = None) -> str | None:
    """The model window open right now, as a key like '2026-10-05 10:30', or None when the model is off."""
    now = (now or datetime.now(ET)).astimezone(ET)
    d, m = now.date(), now.hour * 60 + now.minute
    if is_trading_day(d):
        if 570 <= m < 960:                                   # 09:30-16:00: hourly from 09:30
            start = 570 + ((m - 570) // 60) * 60
            return f"{d.isoformat()} {start // 60:02d}:{start % 60:02d}"
        if 420 <= m < 570:
            return f"{d.isoformat()} pre"                    # from 07:00 until the open
        if m >= 990:
            return f"{d.isoformat()} post"                   # from 16:30 until midnight
        return None                                          # overnight and 16:00-16:30: off
    if 600 <= m < 960:
        return f"{d.isoformat()} day"                        # weekends and holidays: from 10:00
    if m >= 960:
        return f"{d.isoformat()} evening"                    # and from 16:00
    return None


def _load() -> dict[str, str]:
    try:
        return json.loads(_PATH.read_text())
    except Exception:  # noqa: BLE001
        return {}


def take(kind: str, now: datetime | None = None) -> bool:
    """True once per window for this kind of work; False otherwise (use the rules or the last model reads)."""
    w = window(now)
    if w is None:
        return False
    with _lock:
        used = _load()
        if used.get(kind) == w:
            return False
        used[kind] = w
        try:
            _PATH.parent.mkdir(parents=True, exist_ok=True)
            _PATH.write_text(json.dumps(used))
        except Exception:  # noqa: BLE001
            log.warning("could not save the model schedule")
    log.info("model window %s: %s", w, kind)
    return True


def release(kind: str) -> None:
    """Give the window back after a run that failed, so the next attempt inside the same window may use the model."""
    with _lock:
        used = _load()
        if kind in used:
            used.pop(kind)
            try:
                _PATH.write_text(json.dumps(used))
            except Exception:  # noqa: BLE001
                pass


def describe(now: datetime | None = None) -> dict[str, str | None]:
    """For the page and the admin view: whether the model is on now and when the next window opens."""
    now = (now or datetime.now(ET)).astimezone(ET)
    cur = window(now)
    nxt = None
    from datetime import timedelta
    probe = now.replace(minute=(now.minute // 30) * 30, second=0, microsecond=0)   # windows open on the hour or half hour
    for _ in range(4 * 48):                                  # look ahead up to four days
        probe = probe + timedelta(minutes=30)
        w = window(probe)
        if w and w != cur:
            nxt = probe.strftime("%a %H:%M ET")
            break
    return {"window": cur, "next": nxt}
