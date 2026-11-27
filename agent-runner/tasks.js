// ── Task registry (harden-agent-runtime-spine, a2a-task-handle) ─────────────
//
// The RUNNER half of the external task handle. The facade owns the caller-facing
// ledger (`wanxing_requests`); this module owns the per-agent runtime side so
// `tasks/get` can answer "what is happening to that task" from the process that
// is actually executing it.
//
// Scope, stated honestly:
//   • IN-MEMORY and bounded. The runner's task history dies with the process;
//     a caller asking about a task from before the last restart gets
//     `unknown` — which is a real answer, not "not found". The DURABLE record
//     is the claim/turn row on the platform side; this registry is the live
//     view.
//   • No per-task event buffer. `resubscribe` therefore cannot replay deltas
//     it never kept, and it says so instead of pretending to have stopped
//     receiving them. What it CAN do is deliver the settled result once the
//     task finishes — the terminal message is the durable part.
//
// The terminal vocabulary is the same closed set the claim lane uses, so a
// caller never sees a fifth word invented at this layer.

export const TASK_STATES = Object.freeze(["running", "done", "error", "cancelled"]);

const DEFAULT_MAX = 500;

export function createTaskRegistry({ now = Date.now, max = DEFAULT_MAX } = {}) {
  // Insertion-ordered (Map) so eviction is oldest-first without a sort.
  const tasks = new Map();

  function evict() {
    while (tasks.size > max) {
      const oldest = tasks.keys().next().value;
      tasks.delete(oldest);
    }
  }

  /** Minted at ACCEPT, before execution — so a caller always has an address. */
  function open({ taskId, agentKey, sessionId, contextId = null, text = "" }) {
    if (!taskId) throw new Error("taskId required");
    const row = {
      task_id: taskId,
      agent_key: agentKey ?? null,
      session_id: sessionId ?? null,
      context_id: contextId,
      text: String(text ?? "").slice(0, 2000),
      state: "running",
      opened_at: now(),
      settled_at: null,
      result: null,
      error: null,
      cancelled_by: null,
    };
    // A re-entry for the same id (an idempotent replay) keeps the FIRST row:
    // the attempt's start is a fact, not something a retry may move.
    if (!tasks.has(taskId)) tasks.set(taskId, row);
    evict();
    return tasks.get(taskId);
  }

  function settle(taskId, { state, result = null, error = null, cancelledBy = null } = {}) {
    const row = tasks.get(taskId);
    if (!row) return null;
    if (row.state !== "running") return row; // one-way: the first settle wins
    if (!TASK_STATES.includes(state) || state === "running") return row;
    row.state = state;
    row.settled_at = now();
    if (state === "done") row.result = result;
    if (state === "error") row.error = error ?? { code: null, message: "unknown error" };
    if (state === "cancelled") row.cancelled_by = cancelledBy;
    return row;
  }

  function get(taskId) {
    return tasks.get(taskId) ?? null;
  }

  /**
   * The `tasks/get` answer. `unknown` is its own state — "this process has no
   * record of that task" is different from "it failed" and from "not yours".
   */
  function describe(taskId) {
    const row = tasks.get(taskId);
    if (!row) return { task_id: taskId, state: "unknown", reason: "not in this runner's task window" };
    return {
      task_id: row.task_id,
      state: row.state,
      agent_key: row.agent_key,
      session_id: row.session_id,
      context_id: row.context_id,
      opened_at: row.opened_at,
      settled_at: row.settled_at,
      ...(row.state === "done" ? { result: row.result } : {}),
      ...(row.state === "error" ? { error: row.error } : {}),
      ...(row.state === "cancelled" ? { cancelled_by: row.cancelled_by } : {}),
    };
  }

  /** Mark a running task cancelled (the facade's cancel reached this runner). */
  function cancel(taskId, { by = "caller" } = {}) {
    return settle(taskId, { state: "cancelled", cancelledBy: by });
  }

  function size() {
    return tasks.size;
  }

  return { open, settle, get, describe, cancel, size };
}
