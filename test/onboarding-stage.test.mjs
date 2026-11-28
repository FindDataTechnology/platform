// first-run-onboarding: the stage machine, migration rule, and telemetry.
// Pure-function coverage plus the profile-doc round-trip through a fake db.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STAGES,
  advanceStage,
  deriveStage,
  readIntent,
  writeIntent,
  recordStageEvent,
} from "../server/onboarding.js";

function fakeDb() {
  const prefs = new Map();
  return {
    isDbReady: () => true,
    getPreference: (k) => (prefs.has(k) ? prefs.get(k) : null),
    setPreference: (k, v) => prefs.set(k, v),
  };
}

test("deriveStage: answered roles → provisioned; skip/team → done; dismissed tour → done; empty → new", () => {
  assert.equal(deriveStage({ answeredAt: "2026-01-01", roles: ["legal"] }), "provisioned");
  assert.equal(deriveStage({ skipped: true }), "done");
  assert.equal(deriveStage({ wantsTeam: true }), "done");
  assert.equal(deriveStage({}, { legacyTourDone: true }), "done");
  assert.equal(deriveStage({}), "new");
  // answeredAt without roles is not a role answer
  assert.equal(deriveStage({ answeredAt: "2026-01-01", roles: [] }), "new");
});

test("advanceStage: forward moves allowed (incl. skipped middles), backward rejected, same idempotent", () => {
  assert.deepEqual(advanceStage("new", "provisioned"), { stage: "provisioned" });
  assert.deepEqual(advanceStage("new", "done"), { stage: "done" });
  assert.deepEqual(advanceStage("role_answered", "provisioned"), { stage: "provisioned" });
  assert.deepEqual(advanceStage("provisioned", "provisioned"), { stage: "provisioned" });
  assert.equal(typeof advanceStage("done", "new").error, "string");
  assert.equal(typeof advanceStage("new", "bogus").error, "string");
});

test("writeIntent preserves the stage when the new profile omits it", () => {
  const db = fakeDb();
  writeIntent({ db, email: "a@b.c" }, { roles: [], note: "", skipped: false, answeredAt: null, wantsTeam: false, stage: "role_answered" });
  assert.equal(readIntent({ db, email: "a@b.c" }).stage, "role_answered");
  // a later answers-style write that does not name a stage must not erase it
  writeIntent({ db, email: "a@b.c" }, { roles: ["legal"], note: "", skipped: false, answeredAt: "2026-01-01", wantsTeam: false });
  assert.equal(readIntent({ db, email: "a@b.c" }).stage, "role_answered");
});

test("readIntent: an unknown stored stage reads as null", () => {
  const db = fakeDb();
  db.setPreference("onboarding.intent", JSON.stringify({ roles: [], stage: "nonsense" }));
  assert.equal(readIntent({ db }).stage, null);
});

test("recordStageEvent: appends one JSON line; empty dataDir is a silent no-op; write failure does not throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "onb-events-"));
  try {
    recordStageEvent({ at: "2026-01-01T00:00:00Z", email: "a@b.c", from: "new", to: "done", source: "migrate" }, { dataDir: dir });
    const path = join(dir, "onboarding-events.jsonl");
    assert.ok(existsSync(path));
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    assert.deepEqual(line, { at: "2026-01-01T00:00:00Z", email: "a@b.c", from: "new", to: "done", source: "migrate" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // no dataDir → no throw, no file
  assert.doesNotThrow(() => recordStageEvent({ at: "x" }, { dataDir: "" }));
  // unwritable dir → warn, no throw
  assert.doesNotThrow(() => recordStageEvent({ at: "x" }, { dataDir: "/proc/nonexistent-root-dir" }));
});

test("STAGES: ordered and complete", () => {
  assert.deepEqual(STAGES, ["new", "role_answered", "provisioned", "done"]);
});
