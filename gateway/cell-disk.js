// ── Per-cell disk usage and budget (budget-cell-disk-usage 2.1/2.2) ─────────
//
// 2026-11-09 实测：宿主机 30 GiB 托管 48 个 cell，cell 的 workspace 与会话历史**没有任何上限**。
// 一个内容生产租户的 workspace 长到 1051 MiB，加上会话历史，节点长期悬在 kubelet 的驱逐线上
// （nodefs 5% 硬阈值 / 10% 回收目标）反复抖动——facet 因 hostPath 钉在同机，被驱逐后停摆 15 分钟。
//
// 这一层只回答"用了多少、离上限多远"。**它不做删除**：workspace 里是用户的真产出，
// 腾空间必须由用户导出/清理，任何"平台帮你删"都是事故。
//
// 读取是带 TTL 的：48 个 cell × 递归遍历不可能挂在每个状态请求上。

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Defaults sized from the production measurement (single heavy cell ≈ 1 GiB). */
export const DISK_DEFAULTS = Object.freeze({
  softBytes: 512 * 1024 * 1024,
  hardBytes: 2 * 1024 * 1024 * 1024,
});

/** Read the budget knobs; `hard` never below `soft` (a hard cap under soft is a config error, not a trap). */
export function diskBudgets(env = process.env) {
  const mb = (name, fallback) => {
    const raw = Number(env?.[name]);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw * 1024 * 1024) : fallback;
  };
  const softBytes = mb("CELL_DISK_SOFT_MB", DISK_DEFAULTS.softBytes);
  const hardBytes = Math.max(softBytes, mb("CELL_DISK_HARD_MB", DISK_DEFAULTS.hardBytes));
  return { softBytes, hardBytes };
}

/**
 * Three states, because two cannot say "stop growing" before "stop working":
 * `ok` under soft, `near` between (warn, still writable), `over` at/above hard.
 */
export function classifyDisk(totalBytes, { softBytes, hardBytes }) {
  if (!(totalBytes >= 0)) return "ok";
  if (totalBytes >= hardBytes) return "over";
  if (totalBytes >= softBytes) return "near";
  return "ok";
}

/**
 * Recursive byte sum. A missing directory is 0, not an error: cells are created
 * lazily and a status read must never fail because a subdir does not exist yet.
 */
export async function measureDirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await measureDirBytes(full);
      continue;
    }
    // lstat, not stat: a symlink must contribute nothing. Following it would let
    // one cell's usage report bytes that live outside the cell (or in another
    // cell) — the 2026-11-09 measurement would have been meaningless.
    try {
      const info = await lstat(full);
      if (info.isSymbolicLink()) continue;
      total += Number(info.size) || 0;
    } catch {
      /* vanished mid-walk — count what we saw */
    }
  }
  return total;
}

/**
 * Cached meter. `read(root)` returns `{ workspaceBytes, sessionsBytes, totalBytes,
 * measuredAt, state }`; repeated reads inside the TTL reuse the last measurement
 * so a status poll cannot turn into 48 directory walks.
 */
export function createDiskMeter({ ttlMs = 5 * 60_000, budgets = null, now = Date.now } = {}) {
  const cache = new Map(); // root → { at, value }
  const effective = () => budgets ?? diskBudgets();

  return {
    ttlMs,
    /** Measure (or reuse) one cell root. */
    async read(root) {
      const hit = cache.get(root);
      const at = now();
      if (hit && at - hit.at < ttlMs) return hit.value;
      const workspaceBytes = await measureDirBytes(path.join(root, "workspace"));
      const sessionsBytes = await measureDirBytes(path.join(root, "dsh", "sessions"));
      const totalBytes = workspaceBytes + sessionsBytes;
      const b = effective();
      const value = {
        workspaceBytes,
        sessionsBytes,
        totalBytes,
        measuredAt: new Date(at).toISOString(),
        state: classifyDisk(totalBytes, b),
        softBytes: b.softBytes,
        hardBytes: b.hardBytes,
      };
      cache.set(root, { at, value });
      return value;
    },
    /** Drop one cell's cached measurement (after an operator cleanup, say). */
    invalidate(root) {
      cache.delete(root);
    },
    /** Measured entries — the board's input. */
    snapshot() {
      return [...cache.entries()].map(([root, hit]) => ({ root, ...hit.value }));
    },
  };
}
