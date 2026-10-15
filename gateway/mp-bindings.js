// Mini-program account bindings: openid ⇄ platform (Logto) account. Since
// add-device-pairing-auth the same store also holds APP DEVICE bindings under
// `app:<deviceId>` keys (Ed25519 public key + self-reported label; see
// gateway/app-auth.js) — one identity store, two client kinds, namespaced keys.
//
// Identity must be resolvable — "which account does this WeChat user / paired
// device act for" — before any runtime serves the caller, so this is one of
// the few pieces of state that lives OUTSIDE a runtime: at the gateway
// (per-user cells ahead of a cell's boot) or in a single-process deployment's
// data dir (add-single-process-mp-auth). Shared module, same file format at
// both entrypoints. Persisted as a JSON file with atomic temp+rename writes
// (the project's file-persistence convention: one file, serialized mutations,
// crash-safe rename).
//
// File-format compatibility: openid entries keep their original
// {email, groups, boundAt} shape. app: entries add `pubkey` (base64url raw
// 32-byte Ed25519) and `label`. The loader preserves those two fields when
// present and never requires them on openid entries — an older binary that
// rewrites the file drops them (devices must re-pair), which is the accepted
// rollback semantics documented in add-device-pairing-auth design D1.

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

// App-device keys live under this prefix in the same bindings map, so openid
// and device identifiers can never collide.
export const APP_KEY_PREFIX = "app:";

export function createMpBindings({ file }) {
  const bindings = new Map(); // key -> { email, groups, boundAt, pubkey?, label? }
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
            const entry = {
              email: value.email,
              groups: Array.isArray(value.groups) ? value.groups : [],
              boundAt: value.boundAt ?? Date.now(),
            };
            // app: entries carry the device's Ed25519 public key and label;
            // openid entries never do. Preserve them when present (an app:
            // entry without a pubkey is unusable downstream, but loading it
            // keeps the file round-trip stable rather than silently shedding
            // keys on rewrite).
            if (typeof value.pubkey === "string") entry.pubkey = value.pubkey;
            if (typeof value.label === "string") entry.label = value.label;
            bindings.set(openid, entry);
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
    // The web-side paired-devices list: every app: binding owned by `email`,
    // newest first. Public keys stay server-side — the UI never needs them.
    devicesFor: (email) =>
      [...bindings.entries()]
        .filter(([key, value]) => key.startsWith(APP_KEY_PREFIX) && value.email === email)
        .map(([key, value]) => ({
          deviceId: key.slice(APP_KEY_PREFIX.length),
          label: value.label ?? "",
          boundAt: value.boundAt,
        }))
        .sort((a, b) => b.boundAt - a.boundAt),
    issueBindCode,
    consumeBindCode,
  };
}
