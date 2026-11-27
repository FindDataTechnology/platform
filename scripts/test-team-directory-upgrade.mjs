#!/usr/bin/env node
// Upgrade path (openspec: add-agent-team-directory, task 5.2).
//
// A cell that never published anything must survive the upgrade untouched:
// booting the new route module on an existing fleet database creates the two
// card tables (empty) and changes nothing about the existing read faces.
//
// "Byte-identical" is asserted literally — the fleet listing is serialised
// before and after the boot and compared as a string. A projection that quietly
// reorders or adds a field is exactly the kind of regression a deepEqual with a
// hand-written expectation misses.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import { createFleetDatabase, setFleetDatabase } from "../server/routes/fleets-db.js";
import { registerTeamCardRoutes } from "../server/routes/team-cards.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-cards-upgrade-"));

test("an existing cell DB gains two empty tables and no other change", () => {
  const file = path.join(tmpDir, "old-cell.db");
  const fleetDb = createFleetDatabase({ file });
  try {
    fleetDb.createFleet({ id: "f-old", name: "既有团队", ownerEmail: "old@x.test", state: "active" });
    fleetDb.createMember({ id: "m-old", fleetId: "f-old", title: "老岗位", targetKind: "persona", targetId: "preset-1" });

    const before = JSON.stringify({
      fleets: fleetDb.listFleets(),
      members: fleetDb.listMembers("f-old"),
    });
    const tablesBefore = fleetDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.equal(tablesBefore.includes("team_cards"), false, "the old DB must not already have the table");

    setFleetDatabase(fleetDb);
    const app = express();
    registerTeamCardRoutes({ app, authEnabled: false, cellUserEmail: "old@x.test" });

    const tablesAfter = fleetDb.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.ok(tablesAfter.includes("team_cards"), "boot must create the table");
    assert.ok(tablesAfter.includes("team_card_events"), "boot must create the audit table");
    assert.equal(
      fleetDb.db.prepare("SELECT COUNT(*) AS n FROM team_cards").get().n,
      0,
      "a cell with no publications must have no rows",
    );

    const after = JSON.stringify({
      fleets: fleetDb.listFleets(),
      members: fleetDb.listMembers("f-old"),
    });
    assert.equal(after, before, "the existing read faces must be unchanged byte for byte");

    // A second boot (every restart) must be a no-op, not a throw.
    registerTeamCardRoutes({ app: express(), authEnabled: false, cellUserEmail: "old@x.test" });
    assert.equal(fleetDb.db.prepare("SELECT COUNT(*) AS n FROM team_cards").get().n, 0);
  } finally {
    fleetDb.close();
    fs.rmSync(file, { force: true });
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
  }
});
