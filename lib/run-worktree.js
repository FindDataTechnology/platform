// ── Run workbench: one private working directory per run ─────────────────────
//
// (openspec: fleet-run-workbench, tasks 1.1–1.5; spec capability run-workbench)
//
// Two runs of the same post must never share a directory — concurrent runs that
// write the same filename overwrite each other, and the overwrite is silent. The
// workspace used to be a single deployment-wide cwd, so "parallel" had no
// physical precondition.
//
// This module is ONLY the primitive: detect the backend, create a workbench,
// release it with a retention window, sweep orphans, and measure usage. Wiring
// it into the worker/cell spawn path is section 2 of the same change and lives
// in server/worker-slots.js — keeping the filesystem/git mechanics here means
// that wiring has nothing to invent and this file can be tested without a
// cluster.
//
// Backend selection is the PLATFORM's call, never the user's (spec: "不由使用者
// 选择"): a directory inside a git repo gets `git worktree` (isolation plus a
// branch/commit as the promotion exit), everything else gets a plain directory.
// Both have the same contract to the user: exclusive, lifecycle-bound, has a
// promotion exit.
//
// Failure discipline (spec: "建不起来就以失败收口"): create() throws a structured
// error naming the reason; the caller MUST close the run as failed. Falling back
// to the shared directory is indistinguishable, after the fact, from "ran on
// someone else's desk", so it is never an option here.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// git can hang on a network filesystem or a lock held by another run; every
// invocation is bounded so a wedged repo cannot wedge a run's start.
const GIT_TIMEOUT_MS = 10_000;

