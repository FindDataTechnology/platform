// Device identity unit tests (task 2.1). Runs on plain node: the identity
// module is storage/crypto-injected by design, so the KeyStore is an in-memory
// map and randomness comes from node:crypto. The pinned vector cross-checks
// the app side (@noble/curves) against the SERVER's constants (RFC 8032 TEST 1
// seed, scripts/test-app-pairing.mjs) — same bytes on both stacks.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadOrCreateIdentity, clearIdentity, identityFromSeed } from "../src/lib/device-identity.ts";

function memoryStore() {
  const map = new Map();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    _map: map,
  };
}

const nodeRandom = (n) => new Uint8Array(crypto.randomBytes(n));

// The server's pinned vector (RFC 8032 TEST 1): raw pubkey base64url and the
// signature over `device-abc:nonce-123` — byte-identical for any RFC 8032
// implementation, which is what makes this an app↔server contract anchor.
const VECTOR = {
  seed: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
  deviceId: "device-abc",
  message: "device-abc:nonce-123",
  pubkey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  signature: "N9-V2jE0Ql76ycmjAGTdiHK2ZiU55ucScm2tsRWoTzRj1xP03E2WS4uzXDlzABgG_ZiScuuCxkKr6v5ZmdaCBw",
};

test("identity: pinned cross-stack vector — @noble reproduces the server's bytes", () => {
  const id = identityFromSeed(VECTOR.deviceId, VECTOR.seed);
  assert.equal(id.publicKey, VECTOR.pubkey);
  assert.equal(id.sign(VECTOR.message), VECTOR.signature);
});

test("identity: loadOrCreate persists and round-trips; clear wipes", async () => {
  const store = memoryStore();
  const first = await loadOrCreateIdentity(store, nodeRandom);
  assert.match(first.deviceId, /^[A-Za-z0-9_-]{16,}$/);
  assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/);

  const second = await loadOrCreateIdentity(store, nodeRandom);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(second.publicKey, first.publicKey);
  // Same seed → deterministic signature.
  assert.equal(second.sign("m1"), first.sign("m1"));

  await clearIdentity(store);
  const third = await loadOrCreateIdentity(store, nodeRandom);
  assert.notEqual(third.deviceId, first.deviceId);
});

test("identity: signature verifies under node:crypto via the JWK wrap (the server's import path)", () => {
  const id = identityFromSeed(VECTOR.deviceId, VECTOR.seed);
  const pub = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: id.publicKey }, format: "jwk" });
  const sigBuf = Buffer.from(id.sign(VECTOR.message), "base64url");
  assert.equal(crypto.verify(null, Buffer.from(VECTOR.message, "utf8"), pub, sigBuf), true);
  // Tampered message must fail.
  assert.equal(crypto.verify(null, Buffer.from("device-abc:nonce-124", "utf8"), pub, sigBuf), false);
});
