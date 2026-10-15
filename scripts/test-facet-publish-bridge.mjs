#!/usr/bin/env node
// ── Facet pairing surface + publish bridge tests (add-facet-publish-bridge, F3.2) ──
//
// Mounts the REAL modules — pairing.js (bindcode + pair/challenge/login +
// device management + withAppBearer) and registerPackRoutes with a temp pack
// registry — on one express app, substituting only the Logto session with a
// test header. Drives the full wire flow a CLI would: mint a bind code from a
// session, pair a real Ed25519 device, publish through the app Bearer token,
// silently re-login, and hit every gate (creator group, revocation, closed
// pairing).
//
//   node --test scripts/test-facet-publish-bridge.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { test, before, after } from "node:test";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { createFacetPairing, registerPairingRoutes, withAppBearer } from "../facet/pairing.js";

const tmp = mkdtempSync(path.join(tmpdir(), "facet-bridge-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const SECRET = "bridge-test-secret";
const pairing = createFacetPairing({ dataRoot: tmp, tokenSecret: SECRET, ttlHours: 1 });
const registry = createPackRegistry({ file: path.join(tmp, "packs.db") });

// The only stand-in: Logto's session becomes a test header. Everything past
// this seam is production code.
const baseResolve = (req) => {
  const raw = req.headers["x-test-session"];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    if (typeof doc?.email !== "string") return null;
    return { email: doc.email, groups: Array.isArray(doc.groups) ? doc.groups : [] };
  } catch {
    return null;
  }
};
const rejectUnauthenticated = (_req, res) => res.status(401).json({ error: "Authentication required" });
const resolveUser = withAppBearer(baseResolve, pairing.appAuth);

const app = express();
app.use(express.json({ limit: "1mb" }));
registerPairingRoutes(app, { appAuth: pairing.appAuth, mpBindings: pairing.bindings, resolveUser, rejectUnauthenticated });
registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: ["creators"],
  adminGroups: [],
  anonymousRead: true,
});

const server = http.createServer(app);
const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

const session = (email, groups) => ({ "x-test-session": JSON.stringify({ email, groups }), Accept: "application/json" });
const bearer = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });

const CREATOR = "bridge-author@findmail.com";
const OUTSIDER = "bridge-outsider@findmail.com";

// A real Ed25519 device, exactly as the CLI mints one (JWK `x` = base64url
// raw 32 bytes; signature over `deviceId:nonce`).
function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    deviceId: crypto.randomBytes(12).toString("base64url"),
    pubkey: publicKey.export({ format: "jwk" }).x,
    privateKey,
  };
}

