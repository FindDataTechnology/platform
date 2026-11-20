// fleet-scoped-bench-credentials (3.1/3.2): the fleet credential store, the
// "who may carry a bench token" decisions, and the two composition paths.
//
// The rules under test are the ones that make a second fleet safe: a credential
// keyed by fleet (never by process), a member patch that stamps its OWN fleet's
// token or drops the rows, and a shared patch that carries a token only while
// exactly one fleet holds one. `null` must never mean "leave the shared value".
//
// The store is a real sqlite file (temp), the fleet db is injected through
// setFleetDatabase, and DSH_HOME/PLATFORM_DATA_DIR are pointed at the temp dir
// BEFORE the profile module is imported — its path constants freeze at import
// time (that freeze is what once overwrote a live ~/.dsh profile from a test).
import assert from "node:assert/strict";
import { test, after } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cred-"));
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DB_PATH = path.join(tmpRoot, "app.db");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const fleetCred = await import("../lib/fleet-credentials.js");
const { applyMemberOverrides, writeMemberMcpPatch, writeMcpPatch } = await import("../dsh-profile.js");

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function freshDb(name = "fleets.db") {
  const file = path.join(tmpRoot, name);
  fs.rmSync(file, { force: true });
  const db = createFleetDatabase({ file });
  setFleetDatabase(db);
  return db;
}

// ── store (1.1) ─────────────────────────────────────────────────────────────

test("credential is keyed by (fleet, kind) and upsert rotates it", () => {
  const db = freshDb();
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  const first = db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_first0001" });
  assert.equal(first.ok, true);
  const rotated = db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_second002" });
  assert.equal(rotated.ok, true);
  assert.equal(db.getFleetCredential("fleet_A", "bench").token, "lbc_second002");
  assert.equal(db.listFleetCredentials({ kind: "bench" }).length, 1, "one row per (fleet, kind)");
});

test("a token is never returned by the list surface (fingerprint only)", () => {
  const db = freshDb();
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_secret0009" });
  const [row] = db.listFleetCredentials({ kind: "bench" });
  assert.equal(JSON.stringify(row).includes("lbc_secret0009"), false);
  assert.equal(row.tokenTail, "0009");
});

test("ghost fleet write is refused, and a ghost row never reads as a credential", () => {
  const db = freshDb();
  const r = db.setFleetCredential({ fleetId: "fleet_ghost", kind: "bench", token: "lbc_x" });
  assert.deepEqual(r, { ok: false, reason: "unknown_fleet" });
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_aaaa1111" });
  // Delete the fleet row underneath the credential (row deleted, credential left).
  db.db.prepare("DELETE FROM fleets WHERE id = 'fleet_A'").run();
  assert.equal(db.getFleetCredential("fleet_A", "bench"), null, "ghost row reads as absent");
  assert.equal(db.listFleetCredentials({ kind: "bench" }).length, 0, "and is not a holder");
  assert.equal(db.listOrphanFleetCredentials().length, 1, "but stays visible to the gate");
});

// ── resolution (2.1) ────────────────────────────────────────────────────────

