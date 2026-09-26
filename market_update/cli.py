"""Command line entry point.

    market-update              # build a single-file output/index.html (+ report.json)
    market-update --no-ai      # data only, no TypeSafe calls
    market-update --open       # build and open in the default browser
    market-update serve        # run the web service (uvicorn)
    market-update mail-test [you@example.com]   # show the mail transport, or send a test sign-in email
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import webbrowser
from pathlib import Path

from . import config
from . import fetch
from .analyze import build_report
from .render import render_html


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "mail-test":
        from . import mail
        st = mail.status()
        if len(argv) < 2:
            print(f"Mail: {st['transport']} from {st['from_name']} <{st['from_address']}>" if st["configured"] else f"Mail is not configured: {st['problem']}. See .env.example.")
            return 0 if st["configured"] else 1
        subject, text, html = mail.signin_email("https://example.com/auth/verify?token=TEST", 57)
        try:
            used = mail.send(argv[1], f"[test] {subject}", text, html)
        except Exception as e:  # noqa: BLE001
            print(f"Send failed via {st['transport']}: {e}", file=sys.stderr)
            return 1
        print(f"Sent a test sign-in email to {argv[1]} via {used} as {st['from_name']} <{st['from_address']}>")
        return 0
    if argv and argv[0] == "serve":
        import uvicorn
        port = int(os.environ.get("PORT", "8000"))
        uvicorn.run("market_update.server:app", host="0.0.0.0", port=port, log_level="info")
        return 0

    p = argparse.ArgumentParser(prog="market-update", description="Market dashboard for day and swing traders.")
    p.add_argument("--no-ai", action="store_true", help="skip TypeSafe judgments (data only)")
    p.add_argument("--open", action="store_true", help="open the dashboard in a browser when done")
    p.add_argument("--max-cards", type=int, default=None, help=f"stock cards to analyse (default {config.MAX_STOCK_CARDS})")
    p.add_argument("--out", default=str(config.OUTPUT_DIR), help="output directory")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    use_ai = not args.no_ai
    if use_ai and not os.environ.get("TYPESAFE_API_KEY"):
        print("TYPESAFE_API_KEY is not set. Export it or pass --no-ai.", file=sys.stderr)
        return 2

    report = asyncio.run(build_report(use_ai=use_ai, max_cards=args.max_cards))
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "report.json").write_text(json.dumps(report, indent=1, default=str))
    (out_dir / "symbols.json").write_text(json.dumps(fetch.fetch_symbol_index(), separators=(",", ":")))
    # the page re-reads this when the app server stops answering, so a new tunnel address needs no reload
    import time as _t
    (out_dir / "api.json").write_text(json.dumps({"api": config.API_URL, "app": config.APP_URL, "at": int(_t.time())}))
    import shutil
    (out_dir / "static").mkdir(exist_ok=True)
    brand_src = config.STATIC_DIR / "brand"
    if brand_src.exists():
        shutil.copytree(brand_src, out_dir / "static" / "brand", dirs_exist_ok=True)
    for name in ():
        src = config.STATIC_DIR / name
        if src.exists() and src.resolve() != (out_dir / "static" / name).resolve():
            shutil.copy(src, out_dir / "static" / name)
    html_path = out_dir / "index.html"
    html_path.write_text(render_html(report))

    r = report
    print(f"Session: {r['session_label']} [{r['market_state']}]  generated {r['generated_at'][:16]} ET")
    if r["regime"]:
        g = r["regime"]
        print(f"Tone: {g['tone']['choice']} ({g['tone']['confidence']:.2f})  Vol: {g['volatility']['score']:.1f}/3  "
              f"Driver: {g['driver']['choice']}  Lead: {g['leadership']['choice']}  Rates: {g['rates_read']['choice']}  Flow: {g['flow_read']['choice']}")
    print(f"Headlines: {len(r['headlines'])} shown, {r['headlines_dropped']} dropped of {r['headlines_judged']} judged")
    print(f"Stocks: {len(r['stocks'])} cards from {r['stocks_scanned']} scanned   Calendar: {len(r['calendar'])}   Earnings: {len(r['earnings'])} of {r['earnings_total']}")
    for s in r["stocks"][:8]:
        a = s.get("ai") or {}
        print(f"  {s['ticker']:6} {s['chg_pct']:+6.2f}%  ATR {s['technicals'].get('atr_pct') or 0:4.1f}%  "
              f"day {s['scores']['day']:.2f} swing {s['scores']['swing']:.2f}  "
              f"{(a.get('bias') or {}).get('choice','-'):8} {(a.get('setup') or {}).get('choice','-'):22} {' '.join(s['tags'])}")
    st = r["ai_stats"]
    print(f"TypeSafe: {st['calls']} calls, {st['failures']} failed, {st['input_tokens']} in / {st['output_tokens']} out tokens   ({r['elapsed_s']}s)")
    print(f"Wrote {html_path}")
    if args.open:
        webbrowser.open(html_path.as_uri())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
