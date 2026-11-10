// Unit tests — steward key custody (add-cell-lifecycle 4.1, Windows DPAPI 刀).
//
// Pins:
//   - Windows custody seals the private key with DPAPI (CurrentUser) and never
//     leaves a plaintext copy behind
//   - a legacy plaintext .steward-keyv1 is migrated on first read (sealed, then
//     removed) — upgrades do not re-pair
//   - sealed bytes that will not open resolve to null (identity gone), never a
//     silent fallback to a stale plaintext file
//   - DPAPI unavailable (no PowerShell / policy) degrades to the documented
//     0600 file fallback instead of losing the identity
//   - remove() clears both stores
//   - on a real Windows host: DPAPI round-trips through PowerShell and the
//     on-disk blob does not contain the key text
//
// Run: node --test scripts/test-steward-keycustody.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { createKeyStorage, createWindowsDpapi } = await import("../supervisor/steward-identity.js");

// The macOS branch shells out to `security`; tests must not touch the dev
// keychain, so every custody test injects a failing execP (errors are caught
// by the storage and mean "no keychain entry").
const noKeychain = async () => { throw new Error("keychain disabled in custody tests"); };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "steward-custody-"));
}

// Deterministic stand-in for DPAPI with an explicit "unavailable" switch.
function fakeDpapi() {
  const box = { down: false };
  return {
    async protect(plain) {
      return box.down ? null : Buffer.from(`sealed:${plain}`, "utf8").toString("base64");
    },
    async unprotect(blob) {
      if (box.down) return null;
      const text = Buffer.from(blob, "base64").toString("utf8");
      return text.startsWith("sealed:") ? text.slice("sealed:".length) : null;
    },
    set down(v) { box.down = v; },
  };
}

const KEY = "cHJpdmF0ZS1rZXktbWF0ZXJpYWwtZm9yLXRlc3Rz";

test("windows custody seals the key and leaves no plaintext behind", async () => {
  const dir = tmpDir();
  const storage = createKeyStorage({ cellId: "cell-seal", dataDir: dir, execP: noKeychain, dpapi: fakeDpapi() });
  await storage.set(KEY);

  const sealedPath = path.join(dir, ".steward-keyv1.dpapi");
  const legacyPath = path.join(dir, ".steward-keyv1");
  assert.ok(fs.existsSync(sealedPath), "sealed blob written");
  assert.ok(!fs.existsSync(legacyPath), "no plaintext copy");
  assert.ok(!fs.readFileSync(sealedPath, "utf8").includes(KEY), "blob is not the raw key");
  assert.equal(await storage.get(), KEY);
});

test("legacy plaintext key is migrated on first read", async () => {
  const dir = tmpDir();
  const legacyPath = path.join(dir, ".steward-keyv1");
  fs.writeFileSync(legacyPath, KEY, { mode: 0o600 });
  const storage = createKeyStorage({ cellId: "cell-migrate", dataDir: dir, execP: noKeychain, dpapi: fakeDpapi() });

  assert.equal(await storage.get(), KEY, "upgrade still reads the old key");
  assert.ok(fs.existsSync(path.join(dir, ".steward-keyv1.dpapi")), "sealed copy created");
  assert.ok(!fs.existsSync(legacyPath), "plaintext removed after migration");
  assert.equal(await storage.get(), KEY, "second read opens the sealed copy");
});

test("undecryptable sealed blob resolves to null (never a stale plaintext fallback)", async () => {
  const dir = tmpDir();
  const storage = createKeyStorage({ cellId: "cell-tamper", dataDir: dir, execP: noKeychain, dpapi: fakeDpapi() });
  await storage.set(KEY);

  // Simulate a profile reset / corrupt store, with a leftover plaintext file
  // someone planted: neither may resurrect the identity.
  fs.writeFileSync(path.join(dir, ".steward-keyv1.dpapi"), Buffer.from("garbage").toString("base64"));
  fs.writeFileSync(path.join(dir, ".steward-keyv1"), "planted-key", { mode: 0o600 });
  assert.equal(await storage.get(), null);
});

test("DPAPI unavailable degrades to the 0600 file fallback", async () => {
  const dir = tmpDir();
  const dpapi = fakeDpapi();
  dpapi.down = true;
  const storage = createKeyStorage({ cellId: "cell-fallback", dataDir: dir, execP: noKeychain, dpapi });

  await storage.set(KEY);
  assert.ok(!fs.existsSync(path.join(dir, ".steward-keyv1.dpapi")), "no bogus sealed blob");
  assert.equal(fs.readFileSync(path.join(dir, ".steward-keyv1"), "utf8"), KEY);
  assert.equal(await storage.get(), KEY);
});

test("remove clears both stores", async () => {
  const dir = tmpDir();
  const storage = createKeyStorage({ cellId: "cell-remove", dataDir: dir, execP: noKeychain, dpapi: fakeDpapi() });
  await storage.set(KEY);
  await storage.remove();
  assert.ok(!fs.existsSync(path.join(dir, ".steward-keyv1.dpapi")));
  assert.ok(!fs.existsSync(path.join(dir, ".steward-keyv1")));
  assert.equal(await storage.get(), null);
});

test("real DPAPI round-trip on a Windows host", { skip: process.platform !== "win32" }, async () => {
  const dir = tmpDir();
  const storage = createKeyStorage({ cellId: "cell-win-real", dataDir: dir }); // auto-selects DPAPI
  // A random 32-byte Ed25519 seed, base64url — the shape pairSteward stores.
  const seed = crypto.randomBytes(32).toString("base64url");
  await storage.set(seed);

  const sealedPath = path.join(dir, ".steward-keyv1.dpapi");
  assert.ok(fs.existsSync(sealedPath), "DPAPI sealed blob written");
  assert.ok(!fs.existsSync(path.join(dir, ".steward-keyv1")), "no plaintext on Windows");
  assert.ok(!fs.readFileSync(sealedPath, "utf8").includes(seed), "blob is not the raw key");
  assert.equal(await storage.get(), seed, "DPAPI opens what it sealed");

  // Tampering must fail closed, not return garbage.
  fs.writeFileSync(sealedPath, Buffer.from("not-a-dpapi-blob").toString("base64"));
  assert.equal(await storage.get(), null);
});

test("PowerShell-backed DPAPI round-trips a payload", { skip: process.platform !== "win32" }, async () => {
  const dpapi = createWindowsDpapi();
  const sealed = await dpapi.protect("secret-payload");
  assert.ok(sealed, "protect succeeded");
  assert.equal(await dpapi.unprotect(sealed), "secret-payload");
});