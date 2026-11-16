// Speech for Astra Assist: hearing (a voice-activity recorder that hands over
// one utterance at a time as 16 kHz WAV) and speaking (the same streamed voice
// the Astraeya chat uses, played sentence by sentence).

/* ---------------------------------------------------------------- hearing */

const HEADSET = /headset|hands-?free|bluetooth|airpods|buds|headphone|earphone|\bbt\b/i;
const BUILT_IN = /built-?in|internal|microphone array|integrated|realtek|intel|laptop/i;

/** The computer's own microphone, even with headphones plugged in. */
async function builtInMicrophone() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications"
  );
  const pick = devices.find((d) => BUILT_IN.test(d.label) && !HEADSET.test(d.label)) || devices.find((d) => d.label && !HEADSET.test(d.label));
  return pick ? pick.deviceId : undefined;
}

/** 16-bit PCM WAV from float samples at `rate`, resampled to 16 kHz mono. */
function encodeWav(samples, rate) {
  const target = 16000;
  const n = Math.floor((samples.length * target) / rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[Math.min(samples.length - 1, Math.floor((i * rate) / target))];
    out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + out.byteLength);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + out.byteLength, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, target, true); v.setUint32(28, target * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, out.byteLength, true);
  new Int16Array(buf, 44).set(out);
  return new Uint8Array(buf);
}

/**
 * Listens all the time it is on and calls onUtterance(wav) each time the
 * person says something and pauses. onSpeechStart fires the moment speech is
 * heard (used to stop Astraeya talking when interrupted).
 */
class Listener {
  constructor({ onUtterance, onSpeechStart, onLevel }) {
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart || (() => {});
    this.onLevel = onLevel || (() => {});
    this.paused = false;
    /** While Astraeya speaks: only clearly louder, longer speech counts (cutting in). */
    this.strict = false;
  }

  async start() {
    const deviceId = await builtInMicrophone().catch(() => undefined);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Names appear only after permission; try again for the built-in one.
    if (!deviceId) {
      const again = await builtInMicrophone().catch(() => undefined);
      if (again) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: again }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      }
    }
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    const source = this.ctx.createMediaStreamSource(this.stream);
    const node = this.ctx.createScriptProcessor(2048, 1, 1);
    source.connect(node);
    node.connect(this.ctx.destination);

    const frameMs = (2048 / this.rate) * 1000;
    let floor = 0.004;
    let speaking = false;
    let loudMs = 0;
    let quietMs = 0;
    let chunks = [];
    const preRoll = [];

    node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      let sum = 0;
      for (const s of data) sum += s * s;
      const rms = Math.sqrt(sum / data.length);
      this.onLevel(rms);
      if (this.paused) return;
      // The background level drifts slowly; speech is well above it.
      if (!speaking) floor = floor * 0.98 + rms * 0.02;
      const threshold = Math.max(this.strict ? 0.03 : 0.012, floor * (this.strict ? 6 : 3));

      if (!speaking) {
        preRoll.push(data);
        if (preRoll.length > Math.ceil(300 / frameMs)) preRoll.shift();
        loudMs = rms > threshold ? loudMs + frameMs : 0;
        if (loudMs >= (this.strict ? 300 : 120)) {
          speaking = true;
          quietMs = 0;
          chunks = [...preRoll];
          this.onSpeechStart();
        }
        return;
      }
      chunks.push(data);
      quietMs = rms > threshold * 0.8 ? 0 : quietMs + frameMs;
      const length = chunks.length * frameMs;
      // A pause of 0.55 s ends the turn; 30 s is the most one turn can be.
      if (quietMs >= 550 || length > 30000) {
        speaking = false;
        loudMs = 0;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const all = new Float32Array(total);
        let o = 0;
        for (const c of chunks) { all.set(c, o); o += c.length; }
        chunks = [];
        if (length - quietMs > 350) this.onUtterance(encodeWav(all, this.rate));
      }
    };
    this.node = node;
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.node = this.stream = this.ctx = null;
  }
}

/* --------------------------------------------------------------- speaking */

