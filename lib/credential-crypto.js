// credential-crypto.js — at-rest encryption for per-owner credentials
// (openspec: add-user-supplied-credentials, design D2).
//
// Why a dedicated module instead of reusing the session secret directly: the
// session secret signs cookies and embed tokens; it must never become the key
// that also decrypts stored third-party API keys. One leak would then be two.
// The credential key is derived from its own material (CREDENTIAL_SECRET, or a
// 0600 file beside the session secret), and rotating it invalidates stored
// ciphertext rather than silently signing with a leaked key.
//
// Envelope: `v1.<iv-b64url>.<tag-b64url>.<ct-b64url>` — versioned so a future
// key/algorithm change can be expressed without guessing what old rows mean.
// AES-256-GCM: the tag makes tampering detectable, which is the property a
// plain-AES-CBC scheme (the Feishu webhook helper) deliberately does not have.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

let cachedKey = null;

function deriveKey(material) {
  // sha256 normalises arbitrary-length material to exactly 32 bytes and gives a
  // stable key across machines, so a CREDENTIAL_SECRET restored from a backup
  // decrypts the rows written before the restore.
  return createHash("sha256").update(String(material)).digest();
}

async function loadMaterial({ env = process.env, dataDir = env.PLATFORM_DATA_DIR || "" } = {}) {
  if (env.CREDENTIAL_SECRET && String(env.CREDENTIAL_SECRET).trim()) return env.CREDENTIAL_SECRET;
  const dir = dataDir ? path.join(dataDir, "auth") : path.resolve("auth");
  const file = path.join(dir, "credential-secret");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const secret = randomBytes(KEY_BYTES).toString("base64url");
    // `wx` so two processes racing at first boot cannot each write a different
    // key (the loser's ciphertext would be undecryptable forever).
    try {
      await writeFile(file, secret, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return await readFile(file, "utf8");
    }
    await chmod(file, 0o600).catch(() => {});
    return secret;
  }
}

async function getKey(opts) {
  if (cachedKey) return cachedKey;
  cachedKey = deriveKey(await loadMaterial(opts));
  return cachedKey;
}

/**
 * Encrypt one credential value.
 * @returns {Promise<string>} versioned envelope, safe to store as TEXT
 */
export async function encryptCredential(plaintext, opts) {
  if (plaintext == null || plaintext === "") return null;
  const key = await getKey(opts);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/**
 * Decrypt one credential value. Throws on tampering or an unknown version —
 * a credential that cannot be verified must never be handed to an upstream.
 * @returns {Promise<string|null>}
 */
export async function decryptCredential(envelope, opts) {
  if (envelope == null || envelope === "") return null;
  const parts = String(envelope).split(".");
  if (parts.length !== 4) throw new Error("credential envelope malformed");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== ENVELOPE_VERSION) throw new Error(`credential envelope version ${version} unsupported`);
  const key = await getKey(opts);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

// ── Synchronous variants ────────────────────────────────────────────────────
//
// db.js's accessors are synchronous (better-sqlite3 is), so an async decrypt
// there would force every caller through a promise for no benefit. AES-GCM in
// Node is synchronous; only loading the key is async. So: prime once with
// `await primeKey()`, then the sync pair below. If the key is not primed they
// throw rather than silently returning ciphertext as if it were a token.

function requireKeySync() {
  if (!cachedKey) throw new Error("credential key not primed; await primeKey() first");
  return cachedKey;
}

/** Load and cache the key so the sync variants can be used. */
export async function primeKey(opts) {
  await getKey(opts);
}

export function encryptCredentialSync(plaintext) {
  if (plaintext == null || plaintext === "") return null;
  const key = requireKeySync();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [ENVELOPE_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
    ct.toString("base64url")].join(".");
}

export function decryptCredentialSync(envelope) {
  if (envelope == null || envelope === "") return null;
  const parts = String(envelope).split(".");
  if (parts.length !== 4) throw new Error("credential envelope malformed");
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== ENVELOPE_VERSION) throw new Error(`credential envelope version ${version} unsupported`);
  const decipher = createDecipheriv("aes-256-gcm", requireKeySync(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

export function readCredentialMaybeEncryptedSync(value) {
  if (value == null || value === "") return null;
  return isEncryptedEnvelope(value) ? decryptCredentialSync(value) : String(value);
}

/**
 * Whether a stored value is one of our envelopes. Used on the migration path:
 * rows written before encryption are bare plaintext, and a reader must not try
 * to decrypt them (nor a writer re-wrap them blindly). The check is structural,
 * not "does it look like a key" — a real token could contain dots.
 */
export function isEncryptedEnvelope(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  return parts.length === 4 && parts[0] === ENVELOPE_VERSION
    && parts.slice(1).every((p) => p.length > 0);
}

/**
 * Read a credential that may predate encryption.
 *
 * @returns {Promise<string|null>} plaintext either way; null when empty
 */
export async function readCredentialMaybeEncrypted(value, opts) {
  if (value == null || value === "") return null;
  return isEncryptedEnvelope(value) ? decryptCredential(value, opts) : String(value);
}

/** Test-only: forget the memoised key so a fixture can swap CREDENTIAL_SECRET. */
export function _resetKeyCache() {
  cachedKey = null;
}
