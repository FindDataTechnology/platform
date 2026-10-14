// ── Per-server log ring buffer ───────────────────────────────────────────────
//
// Captures each child process's stdout/stderr (and lifecycle notices) into a
// bounded ring buffer, surfaced through the supervisor status API for display
// in the app's status panel.

const MAX_LINES = 500;

export class LogStore {
  constructor() {
    this.map = new Map(); // id -> Array<{ t, stream, line }>
  }

  push(id, stream, text) {
    const arr = this.map.get(id) || [];
    const t = Date.now();
    for (const line of String(text).split(/\r?\n/)) {
      if (line === "") continue;
      arr.push({ t, stream, line });
    }
    if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
    this.map.set(id, arr);
  }

  lines(id) {
    return this.map.get(id) || [];
  }
}
