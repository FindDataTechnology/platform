// Unit tests — steward uplink chapter (add-cell-lifecycle 4.1/4.2/4.3).
//
// Pins:
//   - steward-kind pairing: token kind=steward, binding records kind,
//     stewardFromToken speaks ONLY on the reporting door (accountFromToken
//     still refuses it), silent re-login re-mints steward (never an app token)
//   - the reporting door: whitelist BY SHAPE (content keys never pass),
//     401 for any non-steward credential, degrades open when ingest unset,
//     relay event carries source=cell-steward and no overlay fields
//   - uplink self-discipline: no pair file => no reporter token; platform
//     down => bounded buffer never stalls the tick; second 401 => local
//     identity burned and reporting stops (destroy protocol channel ③)
//
// Run: node --test scripts/test-steward-uplink.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { createMpBindings, APP_KEY_PREFIX } = await import("../gateway/mp-bindings.js");
const { createAppAuth } = await import("../gateway/app-auth.js");
const { verifyMpJwt } = await import("../gateway/mp-auth.js");
const { createCellReportDoor } = await import("../gateway/cell-report.js");
const { createKeyStorage } = await import("../supervisor/steward-identity.js");
const { createStewardReporter } = await import("../supervisor/steward-reporter.js");

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function privFromSeed(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
}

function setupAuth() {
  const secret = "test-secret-steward";
  const bindings = createMpBindings({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bind-")), "bindings.db") });
  const appAuth = createAppAuth({ tokenSecret: secret, ttlHours: 24, bindings });
  return { secret, bindings, appAuth };
}

test("steward-kind pair: token carries kind, accountFromToken refuses, stewardFromToken speaks", async () => {
  const { bindings, appAuth } = setupAuth();
  const code = bindings.issueBindCode ? bindings.issueBindCode("u@x.test", [])?.code : null;
  assert.ok(code, "harness: mintBindCode surface available");
  const seed = Buffer.alloc(32, 9);
  const pub = crypto.createPublicKey(privFromSeed(seed)).export({ format: "jwk" });
  const r = await appAuth.pair({ code, deviceId: "steward-1", pubkey: pub.x, label: "客厅 Mac mini", kind: "steward" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const payload = verifyMpJwt(r.token, "test-secret-steward");
  assert.equal(payload.kind, "steward");
  assert.equal(appAuth.accountFromToken(r.token), null, "steward token must NOT authenticate as a user session");
  const who = appAuth.stewardFromToken(r.token);
  assert.equal(who?.did, "steward-1");
  assert.equal(who?.email, "u@x.test");
  // and the binding kept the kind for silent re-mints
  const binding = bindings.get(APP_KEY_PREFIX + "steward-1");
  assert.equal(binding.kind, "steward");
});


test("credential-domain polity: steward token never becomes an account session", async () => {
  const { bindings, appAuth } = setupAuth();
  const seed = Buffer.alloc(32, 11);
  const pub = crypto.createPublicKey(privFromSeed(seed)).export({ format: "jwk" });
  // steward pair
  const code1 = bindings.issueBindCode("u@x.test", []).code;
  const st = await appAuth.pair({ code: code1, deviceId: "steward-pol", pubkey: pub.x, label: null, kind: "steward" });
  assert.equal(st.ok, true);
  assert.equal(appAuth.sessionEligibleToken(st.token), null, "steward token refused on user surfaces");
  assert.equal(appAuth.accountFromToken(st.token), null);
  assert.ok(appAuth.stewardFromToken(st.token), "…but speaks on the reporting door");
  // app pair (regression): still session-eligible
  const code2 = bindings.issueBindCode("u@x.test", []).code;
  const ap = await appAuth.pair({ code: code2, deviceId: "app-pol", pubkey: pub.x, label: null });
  assert.equal(ap.ok, true);
  const session = appAuth.sessionEligibleToken(ap.token);
  assert.equal(session?.email, "u@x.test");
  assert.equal(session?.mp, true);
});

// ── reporting door ─────────────────────────────────────────────────────────

test("reporting door: whitelist shape only, ingest relay carries source+kind verbatim", async () => {
  const relayed = [];
  const who = { email: "u@x.test", did: "steward-1", deviceKind: "steward" };
  const door = createCellReportDoor({
    appAuth: { stewardFromToken: (t) => (t === "good" ? who : null) },
    env: { FLEET_INGEST_URL: "https://ingest.test", FLEET_INGEST_TOKEN: "tok" },
    fetchImpl: async (url, init) => { relayed.push({ url, init }); return { ok: true, status: 202 }; },
  });
  const res = { code: null, body: null };
  await door.handle({
    headers: { authorization: "Bearer good" },
    body: {
      kind: "manifest",
      payload: {
        fleetCount: 2,
        memberCount: 8,
        enabledTaskCount: 4,
        labels: ["柏讯舆情", "跨境电商盯梢"],
        prompt: "绝不能出机",
        sessions: ["s-1"],
      },
    },
  }, { status: (c) => ({ json: (b) => { res.code = c; res.body = b; } }) });
  assert.equal(res.code, 202);
  assert.equal(relayed.length, 1);
  const ev = JSON.parse(relayed[0].init.body).events[0];
  assert.equal(ev.source, "cell-steward");
  assert.equal(ev.kind, "cell_manifest");
  assert.equal(ev.agent, `cell-steward:${who.did}`);
  assert.deepEqual(Object.keys(ev.payload).sort(), ["enabledTaskCount", "fleetCount", "labels", "memberCount"].sort(), "content keys never pass the shape");
});

test("reporting door refuses non-steward credential and endorse-open without ingest", async () => {
  const door1 = createCellReportDoor({ appAuth: { stewardFromToken: () => null }, env: {} });
  const r1 = { code: null };
  await door1.handle({ headers: { authorization: "Bearer trash" }, body: { kind: "presence", payload: { state: "running" } } }, { status: (c) => ({ json: () => { r1.code = c; } }) });
  assert.equal(r1.code, 401);

  const door2 = createCellReportDoor({ appAuth: { stewardFromToken: () => ({ email: "a", did: "d", deviceKind: "steward" }) }, env: {} });
  const r2 = { code: null, body: null };
  await door2.handle({ headers: { authorization: "Bearer x" }, body: { kind: "presence", payload: { state: "running", os: "darwin", appVersion: "1", protocolVersion: 1, at: 1 } } }, { status: (c) => ({ json: (b) => { r2.code = c; r2.body = b; } }) });
  assert.equal(r2.code, 202);
  assert.equal(r2.body.relayed, false, "no ingest configured = accept-and-drop, never an error");
});

// ── uplink client self-discipline ──────────────────────────────────────────

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "uplink-")); }

test("no pair file ⇒ no token ⇒ no reporting (default OFF)", () => {
  const dataDir = tmpDir();
  const storage = createKeyStorage({ cellId: "c", dataDir });
  const rep = createStewardReporter({ steward: { registry: { get: () => null, put: () => {} }, running: true, cellId: "c" }, dataDir, storage });
  assert.equal(rep.enabled, false);
});

test("second 401 burns the identity and stops reporting", async () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "steward-pair.json"), JSON.stringify({ token: "t", deviceId: "d", gatewayUrl: "https://g.test", email: "e" }, null, 2), { mode: 0o600 });
  const storage = createKeyStorage({ cellId: "d", dataDir });
  await storage.set("priv");
  const rep = createStewardReporter({
    steward: { registry: { get: () => null, put: () => {} }, running: true, cellId: "d" },
    dataDir,
    storage,
    fetchImpl: async () => ({ status: 401, body: {} }),
  });
  assert.equal(rep.enabled, true);
  await rep.tick();
  assert.equal(fs.existsSync(path.join(dataDir, "steward-pair.json")), false, "pair file burned");
  assert.equal(await storage.get(), null, "private key burned");
  assert.equal(rep.state.token, null, "in-memory credential burned too");
});

