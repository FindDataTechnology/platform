#!/usr/bin/env node
// ── Focus overlay tests (add-focus-overlay, tasks 1.1–1.2, 2.1–2.3, 3.1–3.2) ─
//
// The overlay is a preference diff that composes over the derivation at every
// composition point. The branches worth breaking here:
//
//   storage    — round-trip, all-empty deletes the key, corrupt row reads as
//                absent, validation rejects malformed shapes naming the field
//                and add∩remove clashes per dimension;
//   MCP layer  — additions restore ONLY from the pre-focus available map (a
//                disabled, group-gated, or credential-less server stays
//                absent despite `add`), removals drop baseline members, and
//                dangling entries warn once;
//   parity     — with no stored key both patch writers are byte-identical to
//                the noOverlay composition (the pre-change writer path);
//   skills     — the compose root builds declared ± overlay, whole-pack ±
//                overlay for an undeclared persona, and cross-pack additions
//                link into the other pack's root.
//
// Route-level checks (401 unauthenticated, 400 naming the field, 409 while
// streaming) ride a bare express harness with registerAuth — the same shape
// scripts/test-auth-mode.mjs uses.
//
//   node --test scripts/test-focus-overlay.mjs

import assert from "node:assert/strict";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "focus-overlay-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
// PACK_BASELINE_MCP names a second baseline entry (resolvable via the DB row
// below) so baseline-removal semantics are exercised on both layers.
process.env.PACK_BASELINE_MCP = "fo-baseline-db";

// Operator layer: one mcp.json server.
writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { "fo-base": { command: "node", args: ["-e", ""] } } }),
);

// catalog.js binds CATALOG_FILE at import and the repo's own agents.json must
// never be read here — chdir to an empty fixture first (persona-scope trick).
const cwdFixture = path.join(tmpRoot, "cwd");
mkdirSync(cwdFixture, { recursive: true });
writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
process.chdir(cwdFixture);

const db = await import("../db.js");
await db.initDb();
const catalog = await import("../catalog.js");
const extensionStore = await import("../extension-store.js");
const sm = await import("../skill-materialize.js");
const { writeMcpPatch, writeSkillsPatch, deriveScope } = await import("../dsh-profile.js");

const PACK_ID = "fo-pack";
const OTHER_PACK_ID = "fo-other-pack";
const manifest = (resources) => ({
  name: "微调测试包",
  skills: [
    { name: "fo-skill-a", description: "d", content: "# a" },
    { name: "fo-skill-b", description: "d", content: "# b" },
  ],
  mcpServers: [{ registryName: "fo-pack-ref" }],
  agents: [
    { id: "fo-alpha", name: "阿尔法", persona: "p", resources: { skills: ["fo-skill-a"], mcpServers: ["fo-pack-ref"] } },
    { id: "fo-beta", name: "贝塔", persona: "p", ...(resources !== undefined ? { resources } : {}) },
  ],
});
const seedPack = (m = manifest()) =>
  db.upsertInstalledPack({
    packId: PACK_ID,
    name: m.name,
    version: 1,
    manifest: m,
    report: {
      skills: m.skills.map((s) => ({ name: s.name, status: "installed" })),
      mcpServers: [{ name: "fo-pack-ref", status: "installed" }],
      agents: m.agents.map((a) => ({ id: a.id, name: a.name, status: "installed" })),
    },
  });
db.upsertInstalledPack({
  packId: OTHER_PACK_ID,
  name: "另一个包",
  version: 1,
  manifest: { name: "另一个包", skills: [{ name: "fo-foreign-skill", description: "d", content: "# f" }], mcpServers: [], agents: [] },
  report: { skills: [{ name: "fo-foreign-skill", status: "installed" }], mcpServers: [], agents: [] },
});

// resolvePersona requires the generated preset to exist — marker dirs the way
// writeCatalogAgentPresets would leave them.
for (const id of ["fo-alpha", "fo-beta"]) {
  const dir = path.join(process.env.DSH_HOME, ".agent-presets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "agent.cordis.yml"), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: \"test\"\n");
}

