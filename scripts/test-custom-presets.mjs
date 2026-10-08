#!/usr/bin/env node
// ── Custom preset tests (add-custom-presets) ─────────────────────────────────
//
// One harness over the whole server-side chain, mirroring test-focus-overlay:
//
//   storage     — row round-trip, server-assigned `user.` ids, slug-collision
//                 suffixing, update/delete (task 1.1);
//   catalog     — the fifth source serves persona-only entries with the
//                 customPreset marker + composition-time resourceSummary, and
//                 an agents.json id override shadows one (task 2.1);
//   derivation  — the custom family in resolvePersona/deriveScope: focused
//                 boot lists baseline + the presets/<id>/ compose root only,
//                 references intersect availability (cross-pack skill follows
//                 its pack's lifecycle; empty refs focus to the baseline), a
//                 shadowed id composes full (task 2.2);
//   overlay     — a stored diff adjusts the custom role's set on the next
//                 composition; disabled-server and dangling rules hold
//                 (task 2.3);
//   validator   — validatePackManifest rejects `user.`-prefixed agent ids
//                 naming the reserved namespace (task 3.1);
//   backstop    — a pack install meeting a preset's id skips the agent, names
//                 the custom preset as owner, leaves the row untouched
//                 (task 3.2);
//   routes      — the CRUD surface + guards: forbidden keys, mid-stream 409,
//                 availability/shadowed markers, delete of the selected preset
//                 rides the fallback switch (task 4.1).
//
//   node --test scripts/test-custom-presets.mjs

import assert from "node:assert/strict";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "custom-presets-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");

// Operator layer: one mcp.json server (the focus baseline).
writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({ mcpServers: { "cp-base": { command: "node", args: ["-e", ""] } } }),
);

// catalog.js binds CATALOG_FILE at import and the repo's own agents.json must
// never be read here — chdir to a fixture first (persona-scope trick).
const cwdFixture = path.join(tmpRoot, "cwd");
mkdirSync(cwdFixture, { recursive: true });
writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
process.chdir(cwdFixture);

const db = await import("../db.js");
await db.initDb();
const catalog = await import("../catalog.js");
const extensionStore = await import("../extension-store.js");
const sm = await import("../skill-materialize.js");
const packStore = await import("../pack-store.js");
const { validatePackManifest } = await import("../lib/pack-manifest.js");
const { writeMcpPatch, writeSkillsPatch, deriveScope, catalogEntryPersona, rosterPresetId } = await import("../dsh-profile.js");

// A seeded pack whose skill a custom preset references cross-pack.
const PACK_ID = "cp-pack";
const seedPack = () =>
  db.upsertInstalledPack({
    packId: PACK_ID,
    name: "交叉引用包",
    version: 1,
    manifest: {
      name: "交叉引用包",
      skills: [
        { name: "cp-pack-skill", description: "d", content: "# p" },
        { name: "cp-pack-skill-2", description: "d", content: "# q" },
      ],
      mcpServers: [],
      agents: [],
    },
    report: {
      skills: [
        { name: "cp-pack-skill", status: "installed" },
        { name: "cp-pack-skill-2", status: "installed" },
      ],
      mcpServers: [],
      agents: [],
    },
  });
seedPack();

// DB server rows: one enabled addable, one disabled (never resurrectable).
for (const [name, enabled] of [["cp-extra", true], ["cp-disabled", false]]) {
  extensionStore.addMcpServer({ name, config: { command: "node", args: ["-e", ""] }, enabled });
}
// Materialized skills: the pack's two plus one user skill.
for (const [name, originPackId] of [
  ["cp-pack-skill", PACK_ID],
  ["cp-pack-skill-2", PACK_ID],
  ["cp-user-skill", null],
]) {
  db.addCustomSkill({ name, description: "d", content: "# c", ...(originPackId ? { originPackId } : {}) });
  sm.writeSkill({ name, description: "d", content: "# c", ...(originPackId ? { originPackId } : {}), enabled: true });
}

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Storage (task 1.1) ────────────────────────────────────────────────────────