test("sync manifestFn (the production shape) must not silently kill the tick", async () => {
  // Regression: the caller's manifestFn in steward.js is SYNCHRONOUS; tick used
  // to call manifestFn().catch() — a TypeError on a plain object — and every
  // production tick died before posting anything (smoke smoke-caught upstream).
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "steward-pair.json"), JSON.stringify({ token: "t", deviceId: "d", gatewayUrl: "https://g.test", email: "e" }, null, 2), { mode: 0o600 });
  const storage = createKeyStorage({ cellId: "d", dataDir });
  let posts = 0;
  const rep = createStewardReporter({
    steward: { registry: { get: () => null, put: () => {} }, running: true, cellId: "d" },
    dataDir,
    storage,
    manifestFn: () => ({ fleetCount: 2, labels: [3] }), // sync, plain object
    fetchImpl: async () => { posts += 1; return { status: 202, body: {} }; },
  });
  await rep.tick();
  assert.ok(posts >= 2, `presence+manifest posted through the sync manifestFn (${posts})`);
});

test("throwing sync manifestFn degrades to the default manifest, never a dead tick", async () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "steward-pair.json"), JSON.stringify({ token: "t", deviceId: "d", gatewayUrl: "https://g.test", email: "e" }, null, 2), { mode: 0o600 });
  const storage = createKeyStorage({ cellId: "d", dataDir });
  let posts = 0;
  const rep = createStewardReporter({
    steward: { registry: { get: () => null, put: () => {} }, running: true, cellId: "d" },
    dataDir,
    storage,
    manifestFn: () => { throw new Error("beacon store unreadable"); },
    fetchImpl: async () => { posts += 1; return { status: 202, body: {} }; },
  });
  await rep.tick();
  assert.ok(posts >= 2, `tick survived a throwing manifestFn (${posts})`);
});
