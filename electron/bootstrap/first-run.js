// Re-export: the first-run seeding implementation lives in the shared,
// Electron-agnostic `bootstrap/` package at repo root so the headless
// local-services launcher can reuse it. The Electron main process imports
// `runFirstRun` from here unchanged (it passes userDataDir + resourcesDir).
export { runFirstRun } from "../../bootstrap/first-run.js";
