// Dissolve (`DELETE /api/fleets/:id`) must reconcile AFTER archiving.
//
// Why this pin exists (add-pack-memory-declaration 4.2): the pack memory policy
// release lives inside `reconcileFleet` and only fires for an ARCHIVED fleet
// whose pack has no other live team. The dissolve route used to archive the
// fleet, remove its cron jobs and stop — so the policy root `d-<pack>` kept its
// document until some UNRELATED catalog change happened to sweep every fleet
// (`reconcileAllFleets` on the catalog hook in server.js). In a quiet cell that
// sweep may never come.
//
// Source-shape on purpose: `createFleetRoutes` needs a live fleets db plus the
// cron engine to drive end to end, while the defect is a MISSING call — which
// the shape captures exactly. Delete the call and this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "server", "routes", "fleets.js"), "utf8");

/** The dissolve handler's own text: from its registration to the next route. */
function dissolveHandler() {
  const start = SRC.indexOf('router.delete("/:id"');
  assert.notEqual(start, -1, "the dissolve route is gone — re-point this pin");
  const next = SRC.indexOf("router.", start + 10);
  return SRC.slice(start, next === -1 ? undefined : next);
}

test("dissolve reconciles after archiving, so a pack's policy root can be released", () => {
  const body = dissolveHandler();
  const archived = body.indexOf('{ state: "archived" }');
  const reconciled = body.indexOf("await runReconcile(");
  assert.notEqual(archived, -1, "the dissolve handler no longer archives the fleet");
  assert.notEqual(
    reconciled,
    -1,
    "dissolve archives but never reconciles — the 4.2 policy release would wait for an unrelated catalog sweep",
  );
  assert.ok(
    reconciled > archived,
    "reconcile must run AFTER the archive write, otherwise the fleet still reads active and 4.2 cannot fire",
  );
});

test("the handler says why, so the next editor does not drop the call again", () => {
  const body = dissolveHandler();
  assert.match(body, /4\.2/, "the call has no reason attached (4.2) — it reads removable");
  assert.match(
    body,
    /archive is stop-and-keep|never \(re\)materialize/i,
    "the safety argument (reconcile cannot re-materialize an archived fleet) is not recorded next to the call",
  );
});
