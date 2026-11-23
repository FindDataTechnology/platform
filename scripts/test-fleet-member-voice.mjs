// Fleet member voice column (add-room-voice-and-catalog, tasks 3.1/3.2):
//
//   §1 迁移：voice 列可空，既有行不受影响（老库升级零变化）。
//   §2 建岗写齐：createMember 带 voice 写得进去（input_policy 那次漏写的形状
//     不重演），updateMember 能改能清空，deserialize 原样返回。
//   §3 读面：memberView 的投影带 voice，且 overview 的 formation 也带它。
//
//   node --test scripts/test-fleet-member-voice.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-member-voice-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;

const dbMod = await import("../db.js");
const { getFleetDatabase } = await import("../server/routes/fleets-db.js");

let fdb;

before(async () => {
  await dbMod.initDb();
  fdb = getFleetDatabase();
});

const VOICE = { model: "tencent-tts", voice: "101001" };

function mkFleet(id) {
  fdb.createFleet({ id, name: id, ownerEmail: "owner@example.com" });
  return fdb.getFleet(id);
}

function mkMember(id, fleetId, extra = {}) {
  return fdb.createMember({
    id,
    fleetId,
    title: id,
    targetKind: "persona",
    targetId: `persona-${id}`,
    kpiSlots: [],
    cadence: null,
    ...extra,
  });
}

test("voice column is nullable and an un-declared post reads null", () => {
  mkFleet("f-old");
  const m = mkMember("m-no-voice", "f-old");
  assert.equal(m.voice, null, "no declaration = null, byte-identical to before");
});

test("createMember writes the voice it was given (the input_policy gap does not repeat)", () => {
  mkFleet("f-create");
  const m = mkMember("m-with-voice", "f-create", { voice: VOICE });
  assert.deepEqual(m.voice, VOICE, "the declaration survives creation — this is the input_policy bug shape");
});

test("updateMember sets, changes, and clears the voice", () => {
  mkFleet("f-update");
  const m = mkMember("m-update", "f-update");
  assert.equal(m.voice, null);

  let updated = fdb.updateMember(m.id, { voice: VOICE });
  assert.deepEqual(updated.voice, VOICE, "a declaration is written");

  updated = fdb.updateMember(m.id, { voice: { model: "tencent-tts", voice: "101013" } });
  assert.deepEqual(updated.voice, { model: "tencent-tts", voice: "101013" }, "the declaration is replaceable");

  updated = fdb.updateMember(m.id, { voice: null });
  assert.equal(updated.voice, null, "null clears the declaration back to inherit");
});

test("listMembers carries the voice on every row", () => {
  mkFleet("f-list");
  mkMember("m-a", "f-list", { voice: VOICE });
  mkMember("m-b", "f-list");
  const rows = fdb.listMembers("f-list");
  const a = rows.find((r) => r.id === "m-a");
  const b = rows.find((r) => r.id === "m-b");
  assert.deepEqual(a.voice, VOICE);
  assert.equal(b.voice, null);
});
