# astraeya-voice

Astraeya's voice server: text in, speech out, on the CPU. Kokoro-82M (27
voices, default `af_heart`) and eight Piper voices. A private service: only
`astraeya-api` calls it, with a shared secret.

- `server.py` — the server (FastAPI). `POST /synthesize {text, voice}` returns a WAV
  for one sentence; the API splits replies into sentences and streams them.
- `voices.json` — the catalogue (copied from `voices/voices.json`; the API keeps
  its own copy in `src/voice/catalogue.ts`, and a test fails if they drift).
- `models.json` + `download_models.py` — every model file, its URL and SHA-256.
- `pronunciations.json` — words the voices should say differently.

Run locally (PowerShell):

```powershell
cd astraeya-voice
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python server.py      # uses ..\voices for models if present
```

Notes kept from the reference scripts: Kokoro is used at speed 1.0 only, and
kokoro-onnx 0.4.7's int32 `speed` input is cast to float32 before it reaches
onnxruntime. Each Piper `.onnx` sits next to its `.onnx.json`.

Licences: Kokoro-82M is Apache 2.0. The Piper voices are public domain or CC0,
except Cori (medium) and Kathleen, which need this credit wherever their audio
is published: "Voice trained on the Hi-Fi Multi-Speaker English TTS Dataset
(NVIDIA, reader 92, Cori Samuel), CC BY 4.0, https://www.openslr.org/109/".
The app shows these credits on its Help page.
