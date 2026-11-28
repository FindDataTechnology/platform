// ── Marketing collect door ──────────────────────────────────────────────────
//
// Pins the three rules that keep this door from becoming the 2026-11-19 500:
//   * the field is `user` (registry.status()'s projection name), and a cell
//     without one must be refused rather than forwarded with undefined;
//   * a NAMED cell that is not running refuses — it never falls back to another
//     cell, because that would write one owner's counters into another's db;
//   * an UNSET owner picks the first running cell (the collector is a single
//     machine-owned sink, not a per-user lane).
//
// The ordering assertion (door BEFORE the cell-proxy catch-all) lives in
// scripts/test-gateway-assembly.mjs, because only the assembled app sees order.
//
// Run: node --test scripts/test-marketing-collect-door.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideMarketingCollectDoor } from "../gateway/marketing-collect-door.js";

const cell = (user, port) => ({ user, userId: `u-${user}`, port });

test("unset owner picks the first running cell", () => {
  const r = decideMarketingCollectDoor({ owner: "", cells: [cell("a@x", 3101), cell("b@x", 3102)] });
  assert.equal(r.ok, true);
  assert.equal(r.cell.user, "a@x");
});

test("unset owner with no running cells refuses with a reason", () => {
  const r = decideMarketingCollectDoor({ owner: "", cells: [] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(r.reason, /no running cell/);
});

test("a named owner targets exactly that cell", () => {
  const r = decideMarketingCollectDoor({
    owner: "ops@x",
    cells: [cell("a@x", 3101), cell("ops@x", 3102)],
  });
  assert.equal(r.ok, true);
  assert.equal(r.cell.user, "ops@x");
  assert.equal(r.cell.port, 3102);
});

test("a named owner that is not running refuses — never falls back", () => {
  const r = decideMarketingCollectDoor({ owner: "missing@x", cells: [cell("a@x", 3101)] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(r.reason, /MARKETING_EVENTS_CELL=missing@x/);
});

test("a cell missing the `user` field is not a valid target (the 2026-11-19 500)", () => {
  // 这正是第一版上产的形状：status() 的字段是 user，代码读了 email。
  const emailOnly = [{ email: "a@x", port: 3101 }];
  const r = decideMarketingCollectDoor({ owner: "", cells: emailOnly });
  assert.equal(r.ok, false, "a cell without `user` must be refused, not forwarded");
  assert.equal(r.status, 503);
});

test("a cell without a port is not a valid target", () => {
  const r = decideMarketingCollectDoor({ owner: "", cells: [{ user: "a@x" }] });
  assert.equal(r.ok, false);
});
