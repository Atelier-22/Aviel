"""Astraeya's voice server: text in, speech out, entirely on this machine.

Loads Kokoro (all its voices share one model) at start-up and each Piper voice
the first time it is asked for, then keeps them. Only astraeya-api calls it:
it is a private service, and every request must carry the shared secret.

    POST /synthesize  {"text": "...", "voice": "af_heart"}  -> audio/wav
    GET  /voices      the catalogue (voices.json)
    GET  /health      200 once Kokoro is loaded

One sentence per request. The API splits replies into sentences and calls
this once per sentence, so the first sentence can play while the rest are
still being made.

Settings (environment):
    VOICE_MODELS_DIR  folder with kokoro/ and piper/ (default ../voices)
    VOICE_THREADS     CPU threads per synthesis (default 1, as on Render Standard)
    VOICE_SECRET      shared secret expected in X-Voice-Secret (unset = no check, for local use)
    VOICE_PRELOAD     Piper voices to load at start-up (default: live mode's two fast voices)
    PORT              default 5005
"""

from __future__ import annotations

import io
import json
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from kokoro_onnx import Kokoro
from piper import PiperVoice, SynthesisConfig
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
MODELS = Path(os.environ.get("VOICE_MODELS_DIR", HERE.parent / "voices")).resolve()
THREADS = max(1, int(os.environ.get("VOICE_THREADS", "1")))
SECRET = os.environ.get("VOICE_SECRET", "")
# Voices loaded at start-up rather than on first use: live mode's fast voices.
PRELOAD = [v for v in os.environ.get("VOICE_PRELOAD", "en_US-kristin-medium,en_US-john-medium").split(",") if v]

CATALOGUE = json.loads((HERE / "voices.json").read_text(encoding="utf-8"))
VOICES = {v["id"]: v for v in CATALOGUE["voices"]}
DEFAULT_VOICE = CATALOGUE["default"]
PRONUNCIATIONS = json.loads((HERE / "pronunciations.json").read_text(encoding="utf-8"))

MAX_CHARS = 1000


def session_options() -> ort.SessionOptions:
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = THREADS
    opts.inter_op_num_threads = 1
    return opts


def apply_pronunciations(text: str) -> str:
    # Longest phrases first, so "Wezitech Official" wins over "Wezitech".
    for word in sorted(PRONUNCIATIONS, key=len, reverse=True):
        text = re.sub(rf"(?<!\w){re.escape(word)}(?!\w)", PRONUNCIATIONS[word], text)
    return text


def load_kokoro() -> Kokoro:
    session = ort.InferenceSession(
        str(MODELS / "kokoro" / "kokoro-v1.0.onnx"),
        sess_options=session_options(),
        providers=["CPUExecutionProvider"],
    )
    kokoro = Kokoro.from_session(session, str(MODELS / "kokoro" / "voices-v1.0.bin"))
    # kokoro-onnx 0.4.7 passes "speed" as int32 for this model, which expects
    # float32 (and int32 would round 0.9 down to 0). Cast it on the way in.
    run = kokoro.sess.run

    def run_with_float_speed(output_names, inputs, *rest, **kwargs):
        if "speed" in inputs:
            inputs = {**inputs, "speed": np.asarray(inputs["speed"], dtype=np.float32)}
        return run(output_names, inputs, *rest, **kwargs)

    kokoro.sess.run = run_with_float_speed
    return kokoro