// DB server rows: the universes the overlay composes against.
//   fo-extra        — enabled, ungated, plain config ⇒ ADDABLE
//   fo-disabled     — enabled:false ⇒ never resurrectable
//   fo-gated        — requiredGroups ["vip"] ⇒ absent for a non-vip identity
//   fo-registry     — credentialRef with no live token ⇒ absent
//   fo-pack-ref     — the pack's MCP reference, installed
//   fo-baseline-db  — the resolvable PACK_BASELINE_MCP entry
for (const [name, config, enabled, requiredGroups] of [
  ["fo-extra", { command: "node", args: ["-e", ""] }, true, null],
  ["fo-disabled", { command: "node", args: ["-e", ""] }, false, null],
  ["fo-gated", { command: "node", args: ["-e", ""] }, true, ["vip"]],
  ["fo-registry", { url: "http://127.0.0.1:9/mcp", credentialRef: "registry" }, true, null],
  ["fo-pack-ref", { command: "node", args: ["-e", ""] }, true, null],
  ["fo-baseline-db", { command: "node", args: ["-e", ""] }, true, null],
]) {
  extensionStore.addMcpServer({ name, config, enabled, ...(requiredGroups ? { requiredGroups } : {}) });
}

// Materialized skills: this pack's two, the other pack's one, one user skill.
for (const [name, originPackId] of [
  ["fo-skill-a", PACK_ID],
  ["fo-skill-b", PACK_ID],
  ["fo-foreign-skill", OTHER_PACK_ID],
  ["fo-user-skill", null],
]) {
  db.addCustomSkill({ name, description: "d", content: "# c", ...(originPackId ? { originPackId } : {}) });
  sm.writeSkill({ name, description: "d", content: "# c", ...(originPackId ? { originPackId } : {}), enabled: true });
}

seedPack();
await catalog.refresh(null);
const { registerOverlayRoutes } = await import("../server/routes/overlay.js");

const patchDir = path.join(process.env.DSH_HOME, "profiles", "platform");
const mcpPatch = path.join(patchDir, "mcp.patch.yml");
const serversOf = (p = mcpPatch) =>
  yaml.load(readFileSync(p, "utf8")).flatMap((row) => row.insert ?? []).map((e) => e.config.serverName).sort();

// Compose against the same identity inputs the runtime would use: no group
// snapshot (null) for the general case, [] (a snapshot without "vip") for the
// gated-absent assertions.
const compose = (opts = {}) =>
  writeMcpPatch({ ownerEmail: null, userGroups: null, ...opts });

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Storage (task 1.1) ────────────────────────────────────────────────────────

test("overlay preference round-trips and deletes on empty", () => {
  db.setFocusOverlay("fo-beta", { addMcp: ["x", "x"], removeMcp: [], addSkills: ["s"], removeSkills: ["t"] });
  // A stored diff returns deduped arrays for all four dimensions.
  assert.deepEqual(db.getFocusOverlay("fo-beta"), { addMcp: ["x"], removeMcp: [], addSkills: ["s"], removeSkills: ["t"] });
  // An all-empty diff deletes the key entirely.
  db.setFocusOverlay("fo-beta", { addMcp: [], removeMcp: [], addSkills: [], removeSkills: [] });
  assert.equal(db.getFocusOverlay("fo-beta"), null);
  assert.equal(db.getPreference(db.focusOverlayKey("fo-beta")), null, "no ceremony row survives");
  // A corrupt row reads as absent — inert, self-healing.
  db.setPreference(db.focusOverlayKey("fo-beta"), "{not json");
  assert.equal(db.getFocusOverlay("fo-beta"), null);
  db.setPreference(db.focusOverlayKey("fo-beta"), JSON.stringify({ addMcp: "nope" }));
  assert.equal(db.getFocusOverlay("fo-beta"), null, "a wrong-shaped row is absent too");
  db.setPreference(db.focusOverlayKey("fo-beta"), JSON.stringify({ addMcp: [], removeMcp: [], addSkills: [], removeSkills: [] }));
  assert.equal(db.getFocusOverlay("fo-beta"), null, "an all-empty stored row reads as no overlay");
});

