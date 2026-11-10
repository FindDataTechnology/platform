// ── Fleet machines store (add-unified-fleet-console) ────────────────────────
//
// Platform-level state for the unified machine console, one JSON file at the
// gateway / single-process data root — the SAME convention as mp-bindings.json
// (atomic temp+rename, serialized mutations): platform state must exist ahead
// of any cell and cannot live in a cell's SQL store (hosted topology: each
// cell owns its database; the gateway process never reaches into it).
//
// Per paired steward device (keyed by deviceId, the steward token's `did`):
//   lastSeenAt        latest presence/manifest/detail arrival (roster liveness
//                     is derived from THIS, never from the sister-repo ingest)
//   presence          latest presence payload (whitelisted shape)
//   detail            latest cell_detail snapshot (whitelisted shape, per-device
//                     overwrite) + divergenceStreak recomputed on each write
//   desired           { version, entries } — the cloud-authored deployment
//                     expectation this machine pulls; version increments on
//                     every edit so the machine can tell "changed" from "same"
//   history           bounded metadata event ring (add-machine-lifecycle-
//                     console): newest first, capped at HISTORY_LIMIT. Only
//                     real transitions land here — a steady 60s heartbeat
//                     writes NOTHING (liveness/detail self-heal on the next
//                     beat, so their plain values stay in-memory as before).
//                     Event kinds: presence_flip | desired_change |
//                     merge_advance | rejects_flip | divergence_flip | unbound.
//                     Metadata only — never content-class fields.
//   lastSignal        the flip-detection signature { silence, desiredVersion,
//                     seenVersion, rejectSignature, divergenceVerdict } the
//                     history compares against
//   revokedAt         set when the pairing is revoked from the machine console;
//                     the row (with its history) is retained for
//                     HISTORY_RETENTION_MS then swept, and filtered from every
//                     roster view meanwhile
//
// Divergence counts ONLY cloud-desired entries missing from the machine's
// detail — manual local entries diverging from the desired set is the
// local-manual-wins design working as intended, never an alarm.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const HISTORY_LIMIT = 200;
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// The read path derives silence from lastSeenAt with the SAME default window
// the console routes use; flipping it is recorded via noteSilence.
export const DEFAULT_SILENCE_MS = 30 * 60 * 1000;

function freshRow() {
  return { ownerEmail: null, lastSeenAt: null, presence: null, detail: null, divergenceStreak: 0, desired: null, history: [], lastSignal: null, revokedAt: null };
}

// Old files (pre-history) load unchanged: absent fields take their defaults
// and no migration marker is needed — the JSON gains the keys on next write.
function normalizeRow(raw) {
  const row = { ...freshRow(), ...raw };
  if (!Array.isArray(row.history)) row.history = [];
  return row;
}