test("rows round-trip; ids are server-assigned under user. with collision suffixes", () => {
  const a = db.createUserPreset({
    name: "Legal Helper",
    persona: "你是法务助手。",
    skills: ["cp-pack-skill", "ghost-skill"],
    mcpServers: ["cp-extra", "cp-base"],
    tags: ["法务"],
    icon: "scale",
  });
  assert.ok(a.id.startsWith("user."), `id under the reserved prefix, got '${a.id}'`);
  assert.equal(a.id, "user.legal-helper");
  assert.equal(a.persona, "你是法务助手。");
  assert.deepEqual(a.skills, ["cp-pack-skill", "ghost-skill"]);
  assert.deepEqual(a.mcpServers, ["cp-extra", "cp-base"]);
  assert.deepEqual(a.tags, ["法务"]);
  assert.equal(a.icon, "scale");

  // Same display name ⇒ numeric suffix, never an id the author chose.
  const b = db.createUserPreset({ name: "Legal Helper", persona: "第二份。" });
  assert.equal(b.id, "user.legal-helper-2");
  // A CJK-only name folds to the fallback slug (the id stays well-formed).
  const c = db.createUserPreset({ name: "合同审查", persona: "p" });
  assert.equal(c.id, "user.preset");
  const d = db.createUserPreset({ name: "合同审查", persona: "p" });
  assert.equal(d.id, "user.preset-2");

  // Update round-trips the mutable fields; the id never changes.
  const updated = db.updateUserPreset(b.id, { persona: "改后。", skills: ["cp-user-skill"] });
  assert.equal(updated.id, b.id);
  assert.equal(updated.persona, "改后。");
  assert.deepEqual(updated.skills, ["cp-user-skill"]);

  assert.equal(db.deleteUserPreset(c.id), true);
  assert.equal(db.getUserPreset(c.id), null);
  // Cleanup the extras; `a` stays as the derivation fixture below.
  db.deleteUserPreset(b.id);
  db.deleteUserPreset(d.id);
});

// ── Catalog source (task 2.1) ─────────────────────────────────────────────────

const PRESET_ID = "user.legal-helper";
const presetAgentEntries = () =>
  catalog.getCatalogFor(null).agents;

test("a created preset is served persona-only with customPreset + composition-time summary", () => {
  const entries = presetAgentEntries();
  const entry = entries.find((e) => e.id === PRESET_ID);
  assert.ok(entry, `the preset appears in GET /api/catalog's payload: ${entries.map((e) => e.id)}`);
  assert.equal(entry.customPreset, true);
  assert.equal(entry.packId, undefined, "persona-only — no pack fields");
  assert.equal(entry.mode, "chat");
  assert.equal(entry.name, "Legal Helper");
  // Composition-time truth: ghost-skill counts zero; the pack skill, the DB
  // server, and the operator server all count.
  assert.deepEqual(entry.resourceSummary, { skillCount: 1, mcpCount: 2, declared: true });
});

test("a same-id agents.json entry shadows the preset (merged view shows the override)", async () => {
  writeFileSync(
    path.join(cwdFixture, "agents.json"),
    JSON.stringify({
      agents: [
        {
          id: PRESET_ID,
          type: "agent-remote",
          mode: "chat",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "shadow-model",
          name: "Operator Override",
        },
      ],
      apps: [],
    }),
  );
  await catalog.refresh(null);
  const entry = presetAgentEntries().find((e) => e.id === PRESET_ID);
  assert.equal(entry.name, "Operator Override");
  assert.equal(entry.customPreset, undefined, "the overriding entry carries no customPreset marker");
  // The row itself is untouched — shadowing is a merge view, not a mutation.
  assert.ok(db.getUserPreset(PRESET_ID));
  // Restore the empty agents.json for the derivation tests below.
  writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
  await catalog.refresh(null);
  assert.equal(presetAgentEntries().find((e) => e.id === PRESET_ID)?.customPreset, true);
});

// ── Derivation (task 2.2) ─────────────────────────────────────────────────────

