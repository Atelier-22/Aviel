// The only bridge between the app's pages and the rest of the PC.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assist", {
  config: () => ipcRenderer.invoke("assist:config"),
  signIn: (details) => ipcRenderer.invoke("assist:sign-in", details),
  signOut: () => ipcRenderer.invoke("assist:sign-out"),
  capture: () => ipcRenderer.invoke("assist:capture"),
  point: (spot) => ipcRenderer.send("assist:point", spot),
  copy: (text) => ipcRenderer.send("assist:clipboard", text),
  openChat: () => ipcRenderer.send("assist:open-chat"),
  turnOff: () => ipcRenderer.send("assist:off"),
  onStart: (fn) => ipcRenderer.on("assist:start", fn),
  onStop: (fn) => ipcRenderer.on("assist:stop", fn),
  onPointer: (fn) => ipcRenderer.on("pointer:show", (_e, spot) => fn(spot)),
});
