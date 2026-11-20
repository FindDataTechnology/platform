// Secure device identity: a stable opaque deviceId plus an Ed25519 keypair,
// generated once, private key never leaving the platform secure store
// (Keychain / Keystore via expo-secure-store). The storage and crypto
// providers are injected so unit tests run on plain node with node:crypto —
// the same RFC 8032 wire format the server pins (design D4, ADR-0020).

import { ed25519 } from "@noble/curves/ed25519";

export interface KeyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string; // base64url raw 32 bytes
  sign(message: string): string; // base64url
}

const DEVICE_ID_KEY = "yizuo.deviceId";
const PRIVKEY_KEY = "yizuo.ed25519.priv";

// Pure-JS base64url: no btoa/Buffer — identical bytes on Hermes, node, tests.
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toB64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_CHARS[b2 & 63];
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const out: number[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    const n =
      (B64_CHARS.indexOf(b64[i]) << 18) |
      (B64_CHARS.indexOf(b64[i + 1]) << 12) |
      ((B64_CHARS.indexOf(b64[i + 2]) & 63) << 6) |
      (B64_CHARS.indexOf(b64[i + 3]) & 63);
    out.push((n >> 16) & 255);
    if (b64[i + 2] !== "=") out.push((n >> 8) & 255);
    if (b64[i + 3] !== "=") out.push(n & 255);
  }
  return Uint8Array.from(out);
}

// Random bytes provider: expo-crypto in the app, node:crypto in tests.
export type RandomProvider = (n: number) => Uint8Array;

export async function loadOrCreateIdentity(
  store: KeyStore,
  random: RandomProvider,
): Promise<DeviceIdentity> {
  let deviceId = await store.get(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = toB64Url(random(16));
    await store.set(DEVICE_ID_KEY, deviceId);
  }
  let privHex = await store.get(PRIVKEY_KEY);
  if (!privHex) {
    privHex = toB64Url(random(32));
    await store.set(PRIVKEY_KEY, privHex);
  }
  const seed = fromB64Url(privHex);
  const publicKey = toB64Url(ed25519.getPublicKey(seed));
  return {
    deviceId,
    publicKey,
    // The signed message format is the cross-stack contract pinned by the
    // server's fixed vector: `deviceId:nonce` over UTF-8.
    sign: (message: string) => toB64Url(ed25519.sign(new TextEncoder().encode(message), seed)),
  };
}

export async function clearIdentity(store: KeyStore): Promise<void> {
  await store.remove(DEVICE_ID_KEY);
  await store.remove(PRIVKEY_KEY);
}

// Deterministic identity from a stored seed — the bootstrap path after the
// first creation (and the test path for the pinned cross-stack vector).
export function identityFromSeed(deviceId: string, seedB64Url: string): DeviceIdentity {
  const seed = fromB64Url(seedB64Url);
  return {
    deviceId,
    publicKey: toB64Url(ed25519.getPublicKey(seed)),
    sign: (message: string) => toB64Url(ed25519.sign(new TextEncoder().encode(message), seed)),
  };
}

// Exported for tests and for verifying against the server's pinned vector.
export const wire = { toB64Url, fromB64Url };
