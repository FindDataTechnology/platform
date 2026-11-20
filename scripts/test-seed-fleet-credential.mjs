// fleet-scoped-bench-credentials 5.1: the seeding step is the ONLY production
// write in the rollout, and it runs by hand on a live pod right after a roll.
// These cases pin what it must refuse, because the failure modes it guards
// against are the ones that look like success:
//   · a ghost fleet id (wrong cell / deleted fleet) would write a row nobody can
//     resolve — the 2026-11-14 ghost shape, now refused at the write path too;
//   · an empty token would create a row that exists but scopes nothing;
//   · an unreadable store must be "undecidable" (exit 2), never "nothing to do";
//   · and the read-back must go through the resolver the patch assembler uses,
//     not the write's own return value.
import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "seed-fleet-cred-"));
const dataDir = path.join(tmpRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });
process.env.PLATFORM_DATA_DIR = dataDir;
process.env.DB_PATH = path.join(tmpRoot, "app.db");

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
// storeDir("data") joins PLATFORM_DATA_DIR with "data" — the fixture must land on
// the SAME file the child process resolves, or the seeder correctly reports a
// ghost fleet (which is how this was caught: the refusal works).
const dbFile = path.join(dataDir, "data", "fleets.db");
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = createFleetDatabase({ file: dbFile });
setFleetDatabase(db);
db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const SEEDER = new URL("../scripts/seed-fleet-credential.mjs", import.meta.url).pathname;

function seed(args, { token = "lbc_seed0001", input = "", env = {} } = {}) {
  const res = spawnSync(process.execPath, [SEEDER, ...args], {
    env: { ...process.env, PLATFORM_DATA_DIR: dataDir, DB_PATH: process.env.DB_PATH, BENCH_FLEET_TOKEN: token, ...env },
    input,
    encoding: "utf8",
  });
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

test("seeds a real fleet and verifies through the resolver the assembler uses", () => {
  const r = seed(["--fleet", "fleet_A"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /写入后解析: ok/);
  assert.match(r.out, /种子已落/);
  const row = db.getFleetCredential("fleet_A", "bench");
  assert.equal(row.token, "lbc_seed0001");
});

test("dry-run answers the preconditions without writing", () => {
  const r = seed(["--fleet", "fleet_A", "--dry-run"], { token: "lbc_dry00009" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /未写/);
  assert.equal(db.getFleetCredential("fleet_A", "bench").token, "lbc_seed0001", "dry-run must not overwrite");
});

test("ghost fleet is refused (wrong cell / deleted fleet is the likely cause)", () => {
  const r = seed(["--fleet", "fleet_ghost"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /不在本 cell 的 fleets 名册里/);
});

test("an empty token is refused as undecidable, and no row appears", () => {
  const before = db.listFleetCredentials({ kind: "bench" }).length;
  const r = seed(["--fleet", "fleet_A"], { token: "" });
  assert.equal(r.code, 2, r.out);
  assert.equal(db.listFleetCredentials({ kind: "bench" }).length, before);
});

test("unknown kind is refused (a kind with no resolver cannot be scoped)", () => {
  const r = seed(["--fleet", "fleet_A", "--kind", "wire"]);
  assert.equal(r.code, 2, r.out);
});

test("missing --fleet is refused: the seed never guesses which fleet", () => {
  const r = seed([]);
  assert.equal(r.code, 2, r.out);
});

test("token can come from stdin, and never needs to touch argv", () => {
  const r = seed(["--fleet", "fleet_A", "--token-stdin"], { token: "", input: "lbc_stdin007\n" });
  assert.equal(r.code, 0, r.out);
  assert.equal(db.getFleetCredential("fleet_A", "bench").token, "lbc_stdin007");
});

test("rotation: re-seeding replaces the value and reports the new tail", () => {
  const r = seed(["--fleet", "fleet_A"], { token: "lbc_rotate11" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /写入后解析: ok（尾部 te11）/); // last 4 of lbc_rotate11
  assert.equal(db.getFleetCredential("fleet_A", "bench").token, "lbc_rotate11");
});
