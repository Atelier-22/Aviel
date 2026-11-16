# Vercel entry point: the same voice server, Kokoro only (Heart and the other
# Kokoro voices). Vercel's Python runtime serves the FastAPI `app` it finds here.
from server import app  # noqa: F401