/** Splits streamed text into sentences; the opening clause goes early. */
class Sentences {
  constructor() { this.buf = ""; this.first = true; }
  push(text) {
    this.buf += text;
    const out = [];
    for (;;) {
      // The opening words go as soon as there is a comma: "Peter," is
      // spoken while the rest is still being written.
      const m = this.buf.match(/^([\s\S]*?[.!?])(\s+)(?=\S)/) || (this.first ? this.buf.match(/^([\s\S]{4,}?[,;:])(\s+)/) : null);
      if (!m) break;
      out.push(m[1].trim());
      this.buf = this.buf.slice(m[0].length);
      this.first = false;
    }
    return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
  }
  end() { const rest = this.buf.trim(); this.buf = ""; return rest && /[\p{L}\p{N}]/u.test(rest) ? [rest] : []; }
}

/** Plays Astraeya's voice; stop() silences it at once. */
class Voice {
  constructor({ apiUrl, token, voice, onStart, onEnd }) {
    Object.assign(this, { apiUrl, token, voice, onStart, onEnd });
    this.ctx = new AudioContext();
    this.next = 0;
    this.sources = new Set();
    this.chain = Promise.resolve();
    this.pending = 0;
    this.stopped = false;
    this.started = false;
    this.ended = false;
    this.first = true;
  }

  enqueue(text) {
    if (this.stopped || !text.trim()) return;
    this.pending++;
    const first = this.first;
    this.first = false;
    // Each sentence's pieces are played the moment they arrive, in order;
    // at most two sentences are being made at once so the first is not
    // slowed down by the ones after it.
    const pieces = [];
    let finished = false;
    let wake = null;
    const push = (item) => { pieces.push(item); wake?.(); };
    const done = () => { finished = true; wake?.(); };
    this.slot().then(() => this.stream(text, first, push).finally(() => { this.release(); done(); }));
    this.chain = this.chain
      .then(async () => {
        for (;;) {
          if (pieces.length) { this.play(pieces.shift()); continue; }
          if (finished || this.stopped) break;
          await new Promise((r) => (wake = r));
          wake = null;
        }
      })
      .finally(() => { this.pending--; this.maybeEnd(); });
  }

  slot() {
    this.inFlight = this.inFlight || 0;
    this.waiting = this.waiting || [];
    if (this.inFlight < 2) { this.inFlight++; return Promise.resolve(); }
    return new Promise((r) => this.waiting.push(() => { this.inFlight++; r(); }));
  }

  release() {
    this.inFlight--;
    this.waiting.shift()?.();
  }

  end() { this.ended = true; this.maybeEnd(); }

  stop() {
    this.stopped = true;
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear();
    speechSynthesis.cancel();
  }

  /** Reads the speech frames as they stream in and hands each one over at once. */
  async stream(text, first, push) {
    if (this.stopped) return;
    try {
      const res = await fetch(`${this.apiUrl}/voice/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ text, voice: this.voice, first }),
      });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.stopped) break;
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
        for (;;) {
          if (buf.length < 8) break;
          const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          const hl = view.getUint32(0);
          if (buf.length < 8 + hl) break;
          const al = view.getUint32(4 + hl);
          if (buf.length < 8 + hl + al) break;
          const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl)));
          const wav = buf.slice(8 + hl, 8 + hl + al);
          buf = buf.slice(8 + hl + al);
          if (header.error || !al) throw new Error("voice unavailable");
          const buffer = await this.ctx.decodeAudioData(wav.buffer);
          buffer.pause = header.pause ?? 0.2;
          push(buffer);
        }
      }
    } catch {
      // Backup: the system voice, so the answer is still heard.
      push({ fallback: text });
    }
  }

  play(buffer) {
    if (this.stopped) return;
    if (buffer.fallback) {
      const u = new SpeechSynthesisUtterance(buffer.fallback);
      speechSynthesis.speak(u);
      if (!this.started) { this.started = true; this.onStart?.(); }
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.02, this.next);
    src.start(at);
    // Kept for diagnosing pauses: when each piece starts, and how long it is.
    (window.__plays ||= []).push([at, buffer.duration, buffer.pause]);
    this.next = at + buffer.duration + buffer.pause;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    if (!this.started) { this.started = true; setTimeout(() => this.onStart?.(), (at - this.ctx.currentTime) * 1000); }
  }

  maybeEnd() {
    if (!this.ended || this.pending || this.stopped || this.done) return;
    const wait = Math.max(0, this.next - this.ctx.currentTime) * 1000 + 80;
    setTimeout(() => {
      if (this.stopped || this.done) return;
      if (speechSynthesis.speaking) return setTimeout(() => this.maybeEnd(), 250);
      this.done = true;
      this.onEnd?.();
    }, wait);
  }
}

window.AssistSpeech = { Listener, Voice, Sentences, encodeWav };
