"""Fetches the voice models listed in models.json into VOICE_MODELS_DIR.

    python download_models.py            # into $VOICE_MODELS_DIR, or ./models
    python download_models.py --check    # only verify what is there

Files already present with the right checksum are skipped, so a redeploy with
a warm disk downloads nothing. A file whose checksum does not match is deleted
and the script exits non-zero: the voice server must never start on a model
other than the one that was tested.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / "models.json").read_text(encoding="utf-8"))
TARGET = Path(os.environ.get("VOICE_MODELS_DIR", HERE / "models")).resolve()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url: str, dest: Path, attempts: int = 3) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "astraeya-voice-installer"})
            with urllib.request.urlopen(req, timeout=60) as res, open(tmp, "wb") as out:
                while chunk := res.read(1 << 20):
                    out.write(chunk)
            tmp.replace(dest)
            return
        except Exception as err:  # network hiccups: retry, then give up loudly
            print(f"  attempt {attempt} failed: {err}", flush=True)
            tmp.unlink(missing_ok=True)
            if attempt == attempts:
                raise
            time.sleep(3 * attempt)


def main() -> int:
    check_only = "--check" in sys.argv
    TARGET.mkdir(parents=True, exist_ok=True)
    problems = 0
    for entry in MANIFEST["files"]:
        dest = TARGET / entry["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.stat().st_size == entry["size"] and sha256(dest) == entry["sha256"]:
            print(f"ok       {entry['path']}", flush=True)
            continue
        if check_only:
            print(f"MISSING  {entry['path']}", flush=True)
            problems += 1
            continue
        print(f"fetching {entry['path']} ({entry['size'] / 1e6:.0f} MB)", flush=True)
        fetch(entry["url"], dest)
        if sha256(dest) != entry["sha256"]:
            print(f"CHECKSUM MISMATCH {entry['path']}: refusing to keep it", flush=True)
            dest.unlink()
            problems += 1
    print(f"{'All' if not problems else 'NOT all'} {len(MANIFEST['files'])} voice model files in {TARGET}", flush=True)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
