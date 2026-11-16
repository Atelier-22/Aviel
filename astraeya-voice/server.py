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
    VOICE_THREADS     CPU threads per piece (default: half the logical CPUs, at most 4)
    VOICE_WORKERS     pieces made at the same time (default 1)
    VOICE_SECRET      shared secret expected in X-Voice-Secret (unset = no check, for local use)
    VOICE_KOKORO_MODEL  kokoro-v1.0.onnx (default, fastest on the CPUs measured) or kokoro-v1.0.fp16.onnx
    VOICE_DEVICE      cpu (default) or cuda (NVIDIA GPU, with onnxruntime-gpu)
    VOICE_STT_MODEL   Whisper model for /transcribe: base.en (default) or small.en (better, slower)
    VOICE_STT_DIR     where Whisper models are kept (default ./models/whisper)
    VOICE_STT_ONLY    1 = speech-to-text only, no voices (a small second server)
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
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import Response
from kokoro_onnx import Kokoro
try:
    from piper import PiperVoice, SynthesisConfig
except ImportError:  # the cloud build (Vercel) carries Kokoro only
    PiperVoice = SynthesisConfig = None  # type: ignore[assignment,misc]
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
# A relative VOICE_MODELS_DIR is taken from this file's folder, so it works
# wherever the server is started from (a serverless host picks its own).
MODELS = (HERE / os.environ.get("VOICE_MODELS_DIR", str(HERE.parent / "voices"))).resolve()
# Measured on a 4-core laptop (i5-8350U), Heart's first 24 characters: 2.09 s
# on 1 thread, 1.35 s on 4, 1.78 s on 8; two pieces at once on 4 threads each
# took 4.5 s apiece. So each piece gets several threads and pieces are made
# one after another, in order: the opening words come soonest and each later
# piece is made faster than the one before it plays.
THREADS = max(1, int(os.environ.get("VOICE_THREADS", str(min(4, max(1, (os.cpu_count() or 2) // 2))))))
WORKERS = max(1, int(os.environ.get("VOICE_WORKERS", "1")))
SECRET = os.environ.get("VOICE_SECRET", "")
# Which Kokoro build to run: the full model (default) or the official 16-bit
# build of the same model (not faster on the laptop measured: 0.76 vs 0.70
# seconds per second of speech). Same voices either way.
KOKORO_MODEL = os.environ.get("VOICE_KOKORO_MODEL", "kokoro-v1.0.onnx")
# "cuda" runs on an NVIDIA GPU (needs onnxruntime-gpu; see Dockerfile.gpu),
# falling back to the CPU if no GPU is usable. On a GPU, Heart is made many
# times faster than it plays, so speech starts at once and never pauses.
DEVICE = os.environ.get("VOICE_DEVICE", "cpu").lower()
STT_MODEL = os.environ.get("VOICE_STT_MODEL", "base.en")
STT_ONLY = os.environ.get("VOICE_STT_ONLY") == "1"
# Leave speech-to-text out (the cloud build, where Whisper doesn't fit).
SKIP_STT = os.environ.get("VOICE_SKIP_STT") == "1"
STT_DIR = Path(os.environ.get("VOICE_STT_DIR", HERE / "models" / "whisper")).resolve()


def providers() -> list:
    if DEVICE == "cuda" and "CUDAExecutionProvider" in ort.get_available_providers():
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    if DEVICE == "cuda":
        print("[voice] VOICE_DEVICE=cuda but no usable GPU; running on the CPU", flush=True)
    return ["CPUExecutionProvider"]
# Voices loaded at start-up rather than on first use: live mode's fast voices.
PRELOAD = [v for v in os.environ.get("VOICE_PRELOAD", "").split(",") if v]

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
        str(MODELS / "kokoro" / KOKORO_MODEL),
        sess_options=session_options(),
        providers=providers(),
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
    """Models, loaded once and shared. Up to WORKERS sentences are made at the
    same time, each on its own core: onnxruntime runs one session from many
    threads safely. Turning text into phonemes (espeak) is not known to be
    thread-safe, so that short step takes a lock."""

    def __init__(self) -> None:
        self.kokoro: Kokoro | None = None
        self.whisper = None
        self.piper: dict[str, PiperVoice] = {}
        self.slots = threading.BoundedSemaphore(WORKERS)
        self.phonemize_lock = threading.Lock()
        self.piper_lock = threading.Lock()
        self.load_lock = threading.Lock()
        # Separate from load_lock, which load() itself takes for Piper voices.
        self.init_lock = threading.Lock()

    def load(self) -> None:
        started = time.perf_counter()
        if STT_ONLY:
            self.load_whisper()
            print(f"[voice] speech-to-text only ({STT_MODEL}) ready in {time.perf_counter() - started:.1f}s", flush=True)
            return
        self.kokoro = load_kokoro()
        # Warm-up: the first run is slow while onnxruntime plans the graph.
        self.kokoro.create("Ready.", voice=DEFAULT_VOICE, speed=1.0, lang="en-us")
        for voice_id in PRELOAD:
            if voice_id in VOICES and VOICES[voice_id]["engine"] == "piper":
                self.piper_voice(voice_id)
                list(self.piper[voice_id].synthesize("Ready."))
        if not SKIP_STT:
            self.load_whisper()
        print(f"[voice] Kokoro ({KOKORO_MODEL}) and {len(PRELOAD)} Piper voice(s) ready in {time.perf_counter() - started:.1f}s, {WORKERS} parallel x {THREADS} thread(s) on {providers()[0]}, models in {MODELS}", flush=True)

    def load_whisper(self) -> None:
        # Speech to text for Astra Assist. A failure here leaves speaking
        # working and only /transcribe unavailable.
        try:
            from faster_whisper import WhisperModel

            self.whisper = WhisperModel(
                STT_MODEL,
                device="cuda" if providers()[0] == "CUDAExecutionProvider" else "cpu",
                compute_type="int8",
                cpu_threads=max(1, (os.cpu_count() or 2) // 2),
                download_root=str(STT_DIR),
            )
        except Exception as err:  # noqa: BLE001 - reported, not fatal
            print(f"[voice] speech-to-text unavailable: {err}", flush=True)

    def ensure_loaded(self) -> None:
        """Loads the models on first use, for hosts that skip FastAPI's startup
        hook (serverless). Elsewhere the startup hook has already done it."""
        if self.kokoro is None and not STT_ONLY:
            with self.init_lock:
                if self.kokoro is None:
                    self.load()

    def piper_voice(self, voice_id: str) -> PiperVoice:
        if PiperVoice is None:
            raise FileNotFoundError("Piper is not installed here")
        with self.load_lock:
            if voice_id not in self.piper:
                gender = VOICES[voice_id]["gender"]
                path = MODELS / "piper" / gender / f"{voice_id}.onnx"
                voice = PiperVoice.load(str(path))
                voice.session = ort.InferenceSession(str(path), sess_options=session_options(), providers=providers())
                self.piper[voice_id] = voice
            return self.piper[voice_id]

    def synthesize(self, text: str, voice_id: str) -> tuple[bytes, float, int]:
        """WAV bytes, seconds of audio, sample rate."""
        meta = VOICES[voice_id]
        text = apply_pronunciations(text)
        if meta["engine"] == "kokoro":
            self.ensure_loaded()
            if self.kokoro is None:
                raise RuntimeError("Kokoro is not loaded")
            lang = "en-gb" if voice_id.startswith("b") else "en-us"
            with self.phonemize_lock:
                phonemes = self.kokoro.tokenizer.phonemize(text, lang)
            with self.slots:
                samples, rate = self.kokoro.create(phonemes, voice=voice_id, speed=1.0, is_phonemes=True)
            buf = io.BytesIO()
            sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
            return buf.getvalue(), len(samples) / rate, rate

        voice = self.piper_voice(voice_id)
        with self.slots, self.piper_lock:
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


@app.post("/transcribe")
async def transcribe(request: Request, x_voice_secret: str | None = Header(default=None)) -> dict:
    """16 kHz mono WAV in (any WAV is accepted and resampled), text out."""
    check_secret(x_voice_secret)
    if engines.whisper is None:
        raise HTTPException(status_code=503, detail="speech-to-text is not available")
    body = await request.body()
    if not body or len(body) > 25_000_000:
        raise HTTPException(status_code=413, detail="audio missing or too long")
    try:
        audio, rate = sf.read(io.BytesIO(body), dtype="float32")
    except Exception:
        raise HTTPException(status_code=415, detail="send WAV audio")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != 16000:
        n = int(len(audio) * 16000 / rate)
        audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)
    started = time.perf_counter()

    def run() -> str:
        with engines.slots:
            # The app already trims silence, so Whisper's own filter and
            # timestamps are skipped: the same words, a little sooner.
            segments, _ = engines.whisper.transcribe(
                audio, language="en", beam_size=1, vad_filter=False, without_timestamps=True, condition_on_previous_text=False
            )
            return " ".join(seg.text.strip() for seg in segments).strip()

    import anyio

    text = await anyio.to_thread.run_sync(run)
    return {"text": text, "seconds": round(len(audio) / 16000, 2), "ms": round((time.perf_counter() - started) * 1000)}


@app.get("/voices")
def voices(x_voice_secret: str | None = Header(default=None)) -> dict:
    check_secret(x_voice_secret)
    return CATALOGUE


@app.get("/health")
def health() -> dict:
    engines.ensure_loaded()
    if engines.kokoro is None and not (STT_ONLY and engines.whisper is not None):
        raise HTTPException(status_code=503, detail="loading")
    return {
        "status": "ok",
        "workers": WORKERS,
        "threads": THREADS,
        "piperLoaded": sorted(engines.piper),
        "speechToText": STT_MODEL if engines.whisper is not None else None,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5005")), log_level="warning")
