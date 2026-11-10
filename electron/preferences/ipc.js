// ── IPC handlers for Preferences window ─────────────────────────────────────
//
// Exposes the supervisor reference to the window module.

/** @type {import('../supervisor/lifecycle.js').Supervisor} */
let supervisor = null;

export function setSupervisor(s) {
  supervisor = s;
}

export function getSupervisor() {
  return supervisor;
}