test("parseFocusOverlay validates, dedupes, and rejects add∩remove clashes", () => {
  assert.equal(db.parseFocusOverlay(null).ok, true, "null (clear) is valid");
  const ok = db.parseFocusOverlay({ addMcp: [" a ", "a", "b"], removeMcp: [], addSkills: [], removeSkills: [] });
  assert.deepEqual(ok.overlay.addMcp, ["a", "b"], "deduped + trimmed, order preserved");
  const badShape = db.parseFocusOverlay({ addMcp: "x" });
  assert.equal(badShape.ok, false);
  assert.match(badShape.error, /overlay\.addMcp/, "the error names the field");
  const badMember = db.parseFocusOverlay({ addSkills: [42] });
  assert.equal(badMember.ok, false);
  assert.match(badMember.error, /overlay\.addSkills/);
  const clash = db.parseFocusOverlay({ addMcp: ["websearch"], removeMcp: ["websearch"], addSkills: [], removeSkills: [] });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /"websearch".*mcpServers/, "the error names the entry and the dimension");
});

// ── No-overlay byte parity (tasks 2.3 / 3.2) ─────────────────────────────────

test("with no stored key both patch writers are byte-identical to the pre-overlay path", async () => {
  db.setFocusOverlay("fo-beta", null); // ensure clean
  db.setFocusOverlay("fo-alpha", null);
  // Capture each write's bytes IMMEDIATELY — every composition targets the
  // same patch file, so a later write overwrites an unread snapshot.
  const plainBetaBytes = readFileSync(await compose({ agentPreset: "fo-beta" }), "utf8");
  const plainAlphaBytes = readFileSync(await compose({ agentPreset: "fo-alpha" }), "utf8");
  const plainSkillsBetaBytes = readFileSync(await writeSkillsPatch({ agentPreset: "fo-beta" }), "utf8");
  const plainSkillsAlphaBytes = readFileSync(await writeSkillsPatch({ agentPreset: "fo-alpha" }), "utf8");

  // Store a diff, then compose with noOverlay: the suppressed composition must
  // reproduce the plain bytes exactly (the overlay never perturbs output when
  // it is not applied — the pre-change writer's behavior).
  db.setFocusOverlay("fo-beta", { addMcp: ["fo-extra"], removeMcp: ["fo-base"], addSkills: [], removeSkills: [] });
  db.setFocusOverlay("fo-alpha", { addMcp: [], removeMcp: [], addSkills: ["fo-skill-b"], removeSkills: [] });
  assert.equal(readFileSync(await compose({ agentPreset: "fo-beta", noOverlay: true }), "utf8"), plainBetaBytes);
  assert.equal(readFileSync(await compose({ agentPreset: "fo-alpha", noOverlay: true }), "utf8"), plainAlphaBytes);
  assert.equal(readFileSync(await writeSkillsPatch({ agentPreset: "fo-beta", noOverlay: true }), "utf8"), plainSkillsBetaBytes);
  assert.equal(readFileSync(await writeSkillsPatch({ agentPreset: "fo-alpha", noOverlay: true }), "utf8"), plainSkillsAlphaBytes);
  // Sanity: the plain bytes really were focused (operator baseline + the
  // resolvable PACK_BASELINE_MCP entry + the pack ref — every other DB row,
  // gated or not, is dropped by the keep-set; availability decides only
  // whether an overlay add can restore it, proven by the tests below).
  await compose({ agentPreset: "fo-beta", noOverlay: true });
  assert.deepEqual(serversOf(), ["fo-base", "fo-baseline-db", "fo-pack-ref"]);
});

// ── MCP composition layer (tasks 2.1 / 2.2) ──────────────────────────────────

