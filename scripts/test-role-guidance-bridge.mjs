// Agent→agent guidance over the fleet-architect bridge (agent-as-employee-model):
// a post submits a patch as itself; the bridge narrows self-reported identity to
// "a post of this fleet"; nothing here can approve — only propose and read.
//
// Run: node --test scripts/test-role-guidance-bridge.mjs

import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.PLATFORM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-bridge-"));
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const { registerFleetArchitectRoutes } = await import("../server/fleet-architect.js");

const db = getFleetDatabase();
db.createFleet({ id: "f_b", name: "b", ownerEmail: "owner@test" });
db.createMember({ id: "m_b", fleetId: "f_b", title: "a", targetKind: "tool", targetId: "s::t" });
db.upsertRoleState({ fleetId: "f_b", memberId: "m_b", organs: { charter: "v0" } });
db.createFleet({ id: "f_other", name: "o", ownerEmail: "other@test" });
db.createMember({ id: "m_other", fleetId: "f_other", title: "x", targetKind: "tool", targetId: "s::t" });

const app = express();
app.use(express.json());
registerFleetArchitectRoutes({ app, cellUserEmail: "owner@test" });
const roApp = express();
roApp.use(express.json());
registerFleetArchitectRoutes({ app: roApp, cellUserEmail: "owner@test" }, { mount: "/ro", readOnly: true });
const s1 = app.listen(0), s2 = roApp.listen(0);
await Promise.all([new Promise((r) => s1.once("listening", r)), new Promise((r) => s2.once("listening", r))]);
after(() => { s1.close(); s2.close(); });
const base = `http://127.0.0.1:${s1.address().port}/api/fleet-architect`;
const roBase = `http://127.0.0.1:${s2.address().port}/ro`;
const json = (method, url, body) =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 80) }; }
    return { status: r.status, body: parsed };
  });

const patch = (over = {}) => ({ memberId: "m_b", baseVersion: 0, organ: "charter", content: "先核对", reason: "lesson", ...over });

test("agent submits as its post; appears pending with member: author", async () => {
  const r = await json("POST", `${base}/fleets/f_b/guidance`, patch());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.patch.author, { kind: "agent", id: "member:m_b" });
  assert.equal(r.body.patch.state, "pending");
});

test("a post of another fleet cannot author here", async () => {
  const r = await json("POST", `${base}/fleets/f_b/guidance`, patch({ memberId: "m_other" }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /post in this fleet/);
});

test("readOnly mount cannot submit (runner lane proposes nothing)", async () => {
  const r = await json("POST", `${roBase}/fleets/f_b/guidance`, patch());
  assert.equal(r.status, 404);
});

test("list returns patches plus each post's currentVersion and organs", async () => {
  const r = await json("GET", `${base}/fleets/f_b/guidance?state=pending`);
  assert.equal(r.status, 200);
  assert.ok(r.body.patches.length >= 1);
  const role = r.body.roles.find((x) => x.memberId === "m_b");
  assert.equal(role.currentVersion, 0);
  assert.equal(role.organs.charter, "v0");
});

test("no approve path on the bridge", async () => {
  const { body } = await json("GET", `${base}/fleets/f_b/guidance`);
  const { patches } = body;
  const id = patches[0].id;
  const r = await json("POST", `${base}/fleets/f_b/guidance/${id}/merge`, {});
  assert.equal(r.status, 404);
});