// resolvePersona requires the generated preset to exist — marker dir the way
// writeCatalogAgentPresets would leave it: under the ROSTER (dash) form of
// the id, because dsh-agent-presets' containment regex forbids dots in
// directory names.
function seedGeneratedPresetDir(id) {
  const dir = path.join(process.env.DSH_HOME, ".agent-presets", rosterPresetId(id));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "agent.cordis.yml"), "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: \"test\"\n");
  return dir;
}
seedGeneratedPresetDir(PRESET_ID);

const patchDir = path.join(process.env.DSH_HOME, "profiles", "platform");
const mcpPatch = path.join(patchDir, "mcp.patch.yml");
const serversOf = () =>
  yaml.load(readFileSync(mcpPatch, "utf8")).flatMap((row) => row.insert ?? []).map((e) => e.config.serverName).sort();
const dirListOf = async (opts) => {
  const p = await writeSkillsPatch(opts);
  return yaml.load(readFileSync(p, "utf8"))[0].config.customSkillDirs.map((d) => path.resolve(d));
};

test("deriveScope resolves the custom family; a focused boot lists baseline + its root only", async () => {
  const scope = await deriveScope(PRESET_ID);
  const rosterForm = await deriveScope(rosterPresetId(PRESET_ID), { noOverlay: true });
  assert.equal(rosterForm.source, "custom", "the roster/dash form (what ctx.currentPreset holds) resolves too");
  assert.equal(scope.source, "custom");
  assert.equal(scope.customPresetId, PRESET_ID);
  assert.equal(scope.packId, null);
  assert.deepEqual(scope.mcpKeep, ["cp-extra", "cp-base"]);
  assert.deepEqual(scope.skillsDecl, ["cp-pack-skill", "ghost-skill"]);
  assert.equal(scope.overlay, null);
  // Shipped presets stay full.
  assert.equal((await deriveScope("standard")).source, null);

  // Focused MCP composition: operator baseline + the preset's resolvable
  // refs; the ghost ref intersects to nothing; the disabled row never appears.
  await writeMcpPatch({ agentPreset: PRESET_ID, ownerEmail: null, userGroups: null });
  assert.deepEqual(serversOf(), ["cp-base", "cp-extra"]);

  // Focused skills composition: baseline + the presets/<id>/ compose root ONLY
  // (no user root, no pack roots); the root links the available references.
  const dirs = await dirListOf({ agentPreset: PRESET_ID });
  const root = sm.customPresetSkillsRoot(PRESET_ID);
  // Baseline dir is repo-rooted, not cwd-rooted (migrate-fd-prod-cells): cells
  // run from a per-user cwd; the shipped skills/ dir is an image asset.
  const { repoRoot } = await import("../paths.js");
  assert.deepEqual(dirs, [repoRoot("skills"), root]);
  assert.deepEqual(readdirSync(root).sort(), ["cp-pack-skill"]);
  // The cross-pack link points into the pack's root, relative to preset root.
  assert.equal(
    readlinkSync(path.join(root, "cp-pack-skill")),
    path.join("..", "..", "packs", PACK_ID, "cp-pack-skill"),
  );
});

test("a cross-pack reference follows its pack's lifecycle (uninstall drops, reinstall returns)", async () => {
  db.deleteCustomSkillsByPack(PACK_ID);
  sm.removePackSkills(PACK_ID);
  db.deleteInstalledPack(PACK_ID);
  // The reference list still names the skill; composition omits it silently.
  const dirs = await dirListOf({ agentPreset: PRESET_ID });
  assert.equal(dirs.length, 1, "no available skills ⇒ no compose root at all (baseline only)");
  assert.equal((await deriveScope(PRESET_ID)).skillsDir, null);

  seedPack();
  for (const name of ["cp-pack-skill", "cp-pack-skill-2"]) {
    db.addCustomSkill({ name, description: "d", content: "# c", originPackId: PACK_ID });
    sm.writeSkill({ name, description: "d", content: "# c", originPackId: PACK_ID, enabled: true });
  }
  const dirsAgain = await dirListOf({ agentPreset: PRESET_ID });
  assert.equal(dirsAgain.length, 2, "the reference regains effect when its pack returns");
});

