"""Single-file export: inline the static app and embed the report JSON so
output/index.html works from disk, as an artifact, or on any static host."""
from __future__ import annotations

import json
from typing import Any

from . import config


def render_html(report: dict[str, Any]) -> str:
    html = (config.STATIC_DIR / "index.html").read_text()
    css = (config.STATIC_DIR / "styles.css").read_text()
    js = (config.STATIC_DIR / "app.js").read_text()
    data = json.dumps(report, default=str).replace("</", "<\\/")
    html = html.replace('<link rel="stylesheet" href="/static/styles.css">', f"<style>\n{css}\n</style>")
    html = html.replace('<script src="/static/app.js"></script>',
                        f'<script id="report-data" type="application/json">{data}</script>\n<script>\n{js}\n</script>')
    return html
