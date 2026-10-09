// Shared file-persistence helpers — the single home for the atomic-write and
// read-fallback patterns that were previously hand-rolled per store.
//
// Writers: temp file + rename with a UNIQUE temp name (pid + uuid fragment), so
// two concurrent saves on the same target can never collide on the temp path
// (the bug class cron.js had). The file is fsynced before rename; the directory
// gets a best-effort fsync after. New code should prefer the async variants;
// the Sync variants exist for call graphs that are synchronously written (e.g.
// dsh-profile.js).
//
// Readers: readJsonOr never throws — missing file returns the fallback
// silently; an unreadable or unparsable file logs a warning naming the path
// (prefixed with `label`) and returns the fallback.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── Shared id/timestamp helpers (single home; db.js keeps its internal copy) ──

export function nowIso() {
  return new Date().toISOString();
}

export function newId() {
  return randomUUID();
}

// Truncate a session/chat title to one line with an ellipsis. Shared by
// chat-history.js and migrate.js (was duplicated).
export function truncateTitle(s, max = 60) {
  const t = (s || "").trim().replace(/[\r\n]+/g, " ");
  if (!t) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Normalize an OpenAI-compatible base URL: bare host:port gets /v1 appended
// and trailing slashes are stripped. Was duplicated in llm-providers.js and
// dsh-profile.js; lives here so neither imports the other.
export function normalizeBaseUrl(url) {
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === "/") u.pathname = "/v1";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

// ── Atomic writes ────────────────────────────────────────────────────────────

function tempPathFor(file) {
  return `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
}

// Write `text` to `file` atomically. Shared core for every variant: mkdir -p,
// write to a unique temp sibling, fsync, rename over the target, best-effort
// directory fsync. `writeImpl` is fs.writeFileSync or a promisized variant.
function writeViaTemp(file, text, writeImpl) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  writeImpl(tmp, text, "utf8");
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.opendirSync(path.dirname(file));
    try { dirFd.sync(); } finally { dirFd.close(); }
  } catch {
    // Directory fsync is best-effort (some filesystems reject it).
  }
}

export function atomicWriteTextSync(file, text) {
  writeViaTemp(file, text, fs.writeFileSync);
}

export function atomicWriteJsonSync(file, value) {
  atomicWriteTextSync(file, JSON.stringify(value, null, 2));
}

export async function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempPathFor(file);
  const fh = await fs.promises.open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, file);
  try {
    const dir = await fs.promises.opendir(path.dirname(file));
    try { dir.sync(); } finally { await dir.close(); }
  } catch {
    // Directory fsync is best-effort (some filesystems reject it).
  }
}

export async function atomicWriteJson(file, value) {
  await atomicWriteText(file, JSON.stringify(value, null, 2));
}

// ── Read fallback ────────────────────────────────────────────────────────────

export function readJsonOr(file, fallback, { label = "store" } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[${label}] ${file} unreadable: ${err.message}`);
    return fallback;
  }
  try {
    const doc = JSON.parse(raw);
    return doc && typeof doc === "object" ? doc : fallback;
  } catch (err) {
    console.warn(`[${label}] ${file} unparsable, using fallback: ${err.message}`);
    return fallback;
  }
}

// ── Serialized mutation ──────────────────────────────────────────────────────

// Error thrown by tryMutate when another mutation is in flight. Carries code
// "busy" so HTTP layers can map it to 409 (llm-model-management contract).
export class BusyError extends Error {
  constructor() {
    super("another edit in progress");
    this.code = "busy";
  }
}

// Promise-chain serializer: mutate() queues (no lost update), tryMutate()
// rejects immediately with BusyError on contention. The same pattern the
// MCP patch writes already used (single-flight chain), now shared.
export function createWriteChain() {
  let chain = Promise.resolve();
  let pending = false;
  return {
    async mutate(fn) {
      const run = chain.then(fn, fn);
      chain = run.then(() => {}, () => {});
      return run;
    },
    async tryMutate(fn) {
      if (pending) throw new BusyError();
      pending = true;
      try {
        return await this.mutate(fn);
      } finally {
        pending = false;
      }
    },
  };
}