test("empty references focus to the baseline; a disabled server reference stays omitted", async () => {
  const bare = db.createUserPreset({ name: "Bare", persona: "空引用。" });
  seedGeneratedPresetDir(bare.id);
  const dirs = await dirListOf({ agentPreset: bare.id });
  assert.equal(dirs.length, 1, "no skills and no servers ⇒ exactly the deployment baseline");

  // A preset referencing the DISABLED server: the focused runtime omits it
  // (references never re-enable what the user disabled).
  const disabledRef = db.createUserPreset({ name: "Disabled Ref", persona: "p", mcpServers: ["cp-disabled"] });
  seedGeneratedPresetDir(disabledRef.id);
  await writeMcpPatch({ agentPreset: disabledRef.id, ownerEmail: null, userGroups: null });
  assert.deepEqual(serversOf(), ["cp-base"]);
  db.deleteUserPreset(bare.id);
  db.deleteUserPreset(disabledRef.id);
});

test("a shadowed id composes full under the overriding entry's persona", async () => {
  writeFileSync(
    path.join(cwdFixture, "agents.json"),
    JSON.stringify({
      agents: [
        { id: PRESET_ID, type: "agent-remote", mode: "chat", baseUrl: "http://127.0.0.1:9/v1", model: "m", name: "Operator Override" },
      ],
      apps: [],
    }),
  );
  await catalog.refresh(null);
  const scope = await deriveScope(PRESET_ID);
  assert.equal(scope.source, null, "an overridden id is no longer a custom preset — it runs full");
  // Full composition lists the user root and every pack root again.
  const dirs = await dirListOf({ agentPreset: PRESET_ID });
  assert.ok(dirs.includes(path.resolve(sm.MATERIALIZE_DIR)), "full mode lists the user skills root");
  writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
  await catalog.refresh(null);
});

test("the generated persona carries the custom focus note; a plain persona does not", () => {
  const persona = catalogEntryPersona({ id: PRESET_ID, name: "法务助手", customPreset: true, persona: "你是法务助手。" });
  assert.ok(persona.includes("自建预设"), "the note names the self-built preset's resource set");
  assert.ok(persona.includes("聚焦模式"));
  assert.ok(!catalogEntryPersona({ id: "x", name: "普通", persona: "p" }).includes("聚焦模式"));
});

// ── Overlay composition (task 2.3) ────────────────────────────────────────────

