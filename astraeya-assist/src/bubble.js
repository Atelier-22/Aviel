// The bubble that follows the cursor: listens, looks, answers.

// Listener, Voice and Sentences come from speech.js, loaded just before.

const $ = (id) => document.getElementById(id);
let config = null;
let listener = null;
let voice = null;
let busy = false;
let conversationId = null;
let voiceId = "af_heart";
let hideTimer = null;

/* ---------------------------------------------------------------- the mark */
(function drawMark() {
  const m = window.ASTRAEYA_MARK;
  const ns = "http://www.w3.org/2000/svg";
  const svg = $("mark");
  svg.setAttribute("viewBox", m.viewBox);
  const g = document.createElementNS(ns, "g");
  g.setAttribute("transform", m.transform);
  const spin = document.createElementNS(ns, "g");
  spin.id = "spin";
  const tilt = document.createElementNS(ns, "g");
  tilt.setAttribute("class", "ring-tilt");
  const ring = document.createElementNS(ns, "path");
  ring.setAttribute("d", m.ring);
  ring.setAttribute("fill", "#1E6BFF");
  tilt.appendChild(ring);
  spin.appendChild(tilt);
  const ink = document.createElementNS(ns, "path");
  ink.setAttribute("d", m.ink);
  ink.setAttribute("class", "ink");
  g.append(spin, ink);
  svg.appendChild(g);
})();

let spinAngle = 0;
let spinFrame = 0;
function setState(state) {
  document.body.dataset.state = state;
  if (listener) listener.strict = state === "speaking";
  const spinning = state === "thinking" || state === "speaking";
  if (spinning && !spinFrame) {
    const [cx, cy] = window.ASTRAEYA_MARK.ringCentre;
    const tick = () => {
      spinAngle = (spinAngle + 4) % 360;
      $("spin").setAttribute("transform", `rotate(${spinAngle} ${cx} ${cy})`);
      spinFrame = requestAnimationFrame(tick);
    };
    spinFrame = requestAnimationFrame(tick);
  } else if (!spinning && spinFrame) {
    cancelAnimationFrame(spinFrame);
    spinFrame = 0;
    $("spin").removeAttribute("transform");
  }
}

/* ----------------------------------------------------------------- caption */
function caption({ you, say, note } = {}) {
  clearTimeout(hideTimer);
  if (you !== undefined) $("you").textContent = you ? `You: ${you}` : "";
  if (say !== undefined) $("say").textContent = say;
  if (note !== undefined) $("note").textContent = note;
  $("card").classList.toggle("show", Boolean($("you").textContent || $("say").textContent || $("note").textContent));
}
function fadeCaption(ms = 9000) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => caption({ you: "", say: "", note: "" }), ms);
}

/* --------------------------------------------------------------- the loop */
async function heard(wav) {
  // Anything heard while Astraeya is talking is her own voice, unless the
  // person cut in (which switches the state back to listening first).
  if (busy || document.body.dataset.state === "speaking") return;
  busy = true;
  setState("thinking");
  try {
    const res = await fetch(`${config.apiUrl}/voice/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", Authorization: `Bearer ${config.token}` },
      body: wav,
    });
    const { text = "" } = res.ok ? await res.json() : {};
    const question = text.replace(/^\s*(hey,?\s+)?astra(eya)?[,.!]?\s*/i, "").trim();
    if (!question || /^(thank you\.?|you\.?|bye\.?)$/i.test(question)) {
      setState("listening");
      return;
    }
    if (/^(stop|turn (yourself )?off|goodbye|that'?s all)\b/i.test(question)) {
      caption({ you: question, say: "Okay, turning off.", note: "" });
      window.assist.turnOff();
      return;
    }
    caption({ you: question, say: "", note: "" });
    await ask(question);
  } catch {
    caption({ say: "", note: "I couldn't reach Astraeya. Check your connection." });
    setState("listening");
  } finally {
    busy = false;
  }
}

async function ask(question) {
  const shot = await window.assist.capture();
  caption({ note: shot ? "Looking at your screen…" : "" });
  voice = new Voice({
    apiUrl: config.apiUrl,
    token: config.token,
    voice: voiceId,
    onStart: () => setState("speaking"),
    onEnd: () => { if (document.body.dataset.state !== "off") setState("listening"); fadeCaption(); },
  });
  const sentences = new Sentences();
  const res = await fetch(`${config.apiUrl}/assist/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify({
      question,
      conversationId: conversationId || undefined,
      ...(shot ? { screenshot: { mediaType: shot.mediaType, base64: shot.base64, width: shot.width, height: shot.height }, cursor: shot.cursor } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    caption({ note: body.error || "Something went wrong. Try again." });
    setState("listening");
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let said = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop();
    for (const raw of events) {
      const type = raw.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(raw.match(/^data: (.*)$/m)?.[1] || "null");
      if (type === "meta") conversationId = data.conversationId;
      else if (type === "chunk") {
        said += data.text;
        caption({ say: said, note: "" });
        for (const s of sentences.push(data.text)) voice.enqueue(s);
      } else if (type === "point" && shot) {
        window.assist.point({ x: data.x, y: data.y, label: data.label, shot });
      } else if (type === "clipboard") {
        window.assist.copy(data.text);
        caption({ note: "Copied. Press Ctrl+V to paste." });
      } else if (type === "error") {
        caption({ note: data.message });
      }
    }
  }
  for (const s of sentences.end()) voice.enqueue(s);
  voice.end();
  if (!said.trim()) setState("listening");
}

/* ------------------------------------------------------------ on and off */
window.assist.onStart(async () => {
  config = await window.assist.config();
  if (!config.token) return;
  try {
    const s = await fetch(`${config.apiUrl}/settings`, { headers: { Authorization: `Bearer ${config.token}` } }).then((r) => r.json());
    voiceId = s?.settings?.voice?.outputVoice || s?.voice?.outputVoice || voiceId;
  } catch {}
  setState("listening");
  caption({ you: "", say: "I'm here. Ask me anything about your screen.", note: `${config.hotkey} turns me off.` });
  fadeCaption(5000);
  listener = new Listener({
    onUtterance: heard,
    // Talking over Astraeya stops it at once.
    onSpeechStart: () => {
      if (document.body.dataset.state === "speaking") { voice?.stop(); setState("listening"); }
      else if (!busy) setState("hearing");
    },
  });
  try {
    await listener.start();
  } catch {
    caption({ say: "", note: "I can't use the microphone. Allow it in Windows Settings > Privacy > Microphone." });
  }
});

window.assist.onStop(() => {
  voice?.stop();
  listener?.stop();
  listener = null;
  conversationId = null;
  setState("off");
  caption({ you: "", say: "", note: "" });
});
