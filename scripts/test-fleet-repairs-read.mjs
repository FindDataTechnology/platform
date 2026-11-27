// 舰队可修复项读面（允许给特定岗位加大时间预算的出口）。
// Run: node --test scripts/test-fleet-repairs-read.mjs
//
// 判据：软停的岗 → 产出一条 cadence.turnTimeoutMs 建议；已顶上限的岗 →
// 不产出（修复脑如实回 insufficient evidence）；无失败 → null。

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.PLATFORM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-repairs-"));
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

const db = getFleetDatabase();
db.createFleet({ id: "f_rep", name: "rep", ownerEmail: "o@test" });
db.createFleet({ id: "f_cap", name: "cap", ownerEmail: "o@test" });
db.createMember({ id: "m_soft", fleetId: "f_rep", title: "常务岗", targetKind: "tool", targetId: "s::t" });
db.createMember({ id: "m_cap", fleetId: "f_cap", title: "台账主编", targetKind: "tool", targetId: "s::t" });
db.updateMember("m_soft", { cadence: { cron: "0 */2 * * *", tz: "Asia/Shanghai", enabled: true } });
db.updateMember("m_cap", { cadence: { cron: "0 8 * * *", turnTimeoutMs: 1800000 } });

const now = Date.now();
const push = (fleetId, memberId, error, budgetMs) => db.appendTurnEvent({
  fleetId, memberId, source: "cron", status: "failed", errorKind: "timeout",
  error, startedAt: now - 1000, endedAt: now, detail: { budgetMs },
});
push("f_rep", "m_soft", "turn stopped early — budget soft stop (480s of 600s)", 600000);
push("f_cap", "m_cap", "turn stopped early — budget soft stop (1440s of 1800s)", 1800000);

const express = (await import("express")).default;
const app = express();
app.use((req, _res, next) => { req.user = { email: "o@test", groups: [] }; next(); });
createFleetRoutes(app, { authEnabled: true });
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("软停的岗出现在可修复项里，取值是 900s", async () => {
  const r = await fetch(`${base}/api/fleets/f_rep/cockpit`).then((x) => x.json());
  const rep = r.health?.repairs;
  assert.ok(rep, "repairs missing: " + JSON.stringify(r.health));
  const soft = rep.updates.find((u) => u.memberId === "m_soft");
  assert.ok(soft, JSON.stringify(rep.updates));
  assert.equal(soft.after.cadence.turnTimeoutMs, 900000);
  assert.equal(soft.after.cadence.cron, "0 */2 * * *", "cron 不许被动");
});

test("已顶上限的岗不产出建议（修复脑如实回 insufficient evidence）", async () => {
  const r = await fetch(`${base}/api/fleets/f_cap/cockpit`).then((x) => x.json());
  const rep = r.health?.repairs;
  assert.equal(rep?.ok, false, JSON.stringify(rep));
  assert.match(JSON.stringify(rep?.missingEvidence), /no turn-timeout evidence/);
});
