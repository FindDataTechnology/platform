// ── Preferences IPC for the update lifecycle (add-desktop-in-app-update) ────
//
// Whitelisted channels mirroring window.js's pattern: the renderer reads the
// update state, triggers an explicit check, opens the mac notify-only download
// URL, and quits-into-install ONLY through an explicit user action.

import { ipcMain } from "electron";

export function registerUpdaterIpc(updater) {
  ipcMain.handle("update:get-state", () => updater.getState());
  ipcMain.handle("update:check", async () => {
    await updater.check();
    return updater.getState();
  });
  ipcMain.handle("update:quit-and-install", () => ({ ok: updater.quitAndInstall() }));
  ipcMain.handle("update:open-download", async () => ({ ok: await updater.openDownload() }));
}