test("a stored overlay adjusts the custom role's set on the next composition", async () => {
  db.setFocusOverlay(PRESET_ID, {
    addMcp: ["cp-disabled", "cp-ghost-server"],
    removeMcp: ["cp-base"],
    addSkills: ["cp-pack-skill-2", "cp-user-skill", "cp-ghost-skill"],
    removeSkills: ["cp-pack-skill"],
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  let servers;
  let rootEntries;
  try {
    await writeMcpPatch({ agentPreset: PRESET_ID, ownerEmail: null, userGroups: null });
    const _skillsDirs = await dirListOf({ agentPreset: PRESET_ID });
    servers = serversOf();
    rootEntries = readdirSync(sm.customPresetSkillsRoot(PRESET_ID)).sort();
  } finally {
    console.warn = origWarn;
  }
  // MCP: baseline member removed by the diff; the disabled server stays
  // absent despite add; the ghost add is dangling (warned, inert).
  assert.ok(!servers.includes("cp-base"), "an overlay removal drops the operator baseline server");
  assert.ok(!servers.includes("cp-disabled"), "a disabled server stays omitted despite add");
  assert.ok(!servers.includes("cp-ghost-server"));
  assert.deepEqual(servers, ["cp-extra"]);
  // Skills: declared set minus the removal plus both adds.
  assert.deepEqual(rootEntries, ["cp-pack-skill-2", "cp-user-skill"]);
  assert.ok(warns.some((w) => w.includes("cp-ghost-skill")), `dangling skill add warned: ${warns}`);
  // The stored diff rides along as a derivation input, suppressible.
  assert.ok((await deriveScope(PRESET_ID)).overlay?.removeMcp?.includes("cp-base"));
  assert.equal((await deriveScope(PRESET_ID, { noOverlay: true })).overlay, null);
  db.setFocusOverlay(PRESET_ID, null);
});

// ── Manifest validator (task 3.1) ─────────────────────────────────────────────

test("validatePackManifest rejects user.-prefixed agent ids naming the reserved namespace", () => {
  const manifest = {
    name: "前缀测试包",
    skills: [{ name: "pfx-skill", description: "d", content: "# c" }],
    agents: [{ id: "user.sneaky", name: "抢注", persona: "p" }],
  };
  const errors = validatePackManifest(manifest);
  assert.ok(errors.length === 1, `exactly the namespace error: ${JSON.stringify(errors)}`);
  assert.match(errors[0].error, /user\.sneaky/);
  assert.match(errors[0].error, /reserved "user\." namespace/);
  assert.equal(errors[0].entry, "agents[0]");
  // The install path enforces the same rule (defense in depth shares the
  // validator): the manifest is rejected before anything materializes.
  assert.rejects(
    () => packStore.installPack({ packId: "pfx-pack", version: 1, manifest, user: null }),
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(err.details.some((d) => /reserved "user\." namespace/.test(d.error)));
      return true;
    },
  );
});

// ── Foreign-owner backstop (task 3.2) ─────────────────────────────────────────

test("a pack install meeting a preset's id skips the agent and names the preset as owner", async () => {
  // A preset row holding a NON-reserved id stands in for history (rows that
  // predate the `user.` rule; the prefix makes NEW collisions structurally
  // impossible, the backstop covers what validation cannot see). Seeded via
  // the raw handle because the CRUD path only ever assigns user.* ids.
  const raw = db.getDb();
  const now = new Date().toISOString();
  const heldId = "legacy-role";
  raw.prepare(
    "INSERT INTO user_presets (id, name, persona, skills, mcp_servers, tags, icon, created_at, updated_at) VALUES (?, ?, ?, '[]', '[]', '[]', NULL, ?, ?)",
  ).run(heldId, "历史预设", "p", now, now);
  assert.ok(db.getUserPreset(heldId), "the direct-seed row exists");

  const manifest = {
    name: "背板测试包",
    skills: [{ name: "cp-backstop-skill", description: "d", content: "# c" }],
    agents: [
      { id: heldId, name: "同名角色", persona: "p" },
      { id: "cp-backstop-free", name: "自由角色", persona: "p" },
    ],
  };
  const { report } = await packStore.installPack({ packId: "cp-backstop-pack", version: 1, manifest, user: null });
  const skipped = report.agents.find((a) => a.id === heldId);
  assert.equal(skipped?.status, "skipped");
  assert.match(skipped?.reason ?? "", /custom preset "历史预设"/);
  assert.equal(report.agents.find((a) => a.id === "cp-backstop-free")?.status, "installed");
  // The preset is untouched — the row and its persona survive verbatim.
  const after = db.getUserPreset(heldId);
  assert.equal(after?.persona, "p");

  // Cleanup: the seeded pack, its skills, and the legacy row.
  db.deleteCustomSkillsByPack("cp-backstop-pack");
  sm.removePackSkills("cp-backstop-pack");
  db.deleteInstalledPack("cp-backstop-pack");
  db.deleteUserPreset(heldId);
});

// ── Routes (task 4.1) ─────────────────────────────────────────────────────────

function harnessCtx(overrides = {}) {
  const broadcasts = [];
  const calls = { switches: [], syncs: 0 };
  return {
    app: null,
    db,
    broadcast: (m) => broadcasts.push(m),
    broadcasts,
    calls,
    isStreaming: false,
    currentPreset: "standard",
    runtimeOwnerGroups: null,
    runtimeOwnerEmail: null,
    runtimeMcpOverlay: null,
    dshBridge: undefined,
    switchPresetTo: async (id) => { calls.switches.push(id); return { ok: true }; },
    syncCatalogAgentPresets: async () => { calls.syncs += 1; return { changed: false, ids: [] }; },
    ...overrides,
  };
}

async function harnessApp(ctx) {
  const app = express();
  app.use(express.json());
  ctx.app = app;
  const { registerCustomPresetRoutes } = await import("../server/routes/custom-presets.js");
  registerCustomPresetRoutes(ctx);
  return app;
}

function request(app, { method = "GET", path: p = "/api/agent/presets", body, headers = {} } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1", port, path: p, method,
          headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
        },
        (res) => {
          let out = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { out += c; });
          res.on("end", () => resolve({ status: res.statusCode, body: out }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    server.on("error", reject);
  });
}

