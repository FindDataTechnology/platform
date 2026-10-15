// Type definitions for the Electron preload bridge (exposed via contextBridge in
// electron/main-preload.js). Undefined when running in a plain browser (web dev).

export interface PlatformAPI {
  /** Open the native folder picker; resolves to the selected path or null. */
  pickWorkdir: () => Promise<string | null>;
}

declare global {
  interface Window {
    platform?: PlatformAPI;
  }
}