class Engines:
    """Models, loaded once. Synthesis is serialised: with one CPU, running two
    at once only makes both slower, and a queue keeps the order fair."""

    def __init__(self) -> None:
        self.kokoro: Kokoro | None = None
        self.piper: dict[str, PiperVoice] = {}
        self.lock = threading.Lock()
        self.load_lock = threading.Lock()

    def load(self) -> None:
        started = time.perf_counter()
        self.kokoro = load_kokoro()
        # Warm-up: the first run is slow while onnxruntime plans the graph.
        self.kokoro.create("Ready.", voice=DEFAULT_VOICE, speed=1.0, lang="en-us")
        for voice_id in PRELOAD:
            if voice_id in VOICES and VOICES[voice_id]["engine"] == "piper":
                self.piper_voice(voice_id)
                with self.lock:
                    list(self.piper[voice_id].synthesize("Ready."))
        print(f"[voice] Kokoro and {len(PRELOAD)} fast voice(s) ready in {time.perf_counter() - started:.1f}s, {THREADS} thread(s), models in {MODELS}", flush=True)

    def piper_voice(self, voice_id: str) -> PiperVoice:
        with self.load_lock:
            if voice_id not in self.piper:
                gender = VOICES[voice_id]["gender"]
                path = MODELS / "piper" / gender / f"{voice_id}.onnx"
                voice = PiperVoice.load(str(path))
                voice.session = ort.InferenceSession(str(path), sess_options=session_options(), providers=["CPUExecutionProvider"])
                self.piper[voice_id] = voice
            return self.piper[voice_id]

    def synthesize(self, text: str, voice_id: str) -> tuple[bytes, float, int]:
        """WAV bytes, seconds of audio, sample rate."""
        meta = VOICES[voice_id]
        text = apply_pronunciations(text)
        if meta["engine"] == "kokoro":
            if self.kokoro is None:
                raise RuntimeError("Kokoro is not loaded")
            lang = "en-gb" if voice_id.startswith("b") else "en-us"
            with self.lock:
                samples, rate = self.kokoro.create(text, voice=voice_id, speed=1.0, lang=lang)
            buf = io.BytesIO()
            sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
            return buf.getvalue(), len(samples) / rate, rate

        voice = self.piper_voice(voice_id)
        with self.lock:
            chunks = list(voice.synthesize(text, syn_config=SynthesisConfig(length_scale=1.0)))
        if not chunks:
            raise RuntimeError("no audio")
        rate = chunks[0].sample_rate
        pcm = b"".join(c.audio_int16_bytes for c in chunks)
        audio = np.frombuffer(pcm, dtype=np.int16)
        buf = io.BytesIO()
        sf.write(buf, audio, rate, format="WAV", subtype="PCM_16")
        return buf.getvalue(), len(audio) / rate, rate


engines = Engines()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    engines.load()
    yield


app = FastAPI(title="Astraeya voice", docs_url=None, redoc_url=None, lifespan=lifespan)


def check_secret(given: str | None) -> None:
    if SECRET and given != SECRET:
        raise HTTPException(status_code=401, detail="unauthorised")


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)
    voice: str = DEFAULT_VOICE


@app.post("/synthesize")
def synthesize(req: SynthesisRequest, x_voice_secret: str | None = Header(default=None)) -> Response:
    check_secret(x_voice_secret)
    # An unknown voice is not an error: it falls back to the default.
    voice_id = req.voice if req.voice in VOICES else DEFAULT_VOICE
    text = req.text.strip()
    if not re.search(r"[\w]", text):
        raise HTTPException(status_code=422, detail="nothing to say")
    started = time.perf_counter()
    try:
        wav, seconds, rate = engines.synthesize(text, voice_id)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail=f"voice {voice_id} is not installed")
    elapsed = time.perf_counter() - started
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Voice-Id": voice_id,
            "X-Audio-Seconds": f"{seconds:.3f}",
            "X-Synth-Ms": str(round(elapsed * 1000)),
        },
    )


@app.get("/voices")
def voices(x_voice_secret: str | None = Header(default=None)) -> dict:
    check_secret(x_voice_secret)
    return CATALOGUE


@app.get("/health")
def health() -> dict:
    if engines.kokoro is None:
        raise HTTPException(status_code=503, detail="loading")
    return {"status": "ok", "threads": THREADS, "piperLoaded": sorted(engines.piper)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5005")), log_level="warning")
