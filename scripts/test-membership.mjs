// Task-bound temporary membership (agent-as-employee-model 4.3 / 4.4).
// Run: node --test scripts/test-membership.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { membershipActive } from "../lib/membership.js";

test("常驻成员（无绑定任务）始终有效", () => {
  assert.equal(membershipActive({ id: "m" }, () => null).active, true);
});

test("绑定任务在跑 ⇒ 有效；终态 ⇒ 失效并给原因", () => {
  const tasks = { t1: { status: "active" }, t2: { status: "completed" }, t3: { status: "expired" } };
  const get = (id) => tasks[id] ?? null;
  assert.equal(membershipActive({ boundTaskId: "t1" }, get).active, true);
  for (const id of ["t2", "t3"]) {
    const r = membershipActive({ boundTaskId: id }, get);
    assert.equal(r.active, false);
    assert.match(r.reason, /temporary membership ended/);
  }
});

test("绑定任务已不存在 ⇒ 失效（fail-closed）", () => {
  const r = membershipActive({ boundTaskId: "gone" }, () => null);
  assert.equal(r.active, false);
});

test("boundTaskId 往返落库，置 null 即转常驻", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "membership-"));
  const { createFleetDatabase } = await import("../server/routes/fleets-db.js");
  const db = createFleetDatabase({ file: path.join(dir, "fleets.db") });
  db.createFleet({ id: "f", name: "f", ownerEmail: "o@x" });
  const m = db.createMember({ id: "m1", fleetId: "f", title: "temp", targetKind: "persona", targetId: "p" });
  db.updateMember(m.id, { boundTaskId: "task-1" });
  assert.equal(db.getMember(m.id).boundTaskId, "task-1");
  db.updateMember(m.id, { boundTaskId: null });
  assert.equal(db.getMember(m.id).boundTaskId, null);
});
