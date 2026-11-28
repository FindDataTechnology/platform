// fix-dispatch-to-parked-post: a dispatch must not mint a turn nobody can run.
//
// Measured 2026-11-14 (cell 1da519d4c1c0bf89, 24h): four round failures carried
// `Unknown agent preset: <targetId>` — the fleet layer had parked those posts
// (their target rows are gone), but `paused` only stops cadence fires. Manual
// dispatch still created a turn, and it failed from the first millisecond:
// `fleet_1794064092202_yz64fb` 简报岗 ran 336 rounds in 7 days, ALL failed.
//
// The predicate is deliberately the SAME resolver the draft surface
// (`validateFleetDraft`) uses — one question, one answer. This file pins both
// directions plus the two deliberate exemptions, because a guard that only ever
// says "no" is indistinguishable from a guard wired backwards.
//
// Run: node --test scripts/test-dispatch-target-runnable.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

const tmpRoot = (await import("node:fs")).mkdtempSync(
  (await import("node:path")).join((await import("node:os")).tmpdir(), "dispatch-runnable-"),
);
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = `${tmpRoot}/app.db`;
process.env.PLATFORM_DATA_DIR = tmpRoot;

const { dispatchTargetRunnable } = await import("../server/routes/fleets.js");

const deadResolve = () => ({ alive: false, label: "policy-brief", clusterName: null });
const liveResolve = () => ({ alive: true, label: "幕僚长", clusterName: null });

test("死目标：派发被拒，文案点名岗位与目标", () => {
  const r = dispatchTargetRunnable({ title: "简报岗", targetKind: "persona", targetId: "policy-brief" }, deadResolve);
  assert.equal(r.ok, false);
  assert.match(r.error, /简报岗/);
  assert.match(r.error, /policy-brief/);
  assert.match(r.error, /restaff/);
});

test("活目标：照常放行", () => {
  const r = dispatchTargetRunnable({ title: "幕僚长", targetKind: "persona", targetId: "chief" }, liveResolve);
  assert.deepEqual(r, { ok: true });
});

test("工具岗豁免：能力面由运行期判（add-tool-posts 的既有决定）", () => {
  const r = dispatchTargetRunnable({ title: "盯梢岗", targetKind: "tool", targetId: "websearch::web_search" }, deadResolve);
  assert.deepEqual(r, { ok: true }, "工具岗不因 server 不可路由在派发面被拒");
});

test("集群岗不在本判据内（Guard 4 先拒）", () => {
  const r = dispatchTargetRunnable({ title: "集群岗", targetKind: "cluster", targetId: "c1" }, deadResolve);
  assert.deepEqual(r, { ok: true });
});

test("a2a 目标同样按同一判据判活", () => {
  const dead = dispatchTargetRunnable({ title: "外部团队", targetKind: "a2a", targetId: "agent-x" }, deadResolve);
  assert.equal(dead.ok, false);
  const live = dispatchTargetRunnable({ title: "外部团队", targetKind: "a2a", targetId: "agent-x" }, liveResolve);
  assert.deepEqual(live, { ok: true });
});

test("缺 target：拒绝而不是抛", () => {
  const r = dispatchTargetRunnable(null, liveResolve);
  assert.equal(r.ok, false);
});