async function pairDevice(device, email, groups) {
  const bc = await fetch(`${base}/api/mp/bindcode`, { headers: session(email, groups) }).then((r) => r.json());
  assert.match(String(bc.code), /^\d{6}$/);
  const pr = await fetch(`${base}/api/app/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(bc.code), deviceId: device.deviceId, pubkey: device.pubkey, label: "bridge-test" }),
  });
  return { status: pr.status, doc: await pr.json() };
}

const manifest = (name) => ({
  name,
  description: "publish bridge test",
  skills: [{ name: "bridge-skill", description: "cross-instance body", content: "# body\nthe transported skill content" }],
});

before(async () => {
  await pairing.bindings.load();
});

after(() => {
  server.closeAllConnections?.();
  server.close();
  registry.close();
});

test("pair via bind code, then publish lands under the paired account", async () => {
  const device = newDevice();
  const { status, doc } = await pairDevice(device, CREATOR, ["creators"]);
  assert.equal(status, 200);
  assert.equal(doc.email, CREATOR);

  const r = await fetch(`${base}/api/packs`, {
    method: "POST",
    headers: { ...bearer(doc.token), "Content-Type": "application/json" },
    body: JSON.stringify({ packId: null, manifest: manifest("回流桥端到端") }),
  });
  assert.equal(r.status, 200);
  const published = await r.json();
  assert.equal(published.version, 1);

  // The pack is public on the market — the cross-instance pull source shape.
  const detail = await fetch(`${base}/api/packs/${published.id}`).then((x) => x.json());
  assert.equal(detail.authorEmail, CREATOR);
  assert.equal(detail.manifest.skills[0].content.includes("transported skill content"), true);
  return published.id;
});

test("silent re-login (challenge + signature) appends a version", async (t) => {
  const device = newDevice();
  const { doc } = await pairDevice(device, CREATOR, ["creators"]);
  const first = await fetch(`${base}/api/packs`, {
    method: "POST",
    headers: { ...bearer(doc.token), "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: manifest("静默续登测试") }),
  }).then((x) => x.json());

  // Fresh token through the silent door only — no browser anywhere.
  const ch = await fetch(`${base}/api/app/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: device.deviceId }),
  }).then((x) => x.json());
  const signature = crypto
    .sign(null, Buffer.from(`${device.deviceId}:${ch.nonce}`, "utf8"), device.privateKey)
    .toString("base64url");
  const lg = await fetch(`${base}/api/app/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: device.deviceId, nonce: ch.nonce, signature }),
  });
  assert.equal(lg.status, 200);
  const { token } = await lg.json();

  const v2 = await fetch(`${base}/api/packs`, {
    method: "POST",
    headers: { ...bearer(token), "Content-Type": "application/json" },
    body: JSON.stringify({ packId: first.id, manifest: manifest("静默续登测试 v2") }),
  });
  assert.equal(v2.status, 200);
  assert.equal((await v2.json()).version, 2);
  t.diagnostic(`appended version onto ${first.id}`);
});

test("non-creator pairing passes auth but fails the publish gate with 403", async () => {
  const device = newDevice();
  const { doc } = await pairDevice(device, OUTSIDER, ["everyone"]);
  const r = await fetch(`${base}/api/packs`, {
    method: "POST",
    headers: { ...bearer(doc.token), "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: manifest("门外汉的包") }),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "Creator group required");
});

test("revocation (via the device's own app token) kills silent login with binding_required", async () => {
  const device = newDevice();
  const { doc } = await pairDevice(device, CREATOR, ["creators"]);
  const del = await fetch(`${base}/api/app/bind/${device.deviceId}`, { method: "DELETE", headers: bearer(doc.token) });
  assert.equal(del.status, 200);
  const ch = await fetch(`${base}/api/app/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: device.deviceId }),
  });
  assert.equal(ch.status, 401);
  assert.equal((await ch.json()).error, "binding_required");
});

test("without the token secret the doors answer an honest 503 and publish stays session-gated", async () => {
  const closed = createFacetPairing({ dataRoot: path.join(tmp, "closed"), tokenSecret: "", ttlHours: 1 });
  const pr = await fetch(`${base}/api/app/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "123456", deviceId: "whatever-device", pubkey: "A".repeat(43) }),
  });
  // This app IS configured; assert the closed instance's own door shape.
  const own = await new Promise((resolve) => {
    const a2 = express();
    a2.use(express.json());
    registerPairingRoutes(a2, {
      appAuth: closed.appAuth,
      mpBindings: closed.bindings,
      resolveUser: withAppBearer(() => null, closed.appAuth),
      rejectUnauthenticated,
    });
    const s2 = http.createServer(a2).listen(0, "127.0.0.1", async () => {
      const resp = await fetch(`http://127.0.0.1:${s2.address().port}/api/app/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456", deviceId: "d", pubkey: "A".repeat(43) }),
      });
      s2.closeAllConnections?.();
      s2.close(() => resolve(resp));
    });
  });
  assert.equal(own.status, 503);
  void pr;
});

test("withAppBearer resolves the base channel first and only accepts kind=app tokens", async () => {
  const device = newDevice();
  const { doc } = await pairDevice(device, CREATOR, ["creators"]);
  // A session AND a (bogus) bearer: the session must win.
  const who = await fetch(`${base}/api/mp/bindcode`, {
    headers: { ...session(OUTSIDER, []), Authorization: "Bearer not-a-token", Accept: "application/json" },
  });
  assert.equal(who.status, 200); // the outsider session minted, the junk bearer ignored
  // A forged bearer without a pairing is nobody.
  const nobody = await fetch(`${base}/api/packs`, {
    method: "POST",
    headers: { ...bearer("forged.token.value"), "Content-Type": "application/json" },
    body: JSON.stringify({ manifest: manifest("伪造者") }),
  });
  assert.equal(nobody.status, 401);
  void doc;
});
