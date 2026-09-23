#!/usr/bin/env python3
"""Package a versioned release of Market Update.

    python scripts/package_release.py --version 1.0.0 --release-type market-ready

Steps:
  1. Stamp the version into pyproject.toml.
  2. Build a fresh single-file dashboard (output/index.html) unless --skip-build.
  3. Zip the source, deployment files and the built dashboard into
     dist/market-update-<version>-<release-type>.zip with a RELEASE.txt manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INCLUDE_DIRS = ["market_update", "scripts", ".github"]
INCLUDE_FILES = ["pyproject.toml", "README.md", "Dockerfile", "render.yaml", "watchlist.txt", ".gitignore"]
BUILT = ["output/index.html", "output/report.json"]
EXCLUDE_PARTS = {"__pycache__", ".pyc", ".DS_Store", ".cache"}


def stamp_version(version: str) -> None:
    p = ROOT / "pyproject.toml"
    s = p.read_text()
    s2, n = re.subn(r'^version = "[^"]+"', f'version = "{version}"', s, count=1, flags=re.M)
    if n != 1:
        sys.exit("could not find version line in pyproject.toml")
    p.write_text(s2)


def build_dashboard(no_ai: bool) -> None:
    py = ROOT / ".venv" / "bin" / "python"
    cmd = [str(py if py.exists() else sys.executable), "-m", "market_update.cli"]
    if no_ai or not os.environ.get("TYPESAFE_API_KEY"):
        cmd.append("--no-ai")
        print("building dashboard without model judgments (no TYPESAFE_API_KEY in env)" if not no_ai else "building dashboard without model judgments")
    subprocess.run(cmd, cwd=ROOT, check=True)


def wanted(path: Path) -> bool:
    return not any(part in EXCLUDE_PARTS or part.endswith(".pyc") for part in path.parts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--release-type", default="release")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--no-ai", action="store_true")
    a = ap.parse_args()

    stamp_version(a.version)
    if not a.skip_build:
        build_dashboard(a.no_ai)

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    name = f"market-update-{a.version}-{a.release_type}"
    out = dist / f"{name}.zip"
    files: list[Path] = []
    for d in INCLUDE_DIRS:
        for p in (ROOT / d).rglob("*"):
            if p.is_file() and wanted(p.relative_to(ROOT)):
                files.append(p)
    for f in INCLUDE_FILES + BUILT:
        p = ROOT / f
        if p.exists():
            files.append(p)

    manifest = [f"Market Update {a.version} ({a.release_type})",
                f"packaged {datetime.now(timezone.utc).isoformat(timespec='seconds')}",
                "", "files:"]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(files):
            rel = p.relative_to(ROOT)
            z.write(p, f"{name}/{rel}")
            manifest.append(f"  {rel}  sha256:{hashlib.sha256(p.read_bytes()).hexdigest()[:12]}")
        z.writestr(f"{name}/RELEASE.txt", "\n".join(manifest) + "\n")
    print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB, {len(files)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