test("resolveFleetBenchCredential distinguishes ok / no_row / ghost / no_fleet", async () => {
  const db = freshDb();
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.createFleet({ id: "fleet_B", name: "B", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_A0001111" });
  assert.equal((await fleetCred.resolveFleetBenchCredential("fleet_A")).status, "ok");
  assert.equal((await fleetCred.resolveFleetBenchCredential("fleet_A")).credential.fleetId, "fleet_A");
  assert.equal((await fleetCred.resolveFleetBenchCredential("fleet_B")).status, "no_row");
  assert.equal((await fleetCred.resolveFleetBenchCredential("fleet_nope")).status, "ghost");
  assert.equal((await fleetCred.resolveFleetBenchCredential("")).status, "no_fleet");
});

test("benchScopeDecision: 0 / 1 / ≥2 holders", () => {
  assert.equal(fleetCred.benchScopeDecision([]).mode, "none");
  assert.deepEqual(fleetCred.benchScopeDecision([{ fleetId: "fleet_A" }]), { mode: "sole", fleetId: "fleet_A", holders: ["fleet_A"] });
  const multi = fleetCred.benchScopeDecision([{ fleetId: "fleet_B" }, { fleetId: "fleet_A" }]);
  assert.equal(multi.mode, "multiple");
  assert.deepEqual(multi.holders, ["fleet_A", "fleet_B"], "holders are named (sorted) so the warning is actionable");
});

test("benchHolderScope reads the store and reports an unreadable store as unknown", async () => {
  const db = freshDb();
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  assert.equal((await fleetCred.benchHolderScope()).mode, "none");
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_A0001111" });
  assert.equal((await fleetCred.benchHolderScope()).mode, "sole");
  // A store whose reader throws must not read as "nobody holds one".
  const broken = {
    getFleet: () => null,
    listFleetCredentials: () => {
      throw new Error("db locked");
    },
    getFleetCredential: () => null,
  };
  setFleetDatabase(broken);
  const scope = await fleetCred.benchHolderScope();
  assert.equal(scope.mode, "unknown");
  assert.match(scope.error, /db locked/);
});

// ── row math (2.2/3.2) ──────────────────────────────────────────────────────

const benchRows = () => [
  { id: "mcp-bench-proposal", config: { serverName: "bench-proposal", transport: "stdio", command: "node", env: { BENCH_URL: "http://bench", BENCH_FLEET_TOKEN: "shared-LEAK", BENCH_FLEET_REF: "fleet_shared" } } },
  { id: "mcp-bench-ops", config: { serverName: "bench-ops", transport: "stdio", command: "node", env: { BENCH_URL: "http://bench", BENCH_FLEET_TOKEN: "shared-LEAK" } } },
  { id: "mcp-cron", config: { serverName: "cron", transport: "stdio", command: "node" } },
];

test("member overrides stamp BOTH bench rows with the fleet's token and ref", () => {
  const out = applyMemberOverrides(benchRows(), { benchCredential: { fleetId: "fleet_A", token: "lbc_A0001111" } });
  for (const name of ["bench-proposal", "bench-ops"]) {
    const row = out.find((e) => e.config.serverName === name);
    assert.equal(row.config.env.BENCH_FLEET_TOKEN, "lbc_A0001111");
    assert.equal(row.config.env.BENCH_FLEET_REF, "fleet_A");
    assert.equal(row.config.env.BENCH_URL, "http://bench", "other env values survive the stamp");
  }
  assert.equal(JSON.stringify(out).includes("shared-LEAK"), false, "the shared token never survives a member patch");
});

test("member overrides DROP bench rows when the credential is null", () => {
  const out = applyMemberOverrides(benchRows(), { benchCredential: null });
  assert.equal(out.filter((e) => String(e.config.serverName).startsWith("bench-")).length, 0);
  assert.ok(out.find((e) => e.config.serverName === "cron"), "other servers untouched");
});

test("undefined benchCredential leaves the rows verbatim (composition, not a decision)", () => {
  const out = applyMemberOverrides(benchRows(), {});
  assert.equal(out.find((e) => e.config.serverName === "bench-ops").config.env.BENCH_FLEET_TOKEN, "shared-LEAK");
});

// ── shared patch (2.4): the shared writer carries a token only for a sole holder ──

function mcpHome(name) {
  const dshHome = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dshHome, "profiles", "platform"), { recursive: true });
  fs.writeFileSync(
    path.join(dshHome, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "bench-proposal": { command: "node", args: ["server/bench-proposal-mcp.js"], envRefs: ["BENCH_URL", "BENCH_FLEET_TOKEN", "BENCH_FLEET_REF"] },
        "bench-ops": { command: "node", args: ["server/bench-ops-mcp.js"], envRefs: ["BENCH_URL", "BENCH_FLEET_TOKEN"] },
        cron: { command: "node", args: ["server/cron-mcp.js"] },
      },
    }),
  );
  return { dshHome, profileName: "platform", mcpConfig: path.join(dshHome, "mcp.json") };
}

const readPatch = (dirs) => {
  const file = path.join(dirs.dshHome, "profiles", "platform", "mcp.patch.yml");
  const yaml = fs.readFileSync(file, "utf8");
  return yaml;
};
const serverNamesIn = (yamlText) => [...yamlText.matchAll(/serverName: (\S+)/g)].map((m) => m[1]);

test("shared patch: 0 holders ⇒ no bench rows at all", async () => {
  const db = freshDb("s0.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  const dirs = mcpHome("home-none");
  await writeMcpPatch({ dirs, ownerEmail: null, enrichmentEnabled: false });
  const names = serverNamesIn(readPatch(dirs));
  assert.ok(!names.includes("bench-proposal") && !names.includes("bench-ops"), `bench rows must be absent, got ${names}`);
  assert.ok(names.includes("cron"), "other servers still composed");
});

test("shared patch: sole holder ⇒ carries THAT fleet's token", async () => {
  const db = freshDb("s1.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_A0001111" });
  const dirs = mcpHome("home-sole");
  await writeMcpPatch({ dirs, ownerEmail: null, enrichmentEnabled: false });
  const text = readPatch(dirs);
  assert.ok(serverNamesIn(text).includes("bench-ops"));
  assert.match(text, /BENCH_FLEET_TOKEN: lbc_A0001111/);
  assert.match(text, /BENCH_FLEET_REF: fleet_A/);
});

test("shared patch: two holders ⇒ bench rows absent (granted per member, not per cell)", async () => {
  const db = freshDb("s2.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.createFleet({ id: "fleet_B", name: "B", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_A0001111" });
  db.setFleetCredential({ fleetId: "fleet_B", kind: "bench", token: "lbc_B0002222" });
  const dirs = mcpHome("home-multi");
  await writeMcpPatch({ dirs, ownerEmail: null, enrichmentEnabled: false });
  const text = readPatch(dirs);
  const names = serverNamesIn(text);
  assert.ok(!names.includes("bench-proposal") && !names.includes("bench-ops"), `bench rows must be absent, got ${names}`);
  assert.equal(/lbc_[AB]/.test(text), false, "no fleet's token leaks into the shared patch");
});