export function createFleetMachinesStore({ file, now = Date.now }) {
  let machines = {}; // deviceId -> row

  function sweepRevoked() {
    const cutoff = now() - HISTORY_RETENTION_MS;
    for (const key of Object.keys(machines)) {
      const row = machines[key];
      if (row?.revokedAt != null && row.revokedAt < cutoff) delete machines[key];
    }
  }

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      machines = {};
      for (const [key, row] of Object.entries(raw.machines ?? {})) machines[key] = normalizeRow(row);
    } catch {
      // Missing or unreadable file: start empty (first boot, or corrupt file).
      machines = {};
    }
    sweepRevoked();
  }

  let flushing = Promise.resolve();
  function persist() {
    flushing = flushing.then(async () => {
      sweepRevoked();
      const raw = { machines };
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(raw, null, 2));
      await rename(tmp, file);
    });
    return flushing;
  }

  function get(deviceId) {
    return machines[String(deviceId)] ?? null;
  }

  function pushEvent(row, at, kind, payload) {
    row.history.unshift({ at, kind, ...payload });
    if (row.history.length > HISTORY_LIMIT) row.history.length = HISTORY_LIMIT;
  }

  function ensureSignal(row) {
    if (!row.lastSignal) row.lastSignal = {};
    return row.lastSignal;
  }

  // Every steward door arrival lands here: liveness is a side effect of
  // reporting, never a separate probe. The only history this can write is the
  // silent→online (or first-report) flip — a steady heartbeat changes nothing
  // and persists nothing.
  function touch(deviceId, { ownerEmail, presence = null } = {}) {
    const key = String(deviceId);
    const row = machines[key] ?? freshRow();
    if (ownerEmail) row.ownerEmail = ownerEmail;
    row.lastSeenAt = now();
    if (presence) row.presence = presence;
    machines[key] = row;
    // A revoked machine that reports again has re-paired: clear the retention
    // marker so the row (and its new history) is live again — the cleared
    // desired set stays cleared (re-pair inherits nothing).
    if (row.revokedAt != null) row.revokedAt = null;
    const sig = ensureSignal(row);
    const from = sig.silence ?? "never_reported";
    if (from !== "online") {
      pushEvent(row, row.lastSeenAt, "presence_flip", { from, to: "online" });
      sig.silence = "online";
      void persist();
    }
    return row;
  }

  function recomputeDivergence(row) {
    const desired = row.desired;
    const detail = row.detail;
    if (!desired || !Array.isArray(desired.entries) || desired.entries.length === 0) return 0;
    if (!detail || !Array.isArray(detail.deployments)) return 0;
    const liveKeys = new Set(
      detail.deployments.filter((d) => d?.enabled).map((d) => `${d.packId}/${d.agentId}`),
    );
    const missing = desired.entries.filter(
      (e) => e?.enabled !== false && !liveKeys.has(`${e.packId}/${e.agentId}`),
    );
    return missing.length === 0 ? 0 : (row.divergenceStreak ?? 0) + 1;
  }

  // Convergence-outcome bookkeeping: consumed-version advance, merge-reject
  // appearance/clear, divergence episode start/end — each recorded exactly
  // when its signature changes. An unchanged detail snapshot (the common
  // every-minute case) adds no event and touches no disk.
  function recordDetail(deviceId, detail) {
    const key = String(deviceId);
    const row = machines[key];
    if (!row) return null;
    row.detail = detail;
    row.divergenceStreak = recomputeDivergence(row);
    machines[key] = row;
    const sig = ensureSignal(row);
    const at = detail?.at ?? now();
    let dirty = false;
    const seen = detail?.merge?.desiredVersionSeen ?? null;
    if (sig.seenVersion !== seen) {
      if (seen != null) pushEvent(row, at, "merge_advance", { from: sig.seenVersion ?? null, to: seen });
      sig.seenVersion = seen;
      dirty = true;
    }
    const rejects = Array.isArray(detail?.merge?.rejects) ? detail.merge.rejects : [];
    const rejectSignature = rejects.map((r) => `${r.agentPath}:${r.code}`).sort().join("|");
    if (sig.rejectSignature !== rejectSignature) {
      pushEvent(row, at, "rejects_flip", { open: rejects.length > 0, count: rejects.length });
      sig.rejectSignature = rejectSignature;
      dirty = true;
    }
    const verdict = row.divergenceStreak > 0;
    if (sig.divergenceVerdict !== verdict) {
      pushEvent(row, at, "divergence_flip", { open: verdict, streak: row.divergenceStreak });
      sig.divergenceVerdict = verdict;
      dirty = true;
    }
    if (dirty) void persist();
    return row;
  }

  // Shape-of-change counts for the audit event: never the payloads themselves.
  // `enabled` is normalized the way the console routes store it — absent
  // means enabled (`enabled !== false`), not false.
  function diffDesired(prevEntries, nextEntries) {
    const key = (e) => `${e?.packId}/${e?.agentId}`;
    const on = (e) => e?.enabled !== false;
    const prevMap = new Map((Array.isArray(prevEntries) ? prevEntries : []).map((e) => [key(e), e]));
    const nextMap = new Map((Array.isArray(nextEntries) ? nextEntries : []).map((e) => [key(e), e]));
    let added = 0;
    let removed = 0;
    let toggled = 0;
    for (const [k, e] of nextMap) {
      const p = prevMap.get(k);
      if (!p) added++;
      else if (on(p) !== on(e)) toggled++;
    }
    for (const k of prevMap.keys()) if (!nextMap.has(k)) removed++;
    return { added, removed, toggled };
  }

  // The cloud-authored expectation is the ONE piece of this store that cannot
  // self-heal: liveness and detail both arrive again on the next steward beat,
  // but a desired set only exists because a human edited it. Losing it to a
  // gateway restart (hosted pods roll constantly) silently reverts every
  // machine to "no expectation" and the next merge deletes its cloud rows —
  // so these two mutations write through. Callers that must answer only after
  // durability await `flush`.
  function recordDesired(deviceId, entries, { ownerEmail = null } = {}) {
    const key = String(deviceId);
    const row = machines[key] ?? freshRow();
    if (ownerEmail) row.ownerEmail = ownerEmail;
    const prev = row.desired;
    row.desired = { version: (prev?.version ?? 0) + 1, entries, at: now() };
    machines[key] = row;
    pushEvent(row, row.desired.at, "desired_change", {
      who: ownerEmail ?? row.ownerEmail ?? null,
      version: row.desired.version,
      ...diffDesired(prev?.entries, entries),
    });
    ensureSignal(row).desiredVersion = row.desired.version;
    void persist();
    return row;
  }

  function clearDesired(deviceId) {
    const row = machines[String(deviceId)];
    if (!row) return null;
    row.desired = null;
    row.divergenceStreak = 0;
    machines[String(deviceId)] = row;
    void persist();
    return row;
  }

  // Read-path silence bookkeeping (add-machine-lifecycle-console): silence is
  // DERIVED on read (now - lastSeenAt > window), so the console routes report
  // it back here; the flip is recorded once per silence episode. A row with
  // no observed signal yet records nothing — "never_reported" is the initial
  // state, not a transition.
  function noteSilence(deviceId, silence) {
    const row = machines[String(deviceId)];
    if (!row) return null;
    const sig = row.lastSignal;
    if (!sig || sig.silence === silence) return row;
    pushEvent(row, now(), "presence_flip", { from: sig.silence, to: silence });
    sig.silence = silence;
    void persist();
    return row;
  }

  // Revocation from the machine console (add-machine-lifecycle-console):
  // kills the cloud expectation with the binding so a re-pair under the SAME
  // deviceId cannot inherit stale expectations, marks the row for retention,
  // and lands one final history event. The row (with history) survives for
  // HISTORY_RETENTION_MS, then the sweep removes it wholesale.
  function revoke(deviceId, { who = null } = {}) {
    const key = String(deviceId);
    const row = machines[key];
    if (!row) return null;
    row.revokedAt = now();
    row.desired = null;
    row.divergenceStreak = 0;
    pushEvent(row, row.revokedAt, "unbound", { who: who ?? row.ownerEmail ?? null });
    machines[key] = row;
    void persist();
    return row;
  }

  function list() {
    return Object.entries(machines)
      .filter(([, row]) => row?.revokedAt == null)
      .map(([deviceId, row]) => ({ deviceId, ...row }));
  }

  return {
    load,
    get: (deviceId) => get(deviceId),
    touch,
    recordDetail,
    recordDesired,
    clearDesired,
    noteSilence,
    revoke,
    list,
    get flush() {
      return flushing;
    },
    persist,
  };
}