async function git(args, cwd) {
  const { stdout } = await run("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
  return stdout.trim();
}

/**
 * Which backend a base directory supports.
 *
 * `rev-parse --absolute-git-dir` succeeds exactly when `base` is inside a
 * working tree. A failure of ANY kind (not a repo, git absent, timeout) reads
 * as `directory` — the spec's "非仓库自动退化为普通目录", and the reason it must
 * not throw: a deployment without git is a supported deployment, not an error.
 *
 * @returns {Promise<"worktree"|"directory">}
 */
export async function detectBackend({ base } = {}) {
  if (typeof base !== "string" || !base) return "directory";
  try {
    await git(["rev-parse", "--absolute-git-dir"], base);
    return "worktree";
  } catch {
    return "directory";
  }
}

// A turn/run reference is caller-supplied and lands in a path, so keep only
// characters that cannot escape the parent or confuse a shell. Collisions are
// avoided by the caller's uniqueness (run ids), not by this mapping.
//
// Exported so the host can mark a ref live BEFORE create() touches the
// filesystem: a sweeper with keepDays=0 skips the age check, so a bench
// created but not yet marked live is a directory it would delete on sight.
export function sanitizeRef(ref) {
  const s = String(ref ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!s) throw workbenchError("a non-empty run/turn reference is required");
  return s;
}

function workbenchError(message, cause) {
  const err = new Error(`工作台未建立: ${message}`, cause ? { cause } : undefined);
  err.code = "WORKBENCH_CREATE_FAILED";
  return err;
}

/**
 * Create this run's workbench.
 *
 * Directory backend: `<dataRoot>/workbenches/<ref>/`.
 * Worktree backend: `git worktree add --detach <dir> <baseRef>` — detached so a
 * release can never leave a stray branch behind; the promotion exit is an
 * explicit commit/branch the caller creates, not a side effect of creation.
 *
 * @param {object} opts
 * @param {string} opts.base      the repository (or plain) directory the run works against
 * @param {string} opts.run       unique run/turn reference (becomes the directory name)
 * @param {string} opts.dataRoot  root under which `workbenches/` lives
 * @param {"worktree"|"directory"} opts.backend   from detectBackend()
 * @param {string} [opts.baseRef] worktree only; defaults to the repo's current HEAD
 * @returns {Promise<{cwd: string, backend: string, workbenchRef: string}>}
 */
export async function create({ base, run: runRef, dataRoot, backend, baseRef } = {}) {
  const workbenchRef = sanitizeRef(runRef);
  if (typeof dataRoot !== "string" || !dataRoot) throw workbenchError("dataRoot is required");
  const dir = path.join(dataRoot, "workbenches", workbenchRef);
  try {
    if (backend === "worktree") {
      if (typeof base !== "string" || !base) throw new Error("base is required for the worktree backend");
      // --detach needs an explicit start point; resolve HEAD once so a caller
      // that passes nothing gets "what the repo is on now", not a failure.
      const startPoint = baseRef || (await git(["rev-parse", "HEAD"], base));
      await git(["worktree", "add", "--detach", dir, startPoint], base);
    } else if (backend === "directory") {
      await fs.mkdir(dir, { recursive: true });
    } else {
      throw new Error(`unknown backend '${backend}' (known: worktree, directory)`);
    }
  } catch (err) {
    throw workbenchError(err?.message || String(err), err);
  }
  return { cwd: dir, backend, workbenchRef };
}

/**
 * Release a workbench: keep it for `keepDays` for inspection, then delete.
 *
 * Deletion happens NOW when keepDays <= 0 (the caller is done inspecting, or the
 * retention is explicitly zero); otherwise the directory is left in place for
 * the sweeper (see sweep()) to reap once it ages out. That split is what makes
 * a crash survivable: a killed run never calls release(), and the sweeper finds
 * it by absence of a live run — not by trusting this call to have happened.
 *
 * Deletion failure MUST NOT throw (spec: slot return wins over cleanup); it is
 * reported in `leftovers` so the caller can log it.
 *
 * @returns {Promise<{removed: string[], leftovers: string[], deferred: boolean}>}
 */
export async function release({ workbenchRef, backend, dataRoot, keepDays = 0 } = {}) {
  const dir = path.join(String(dataRoot), "workbenches", sanitizeRef(workbenchRef));
  const deferred = Number(keepDays) > 0;
  if (deferred) return { removed: [], leftovers: [], deferred };
  return removeDir(dir, backend === "worktree" ? await repoOf(dir) : null);
}

async function repoOf(dir) {
  try {
    return await git(["rev-parse", "--show-toplevel"], dir);
  } catch {
    return null;
  }
}

async function removeDir(dir, repo) {
  const removed = [];
  const leftovers = [];
  try {
    if (repo) {
      // Detach the worktree before removing its directory, or git keeps a stale
      // registration and `worktree list` grows forever (spec: 元数据不得无限增长).
      try {
        await git(["worktree", "remove", "--force", dir], repo);
        removed.push(dir);
        return { removed, leftovers, deferred: false };
      } catch {
        // fall through to plain rm + prune
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
    removed.push(dir);
    if (repo) await git(["worktree", "prune"], repo).catch(() => {});
  } catch (err) {
    // Slot return wins over cleanup (spec): report, never rethrow.
    console.warn(`[workbench] could not remove ${dir}: ${err?.message || err}`);
    leftovers.push(dir);
  }
  return { removed, leftovers, deferred: false };
}

/**
 * Reap workbenches whose run no longer exists.
 *
 * `isLive(ref)` answers "is a run with this reference still running?" — the
 * caller owns that knowledge (the run ledger); this module owns only the
 * filesystem. Something older than `keepDays` that isLive() says is dead is
 * removed; anything younger, or that isLive() claims, is kept.
 *
 * @param {object} opts
 * @param {string} opts.dataRoot
 * @param {(ref: string) => boolean} [opts.isLive]  defaults to "nothing is live"
 * @param {number} [opts.keepDays]   retention window; <=0 reaps every dead one
 * @param {number} [opts.now]        epoch ms, injectable for tests
 * @param {string} [opts.repo]       worktree repos are pruned once after the pass
 * @returns {Promise<{removed: string[], kept: string[], failed: string[]}>}
 */
export async function sweep({ dataRoot, isLive = () => false, keepDays = 0, now = Date.now(), repo = null } = {}) {
  const root = path.join(String(dataRoot), "workbenches");
  const removed = [];
  const kept = [];
  const failed = [];
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { removed, kept, failed };
  }
  const keep = Math.max(0, Number(keepDays) || 0);
  // keepDays=0 means "no inspection window" — reap every dead workbench
  // regardless of how recently it was touched. Comparing ages against a cutoff
  // equal to `now` would spare a directory created in the same millisecond
  // (mtime is fractional and can land a hair past `now`), so the age check is
  // skipped entirely rather than left to a boundary comparison.
  const cutoff = now - keep * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ref = entry.name;
    const dir = path.join(root, ref);
    if (isLive(ref)) { kept.push(dir); continue; }
    if (keep > 0) {
      let age = 0;
      try {
        age = (await fs.stat(dir)).mtimeMs;
      } catch {
        failed.push(dir);
        continue;
      }
      if (age > cutoff) { kept.push(dir); continue; }
    }
    const result = await removeDir(dir, repo);
    if (result.leftovers.length) failed.push(dir);
    else removed.push(dir);
  }
  if (repo && removed.length) await git(["worktree", "prune"], repo).catch(() => {});
  return { removed, kept, failed };
}

/**
 * Disk usage of one workbench, in MiB.
 *
 * `WORKBENCH_MAX_MB` bounds a single run. The caller decides what to do when it
 * is exceeded — and MUST do it at END OF TURN, never mid-write: a half-written
 * artifact reported as complete is worse than a failed run (spec: MUST NOT 静默
 * 截断). This function only measures.
 *
 * @returns {Promise<{bytes: number, mb: number, limitMb: number|null, over: boolean}>}
 */
export async function usageOf({ workbenchRef, dataRoot, limitMb = Number(process.env.WORKBENCH_MAX_MB) || null } = {}) {
  const dir = path.join(String(dataRoot), "workbenches", sanitizeRef(workbenchRef));
  const bytes = await dirBytes(dir);
  const mb = Math.round((bytes / (1024 * 1024)) * 100) / 100;
  return { bytes, mb, limitMb, over: limitMb != null && mb > limitMb };
}

async function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirBytes(p);
    else if (entry.isFile()) {
      try {
        total += (await fs.stat(p)).size;
      } catch {
        // a file removed between readdir and stat contributes nothing
      }
    }
  }
  return total;
}

