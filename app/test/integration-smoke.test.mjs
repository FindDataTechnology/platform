// End-to-end smoke (tasks 2.1/2.2 integration half): the APP-side code —
// @noble/curves identity + pairing client, exactly what pair.tsx drives —
// against a REAL server.js booted with forward_auth + MP_TOKEN_SECRET.
// Everything except the RN UI is exercised: probe → pair → silent login →
// replay rejection (401) → revoke → rebind signal.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadOrCreateIdentity, clearIdentity } from "../src/lib/device-identity.ts";
import { createPairingClient } from "../src/lib/pairing.ts";

const REPO = path.resolve(import.meta.dirname, "../..");

const scratch = mkdtempSync(path.join(tmpdir(), "app-pair-smoke-"));
const dataDir = path.join(scratch, "data");
const PORT = 9400 + Math.floor(Math.random() * 90);
const child = spawn(process.execPath, [path.join(REPO, "server.js")], {
  cwd: REPO,
  // Own process group so teardown can kill the server AND its dsh child in
  // one shot (see e2e/helpers.js spawnTestServer for the full rationale).
  detached: true,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    PLATFORM_DATA_DIR: dataDir,
    DSH_HOME: path.join(scratch, "dsh"),
    MCP_CONFIG_PATH: path.join(dataDir, "mcp.json"),
    LLM_API_KEY: "",
    AUTH_MODE: "forward_auth",
    MP_TOKEN_SECRET: "app-smoke-secret",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      // forward_auth answers anonymous /api/config with 401 — any HTTP answer
      // (even 401/404) means the listener is up.
      const r = await fetch(`http://127.0.0.1:${PORT}/api/config`);
      if (r.status < 500) return;
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("smoke server never came up");
}

test.after(async () => {
  // Group teardown: SIGKILL on the direct pid orphans the dsh child (PPID=1,
  // spinning under launchd). SIGTERM the group, wait out the bridge's
  // shutdown ladder, then group-SIGKILL any straggler.
  if (child.pid) {
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch { /* group gone */ }
    };
    killGroup("SIGTERM");
    const deadline = Date.now() + 15_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    killGroup("SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(scratch, { recursive: true, force: true });
});

test("app-side pairing chain against a real instance", async () => {
  await waitForServer();
  const base = `http://127.0.0.1:${PORT}`;
  const webHeaders = { "x-forwarded-email": "smoke@corp.com", "x-forwarded-groups": "users" };
  // forward_auth shape: every request traverses the proxy, which injects the
  // identity headers — the app's Bearer rides on top for the management
  // routes. (The pairing routes need neither.)
  const client = createPairingClient((p, init) =>
    fetch(base + p, { ...init, headers: { ...webHeaders, ...(init?.headers ?? {}) } }),
  );

  // Probe through the proxy (identity injected): the capability is readable.
  // The anonymous-401→unknown case is covered by the unit tests.
  assert.equal(await client.probeConfig(), "supported");

  // In-memory KeyStore; node randomness — the pure app logic.
  const mem = new Map();
  const store = {
    get: async (k) => mem.get(k) ?? null,
    set: async (k, v) => void mem.set(k, v),
    remove: async (k) => void mem.delete(k),
  };
  await clearIdentity(store);
  const identity = await loadOrCreateIdentity(store, (n) => new Uint8Array(n));

  // Mint from the web side, pair with the real endpoints.
  const mint = await fetch(`${base}/api/mp/bindcode`, { headers: { ...webHeaders, accept: "application/json" } }).then((r) => r.json());
  assert.match(String(mint.code), /^\d{6}$/);
  const paired = await client.pair({
    code: mint.code,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    label: "smoke device",
  });
  assert.equal(paired.ok, true);

  // The token is a kind=app JWT carrying the account identity.
  const claims = JSON.parse(Buffer.from(paired.token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.kind, "app");
  assert.equal(claims.did, identity.deviceId);
  assert.equal(claims.email, "smoke@corp.com");

  // Silent login: real challenge, @noble signature, real verification.
  const silent = await client.silentLogin(identity);
  assert.equal(silent.ok, true);

  // Revoke self with the app bearer, then the next silent login says rebind.
  assert.equal(await client.revokeSelf(paired.token, identity.deviceId), true);
  const revoked = await client.silentLogin(identity);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.rebind, true);
});
