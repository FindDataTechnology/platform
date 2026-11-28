// Guidance routes + owner-inbox lane (agent-as-employee-model 2.2–2.4).
//
// Run: node --test scripts/test-role-guidance-routes.mjs

import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.PLATFORM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rg-routes-"));
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createRoleGuidanceRoutes } = await import("../server/routes/role-guidance.js");
const { laneTable } = await import("../server/owner-inbox.js");

const db = getFleetDatabase();
const fleet = db.createFleet({ id: "f_rg_1", name: "t", ownerEmail: "owner@x" });
db.upsertRoleState({ fleetId: fleet.id, memberId: "m1", organs: { charter: "v0" } });

const app = express();
app.use(express.json());
app.use((req, _res, next) => { const e = req.get("x-user"); if (e) req.user = { email: e, groups: [] }; next(); });
createRoleGuidanceRoutes(app, { authEnabled: true });
const server = app.listen(0);
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}/api/fleets/${fleet.id}`;
const call = (method, p, body, user = "owner@x") =>
  fetch(base + p, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

test("非属主 403，匿名 401", async () => {
  assert.equal((await call("GET", "/guidance", null, "other@x")).status, 403);
  assert.equal((await call("GET", "/guidance", null, null)).status, 401);
});

test("提交：发起人取自身份，body 里伪造的 author 被忽略", async () => {
  const r = await call("POST", "/members/m1/guidance", { baseVersion: 0, organ: "charter", content: "x", reason: "r", author: { kind: "agent", id: "spoof" } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.patch.author, { kind: "human", id: "owner@x" });
});

test("缺字段 400 并点名", async () => {
  const r = await call("POST", "/members/m1/guidance", { organ: "charter" });
  assert.equal(r.status, 400);
  assert.ok(r.body.missing.includes("baseVersion"));
});

test("收件箱出现待审补丁；合入后版本前进且离开收件箱；再合 400", async () => {
  const items = laneTable({ email: "owner@x" })["guidance-patch"]();
  assert.ok(items.length >= 1);
  const id = items[0].itemRef;
  const m = await call("POST", `/guidance/${id}/merge`);
  assert.equal(m.status, 200);
  const v = await call("GET", "/members/m1/role/versions?source=guidance");
  assert.equal(v.body.current, 1);
  assert.ok(!laneTable({ email: "owner@x" })["guidance-patch"]().some((i) => i.itemRef === id));
  assert.equal((await call("POST", `/guidance/${id}/merge`)).status, 400);
});

test("基版本过期 409", async () => {
  const p = await call("POST", "/members/m1/guidance", { baseVersion: 0, organ: "charter", content: "y", reason: "r" });
  const r = await call("POST", `/guidance/${p.body.patch.id}/merge`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "stale-base");
});

test("别的舰队的补丁 id 在本舰队路径下 404", async () => {
  const other = db.createFleet({ id: "f_rg_2", name: "o", ownerEmail: "owner@x" });
  db.upsertRoleState({ fleetId: other.id, memberId: "m1", organs: {} });
  const { patch } = db.submitGuidancePatch({ fleetId: other.id, memberId: "m1", baseVersion: 0, organ: "charter", content: "z", reason: "r", author: { kind: "human", id: "owner@x" } });
  assert.equal((await call("POST", `/guidance/${patch.id}/merge`)).status, 404);
});

test("三视图在真库上可取；成本两视图一致；self 校验成员归属", async () => {
  const g = await call("GET", "/views/general");
  assert.equal(g.status, 200, JSON.stringify(g.body));
  for (const k of ["reports", "progress", "difficulties", "cost", "outcomes", "commitments"]) assert.ok(k in g.body, k);
  const p = await call("GET", "/views/professional");
  assert.equal(p.status, 200);
  assert.deepEqual(g.body.cost, p.body.cost);
  assert.ok(!("error" in g.body.progress), JSON.stringify(g.body.progress));
  assert.equal((await call("GET", "/views/self")).status, 400);
  assert.equal((await call("GET", "/views/self?memberId=nope")).status, 404);
  assert.equal((await call("GET", "/views/boss")).status, 400);
});

test("克隆角色：目标舰队须同属主；成功后目标岗带器官与胜任力", async () => {
  const db2 = getFleetDatabase();
  const tgt = db2.createFleet({ id: "f_rg_t", name: "t2", ownerEmail: "owner@x" });
  db2.createMember({ id: "tm1", fleetId: tgt.id, title: "clone", targetKind: "tool", targetId: "s::t" });
  const denied = await call("POST", "/members/m1/role/clone", { toFleetId: tgt.id, toMemberId: "tm1" }, "other@x");
  assert.equal(denied.status, 403);
  const r = await call("POST", "/members/m1/role/clone", { toFleetId: tgt.id, toMemberId: "tm1" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.domainMemory, "pending-memory-service-copy");
  assert.equal(db2.getRoleState(tgt.id, "tm1").organs.charter, "x");
  const again = await call("POST", "/members/m1/role/clone", { toFleetId: tgt.id, toMemberId: "tm1" });
  assert.equal(again.status, 409);
});

test("晋升预览含胜任力引用、不含记忆内容；不存在角色 404", async () => {
  const r = await call("GET", "/members/m1/role/promotion");
  assert.equal(r.status, 200);
  assert.equal(r.body.provenance.role.includes("m1"), true);
  assert.ok(Array.isArray(r.body.competence));
  assert.equal((await call("GET", "/members/nope/role/promotion")).status, 404);
});

test("成长轨迹：版本、最近来源与待审数逐岗可读", async () => {
  const r = await call("GET", "/roles");
  assert.equal(r.status, 200);
  const row = r.body.roles.find((x) => x.memberId === "m1");
  assert.equal(row.currentVersion, 1, JSON.stringify(row));
  assert.equal(row.latestSource, "guidance");
  assert.ok(row.changes >= 1);
  assert.equal(typeof row.pendingPatches, "number");
});
