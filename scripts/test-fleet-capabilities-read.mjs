// 团队能力读面（capability-layer scope=team）。
// Run: node --test scripts/test-fleet-capabilities-read.mjs
//
// 三条判据：无来源包如实说明 / 有包时返回该团队各岗能力 / manifest 读不出不返回空表。

import assert from "node:assert/strict";
import { test, after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.PLATFORM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-caps-"));
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createRoleGuidanceRoutes } = await import("../server/routes/role-guidance.js");
const dbModule = await import("../db.js");
await dbModule.initDb();

const db = getFleetDatabase();
db.createFleet({ id: "f_cap", name: "cap", ownerEmail: "o@test" });
db.createMember({ id: "m1", fleetId: "f_cap", title: "岗1", targetKind: "tool", targetId: "s::t" });
db.createFleet({ id: "f_bare", name: "bare", ownerEmail: "o@test" });

const app = express();
app.use((req, _res, next) => { req.user = { email: "o@test", groups: [] }; next(); });
createRoleGuidanceRoutes(app, { authEnabled: true });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}/api/fleets`;
const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));

test("没从 pack 建队的团队 ⇒ 如实说明，不返回空表", async () => {
  const r = await get("/f_bare/capabilities");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /not built from a pack/);
  assert.equal(r.body.capabilities, undefined, "不许给一张看起来正常的空表");
});

test("有来源包但 manifest 读不出 ⇒ 如实说明", async () => {
  db.updateFleet("f_cap", { sourceTemplate: { packId: "no-such-pack", version: 1 } });
  const r = await get("/f_cap/capabilities");
  assert.equal(r.body.ok, false);
  assert.match(r.body.reason, /not readable/);
});

test("有来源包 ⇒ 返回 team scope 的能力表", async () => {
  const manifest = {
    name: "p", skills: [{ name: "s1", description: "S1" }],
    mcpServers: [{ registryName: "srv", allowTools: ["t1"] }],
    agents: [{ id: "a1", name: "岗1", resources: { skills: ["s1"] } }],
    fleet: { members: [{ ref: "m1", target: { kind: "existing-persona", id: "a1" } }] },
  };
  // 真装一个包（ESM 的模块导出不可赋值，所以走真实写入路径而不是打桩）。
  dbModule.getDb()
    .prepare(`INSERT INTO installed_packs (pack_id, name, version, manifest, report, source, installed_at, updated_at)
              VALUES (?, ?, ?, ?, '[]', 'market', datetime('now'), datetime('now'))`)
    .run("test-pack-1", "测试包", 1, JSON.stringify(manifest));
  db.updateFleet("f_cap", { sourceTemplate: { packId: "test-pack-1", version: 1 } });

  const r = await get("/f_cap/capabilities");
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.capabilities));
  assert.ok(r.body.capabilities.some((c) => c.kind === "skill" && c.name === "s1"), "技能应出现在团队能力表里");
});
