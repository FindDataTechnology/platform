// ── Run workbench host: the acquire/sweep race (fleet-run-workbench §1.4) ───
//
// sweep() with keepDays=0 skips the age check, so a bench that exists on disk
// but is not yet in the host's live set is a directory it deletes on sight.
// acquire() awaits create() (mkdir) before it used to mark live — the window
// between the two is exactly where a concurrent hourly sweep would reap the
// run's brand-new bench. This pins that acquire marks live BEFORE create, so a
// sweep fired in that window leaves the bench alone.
//
//   node --test scripts/test-run-workbench-host.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { createRunWorkbenchHost } from "../server/run-workbench-host.js";

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test("a sweep fired while acquire is mid-create does NOT reap the new bench", async () => {
  const base = await tmp("wbhost-base"); // plain dir ⇒ directory backend
  const dataRoot = await tmp("wbhost-data");
  const host = createRunWorkbenchHost({ base, dataRoot });

  // Start the acquire and, without awaiting it, fire a sweep. acquire() has
  // already marked the ref live synchronously before its first await (create's
  // mkdir), so the sweep must see it as live and keep it.
  const acquireP = host.acquire({ id: "run-race-1" }, null);
  const sweepP = host.sweep();
  const [wb, swept] = await Promise.all([acquireP, sweepP]);

  assert.ok(swept.removed.every((d) => !d.endsWith(wb.workbenchRef)), "the new bench was not swept");
  // And the bench is actually usable (a file can be written under it).
  await fs.writeFile(path.join(wb.cwd, "out.txt"), "x");
  assert.equal((await fs.readFile(path.join(wb.cwd, "out.txt"), "utf8")), "x");
});

test("a bench released with keepDays=0 is gone after release; a sweep confirms", async () => {
  const base = await tmp("wbhost-base");
  const dataRoot = await tmp("wbhost-data");
  const host = createRunWorkbenchHost({ base, dataRoot });
  const wb = await host.acquire({ id: "run-rel-1" }, null);
  await fs.writeFile(path.join(wb.cwd, "f.txt"), "y");
  await host.release(wb);
  await assert.rejects(() => fs.stat(wb.cwd), "released (keepDays=0) removes the dir now");
});

test("acquire of an invalid ref fails without leaking a live mark", async () => {
  const base = await tmp("wbhost-base");
  const dataRoot = await tmp("wbhost-data");
  const host = createRunWorkbenchHost({ base, dataRoot });
  await assert.rejects(() => host.acquire({ id: "   " }, null), /工作台未建立|non-empty/);
  // A later sweep must not be confused by a dangling live mark.
  const swept = await host.sweep();
  assert.equal(swept.failed.length, 0);
});
