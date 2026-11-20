// ── Revision storage (harden-agent-runtime-spine, runtime-revision 5.1) ─────
//
// Two tables, and the split is the same one the claim lane makes:
//
//   runtime_revisions   one row per revision (identity = fingerprint), CURRENT
//                       state, what promote/rollback read and move.
//   runtime_governance  append-only audit — one row per promote/rollback, so
//                       "who moved the pointer and why" survives any rollback.
//
// The pointer is NOT a third table: "what is active" is `state = 'active'` on
// exactly one row per deployment. A separate pointer row would be a second
// truth about the same fact, and the two could disagree after a crash.
//
// Per-deployment scoping: one cell hosts many pack deployments, and "v3" of two
// different packs are unrelated. The deployment key is the pack id (+ owner),
// carried on the revision so a lookup is by (deployment, fingerprint).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runtime_revisions (
     deployment TEXT NOT NULL,
     revision_id TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     name TEXT,
     pack_id TEXT,
     pack_version TEXT,
     overrides TEXT,
     state TEXT NOT NULL DEFAULT 'candidate',
     trial TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (deployment, revision_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runtime_revisions_active ON runtime_revisions(deployment, state)`,
  `CREATE TABLE IF NOT EXISTS runtime_governance (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     deployment TEXT NOT NULL,
     action TEXT NOT NULL,
     from_revision TEXT,
     to_revision TEXT NOT NULL,
     by TEXT,
     reason TEXT,
     overridden INTEGER NOT NULL DEFAULT 0,
     override_reason TEXT,
     at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_runtime_governance_deploy ON runtime_governance(deployment, at)`,
];

const parse = (s) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/**
 * @param {object} p
 * @param {import("better-sqlite3").Database} p.db
 * @param {() => number} [p.now]
 */
export function createRevisionStore({ db, now = Date.now }) {
  for (const sql of SCHEMA) db.exec(sql);

  const getStmt = db.prepare("SELECT * FROM runtime_revisions WHERE deployment = ? AND revision_id = ?");
  const activeStmt = db.prepare("SELECT * FROM runtime_revisions WHERE deployment = ? AND state = 'active' LIMIT 1");
  const listStmt = db.prepare("SELECT * FROM runtime_revisions WHERE deployment = ? ORDER BY created_at DESC");
  const upsertStmt = db.prepare(`
    INSERT INTO runtime_revisions (deployment, revision_id, fingerprint, name, pack_id, pack_version, overrides, state, trial, created_at, updated_at)
    VALUES (@deployment, @revision_id, @fingerprint, @name, @pack_id, @pack_version, @overrides, @state, @trial, @created_at, @updated_at)
    ON CONFLICT(deployment, revision_id) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      pack_version = COALESCE(excluded.pack_version, pack_version),
      overrides = COALESCE(excluded.overrides, overrides),
      trial = COALESCE(excluded.trial, trial),
      updated_at = excluded.updated_at
  `);
  const setState = db.prepare("UPDATE runtime_revisions SET state = ?, updated_at = ? WHERE deployment = ? AND revision_id = ?");
  const retireOthers = db.prepare("UPDATE runtime_revisions SET state = 'retired', updated_at = ? WHERE deployment = ? AND state = 'active' AND revision_id != ?");
  const setTrial = db.prepare("UPDATE runtime_revisions SET trial = ?, updated_at = ? WHERE deployment = ? AND revision_id = ?");

  const rowToRev = (r) =>
    r && {
      deployment: r.deployment,
      revisionId: r.revision_id,
      fingerprint: r.fingerprint,
      name: r.name,
      packId: r.pack_id,
      packVersion: r.pack_version,
      overrides: parse(r.overrides),
      state: r.state,
      trial: parse(r.trial),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };

  // Trials are mutated in place (they are one report per revision, replaced by
  // a re-run) — unlike governance rows, they are not history.
  function record(revision) {
    if (!revision?.fingerprint) throw Object.assign(new Error("revision needs a fingerprint"), { code: "REVISION_NO_FINGERPRINT" });
    // A revision without a deployment cannot be scoped: "v3" of two packs are
    // unrelated, and a NULL here would put them in one bucket. Say which field
    // is missing instead of letting SQLite report a NOT NULL constraint.
    if (!revision.deployment) throw Object.assign(new Error("revision needs a deployment (its scope)"), { code: "REVISION_NO_DEPLOYMENT" });
    const t = now();
    upsertStmt.run({
      deployment: revision.deployment,
      revision_id: revision.revisionId ?? revision.fingerprint,
      fingerprint: revision.fingerprint,
      name: revision.name ?? null,
      pack_id: revision.packId ?? null,
      pack_version: revision.packVersion ?? null,
      overrides: revision.overrides ? JSON.stringify(revision.overrides) : null,
      state: revision.state ?? "candidate",
      trial: revision.trial ? JSON.stringify(revision.trial) : null,
      created_at: revision.createdAt ?? t,
      updated_at: t,
    });
    return get(revision.deployment, revision.revisionId ?? revision.fingerprint);
  }

  function get(deployment, revisionId) {
    return rowToRev(getStmt.get(deployment, revisionId));
  }
  function active(deployment) {
    return rowToRev(activeStmt.get(deployment));
  }
  function list(deployment) {
    return listStmt.all(deployment).map(rowToRev);
  }
  function attachTrial(deployment, revisionId, trial) {
    setTrial.run(trial ? JSON.stringify(trial) : null, now(), deployment, revisionId);
    return get(deployment, revisionId);
  }

  /**
   * Move the pointer. `from` is read INSIDE the same transaction that writes,
   * so a concurrent promote cannot leave two active revisions — exactly the
   * failure a separate pointer row would allow.
   */
  function movePointer(deployment, revisionId, { action, by = null, reason = null, overridden = false, overrideReason = null } = {}) {
    return db.transaction(() => {
      const before = active(deployment);
      retireOthers.run(now(), deployment, revisionId);
      setState.run("active", now(), deployment, revisionId);
      db.prepare(`INSERT INTO runtime_governance (deployment, action, from_revision, to_revision, by, reason, overridden, override_reason, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        deployment, action, before?.revisionId ?? null, revisionId, by, reason, overridden ? 1 : 0, overrideReason, now(),
      );
      return { before: before?.revisionId ?? null, after: revisionId, revision: get(deployment, revisionId) };
    })();
  }

  function governance(deployment) {
    return db.prepare("SELECT * FROM runtime_governance WHERE deployment = ? ORDER BY at ASC, id ASC").all(deployment)
      .map((r) => ({
        action: r.action,
        from: r.from_revision,
        to: r.to_revision,
        by: r.by,
        reason: r.reason,
        overridden: r.overridden === 1,
        overrideReason: r.override_reason,
        at: r.at,
      }));
  }

  return { record, get, active, list, attachTrial, movePointer, governance };
}
