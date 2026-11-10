#!/usr/bin/env node
// ── Same-name publish gate tests (add-mixed-fleet-packs-and-market-consolidation 3.1) ──
//
// Mounts the REAL publish path — registerPackRoutes with a temp pack
// registry — exactly as facet/index.js assembles it, with the gate module
// registered BEFORE the pack routes (registration order is the mechanism),
// substituting only the Logto session with a test header. Scenarios from
// design D5 / pack-marketplace delta "Publish abuse controls":
//   1. same author + same name (mint)        → 409 naming the existing packId
//   2. same name under a different author    → passes (curation matter)
//   3. a rejected publish stores nothing     → registry snapshot unchanged
//   4. listed OR unlisted both block; version-append under the same packId
//      (the upgrade path the 409 points to) passes; authorEmail matching is
//      exact (no trim, no normalization).
//
//   node --test scripts/test-facet-publish-gate.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test, after } from "node:test";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { registerSameNamePublishGate } from "../facet/publish-gate.js";

const tmp = mkdtempSync(path.join(tmpdir(), "facet-pub-gate-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const registry = createPackRegistry({ file: path.join(tmp, "packs.db") });

// The only stand-in: Logto's session becomes a test header. Everything past
// this seam is production code.
const resolveUser = (req) => {
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

const app = express();
app.use(express.json({ limit: "24mb" })); // same global parser posture as facet/index.js
// Registration order mirrors facet/index.js: the gate pre-route first, the
// publish handler from registerPackRoutes behind it.
registerSameNamePublishGate(app, { registry, resolveUser });
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
after(() => {
  server.closeAllConnections?.();
  server.close();
  registry.close();
});

const CREATOR = "gate-author@findmail.com";
const OTHER = "gate-other@findmail.com";
// Exact-match discipline: a byte-different email is a DIFFERENT author.
const CREATOR_TRAILING_SPACE = ` ${CREATOR}`;

const manifest = (name) => ({
  name,
  description: "same-name publish gate test",
  skills: [{ name: "gate-skill", description: "gate test body", content: "# gate\nsame-name publish gate" }],
});

const publish = (email, body) =>
  fetch(`${base}/api/packs`, {
    method: "POST",
    headers: { "x-test-session": JSON.stringify({ email, groups: ["creators"] }), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const authorView = (email) => registry.list({ author: email, viewer: { email }, pageSize: 100 });

test("first publish lands, then same author + same name is a structured 409 naming the pack", async () => {
  const first = await publish(CREATOR, { manifest: manifest("同名防呆·样例") });
  assert.equal(first.status, 200);
  const { id } = await first.json();

  const dup = await publish(CREATOR, { manifest: manifest("同名防呆·样例") });
  assert.equal(dup.status, 409);
  const body = await dup.json();
  assert.equal(body.code, "DUPLICATE_PACK_NAME");
  assert.equal(body.existingPackId, id);
  // The reject wording carries the identifier AND the upgrade path.
  assert.ok(body.error.includes(id), `error must name the existing packId: ${body.error}`);
  assert.match(body.error, /新版本/);
  assert.match(body.hint, /packId/);
});

test("same name under a different author passes (cross-author collisions are curation)", async () => {
  const r = await publish(OTHER, { manifest: manifest("同名防呆·样例") });
  assert.equal(r.status, 200);
  const doc = await r.json();
  assert.notEqual(doc.id, (await authorView(CREATOR)).packs[0].id);
  // Both authors now hold a live pack under the same name — allowed.
  assert.equal((await authorView(OTHER)).total, 1);
  assert.equal((await authorView(CREATOR)).total, 1);
});

test("a rejected publish stores nothing", async () => {
  const mine = await authorView(CREATOR);
  const existingId = mine.packs[0].id;
  const versionsBefore = registry.versions(existingId).length;
  const marketBefore = (await fetch(`${base}/api/packs?pageSize=100`).then((x) => x.json())).total;

  const dup = await publish(CREATOR, { manifest: manifest("同名防呆·样例") });
  assert.equal(dup.status, 409);

  // Zero rows anywhere: no second pack for the author, no new version on the
  // existing one, the public listing did not grow.
  const mineAfter = await authorView(CREATOR);
  assert.equal(mineAfter.total, mine.total);
  assert.equal(mineAfter.packs.length, mine.packs.length);
  assert.equal(registry.versions(existingId).length, versionsBefore);
  const marketAfter = (await fetch(`${base}/api/packs?pageSize=100`).then((x) => x.json())).total;
  assert.equal(marketAfter, marketBefore);
});

test("unlisted packs also block — listed OR unlisted, both count", async () => {
  const existingId = (await authorView(CREATOR)).packs[0].id;
  assert.equal(registry.setUnlisted({ email: CREATOR, id: existingId }), true);

  const dup = await publish(CREATOR, { manifest: manifest("同名防呆·样例") });
  assert.equal(dup.status, 409);
  const body = await dup.json();
  assert.equal(body.existingPackId, existingId);
});

test("the upgrade path the 409 points to works: version-append under the same packId passes", async () => {
  const existingId = (await authorView(CREATOR)).packs[0].id;
  const r = await publish(CREATOR, { packId: existingId, manifest: manifest("同名防呆·样例") });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, 2);
});

test("authorEmail matches exactly — no trim, no normalization", async () => {
  // A byte-different email is a different author: the gate must not fold
  // whitespace (or case) when deciding "same author".
  const r = await publish(CREATOR_TRAILING_SPACE, { manifest: manifest("同名防呆·样例") });
  assert.equal(r.status, 200);
  assert.equal((await authorView(CREATOR_TRAILING_SPACE)).total, 1);
});
