"""Builds the folder that is uploaded to Vercel: this folder's files, the
voice server, and Heart's model (the official 16-bit build, to fit Vercel's
500 MB limit). Model files never go into git; they are copied here from a
local folder (download_models.py fetches them, checksummed).

    python stage.py <kokoro-model-dir> <out-dir>
    cd <out-dir> && npx vercel deploy --prod --yes

Settings on the Vercel project (astraeya-voice): VOICE_MODELS_DIR=models,
VOICE_KOKORO_MODEL=kokoro-v1.0.fp16.onnx, VOICE_SKIP_STT=1, VOICE_THREADS=1
(one vCPU: 2 threads measured slower), VOICE_SECRET (the same value as the
API's VOICE_SECRET on Render).
"""
import shutil
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for f in ("app.py", "requirements.txt", "vercel.json"):
    shutil.copy2(here / f, out / f)
for f in ("server.py", "voices.json", "pronunciations.json"):
    shutil.copy2(here.parent / f, out / f)
(out / "models" / "kokoro").mkdir(parents=True, exist_ok=True)
for f in ("kokoro-v1.0.fp16.onnx", "voices-v1.0.bin"):
    shutil.copy2(src / f, out / "models" / "kokoro" / f)
# Vercel allows 225 MB per function. The voices file holds all 54 Kokoro
# voices; only the ones Astraeya offers (voices.json) are kept, which halves it.
import json
import numpy as np


def kokoro_ids(o):
    if isinstance(o, dict):
        if o.get("engine") == "kokoro" and "id" in o:
            yield o["id"]
        for v in o.values():
            yield from kokoro_ids(v)
    elif isinstance(o, list):
        for v in o:
            yield from kokoro_ids(v)


ids = set(kokoro_ids(json.loads((here.parent / "voices.json").read_text(encoding="utf-8"))))
voices_path = out / "models" / "kokoro" / "voices-v1.0.bin"
everything = np.load(voices_path)
kept = {k: everything[k] for k in sorted(ids) if k in everything.files}
everything.close()
with open(voices_path, "wb") as f:
    np.savez(f, **kept)
print(f"staged {out} with {len(kept)} Kokoro voices")