// ── Per-turn change list (spec: 每回合的改动必须可归属到那一次运行) ──────────
//
// The workbench IS the run's own directory — a `--detach` worktree whose HEAD
// is the point the run started from, or (no git) a directory the run created
// empty. Both facts make "what this run changed" a local question the HOST can
// answer without any child-process cooperation:
//
//   worktree  → `git diff HEAD` covers every change git can see, INCLUDING shell
//               commands (`rm`, `sed -i`, a build script), not only file tools.
//   directory → the directory started empty, so every file present is output.
//
// No index mutation (`--no-renames` keeps a rename as one delete + one add,
// which is the honest unit for a change list; `ls-files --others` respects
// .gitignore like git itself). This replaces the design's original plan of
// mounting @deepseek-ai/dsh-workspace-changes: that package is a dependency
// only of the pruned dsh-web-app, its summary lives inside the child (so the
// host would need a new RPC bridge), and its first snapshot copies worktree-
// sized data to disk — the very risk the quota exists to bound. See design D5-rev.

const CHANGES_MAX_FILES = 500;
// shortcut: one file counts only up to 2 MiB (reading it to count lines); above
// that it is listed without counts, matching the plugin's maxFileBytes. Upgrade
// if a run routinely produces larger text artifacts that need line counts.
const CHANGES_MAX_FILE_BYTES = 2 * 1024 * 1024;

async function countLines(file) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return { lines: null, bytes: null };
  }
  if (!st.isFile()) return { lines: null, bytes: null };
  if (st.size > CHANGES_MAX_FILE_BYTES) return { lines: null, bytes: st.size };
  let buf;
  try {
    buf = await fs.readFile(file);
  } catch {
    return { lines: null, bytes: st.size };
  }
  if (buf.includes(0)) return { lines: null, bytes: st.size }; // binary: no line count
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  if (buf.length && buf[buf.length - 1] !== 0x0a) n++;
  return { lines: n, bytes: st.size };
}

async function walkFiles(root, cap) {
  const out = [];
  const visit = async (dir, rel) => {
    if (out.length >= cap) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const child = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(child, childRel);
      else if (e.isFile()) out.push({ rel: childRel, abs: child });
    }
  };
  await visit(root, "");
  return out;
}

/**
 * Did this run promote its changes? (spec: 非 git 工作台的产物必须走显式晋升)
 *
 * The three promotion exits are the EXISTING lanes — `report_status` (a
 * conclusion filed), `save_to_library` (a file into the resource library), and
 * an artifact raised through report (both ride `reported`). For a directory
 * workbench (no git — nothing preserves the run's files on its own) a run that
 * changed files WITHOUT touching any exit has left its output stranded: the
 * read face MUST say "改动 N、晋升 0", never "delivered".
 *
 * Only meaningful for the directory backend: a worktree's branch/commit IS the
 * promotion, so this returns null there (nothing to warn about).
 *
 * @param {object} p
 * @param {object|null} p.changes      the diffSince() result
 * @param {boolean} p.reported         the turn filed a report_status / artifact
 * @param {Array<{name?:string}>} [p.toolBlocks]  this turn's tool calls
 * @returns {null | {changed:number, promoted:number}}
 */