test("additions draw only from the enabled universe; removals drop any member", async () => {
  db.setFocusOverlay("fo-beta", {
    addMcp: ["fo-extra", "fo-disabled", "fo-gated", "fo-registry", "fo-pack-ref", "fo-ghost"],
    removeMcp: ["fo-base"],
    addSkills: [],
    removeSkills: [],
  });
  const logs = [];
  const warns = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    // userGroups [] = a real snapshot without "vip": the gated row is filtered
    // out of the available map, exactly like a non-vip identity's runtime.
    await compose({ agentPreset: "fo-beta", userGroups: [] });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const servers = serversOf();
  // Baseline minus the removed operator server; the DB baseline survives.
  assert.ok(!servers.includes("fo-base"), "an overlay removal drops the operator baseline server");
  assert.ok(servers.includes("fo-baseline-db"), "the un-removed PACK_BASELINE_MCP entry stays");
  // The pack ref is derived in; an explicitly-added derived name is a no-op.
  assert.ok(servers.includes("fo-pack-ref"));
  // The enabled, ungated addition composes in.
  assert.ok(servers.includes("fo-extra"), "an enabled non-pack server appears via add");
  // The three stay-out cases (design D2's structural rule).
  assert.ok(!servers.includes("fo-disabled"), "a disabled server stays absent despite add");
  assert.ok(!servers.includes("fo-gated"), "a group-gated server stays absent despite add");
  assert.ok(!servers.includes("fo-registry"), "a credential-less registry server stays absent despite add");
  // The ghost add resolves to nothing: inert + one warn naming it.
  assert.ok(!servers.includes("fo-ghost"));
  assert.ok(warns.some((w) => w.includes("fo-ghost") && w.includes("dangling")), `dangling warn emitted: ${warns}`);
  // The composition log names the layer.
  assert.ok(logs.some((l) => l.includes("focused on pack") && l.includes("+overlay[add:")), `overlay log line emitted: ${logs}`);
  assert.deepEqual(servers, ["fo-baseline-db", "fo-extra", "fo-pack-ref"]);
});

test("the gated server is addable for an identity that holds the group", async () => {
  db.setFocusOverlay("fo-beta", { addMcp: ["fo-gated"], removeMcp: [], addSkills: [], removeSkills: [] });
  await compose({ agentPreset: "fo-beta", userGroups: ["vip"] });
  assert.ok(serversOf().includes("fo-gated"), "group visibility — not the overlay — decides availability");
});

test("an overlay removal may drop a pack member (user-level narrowing)", async () => {
  db.setFocusOverlay("fo-beta", { addMcp: [], removeMcp: ["fo-pack-ref"], addSkills: [], removeSkills: [] });
  await compose({ agentPreset: "fo-beta" });
  assert.ok(!serversOf().includes("fo-pack-ref"), "the pack's own ref is removable for this role");
  // The manifest is untouched — the next noOverlay composition restores it.
  await compose({ agentPreset: "fo-beta", noOverlay: true });
  assert.ok(serversOf().includes("fo-pack-ref"), "noOverlay composition proves the definition never changed");
});

// ── Skills compose root (tasks 3.1 / 3.2) ────────────────────────────────────