// ── member patch file (2.3): fleet-scoped dir, own token, cross-fleet isolation ──

test("member patch: two fleets, same persona ⇒ two files, each with its own token", async () => {
  const db = freshDb("m1.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.createFleet({ id: "fleet_B", name: "B", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_A0001111" });
  db.setFleetCredential({ fleetId: "fleet_B", kind: "bench", token: "lbc_B0002222" });
  const dirs = mcpHome("home-member");
  const a = await writeMemberMcpPatch({ personaPreset: "proposer", fleetIdentity: { fleetId: "fleet_A", memberId: "m1" }, dirs, ownerEmail: null });
  const b = await writeMemberMcpPatch({ personaPreset: "proposer", fleetIdentity: { fleetId: "fleet_B", memberId: "m2" }, dirs, ownerEmail: null });
  assert.notEqual(a, b, "same persona in two fleets must not share one patch file");
  const aText = fs.readFileSync(a, "utf8");
  const bText = fs.readFileSync(b, "utf8");
  assert.match(aText, /BENCH_FLEET_TOKEN: lbc_A0001111/);
  assert.match(bText, /BENCH_FLEET_TOKEN: lbc_B0002222/);
  assert.equal(aText.includes("lbc_B"), false, "fleet A's patch never carries fleet B's token");
});

test("member patch: no credential row ⇒ bench rows absent, not shared", async () => {
  const db = freshDb("m2.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  const dirs = mcpHome("home-member-empty");
  const p = await writeMemberMcpPatch({ personaPreset: "proposer", fleetIdentity: { fleetId: "fleet_A", memberId: "m1" }, dirs, ownerEmail: null });
  const text = fs.readFileSync(p, "utf8");
  assert.equal(serverNamesIn(text).filter((n) => n.startsWith("bench-")).length, 0, `got ${serverNamesIn(text)}`);
  // The shared patch (0 holders) also has none, so nothing could leak in.
  await writeMcpPatch({ dirs, ownerEmail: null, enrichmentEnabled: false });
  assert.equal(/BENCH_FLEET_TOKEN/.test(readPatch(dirs)), false);
});

test("member patch: ghost fleet ⇒ rows absent", async () => {
  const db = freshDb("m3.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_A0001111" });
  db.db.prepare("DELETE FROM fleets WHERE id = 'fleet_A'").run();
  const dirs = mcpHome("home-member-ghost");
  const p = await writeMemberMcpPatch({ personaPreset: "proposer", fleetIdentity: { fleetId: "fleet_A", memberId: "m1" }, dirs, ownerEmail: null });
  assert.equal(serverNamesIn(fs.readFileSync(p, "utf8")).filter((n) => n.startsWith("bench-")).length, 0);
});

test("rotation: the next patch write carries the new value (no restart needed to compose)", async () => {
  const db = freshDb("r1.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_before001" });
  const dirs = mcpHome("home-rotate");
  await writeMcpPatch({ dirs, ownerEmail: null, enrichmentEnabled: false });
  assert.match(readPatch(dirs), /lbc_before001/);
  db.setFleetCredential({ fleetId: "fleet_A", kind: "bench", token: "lbc_after0002" });
  await writeMcpPatch({ dirs, ownerEmail: null, enrichmentEnabled: false });
  const text = readPatch(dirs);
  assert.match(text, /lbc_after0002/);
  assert.equal(text.includes("lbc_before001"), false, "the old value must not survive the rewrite");
});

test("member composition never leaks bench rows into the shared patch file", async () => {
  // The member writer needs WHOLE entries (to stamp its fleet's credential),
  // but what lands in the shared patch file must follow the SHARED rule. The
  // first implementation passed `keepBenchRows` down and the shared file kept
  // the rows — a child spawned in that window would read a process-level token
  // straight off the shared patch. This pins the boundary: whole entries are a
  // return value, never a file.
  const db = freshDb("leak.db");
  db.createFleet({ id: "fleet_A", name: "A", ownerEmail: "o@x.y" });
  const dirs = mcpHome("home-leak");
  const member = await writeMemberMcpPatch({
    personaPreset: "proposer",
    fleetIdentity: { fleetId: "fleet_A", memberId: "m1" },
    dirs,
    ownerEmail: null,
  });
  assert.ok(member, "member patch composed");
  const shared = readPatch(dirs);
  assert.equal(serverNamesIn(shared).filter((n) => n.startsWith("bench-")).length, 0, `shared file must not carry bench rows, got ${serverNamesIn(shared)}`);
  assert.equal(/BENCH_FLEET_TOKEN/.test(shared), false, "and no bench token either");
});
