// ── Durable webhook acceptance (add-rollout-gap-durability) ─────────────────
//
// The bot webhook pipeline used to ack-and-forget: the reply reached the
// platform but nothing was on disk, so a pod roll between ack and turn
// completion silently lost the message (the "换 pod 缝隙丢消息" standing
// gap), and the boot window buffered in memory with a drop-on-overflow cap.
// This module makes acceptance durable FIRST:
//
//   accept (atomic file) → ack → dispatch → turn → markDone
//
// A record survives a crash in exactly one of three states, and startup
// takeover maps each to its honest action:
//   pending    — never dispatched            → process it (replay)
//   dispatched — the turn had started        → mark done, outcome unknown
//                (re-running risks a double reply; the honest gap is the
//                in-flight turn itself, same as every killed turn)
//   done       — settled (or duplicate)      → retention window, then cleanup
//
// Idempotency rides the same store: the record's `key` (botId + platform
// message id) indexes every live record, so a platform retry or edge replay
// of an already-accepted message is acked WITHOUT a second turn. Payloads
// without a parseable id dedupe by nothing — never a guessed key.

import { readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Done records stay queryable for the duplicate window (platform retries and
// replays arrive within minutes; 24h is generous) and age out with their keys.
const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;
// The disk cap the memory BOOT_BUFFER_MAX became: overflow answers 503 (the
// platform retries) instead of dropping an accepted message silently.
const MAX_RECORDS = Number(process.env.BOTS_ACCEPTANCE_MAX) || 500;

export function createBotAcceptance({ dir = null, now = Date.now } = {}) {
  // Directory precedence: explicit > BOTS_ACCEPTANCE_DIR > PLATFORM_DATA_DIR
  // (prod: /data/bot-acceptance) > next to the app db (tests set DB_PATH to a
  // tmp file, so the store lands in the same tmp root and dies with it).
  const root =
    dir ||
    process.env.BOTS_ACCEPTANCE_DIR ||
    (process.env.PLATFORM_DATA_DIR
      ? path.join(process.env.PLATFORM_DATA_DIR, "bot-acceptance")
      : path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.resolve("."), "bot-acceptance"));
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });

  const records = new Map(); // id -> record (live = pending|dispatched|done-within-retention)
  const keys = new Map(); // key -> id (live records with a parseable id)

  const fileOf = (id) => path.join(root, `${id}.json`);
  const tmpOf = (id) => path.join(root, `.${id}.${crypto.randomBytes(4).toString("hex")}.tmp`);

  // Atomic record write: tmp + rename, so a reader (boot scan) never sees a
  // torn file. No fsync: a process crash loses at most the un-rename'd tmp
  // (nothing was acked for it), a power cut is the documented D4 boundary.
  function write(rec) {
    const tmp = tmpOf(rec.id);
    writeFileSyncSafe(tmp, JSON.stringify(rec));
    renameSync(tmp, fileOf(rec.id));
    records.set(rec.id, rec);
    if (rec.key) keys.set(rec.key, rec.id);
  }

  function writeFileSyncSafe(file, text) {
    // mode 0o600 — credentials-adjacent payloads (raw webhook bodies) stay
    // owner-only on disk.
    writeFileSync(file, text, { mode: 0o600 });
  }

  function makeId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
  }

  // Boot scan: load every record, drop expired done ones, index the rest.
  function load() {
    let entries = [];
    try {
      entries = readdirSync(root).filter((f) => f.endsWith(".json"));
    } catch {
      return { loaded: 0, expired: 0 };
    }
    let loaded = 0;
    let expired = 0;
    const cut = now() - DONE_RETENTION_MS;
    for (const f of entries) {
      try {
        const rec = JSON.parse(readFileSync(path.join(root, f), "utf8"));
        if (rec.state === "done" && (rec.doneAt ?? rec.receivedAt) < cut) {
          rmSync(path.join(root, f), { force: true });
          expired += 1;
          continue;
        }
        records.set(rec.id, rec);
        if (rec.key) keys.set(rec.key, rec.id);
        loaded += 1;
      } catch {
        // A torn file (crash mid-write of the legacy non-atomic path) is not
        // an acceptance record: remove it so the count stays honest.
        rmSync(path.join(root, f), { force: true });
      }
    }
    return { loaded, expired };
  }

  // Accept one inbound webhook. `rec` = { kind: "boot"|"message", botId,
  // key?, message?, given?, adapterReq? }. Returns { record, duplicate } —
  // duplicate=true means the key was already live: the record is stored as a
  // done/duplicate note (observable) and the caller must NOT run a turn.
  function accept(rec) {
    if (records.size >= MAX_RECORDS) {
      const err = new Error(`acceptance store full (${MAX_RECORDS} live records)`);
      err.code = "BOTS_ACCEPTANCE_FULL";
      throw err;
    }
    const id = makeId();
    const record = { id, state: "pending", receivedAt: now(), ...rec };
    if (rec.key && keys.has(rec.key)) {
      const dup = { ...record, state: "done", note: "duplicate", doneAt: now() };
      write(dup);
      return { record: dup, duplicate: true };
    }
    write(record);
    return { record, duplicate: false };
  }

  // One-way state machine: pending → dispatched → done. A second claim
  // (takeover racing the drain) returns null instead of re-writing, so both
  // sides converge on single processing.
  const NEXT_STATE = {
    pending: new Set(["dispatched", "done"]),
    dispatched: new Set(["done"]),
    done: new Set(),
  };

  function transition(id, state, note = null) {
    const rec = records.get(id);
    if (!rec || !NEXT_STATE[rec.state]?.has(state)) return null;
    const next = { ...rec, state, note: note ?? rec.note ?? null, ...(state === "done" ? { doneAt: now() } : {}) };
    write(next);
    return next;
  }

  const markDispatched = (id) => transition(id, "dispatched");
  const markDone = (id, note = null) => transition(id, "done", note);

  function pending(kind = null) {
    return [...records.values()].filter((r) => r.state === "pending" && (kind ? r.kind === kind : true));
  }

  function all() {
    return [...records.values()];
  }

  function byId(id) {
    return records.get(id) ?? null;
  }

  // Retention cleanup for done records (boot + periodic callers).
  function cleanup() {
    const cut = now() - DONE_RETENTION_MS;
    let removed = 0;
    for (const rec of [...records.values()]) {
      if (rec.state === "done" && (rec.doneAt ?? rec.receivedAt) < cut) {
        records.delete(rec.id);
        if (rec.key && keys.get(rec.key) === rec.id) keys.delete(rec.key);
        rmSync(fileOf(rec.id), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  // A fresh instance is the store as it exists on disk right now — recovery
  // is the constructor's job, not an extra call the host must remember.
  load();

  return { root, load, accept, markDispatched, markDone, pending, all, byId, cleanup, MAX_RECORDS };
}
