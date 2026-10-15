// ── Child process spawn / stop ───────────────────────────────────────────────
//
// Spawns a server as a child process using the bundled (or, in dev, system)
// Node binary - never Electron's Node - so native addons (better-sqlite3,
// tree-sitter) run on their standard ABI with no rebuild (Decision D4).
// The Electron main process itself stays pure JS and never imports server.js.

import fs from "node:fs";
import { spawn } from "node:child_process";

export function spawnServer(descriptor, { onLog, onExit } = {}) {
  const { cmd, args, cwd, env: descEnv = {} } = descriptor.start || {};

  // Defensive check for existence: clearer error in logs before spawn
  if (!fs.existsSync(cmd)) {
    try { onLog?.("stderr", `spawn error: command not found: ${cmd} (kind: ${descriptor.kind})`); } catch { /* swallow */ }
    onExit?.(-2, null);
    return null;
  }

  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...descEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const push = (stream) => (d) => {
    try { onLog?.(stream, d.toString()); } catch { /* swallow */ }
  };
  child.stdout?.on("data", push("stdout"));
  child.stderr?.on("data", push("stderr"));
  child.on("exit", (code, signal) => onExit?.(code, signal));
  child.on("error", (err) => {
    try { onLog?.("stderr", `spawn error: ${err.message}`); } catch { /* swallow */ }
    onExit?.(-1, null);
  });
  return child;
}

// Graceful SIGTERM, then SIGKILL after a timeout. Resolves once the child is gone.
export function stopChild(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode) return resolve();
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", fin);
    try { child.kill("SIGTERM"); } catch { fin(); }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, timeoutMs);
    setTimeout(fin, timeoutMs + 1000);
  });
}
