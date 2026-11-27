// IS_DESKTOP — true inside the Electron shell only. The preload bridge
// (electron/main-preload.js, contextBridge) is the single tell: it exists in
// the desktop app and never in a plain browser. Same idiom as Sidebar's
// CAN_PICK_NATIVE / ControlStrip's folder-picker gate — one definition shared
// by every surface that forks on desktop-vs-web (fleet nav, fleet page).
export const IS_DESKTOP =
  typeof window !== "undefined" && typeof window.platform?.pickWorkdir === "function";