test("declared persona with overlay: root = declared ± overlay, cross-pack adds link out", async () => {
  db.setFocusOverlay("fo-alpha", {
    addMcp: [],
    removeMcp: [],
    addSkills: ["fo-skill-b", "fo-foreign-skill", "fo-user-skill", "fo-ghost-skill"],
    removeSkills: ["fo-skill-a"],
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let patch;
  try {
    patch = await writeSkillsPatch({ agentPreset: "fo-alpha" });
  } finally {
    console.warn = origWarn;
  }
  const dirs = yaml.load(readFileSync(patch, "utf8"))[0].config.customSkillDirs.map((d) => path.resolve(d));
  const root = sm.personaSkillsRoot(PACK_ID, "fo-alpha");
  assert.ok(dirs.includes(root), "the compose root is listed");
  assert.deepEqual(readdirSync(root).sort(), ["fo-foreign-skill", "fo-skill-b", "fo-user-skill"]);
  // The cross-pack link points into the OTHER pack's root; the user-row link
  // points at the flat user root — both relative to the persona root.
  assert.equal(
    readlinkSync(path.join(root, "fo-foreign-skill")),
    path.join("..", "..", "..", OTHER_PACK_ID, "fo-foreign-skill"),
  );
  assert.equal(readlinkSync(path.join(root, "fo-skill-b")), path.join("..", "..", "fo-skill-b"));
  assert.equal(readlinkSync(path.join(root, "fo-user-skill")), path.join("..", "..", "..", "fo-user-skill"));
  assert.ok(warns.some((w) => w.includes("fo-ghost-skill")), `dangling skill add warned: ${warns}`);
});

test("undeclared persona with overlay: whole-pack base, forced compose root", async () => {
  db.setFocusOverlay("fo-beta", { addMcp: [], removeMcp: [], addSkills: [], removeSkills: ["fo-skill-a"] });
  const patch = await writeSkillsPatch({ agentPreset: "fo-beta" });
  const dirs = yaml.load(readFileSync(patch, "utf8"))[0].config.customSkillDirs.map((d) => path.resolve(d));
  const root = sm.personaSkillsRoot(PACK_ID, "fo-beta");
  assert.ok(dirs.includes(root), "an overlay forces the persona root even when undeclared");
  assert.ok(!dirs.includes(sm.packSkillsRoot(PACK_ID)), "the pack root itself is not listed");
  assert.deepEqual(readdirSync(root).sort(), ["fo-skill-b"], "whole-pack base minus the removed skill");
});

test("deriveScope carries the stored overlay as a derivation input", async () => {
  const scope = await deriveScope("fo-beta");
  assert.deepEqual(scope.overlay, { addMcp: [], removeMcp: [], addSkills: [], removeSkills: ["fo-skill-a"] });
  const suppressed = await deriveScope("fo-beta", { noOverlay: true });
  assert.equal(suppressed.overlay, null, "noOverlay suppresses the input");
  assert.equal((await deriveScope("standard")).overlay, null, "full mode never carries an overlay");
});

// ── Routes (task 1.2 / 1.3 guards) ────────────────────────────────────────────

function harnessCtx(overrides = {}) {
  const broadcasts = [];
  return {
    app: null,
    db,
    extensionStore,
    broadcast: (m) => broadcasts.push(m),
    broadcasts,
    isStreaming: false,
    currentPreset: "standard", // the adjusted presets are not live ⇒ no rewrite
    runtimeOwnerGroups: null,
    runtimeOwnerEmail: null,
    dshBridge: undefined,
    ...overrides,
  };
}

function harnessApp(ctx) {
  const app = express();
  app.use(express.json());
  ctx.app = app;
  registerOverlayRoutes(ctx);
  return app;
}

function request(app, { method = "GET", path = "/api/agent/overlay", body, headers = {} } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({
        host: "127.0.0.1", port, path, method,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { out += c; });
        res.on("end", () => resolve({ status: res.statusCode, body: out }));
      });
      req.on("error", reject);
      req.end(payload);
    });
    server.on("error", reject);
  });
}

test("an unauthenticated request is rejected when auth is enabled", async () => {
  const ctx = harnessCtx({ authMode: "forward_auth", authEnabled: true, ssoEnabled: false });
  const app = express();
  ctx.app = app;
  const { registerAuth } = await import("../server/auth.js");
  app.use(express.json());
  registerAuth(ctx);
  registerOverlayRoutes(ctx);
  const r = await request(app, { path: "/api/agent/overlay?preset=fo-beta" });
  assert.equal(r.status, 401, `expected 401, got ${r.status}: ${r.body}`);
});

