// Decision delivery must not cost the turn its context
// (fix-decision-delivery-context).
//
// The old execute-now splice REPLACED `{{fleetContext}}` with the decision
// digest. The engine's injection seam only renders when the placeholder is
// still there, so the delivery turn — the owner forcing a ruling, the highest
// stakes turn in the lane — ran with LESS context than an ordinary cadence
// round, and an owner-forced turn is exactly the one that needs to see the
// fleet state it is about to change.
//
// The fix is one judgement (`keepFleetContextPlaceholder`), so this suite pins
// that judgement on both sides of the switch. The seam's own behaviour is
// covered by test-fleet-report-lane (unchanged).
//
// Run: node --test scripts/test-decision-delivery-context.mjs

import assert from "node:assert/strict";
import { test, after } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deliv-ctx-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

const cron = await import("../cron.js");

after(() => {
  cron.setFleetContextRenderer(null);
  try { cron.shutdown?.(); } catch { /* nothing armed */ }
});

test("accessor: cron reports whether a renderer is mounted", () => {
  cron.setFleetContextRenderer(null);
  assert.equal(cron.hasFleetContextRenderer(), false);
  cron.setFleetContextRenderer(async () => "【集群巡视上下文】在岗 2/2");
  assert.equal(cron.hasFleetContextRenderer(), true);
  cron.setFleetContextRenderer(null);
});

test("judgement: with a renderer, a templated prompt KEEPS its placeholder", () => {
  cron.setFleetContextRenderer(async () => "段");
  try {
    // This is what the route asks before composing the delivery prompt. Keeping
    // the placeholder is what lets the seam render the context (and the ruling,
    // which rides the same segment) — pre-baking would silently kill both.
    assert.equal(cron.keepFleetContextPlaceholder("巡视下属。{{fleetContext}}"), true);
    // A prompt without the placeholder has nothing to keep: the route pre-bakes.
    assert.equal(cron.keepFleetContextPlaceholder("没有占位符"), false);
    assert.equal(cron.keepFleetContextPlaceholder(null), false);
    assert.equal(cron.keepFleetContextPlaceholder(undefined), false);
  } finally {
    cron.setFleetContextRenderer(null);
  }
});

test("judgement: without a renderer the placeholder is NOT kept (nothing would expand it)", () => {
  cron.setFleetContextRenderer(null);
  // The turn must then receive the ruling in its prompt — a placeholder left
  // behind would reach the model as literal text and the ruling would be lost.
  assert.equal(cron.keepFleetContextPlaceholder("巡视下属。{{fleetContext}}"), false);
});

test("judgement: a non-function renderer counts as absent", () => {
  cron.setFleetContextRenderer("not-a-function");
  try {
    assert.equal(cron.hasFleetContextRenderer(), false);
    assert.equal(cron.keepFleetContextPlaceholder("{{fleetContext}}"), false);
  } finally {
    cron.setFleetContextRenderer(null);
  }
});
