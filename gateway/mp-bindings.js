// Mini-program account bindings: openid ⇄ platform (Logto) account.
//
// Identity must be resolvable — "which account does this WeChat user own" —
// before any runtime serves the caller, so this is one of the few pieces of
// state that lives OUTSIDE a runtime: at the gateway (per-user cells ahead of
// a cell's boot) or in a single-process deployment's data dir
// (add-single-process-mp-auth). Shared module, same file format at both
// entrypoints. Persisted as a JSON file with atomic temp+rename writes (the
// project's file-persistence convention: one file, serialized mutations,
// crash-safe rename).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

// Six-digit, single-use, short-lived bind codes minted from an authenticated
// WEB session (the Logto browser cookie) and redeemed in the mini program —
// the bridge that lets a WeChat user prove account ownership without the
// mini program ever seeing credentials (Logto offers no password grant; see
// design D3). Ephemeral by design: in-memory only, a gateway restart simply
// asks the user to fetch a fresh code.
const BIND_CODE_TTL_MS = 5 * 60 * 1000;

export function createMpBindings({ file }) {
  const bindings = new Map(); // openid -> { email, groups, boundAt }
  const bindCodes = new Map(); // code -> { email, groups, expiresAt }

  function issueBindCode(email, groups) {
    const now = Date.now();
    for (const [code, entry] of bindCodes) {
      if (entry.expiresAt <= now) bindCodes.delete(code);
    }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    bindCodes.set(code, { email, groups, expiresAt: now + BIND_CODE_TTL_MS });
    return { code, expiresAt: now + BIND_CODE_TTL_MS, ttlMs: BIND_CODE_TTL_MS };
  }

  // Single use: a valid code is consumed (deleted) atomically with the read.
  // Expired or unknown codes resolve to null.
  function consumeBindCode(code) {
    const key = String(code ?? "");
    const entry = bindCodes.get(key);
    if (!entry) return null;
    bindCodes.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    return entry;
  }

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      if (raw && typeof raw === "object") {
        for (const [openid, value] of Object.entries(raw.bindings ?? {})) {
          if (value && typeof value.email === "string") {
            bindings.set(openid, {
              email: value.email,
              groups: Array.isArray(value.groups) ? value.groups : [],
              boundAt: value.boundAt ?? Date.now(),
            });
          }
        }
      }
    } catch {
      // Missing or unreadable file: start empty (first boot, or corrupt file).
    }
  }

  // Serialized mutations: each write is atomic (temp + rename), and callers
  // await `flushing` so concurrent bind/unbind cannot interleave writes.
  let flushing = Promise.resolve();

  function persist() {
    flushing = flushing.then(async () => {
      const raw = { bindings: Object.fromEntries(bindings) };
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(raw, null, 2));
      await rename(tmp, file);
    });
    return flushing;
  }

  return {
    load,
    get: (openid) => bindings.get(openid) ?? null,
    async set(openid, value) {
      bindings.set(openid, { ...value, boundAt: Date.now() });
      await persist();
    },
    async remove(openid) {
      if (bindings.delete(openid)) await persist();
    },
    issueBindCode,
    consumeBindCode,
  };
}