test("malformed PUT returns 400 naming the field; a clash is rejected naming the entry", async () => {
  const app = harnessApp(harnessCtx());
  const noPreset = await request(app, { method: "PUT", body: { overlay: {} } });
  assert.equal(noPreset.status, 400);
  assert.match(JSON.parse(noPreset.body).error, /preset/);
  const badDim = await request(app, { method: "PUT", body: { preset: "fo-beta", overlay: { removeSkills: "x" } } });
  assert.equal(badDim.status, 400);
  assert.match(JSON.parse(badDim.body).error, /overlay\.removeSkills/);
  const clash = await request(app, {
    method: "PUT",
    body: { preset: "fo-beta", overlay: { addSkills: ["s"], removeSkills: ["s"], addMcp: [], removeMcp: [] } },
  });
  assert.equal(clash.status, 400);
  assert.match(JSON.parse(clash.body).error, /"s".*skills/);
  const notFocused = await request(app, { method: "PUT", body: { preset: "standard", overlay: null } });
  assert.equal(notFocused.status, 400, "a shipped preset keeps the availability semantics");
});

test("a valid PUT stores the diff and broadcasts; a stream rejects with 409", async () => {
  const ctx = harnessCtx();
  const app = harnessApp(ctx);
  db.setFocusOverlay("fo-beta", null);
  const ok = await request(app, {
    method: "PUT",
    body: { preset: "fo-beta", overlay: { addMcp: ["fo-extra"], removeMcp: [], addSkills: [], removeSkills: [] } },
  });
  assert.equal(ok.status, 200, ok.body);
  assert.deepEqual(db.getFocusOverlay("fo-beta")?.addMcp, ["fo-extra"]);
  assert.ok(ctx.broadcasts.some((m) => m.type === "overlay_changed" && m.preset === "fo-beta"), "picker refresh broadcast");
  // The live-preset rewrite path is exercised in e2e; here the 409 guard:
  ctx.isStreaming = true;
  const busy = await request(app, {
    method: "PUT",
    body: { preset: "fo-beta", overlay: null },
  });
  assert.equal(busy.status, 409, "the set_preset streaming guard applies");
  assert.match(JSON.parse(busy.body).error, /responding/);
  ctx.isStreaming = false;
});

test("GET returns the stored diff, the effective set, and the addable universes", async () => {
  db.setFocusOverlay("fo-beta", { addMcp: ["fo-extra"], removeMcp: ["fo-base"], addSkills: ["fo-foreign-skill"], removeSkills: ["fo-skill-a"] });
  const app = harnessApp(harnessCtx());
  const r = await request(app, { path: "/api/agent/overlay?preset=fo-beta" });
  assert.equal(r.status, 200, r.body);
  const doc = JSON.parse(r.body);
  assert.equal(doc.preset, "fo-beta");
  assert.deepEqual(doc.overlay?.addMcp, ["fo-extra"]);
  // Effective MCP: baseline (operator + PACK_BASELINE_MCP) + pack ref ± overlay.
  assert.deepEqual([...doc.effective.mcpServers].sort(), ["fo-baseline-db", "fo-extra", "fo-pack-ref"]);
  // Effective skills: whole-pack minus removed plus the cross-pack add.
  assert.deepEqual([...doc.effective.skills].sort(), ["fo-foreign-skill", "fo-skill-b"]);
  // Universes exclude what is already effective; unavailable names never appear.
  assert.ok(!doc.addableMcp.includes("fo-extra"));
  assert.ok(!doc.addableMcp.includes("fo-disabled"));
  assert.ok(!doc.addableMcp.includes("fo-registry"));
  assert.ok(doc.addableMcp.includes("fo-gated") || doc.addableMcp.includes("fo-base"), `universe carries addable names: ${doc.addableMcp}`);
  assert.ok(!doc.addableSkills.includes("fo-skill-b"));
  assert.ok(doc.addableSkills.includes("fo-user-skill") || doc.addableSkills.includes("fo-skill-a"), `skill universe: ${doc.addableSkills}`);
});