export function promotionReading({ changes, reported = false, toolBlocks = [] } = {}) {
  if (!changes?.ok || changes.backend !== "directory") return null;
  const changed = Number(changes.total ?? changes.files?.length ?? 0);
  if (!changed) return null; // no output ⇒ nothing to promote, nothing to warn about
  const savedLibrary = toolBlocks.some((b) => /save_to_library|library/i.test(String(b?.name ?? "")));
  const promoted = reported || savedLibrary ? 1 : 0;
  return { changed, promoted };
}

/**
 * What this run changed, attributed to its workbench.
 *
 * Returns a shape the run ledger and the read face can hold verbatim:
 *   { ok: true,  backend, files: [{path, status, added, deleted}], total,
 *     added, deleted, coverage }
 *   { ok: false, backend, files: [], reason }   — measurement itself failed.
 *
 * `ok:false` MUST surface as "未取得 + 原因", never as "no changes" (spec: 取不到
 * 不等于没有改动); the caller does that, this function only says which case it is.
 * `coverage` says how complete the list is, so a no-git run never looks like a
 * git-complete one (spec: 无 git 时如实说明覆盖范围).
 *
 * @param {object} opts
 * @param {string} opts.dir            the run's workbench directory
 * @param {"worktree"|"directory"} [opts.backend]
 * @param {string} [opts.baseRef]      worktree backend start point (default HEAD)
 */
export async function diffSince({ dir, backend, baseRef = "HEAD" } = {}) {
  if (typeof dir !== "string" || !dir) return { ok: false, backend, files: [], reason: "no workbench directory" };
  const isRepo = backend === "worktree" || (backend == null && (await detectBackend({ base: dir })) === "worktree");
  if (!isRepo) {
    // Directory backend: the workbench started empty, so everything here is
    // this run's output. Listed as "added" with line counts.
    let entries;
    try {
      entries = await walkFiles(dir, CHANGES_MAX_FILES);
    } catch (err) {
      return { ok: false, backend: "directory", files: [], reason: err?.message || String(err) };
    }
    const files = [];
    let added = 0;
    for (const { rel, abs } of entries) {
      const { lines } = await countLines(abs);
      const n = lines ?? 0;
      added += n;
      files.push({ path: rel, status: "A", added: lines, deleted: 0 });
    }
    return {
      ok: true,
      backend: "directory",
      files,
      total: files.length,
      added,
      deleted: 0,
      // Honest scope: no git here, and shell-only edits are indistinguishable
      // from nothing when a file is rewritten in place — say what IS covered.
      coverage: "无 git：清单为工作台内的全部文件（本运行产出）",
    };
  }

  let numstat;
  let untracked;
  try {
    numstat = await git(["diff", "--numstat", "--no-renames", "-z", baseRef], dir);
    untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], dir);
  } catch (err) {
    return { ok: false, backend: "worktree", files: [], reason: err?.message || String(err) };
  }
  const files = [];
  let added = 0;
  let deleted = 0;
  for (const rec of numstat.split("\0")) {
    if (!rec) continue;
    const tab1 = rec.indexOf("\t");
    const tab2 = rec.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const aRaw = rec.slice(0, tab1);
    const dRaw = rec.slice(tab1 + 1, tab2);
    const filePath = rec.slice(tab2 + 1);
    if (!filePath) continue;
    const binary = aRaw === "-" || dRaw === "-";
    const a = binary ? null : Number(aRaw);
    const d = binary ? null : Number(dRaw);
    if (Number.isFinite(a)) added += a;
    if (Number.isFinite(d)) deleted += d;
    files.push({ path: filePath, status: d > 0 && a === 0 ? "D" : a > 0 && d === 0 ? "A" : "M", added: a, deleted: d });
  }
  for (const p of untracked.split("\0")) {
    if (!p) continue;
    const { lines } = await countLines(path.join(dir, p));
    if (lines != null) added += lines;
    files.push({ path: p, status: "A", added: lines, deleted: 0 });
  }
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return {
    ok: true,
    backend: "worktree",
    files: files.slice(0, CHANGES_MAX_FILES),
    total: files.length,
    added,
    deleted,
    coverage: "git：覆盖本工作台的全部改动（含 shell 命令造成的改动）",
  };
}
