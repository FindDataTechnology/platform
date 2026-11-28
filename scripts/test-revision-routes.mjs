// Route tests for revision governance (harden-agent-runtime-spine,
// runtime-revision 5.3–5.5). The rules are pinned in test-runtime-revision.mjs;
// this file pins the WIRING — that the owner gate answers, that a refusal is a
// 409 with its reason (not a 500), and that a rollback whose target no longer
// reproduces is refused rather than trusted.
//
// Run: node --test scripts/test-revision-routes.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";

const tmp = mkdtempSync(path.join(tmpdir(), "revision-routes-"));

const { registerRevisionRoutes } = await import("../server/routes/revisions.js");

const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

let db;
let server;
let base;
let reproduced = {}; // deployment → fingerprint() returns this

before(async () => {
  db = new Database(path.join(tmp, "fleets.db"));
  const app = express();
  app.use(express.json());
  registerRevisionRoutes({
    app,
    getDb: () => db,
    requireOwner: (req) => (req.headers["x-owner"] === "nobody" ? null : { email: req.headers["x-owner"] || "owner@example.com" }),
    fingerprintOf: async (deployment) => reproduced[deployment] ?? null,
    log: { warn: () => {} },
  });
  server = createServer(app).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const call = (p, body = null, headers = {}) =>
  fetch(base + p, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const DEP = "packs-p1";
const create = (fp, extra = {}) => call(`/api/revisions/${DEP}`, { fingerprint: fp, ...extra });

test("owner gate: a non-owner gets 403, not a 500 and not a silent success", async () => {
  const r = await call(`/api/revisions/${DEP}`, null, { "x-owner": "nobody" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "NOT_OWNER");
});

test("create: a revision without a fingerprint is refused by name", async () => {
  const r = await call(`/api/revisions/${DEP}`, { name: "v1" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "FINGERPRINT_REQUIRED");
});

test("create: a trial about a DIFFERENT build is refused, not stored", async () => {
  await create(FP_A);
  const r = await call(`/api/revisions/${DEP}`, { fingerprint: FP_A, trial: { fingerprint: FP_B, assertions: [{ pass: true }] } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "trial-fingerprint-mismatch");
});

test("promote: no trial ⇒ 409 naming the reason; an audited override succeeds", async () => {
  await create(FP_A);
  const refused = await call(`/api/revisions/${DEP}/promote`, { revisionId: FP_A });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "no-trial");

  const forced = await call(`/api/revisions/${DEP}/promote`, {
    revisionId: FP_A, override: true, overrideReason: "hotfix window",
  });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.moved, true);

  const list = await call(`/api/revisions/${DEP}`);
  assert.equal(list.body.active.revisionId, FP_A);
  const last = list.body.governance.at(-1);
  assert.equal(last.overridden, true, "the override is recorded, not silent");
  assert.equal(last.overrideReason, "hotfix window");
  assert.ok(last.by, "and names who did it");
});

test("promote: a green trial under the same fingerprint is the normal path", async () => {
  await create(FP_B);
  await call(`/api/revisions/${DEP}`, {
    fingerprint: FP_B,
    trial: { fingerprint: FP_B, assertions: [{ pass: true }], green: true },
  });
  const r = await call(`/api/revisions/${DEP}/promote`, { revisionId: FP_B });
  assert.equal(r.status, 200);
  assert.equal(r.body.decision.reason, "trial-green");
  const list = await call(`/api/revisions/${DEP}`);
  assert.equal(list.body.active.revisionId, FP_B, "the pointer moved");
});

test("rollback: a target that no longer reproduces is REFUSED as divergence", async () => {
  reproduced = { [DEP]: "c".repeat(64) }; // the tree drifted: reproduces a DIFFERENT fingerprint
  const r = await call(`/api/revisions/${DEP}/rollback`, { revisionId: FP_A });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "diverged");
  assert.match(r.body.error.message, /drift/i);
});

test("rollback: no way to reproduce ⇒ refused, never assumed", async () => {
  reproduced = {};
  const r = await call(`/api/revisions/${DEP}/rollback`, { revisionId: FP_A });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "cannot-reproduce");
});

test("rollback: a reproducing target moves the pointer and is recorded", async () => {
  reproduced = { [DEP]: FP_A };
  const r = await call(`/api/revisions/${DEP}/rollback`, { revisionId: FP_A, reason: "regression in v2" });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, true);
  const list = await call(`/api/revisions/${DEP}`);
  assert.equal(list.body.active.revisionId, FP_A);
  const last = list.body.governance.at(-1);
  assert.equal(last.action, "rollback");
  assert.equal(last.from, FP_B);
  assert.equal(last.to, FP_A);
  assert.equal(last.reason, "regression in v2");
});

test("unknown revision ids are 404 on both verbs — not a silent no-op", async () => {
  const p = await call(`/api/revisions/${DEP}/promote`, { revisionId: "d".repeat(64) });
  assert.equal(p.status, 404);
  const r = await call(`/api/revisions/${DEP}/rollback`, { revisionId: "d".repeat(64) });
  assert.equal(r.status, 404);
});