test("POST creates (server-assigned id), rejects forbidden keys, and 409s mid-stream", async () => {
  const ctx = harnessCtx();
  const app = await harnessApp(ctx);
  const forbidden = await request(app, {
    method: "POST",
    body: { name: "X", persona: "p", baseUrl: "http://evil", model: "m" },
  });
  assert.equal(forbidden.status, 400);
  assert.match(JSON.parse(forbidden.body).error, /persona-only.*baseUrl/);

  const created = await request(app, {
    method: "POST",
    body: { name: "路由预设", persona: "你是路由预设。", skills: ["cp-user-skill", "gone-skill"], mcpServers: ["gone-server"] },
  });
  assert.equal(created.status, 201, created.body);
  const { preset } = JSON.parse(created.body);
  assert.ok(preset.id.startsWith("user."));
  assert.ok(ctx.broadcasts.some((m) => m.type === "catalog_changed"), "the catalog refresh broadcast fires");
  assert.ok(ctx.calls.syncs > 0, "the serialized catalog sync runs");

  ctx.isStreaming = true;
  const busy = await request(app, { method: "POST", body: { name: "忙", persona: "p" } });
  assert.equal(busy.status, 409);
  assert.match(JSON.parse(busy.body).error, /responding/);
  ctx.isStreaming = false;

  // GET carries the composition-time markers.
  const list = await request(app);
  const view = JSON.parse(list.body).presets.find((r) => r.id === preset.id);
  assert.deepEqual(view.unavailableSkills, ["gone-skill"]);
  assert.deepEqual(view.unavailableMcpServers, ["gone-server"]);
  assert.equal(view.shadowed, false);

  // PUT edits without letting the author touch the id.
  const edited = await request(app, { method: "PUT", path: `/api/agent/presets/${preset.id}`, body: { persona: "改。" } });
  assert.equal(edited.status, 200, edited.body);
  assert.equal(JSON.parse(edited.body).preset.persona, "改。");
  assert.equal(JSON.parse(edited.body).preset.id, preset.id);
  assert.equal(db.getUserPreset(preset.id).persona, "改。");

  // DELETE removes the row; a missing id 404s.
  const deleted = await request(app, { method: "DELETE", path: `/api/agent/presets/${preset.id}` });
  assert.equal(deleted.status, 200);
  assert.equal(db.getUserPreset(preset.id), null);
  assert.equal((await request(app, { method: "DELETE", path: `/api/agent/presets/${preset.id}` })).status, 404);
});

test("deleting the SELECTED preset switches back first and prunes its artifacts", async () => {
  const ctx = harnessCtx();
  const app = await harnessApp(ctx);
  const { preset } = JSON.parse(
    (await request(app, { method: "POST", body: { name: "被选中", persona: "p", skills: ["cp-user-skill"] } })).body,
  );
  // Park an own-mode fallback the way a real switch would.
  db.setPreference("agent.preset.own", "code");
  db.setFocusOverlay(preset.id, { addMcp: ["cp-extra"], removeMcp: [], addSkills: [], removeSkills: [] });
  ctx.currentPreset = rosterPresetId(preset.id);

  const deleted = await request(app, { method: "DELETE", path: `/api/agent/presets/${preset.id}` });
  assert.equal(deleted.status, 200, deleted.body);
  // The fallback switch ran BEFORE the prune (the child never restarts onto a
  // dead preset id), toward the user's own mode.
  assert.deepEqual(ctx.calls.switches, ["code"]);
  assert.equal(db.getUserPreset(preset.id), null);
  assert.equal(db.getFocusOverlay(preset.id), null, "the stored overlay diff dies with the preset");
  assert.ok(ctx.broadcasts.some((m) => m.type === "catalog_changed"));
});
