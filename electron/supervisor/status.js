// ── Status inspection IPC ────────────────────────────────────────────────────
//
// Exposes the supervisor's live server status to the renderer (spec: "Status
// inspection"). The renderer calls ipcRenderer.invoke("supervisor:status")
// via a preload bridge (added when the status UI panel is wired) and receives
// the array from Supervisor.status().

import { ipcMain } from "electron";

export function registerStatusIpc(supervisor) {
  ipcMain.handle("supervisor:status", () => supervisor.status());
}
