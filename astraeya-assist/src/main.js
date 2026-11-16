// Astra Assist: Astraeya on the Windows desktop.
//
// Windows + Ctrl + A turns it on: a small Astraeya bubble follows the cursor,
// listens, looks at the screen when asked something, and answers out loud.
// The same keys turn it off. It never captures the screen or listens while
// it is off.

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  screen,
  desktopCapturer,
  clipboard,
  safeStorage,
  nativeImage,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const HOTKEYS = ["Super+Control+A", "Control+Alt+A"];
/** Longest side of the screenshot sent to the model; larger only costs time. */
const MAX_SHOT = 1568;

let tray = null;
let setupWin = null;
let bubbleWin = null;
let pointerWin = null;
let followTimer = null;
let active = false;
let hotkey = null;

// ---------------------------------------------------------------------------
// Settings: the API address, and the sign-in token (encrypted by Windows).
// ---------------------------------------------------------------------------

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function apiUrl() {
  return (process.env.ASTRAEYA_API_URL || readSettings().apiUrl || "http://localhost:4000").replace(/\/$/, "");
}

function getToken() {
  const s = readSettings();
  if (!s.token) return null;
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(s.token, "base64")) : s.token;
  } catch {
    return null;
  }
}

function saveToken(token) {
  const stored = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token).toString("base64") : token;
  writeSettings({ token: stored });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function openSetup() {
  if (setupWin) return setupWin.focus();
  setupWin = new BrowserWindow({
    width: 440,
    height: 600,
    resizable: false,
    title: "Astra Assist",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  setupWin.loadFile(path.join(__dirname, "setup.html"));
  setupWin.on("closed", () => (setupWin = null));
}

function createBubble() {
  bubbleWin = new BrowserWindow({
    width: 340,
    height: 150,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  // Clicks go straight through to whatever is underneath.
  bubbleWin.setIgnoreMouseEvents(true);
  bubbleWin.loadFile(path.join(__dirname, "bubble.html"));
}

function createPointer() {
  const { bounds } = screen.getPrimaryDisplay();
  pointerWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  pointerWin.setAlwaysOnTop(true, "screen-saver");
  pointerWin.setIgnoreMouseEvents(true);
  pointerWin.loadFile(path.join(__dirname, "pointer.html"));
}

/** The bubble sits just below and to the right of the cursor, kept on screen. */
function follow() {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(p);
  const [w, h] = bubbleWin.getSize();
  let x = p.x + 22;
  let y = p.y + 22;
  if (x + w > workArea.x + workArea.width) x = p.x - w - 12;
  if (y + h > workArea.y + workArea.height) y = p.y - h - 12;
  bubbleWin.setPosition(Math.round(x), Math.round(y), false);
}

// ---------------------------------------------------------------------------
// On and off
// ---------------------------------------------------------------------------

function setActive(on) {
  if (on && !getToken()) {
    openSetup();
    return;
  }
  active = on;
  if (on) {
    follow();
    bubbleWin.showInactive();
    followTimer = setInterval(follow, 16);
    bubbleWin.webContents.send("assist:start");
  } else {
    clearInterval(followTimer);
    followTimer = null;
    bubbleWin.webContents.send("assist:stop");
    bubbleWin.hide();
    pointerWin?.hide();
  }
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(active ? "Astra Assist is on (press the keys again to turn it off)" : `Astra Assist: press ${hotkeyLabel()} to start`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: active ? "Turn off" : `Turn on (${hotkeyLabel()})`, click: () => setActive(!active) },
      { label: "Settings and sign-in", click: openSetup },
      { type: "separator" },
      { label: "Quit Astra Assist", click: () => app.quit() },
    ])
  );
}

function hotkeyLabel() {
  return hotkey === "Super+Control+A" ? "Windows + Ctrl + A" : hotkey === "Control+Alt+A" ? "Ctrl + Alt + A" : "the hotkey";
}

// ---------------------------------------------------------------------------
// What the renderer asks for
// ---------------------------------------------------------------------------

ipcMain.handle("assist:config", () => ({ apiUrl: apiUrl(), token: getToken(), hotkey: hotkeyLabel(), signedIn: Boolean(getToken()) }));

ipcMain.handle("assist:sign-in", async (_e, { email, password, server }) => {
  if (server) writeSettings({ apiUrl: server.replace(/\/$/, "") });
  const res = await fetch(`${apiUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).catch(() => null);
  if (!res) return { ok: false, error: `Could not reach Astraeya at ${apiUrl()}.` };
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) return { ok: false, error: body.error || "Those details didn't work." };
  saveToken(body.token);
  updateTray();
  return { ok: true, name: body.user?.displayName || body.user?.email || "" };
});

ipcMain.handle("assist:sign-out", () => {
  writeSettings({ token: null });
  if (active) setActive(false);
  return { ok: true };
});

/**
 * A screenshot of the display under the cursor, downscaled for the model, and
 * where the cursor is in it. Only ever taken while Astra Assist is on.
 */
ipcMain.handle("assist:capture", async () => {
  if (!active) return null;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width, height } = display.size;
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source) return null;
  let image = source.thumbnail;
  const size = image.getSize();
  const ratio = Math.min(1, MAX_SHOT / Math.max(size.width, size.height));
  if (ratio < 1) image = image.resize({ width: Math.round(size.width * ratio), quality: "good" });
  const shot = image.getSize();
  return {
    mediaType: "image/jpeg",
    base64: image.toJPEG(82).toString("base64"),
    width: shot.width,
    height: shot.height,
    cursor: {
      x: ((cursor.x - display.bounds.x) / width) * shot.width,
      y: ((cursor.y - display.bounds.y) / height) * shot.height,
    },
    display: { id: display.id, bounds: display.bounds },
  };
});

/** Points at a spot the model found, given in screenshot pixels. */
ipcMain.on("assist:point", (_e, { x, y, label, shot }) => {
  if (!active || !shot) return;
  const b = shot.display.bounds;
  const sx = b.x + (x / shot.width) * b.width;
  const sy = b.y + (y / shot.height) * b.height;
  if (!pointerWin || pointerWin.isDestroyed()) createPointer();
  pointerWin.setBounds(b);
  pointerWin.showInactive();
  pointerWin.webContents.send("pointer:show", { x: sx - b.x, y: sy - b.y, label });
});

ipcMain.on("assist:clipboard", (_e, text) => {
  if (typeof text === "string" && text.trim()) clipboard.writeText(text);
});

ipcMain.on("assist:open-chat", () => {
  const web = (readSettings().webUrl || "http://localhost:3000").replace(/\/$/, "");
  shell.openExternal(`${web}/chat`);
});

ipcMain.on("assist:off", () => setActive(false));

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => openSetup());

  app.whenReady().then(() => {
    app.setAppUserModelId("com.wezitech.astraassist");
    createBubble();
    createPointer();

    for (const key of HOTKEYS) {
      if (globalShortcut.register(key, () => setActive(!active))) {
        hotkey = key;
        break;
      }
    }

    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png")).resize({ width: 16, height: 16 }));
    tray.on("click", () => setActive(!active));
    updateTray();

    // First run, or not signed in: show the set-up screen.
    if (!getToken() || process.argv.includes("--setup")) openSetup();
    if (process.argv.includes("--on")) setActive(true);
  });

  // For automated tests only: switch on and off without the keyboard.
  if (process.env.ASTRA_ASSIST_TEST) global.__astraAssist = { setActive, isActive: () => active };

  app.on("window-all-closed", (e) => e.preventDefault());
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
