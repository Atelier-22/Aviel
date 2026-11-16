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
const MAX_SHOT = 1280;

// The windows are tiny and mostly transparent. Compositing them on the GPU
// cost over a gigabyte of memory and kept Windows redrawing the screen;
// drawing them in software costs almost nothing.
app.disableHardwareAcceleration();

let tray = null;
let setupWin = null;
let bubbleWin = null;
let pointerWin = null;
let followTimer = null;
let pointerTimer = null;
let lastCursor = { x: -1, y: -1 };
let lastAnchor = "";

/** The bubble window: the logo in one corner, the text card beside it. */
const BUBBLE_W = 380;
const BUBBLE_H = 270;
/** The logo's size plus its margin, and its distance from the cursor tip. */
const ORB = 66;
const GAP = 14;
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
  // The live Astraeya by default; a local server only when chosen in set-up
  // (the Server field) or through ASTRAEYA_API_URL for development.
  return (process.env.ASTRAEYA_API_URL || readSettings().apiUrl || "https://astraeya-api.onrender.com").replace(/\/$/, "");
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
    width: BUBBLE_W,
    height: BUBBLE_H,
    frame: false,
    transparent: true,
    resizable: false,
    useContentSize: true,
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
function follow(force = false) {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  // Only when the cursor has actually moved: moving a window for nothing
  // makes Windows redraw it.
  if (!force && p.x === lastCursor.x && p.y === lastCursor.y) return;
  lastCursor = p;
  const wa = screen.getDisplayNearestPoint(p).workArea;
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;

  // The logo always sits just below-right of the cursor tip; only if the
  // cursor is right at the screen's edge does it go to the other side.
  const orbLeft = p.x + GAP + ORB <= right ? p.x + GAP : p.x - GAP - ORB;
  const orbTop = p.y + GAP + ORB <= bottom ? p.y + GAP : p.y - GAP - ORB;
  // The text card opens towards whichever side has room.
  const cardRight = orbLeft + BUBBLE_W <= right;
  const cardBelow = orbTop + BUBBLE_H <= bottom;
  const x = cardRight ? orbLeft : orbLeft + ORB - BUBBLE_W;
  const y = cardBelow ? orbTop : orbTop + ORB - BUBBLE_H;

  // setBounds with the size every time: at 150% scaling, moving a window
  // without it makes Windows grow it a few pixels at a time.
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width: BUBBLE_W, height: BUBBLE_H }, false);
  const anchor = `${cardRight ? "left" : "right"}-${cardBelow ? "top" : "bottom"}`;
  if (anchor !== lastAnchor) {
    lastAnchor = anchor;
    bubbleWin.webContents.send("assist:anchor", anchor);
  }
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
    follow(true);
    bubbleWin.showInactive();
    // Checked 60 times a second; the window only moves when the cursor did.
    followTimer = setInterval(follow, 16);
    bubbleWin.webContents.send("assist:start");
  } else {
    clearInterval(followTimer);
    followTimer = null;
    bubbleWin.webContents.send("assist:stop");
    bubbleWin.hide();
    clearTimeout(pointerTimer);
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
    base64: image.toJPEG(75).toString("base64"),
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
  // The full-screen layer is hidden again as soon as the marker has faded.
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => pointerWin?.hide(), 6500);
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

// Automated tests run as a separate copy with their own settings, so they
// never touch (or are blocked by) the installed app.
const TESTING = Boolean(process.env.ASTRA_ASSIST_TEST);
if (TESTING) app.setPath("userData", `${app.getPath("userData")}-test`);

if (!TESTING && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Starting it again with --quit closes the running copy (used by the
  // installer when updating); otherwise it opens the settings.
  app.on("second-instance", (_e, argv) => (argv.includes("--quit") ? app.quit() : openSetup()));

  app.whenReady().then(() => {
    app.setAppUserModelId("com.wezitech.astraassist");
    // Always there: it starts with Windows (quietly, in the tray), so the
    // keys work any time. Not for test copies.
    if (!TESTING && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ["--background"] });
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
    if ((!getToken() && !process.argv.includes("--background")) || process.argv.includes("--setup")) openSetup();
    if (process.argv.includes("--on")) setActive(true);
  });

  // For automated tests only: switch on and off without the keyboard.
  if (process.env.ASTRA_ASSIST_TEST) global.__astraAssist = { setActive, isActive: () => active };

  app.on("window-all-closed", (e) => e.preventDefault());
  app.on("will-quit", () => globalShortcut.unregisterAll());
}
