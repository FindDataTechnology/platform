// ── Preload script for the main window ───────────────────────────────────────
// Exposes only whitelisted IPC channels via contextBridge.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("platform", {
  // Open the native folder picker; resolves to the selected path or null.
  pickWorkdir: () => ipcRenderer.invoke("workdir:pick"),
});
