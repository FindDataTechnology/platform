// server/team-approvals.js — the "待批准调用" ledger (openspec:
// add-team-as-a2a-agent, 7.1–7.2).
//
// Why an approval is a ROW and not a decision at call time: a `listed` team
// says "you must ask me first", so the refusal has to LEAVE a trace the owner
// can act on. A stateless `needs_approval` that forgets the caller makes the
// product a dead end — the caller is told to wait for a permission nobody can
// grant.
//
// States are minimal on purpose: pending → approved | rejected. Expiry is a
// timestamp on the approved row, evaluated on read, so a one-off approval is
// `expires_at = NULL` and a time-boxed one needs no sweeper.

export const APPROVAL_STATUSES = Object.freeze(["pending", "approved", "rejected"]);

export function ensureTeamApprovalsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_call_approvals (
    cell_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    caller TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    decided_at INTEGER,
    decided_by TEXT,
    expires_at INTEGER,
    PRIMARY KEY (cell_id, handle, caller)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_team_approvals_status ON team_call_approvals(cell_id, handle, status)`);
}

/** Record (or refresh) a pending request. Idempotent: one row per caller. */
export function requestApproval(db, { cellId, handle, caller, now = Date.now() }) {
  const subject = String(caller ?? "").trim().toLowerCase();
  if (!subject) return { ok: false, error: "caller required" };
  const existing = db
    .prepare("SELECT status FROM team_call_approvals WHERE cell_id = ? AND handle = ? AND caller = ?")
    .get(cellId, handle, subject);
  // An already-approved caller asks again only because the approval expired.
  if (existing?.status === "approved") {
    const row = db
      .prepare("SELECT expires_at FROM team_call_approvals WHERE cell_id = ? AND handle = ? AND caller = ?")
      .get(cellId, handle, subject);
    if (row?.expires_at == null || row.expires_at > now) return { ok: true, status: "approved" };
  }
  db.prepare(
    `INSERT INTO team_call_approvals (cell_id, handle, caller, status, requested_at)
     VALUES (?, ?, ?, 'pending', ?)
     ON CONFLICT(cell_id, handle, caller) DO UPDATE SET
       status = 'pending', requested_at = excluded.requested_at, decided_at = NULL, decided_by = NULL, expires_at = NULL`,
  ).run(cellId, handle, subject, now);
  return { ok: true, status: "pending" };
}

/** The owner's queue: pending requests, oldest first. */
export function listPendingApprovals(db, { cellId, handle }) {
  return db
    .prepare(
      `SELECT caller, requested_at FROM team_call_approvals
        WHERE cell_id = ? AND handle = ? AND status = 'pending'
        ORDER BY requested_at ASC`,
    )
    .all(cellId, handle)
    .map((r) => ({ caller: r.caller, requestedAt: r.requested_at }));
}

/** Approve one caller. `expiresAt = null` means a one-off, standing approval. */
export function approveCaller(db, { cellId, handle, caller, by, expiresAt = null, now = Date.now() }) {
  const subject = String(caller ?? "").trim().toLowerCase();
  const changed = db
    .prepare(
      `UPDATE team_call_approvals
          SET status = 'approved', decided_at = ?, decided_by = ?, expires_at = ?
        WHERE cell_id = ? AND handle = ? AND caller = ?`,
    )
    .run(now, by ?? "", expiresAt, cellId, handle, subject);
  return { ok: changed.changes > 0 };
}

export function rejectCaller(db, { cellId, handle, caller, by, now = Date.now() }) {
  const subject = String(caller ?? "").trim().toLowerCase();
  const changed = db
    .prepare(
      `UPDATE team_call_approvals
          SET status = 'rejected', decided_at = ?, decided_by = ?, expires_at = NULL
        WHERE cell_id = ? AND handle = ? AND caller = ?`,
    )
    .run(now, by ?? "", cellId, handle, subject);
  return { ok: changed.changes > 0 };
}

/** What the policy layer consumes: live approvals only (expired ≠ approved). */
export function listApprovals(db, { cellId, handle, now = Date.now() }) {
  return db
    .prepare(
      `SELECT caller, expires_at FROM team_call_approvals
        WHERE cell_id = ? AND handle = ? AND status = 'approved'
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(cellId, handle, now)
    .map((r) => ({ subject: r.caller, expiresAt: r.expires_at ?? null }));
}

/** A caller's own standing, for the directory's button state. */
export function approvalStateFor(db, { cellId, handle, caller, now = Date.now() }) {
  const subject = String(caller ?? "").trim().toLowerCase();
  const row = db
    .prepare("SELECT status, expires_at FROM team_call_approvals WHERE cell_id = ? AND handle = ? AND caller = ?")
    .get(cellId, handle, subject);
  if (!row) return "none";
  if (row.status === "approved" && row.expires_at != null && row.expires_at <= now) return "expired";
  return row.status;
}
