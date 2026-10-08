// Re-export: the supervisor lifecycle implementation lives in the shared,
// Electron-agnostic `supervisor/` package at repo root so the headless
// local-services launcher can reuse it. The Electron main process imports
// `Supervisor` from here unchanged.
export { Supervisor } from "../../supervisor/lifecycle.js";
