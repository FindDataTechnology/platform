#!/usr/bin/env node
// ── Ops-console board alarm tests (fix-ops-console-board-alarms, tasks 2.6)
//
//   computeDrift       — cluster-internal-facts matrix: Synced ⇒ in-agreement
//                        (a differing fallback-pipeline tag can no longer
//                        produce "newer build not rolled"), OutOfSync ⇒
//                        flagged, no ArgoCD fact ⇒ unknown;
//   storeLastOk        — true recovery age: newest non-error snapshot, never
//                        the failed write's own timestamp, null when the
//                        source has never succeeded;
//   renderFleetOverview— degraded line reports last-ok from real successes
//                        ("never succeeded" when none);
//   renderFleet        — the five-state legend is present (warm = no live
//                        process, re-warms on demand).
//
//   node --test scripts/test-ops-console-board.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Module init reads env (token gate, DB_PATH) and renderFleetOverview branches
// on FLEET_BOARD_URL — all must be set before the dynamic import.
const tmpDir = mkdtempSync(path.join(tmpdir(), "ops-console-test-"));
process.env.OPS_CONSOLE_TOKEN = "test-token";
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.FLEET_BOARD_URL = "http://100.64.0.12:31881";

const { computeDrift, argocdStatusFor, overallStatus, storeWrite, storeLatest, storeLastOk, renderFleetOverview, renderFleet } =
  await import("../services/ops-console/index.js");

test("computeDrift: synced ⇒ in-agreement even when the fallback build tag would differ", () => {
  // The live false-positive: running sha-f221a40 (canonical GHA path) while
  // the fallback build system's last tag was sha-6048f89. There is no build
  // input anymore — Synced is the whole verdict.
  const d = computeDrift("ccr.ccs.tencentyun.com/yizuo/platform:sha-f221a40", { sync: "Synced" });
  assert.equal(d.status, "in-agreement");
  assert.equal(d.running, "sha-f221a40");
  assert.equal(d.built, undefined);
});

test("computeDrift: out-of-sync application is flagged", () => {
  const d = computeDrift("reg/platform:sha-f221a40", { sync: "OutOfSync" });
  assert.equal(d.status, "cluster-out-of-sync");
});

test("computeDrift: no ArgoCD fact ⇒ unknown, never a derived verdict", () => {
  const d = computeDrift("reg/platform:sha-f221a40", null);
  assert.equal(d.status, "unknown");
});

test("computeDrift: non-sha image with Synced still agrees, unparsed tag stays null", () => {
  const d = computeDrift("library/node:25-bookworm-slim", { sync: "Synced" });
  assert.equal(d.status, "in-agreement");
  assert.equal(d.running, null);
});

test("storeLastOk: reports the last success, not the failed write's timestamp", () => {
  const oldOk = Date.now() - 3600_000;
  storeWrite("t-lastok", { agents_total: 1 }, oldOk);
  storeWrite("t-lastok", { __error: "getaddrinfo ENOTFOUND fleet-observer" }, Date.now());
  assert.equal(storeLastOk("t-lastok"), oldOk);
  // The latest snapshot is still the failure — renderers keep their stale view.
  assert.ok(storeLatest("t-lastok").data.__error);
});

test("storeLastOk: never-succeeded source returns null", () => {
  storeWrite("t-never", { __error: "HTTP 401" }, Date.now());
  assert.equal(storeLastOk("t-never"), null);
});

// renderFleetOverview reads the hardcoded "fleetBoard" source and the module
// owns one DB — order matters: never-succeeded must run before any successful
// fleetBoard snapshot lands in the store.
test("renderFleetOverview: never-succeeded source says so explicitly", () => {
  storeWrite("fleetBoard", { __error: "connect ECONNREFUSED" }, Date.now());
  const html = renderFleetOverview();
  assert.match(html, /board read failed/);
  assert.match(html, /never succeeded/);
  assert.doesNotMatch(html, /last ok/);
});

test("renderFleetOverview: degraded line derives last-ok from the last success", () => {
  const oldOk = Date.now() - 3600_000;
  storeWrite("fleetBoard", { agents_total: 2, states: { resident: 2 } }, oldOk);
  storeWrite("fleetBoard", { __error: "getaddrinfo ENOTFOUND fleet-observer" }, Date.now());
  const html = renderFleetOverview();
  assert.match(html, /board read failed/);
  assert.match(html, /last ok \d+s ago/);
  assert.doesNotMatch(html, /never succeeded/);
});

test("renderFleetOverview: healthy board renders live data", () => {
  storeWrite("fleetBoard", { agents_total: 3, states: { resident: 2, warm: 1 }, turns: 5, errors: 0 }, Date.now());
  const html = renderFleetOverview();
  assert.match(html, /fleet overview/);
  assert.match(html, /3 agent\(s\)/);
  assert.match(html, /warm 1/);
});

test("renderFleet: five-state legend present, warm explained as no live process", () => {
  storeWrite("runnerHealth", { ok: true, agents: [{ key: "pack-demo-fingpt", state: "warm", version: 1, port: 8793 }], children: 0, queued: 0, budget: 0, budgetMb: 512 }, Date.now());
  const html = renderFleet();
  assert.match(html, /agent fleet/);
  assert.match(html, /warm no live process/);
  assert.match(html, /re-warms on demand/);
  assert.match(html, /resident warm &amp; idle/);
});

// ── fix-ops-console-drift-granularity: per-deployment drift fact ─────────────

test("argocdStatusFor: own Synced entry wins over an app-wide OutOfSync", () => {
  const app = { sync: "OutOfSync", resources: [{ kind: "Deployment", name: "lawcraw", status: "OutOfSync" }, { kind: "Deployment", name: "platform", status: "Synced" }] };
  assert.equal(argocdStatusFor("platform", app).sync, "Synced");
});

test("argocdStatusFor: own OutOfSync entry flags the deployment", () => {
  const app = { sync: "Synced", resources: [{ kind: "Deployment", name: "platform", status: "OutOfSync" }] };
  assert.equal(argocdStatusFor("platform", app).sync, "OutOfSync");
});

test("argocdStatusFor: unlisted deployment falls back to the app-level status", () => {
  const app = { sync: "OutOfSync", resources: [{ kind: "Deployment", name: "lawcraw", status: "OutOfSync" }] };
  assert.equal(argocdStatusFor("platform", app).sync, "OutOfSync");
});

test("argocdStatusFor: no ArgoCD fact at all stays null", () => {
  assert.equal(argocdStatusFor("platform", null), null);
});

const cleanModel = (argocd) => ({
  cards: [],
  banner: { nodes: [], oomEvictions: 0, jenkinsQueue: 0, argocd },
  jenkins: null, harbor: { reachable: true }, relay: null,
  stale: { k8s: false, jenkins: false },
});

test("overallStatus: app-level OutOfSync counts exactly one warning with clean cards", () => {
  const s = overallStatus(cleanModel({ sync: "OutOfSync", resources: [] }));
  assert.equal(s.cls, "warn");
  assert.equal(s.label, "1 warning");
});

test("overallStatus: fully synced app with clean cards is all nominal", () => {
  const s = overallStatus(cleanModel({ sync: "Synced", resources: [] }));
  assert.equal(s.cls, "ok");
  assert.equal(s.label, "all nominal");
});

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));
