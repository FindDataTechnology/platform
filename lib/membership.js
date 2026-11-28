// Task-bound temporary membership (agent-as-employee-model 4.3).
//
// A member row may carry `boundTaskId`: its team access lives only while that
// task is live. Checked at access time against the task record, so no cleanup
// job is needed for correctness — a missed sweep cannot leave access open.

const TERMINAL_STATUSES = new Set(["completed", "expired"]);

// Returns { active: true } or { active: false, reason }.
// `getTask(id)` returns the raw task record or null.
export function membershipActive(member, getTask) {
  if (!member?.boundTaskId) return { active: true };
  const task = getTask(member.boundTaskId);
  if (!task) return { active: false, reason: `bound task ${member.boundTaskId} no longer exists — temporary membership ended` };
  if (TERMINAL_STATUSES.has(task.status)) {
    return { active: false, reason: `bound task ${member.boundTaskId} is ${task.status} — temporary membership ended with it` };
  }
  return { active: true };
}
