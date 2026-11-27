// server/chat-retention.js — keep the SQLite session index bounded.
//
// 2026-11-19 实测: `chat_messages` 是全代码库唯一没有保留策略的增长表
// (pack_usage_events 180 天、trace_events 7 天都有)。生产最重的那个 cell 上
// app.db 1.7 GiB，其中 chat_messages 1.31 GiB / 61,089 行 — 比它索引的
// 951 MiB transcripts 还大，因为 `blocks` 存的是未压缩 JSON。
//
// 剪的是索引，不是对话: chat-history spec 已把 transcripts 定为 store of
// record、索引是可重建投影，`scripts/rebuild-chat-index.mjs` 能从 transcripts
// 把被剪的会话原样建回来。transcripts 本模块一行都不碰。
//
// cell 是长期驻留的 (CELL_IDLE_REAP_SECS 默认 0 = 不回收)，所以"开机剪一次"
// 在这里等于"永不剪" — 就是 2026-10-10 trace 库长到 8GB 的那条失效模式。
// 因此照 usage-telemetry 用循环定时器。

import { getDb, isDbReady } from "../db.js";

const DAY_MS = 86_400_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

let sweepTimer = null;
let bootSweepTimer = null;
// Last sweep outcome, for the operator-facing status read. Null until a sweep
// has actually run — "never swept" and "swept, removed 0" must not look alike.
let lastSweep = null;
let nextRunAt = null;

/**
 * Default 90 days. `0` disables pruning entirely (the escape hatch); anything
 * missing, non-numeric or negative falls back to the default rather than
 * silently disabling or pruning everything.
 */
export function resolveRetentionDays(env = process.env) {
  const raw = env?.CHAT_RETENTION_DAYS;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return n;
}

/**
 * One retention sweep. Returns `{ removed, disabled?, skipped?, error? }` and
 * never throws — a failed sweep must not touch the chat path.
 *
 * Deletes by `chat_sessions.updated_at`, not by message time: a user can
 * reopen a year-old session and keep talking, and that session's updated_at
 * moves with it, so it stays. Per-message deletion would cut a conversation in
 * half, which is worse than not pruning at all. FK CASCADE (foreign_keys=ON)
 * takes each deleted session's messages with it.
 */
export function pruneChatHistory({ days = resolveRetentionDays(), now = Date.now() } = {}) {
  if (!(days > 0)) {
    lastSweep = { at: now, removed: 0, disabled: true };
    return { removed: 0, disabled: true };
  }
  if (!isDbReady()) {
    // Not an error: a cell can boot with the DB disabled (graceful degrade).
    return { removed: 0, skipped: "db-unavailable" };
  }
  const cutoff = new Date(now - days * DAY_MS).toISOString();
  try {
    const db = getDb();
    const { changes } = db.prepare("DELETE FROM chat_sessions WHERE updated_at < ?").run(cutoff);
    if (changes > 0) {
      // Hand the freed pages back to the filesystem. With auto_vacuum=OFF the
      // file only ever grows (trace.js, 2026-10-10) — on a pre-existing file
      // this is a no-op until the operator runs the one-off VACUUM that turns
      // INCREMENTAL on; it must not lose the delete count when it fails.
      try {
        db.pragma("incremental_vacuum");
      } catch (e) {
        console.warn(`[chat-retention] reclaim failed (rows already removed): ${e?.message || e}`);
      }
    }
    lastSweep = { at: now, removed: changes, cutoff };
    if (changes > 0) console.log(`[chat-retention] pruned ${changes} session(s) older than ${days}d`);
    return { removed: changes, cutoff };
  } catch (e) {
    const msg = String(e?.message || e);
    lastSweep = { at: now, removed: 0, error: msg };
    // A store that cannot be bounded is the failure that hid for 8 days in the
    // trace incident — it must say so in its own words, not as a generic warn.
    if (/malformed|corrupt/i.test(msg)) {
      console.warn(`[chat-retention] STORE UNBOUNDED: sweep failed with '${msg}' — the index is no longer being bounded`);
    } else {
      console.warn(`[chat-retention] sweep failed: ${msg}`);
    }
    return { removed: 0, error: msg };
  }
}

/** Operator-facing state for `GET /api/config` (chat-retention 4.1). */
export function chatRetentionStatus() {
  const days = resolveRetentionDays();
  let sessionsIndexed = 0;
  let messagesIndexed = 0;
  if (isDbReady()) {
    try {
      const db = getDb();
      // COUNT(*) over an index: 61k rows on the heaviest cell, sub-millisecond.
      sessionsIndexed = db.prepare("SELECT COUNT(*) AS n FROM chat_sessions").get()?.n ?? 0;
      messagesIndexed = db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()?.n ?? 0;
    } catch {
      /* counts are diagnostic only — a read failure must not fail /api/config */
    }
  }
  return {
    enabled: days > 0,
    windowDays: days,
    sessionsIndexed,
    messagesIndexed,
    lastSweep: lastSweep
      ? {
          at: new Date(lastSweep.at).toISOString(),
          removed: lastSweep.removed,
          ...(lastSweep.disabled ? { disabled: true } : {}),
          ...(lastSweep.error ? { error: lastSweep.error } : {}),
        }
      : null,
    nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : null,
  };
}

/**
 * Daily sweep timer, plus one sweep shortly after boot so an operator gets a
 * reading on day one instead of 24h later. The boot sweep is deferred (not run
 * inline) so it can never delay readiness.
 */
export function startChatRetentionTimer() {
  if (sweepTimer) return;
  const tick = () => {
    const days = resolveRetentionDays();
    pruneChatHistory({ days });
    nextRunAt = days > 0 ? Date.now() + SWEEP_INTERVAL_MS : null;
  };
  bootSweepTimer = setTimeout(tick, 30_000);
  bootSweepTimer.unref?.();
  sweepTimer = setInterval(tick, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  nextRunAt = Date.now() + 30_000;
}

/** Stop the timers (tests / ordered shutdown). */
export function stopChatRetentionTimer() {
  if (bootSweepTimer) clearTimeout(bootSweepTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  bootSweepTimer = null;
  sweepTimer = null;
  nextRunAt = null;
}
