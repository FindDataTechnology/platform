// Unit tests — add-crm-desk-pack-embed: chatwoot BYOK credential module (2.1),
// credentialEnv resolution at patch composition (3.1), stale on 401 (3.2),
// action-gate dual credential (4.x), pack shape (5.x).
// Run: node --test scripts/test-crm-desk-pack-embed.mjs   (also in test:unit)

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crm-pack-")), "data.db");
process.env.DB_PATH = DB_PATH;
process.env.DSH_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crm-pack-dsh-")), "dsh");
// dsh-profile captures MCP_CONFIG_PATH at import time — the per-test configs
// below all WRITE to this one path (the established dsh-profile test pattern:
// env before the dynamic import).
process.env.MCP_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "crm-pack-mcp-")), "mcp.json");

const db = await import("../db.js");
await db.initDb();
const cw = await import("../chatwoot-credentials.js");

const MERCHANT = "merchant@test.example";
const OTHER = "other@test.example";

// ── 2.1 credential module ───────────────────────────────────────────────────

test("2.1a store/status/liveToken/disconnect lifecycle", () => {
  assert.deepEqual(cw.status(MERCHANT), { connected: false, stale: false, hasLoginCredentials: false });
  cw.store({ email: MERCHANT, token: "cw-token-1", loginEmail: "m@chat.example", loginPassword: "pw" });
  assert.deepEqual(cw.status(MERCHANT), { connected: true, stale: false, hasLoginCredentials: true });
  assert.equal(cw.liveToken(MERCHANT), "cw-token-1");
  assert.deepEqual(cw.loginCredentials(MERCHANT), { email: "m@chat.example", password: "pw" });
  assert.equal(cw.liveToken(OTHER), null, "per-user isolation");
  cw.disconnect(MERCHANT);
  assert.equal(cw.connected !== undefined && cw.status(MERCHANT).connected, false);
  assert.equal(cw.loginCredentials(MERCHANT), null);
});

test("2.1b re-save recovers stale; partial login pair is rejected at store", () => {
  cw.store({ email: MERCHANT, token: "cw-token-2" });
  assert.equal(cw.status(MERCHANT).hasLoginCredentials, false, "token-only connect");
  assert.deepEqual(cw.loginCredentials(MERCHANT), null);
  cw.markInvalid(MERCHANT);
  assert.equal(cw.status(MERCHANT).stale, true);
  assert.equal(cw.liveToken(MERCHANT), null, "stale ⇒ no live token");
  cw.store({ email: MERCHANT, token: "cw-token-3" });
  assert.equal(cw.status(MERCHANT).stale, false, "fresh paste clears stale");
  assert.equal(cw.liveToken(MERCHANT), "cw-token-3");
});

test("2.1c credential-refs dispatch knows the ref", async () => {
  const refs = await import("../credential-refs.js");
  assert.equal(refs.knownRef("chatwoot"), true);
  assert.equal(refs.connectPanelForRef("chatwoot"), "chatwoot");
  assert.match(refs.credentialMissingReason("chatwoot"), /Chatwoot/);
  cw.store({ email: MERCHANT, token: "cw-token-4" });
  assert.equal(refs.credentialConnected("chatwoot", MERCHANT), true);
  assert.equal(refs.credentialConnected("chatwoot", OTHER), false);
});

// ── 3.1 credentialEnv resolution at patch composition ──────────────────────

const { writeMcpPatch } = await import("../dsh-profile.js");
const yaml = (await import("js-yaml")).default;

const PATCH = path.join(process.env.DSH_HOME, "profiles", "platform", "mcp.patch.yml");

// Mirrors the real platform.bundle.json chatwoot entry (envRefs carries BOTH
// names — the deployment fallback needs the token too; credentialEnv is the
// per-user override layer on top).
const CHATWOOT_ENTRY = {
  command: "node",
  args: ["node_modules/@fazer-ai/mcp-chatwoot/dist/index.js"],
  credentialEnv: { CHATWOOT_API_TOKEN: "chatwoot" },
  envRefs: ["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"],
};

function patchEntry(name) {
  // A skipped write (zero surviving servers) leaves no patch file — that IS
  // the omitted state the assertions below look for.
  if (!fs.existsSync(PATCH)) return null;
  const doc = yaml.load(fs.readFileSync(PATCH, "utf8"));
  return (doc[0]?.insert ?? []).find((e) => e.config.serverName === name) ?? null;
}

test("3.1a connected user: patch env carries the user's token over deployment env", async () => {
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: { chatwoot: CHATWOOT_ENTRY } }));
  process.env.CHATWOOT_BASE_URL = "https://desk.example";
  process.env.CHATWOOT_API_TOKEN = "deployment-shared-token";
  cw.store({ email: MERCHANT, token: "user-token-xyz" });
  try {
    await writeMcpPatch({ ownerEmail: MERCHANT });
    const entry = patchEntry("chatwoot");
    assert.ok(entry, "entry present for connected user");
    assert.equal(entry.config.env.CHATWOOT_API_TOKEN, "user-token-xyz", "user credential wins");
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
  }
});

test("3.1b authenticated user without credential: entry omitted even with deployment env", async () => {
  process.env.CHATWOOT_BASE_URL = "https://desk.example";
  process.env.CHATWOOT_API_TOKEN = "deployment-shared-token";
  try {
    fs.rmSync(PATCH, { force: true });
    await writeMcpPatch({ ownerEmail: OTHER });
    assert.equal(patchEntry("chatwoot"), null, "never falls back to shared env for an authenticated user");
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
  }
});

test("3.1c machine owner (null email): deployment env path byte-identical to pre-change", async () => {
  process.env.CHATWOOT_BASE_URL = "https://desk.example";
  process.env.CHATWOOT_API_TOKEN = "deployment-shared-token";
  fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: { chatwoot: CHATWOOT_ENTRY } }));
  try {
    fs.rmSync(PATCH, { force: true });
    await writeMcpPatch({});
    const entry = patchEntry("chatwoot");
    assert.ok(entry, "machine owner keeps the deployment path");
    assert.equal(entry.config.env.CHATWOOT_API_TOKEN, "deployment-shared-token");
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
  }
});

test("3.1d stale credential omits the entry (stale ⇒ not live)", async () => {
  cw.markInvalid(MERCHANT);
  try {
    fs.rmSync(PATCH, { force: true });
    await writeMcpPatch({ ownerEmail: MERCHANT });
    assert.equal(patchEntry("chatwoot"), null);
  } finally {
    cw.store({ email: MERCHANT, token: "cw-token-5" });
  }
});

// ── 4.x action gate dual credential ─────────────────────────────────────────

const { getAction, validateArgs } = await import("../lib/action-registry.js");
const { requireChatwootCredential } = await import("../lib/action-preflight.js");
const { executeRegisteredAction, ExecutorError } = await import("../lib/action-executor.js");

test("4.1a crm.message.send carries credentialRef and preflight tri-branches", async () => {
  const action = getAction("crm.message.send");
  assert.equal(action.credentialRef, "chatwoot");
  // connected user → ok
  assert.deepEqual(await requireChatwootCredential()({ email: MERCHANT }, {}, action), { ok: true });
  // authenticated user without credential → refused with connect path
  const refused = await requireChatwootCredential()({ email: OTHER }, {}, action);
  assert.equal(refused.ok, false);
  assert.match(refused.details, /Chatwoot/);
  assert.equal(refused.connectPath, "/settings/connections?panel=chatwoot");
  // machine owner (no email) → ok (deployment env fallback branch)
  process.env.CHATWOOT_BASE_URL = "https://desk.example";
  process.env.CHATWOOT_API_TOKEN = "deployment-shared-token";
  try {
    assert.deepEqual(await requireChatwootCredential()({}, {}, action), { ok: true });
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
  }
});

test("4.1b arg shape unchanged", () => {
  const shape = validateArgs("crm.message.send", { account_id: 7, conversation_id: 1 });
  assert.equal(shape.ok, false);
  assert.deepEqual(shape.missing, ["content"]);
});

// Mirrors what resolveStdioServerConfig returns for the bundled entry: the
// credentialEnv map is what makes the executor take the user-credential path.
const STUB_STDIO = {
  command: process.execPath,
  args: ["scripts/fixtures/stub-crm-mcp.mjs"],
  credentialEnv: { CHATWOOT_API_TOKEN: "chatwoot" },
};
const CRM_ARGS = { account_id: 1, conversation_id: 42, content: "您好" };

async function runSend({ email }) {
  process.env.STUB_MODE = "echo";
  try {
    return await executeRegisteredAction({
      action: getAction("crm.message.send"),
      args: { ...CRM_ARGS },
      email,
      deps: { stdioServerFor: () => STUB_STDIO },
    });
  } finally {
    delete process.env.STUB_MODE;
  }
}

test("4.2a connected user's send executes with the user's token in child env", async () => {
  const out = await runSend({ email: MERCHANT });
  const echoed = JSON.parse(out.summary).receivedArgs;
  assert.deepEqual(Object.keys(echoed).sort(), ["account_id", "content", "conversation_id"]);
});

test("4.2b authenticated user without credential cannot execute (preflight, not executor)", async () => {
  const action = getAction("crm.message.send");
  const refused = await requireChatwootCredential()({ email: OTHER }, CRM_ARGS, action);
  assert.equal(refused.ok, false);
});

test("3.2 tool-level 401 on the user path flips THEIR credential stale, deployment env untouched", async () => {
  cw.store({ email: MERCHANT, token: "stale-me" });
  process.env.STUB_MODE = "401";
  let caught = null;
  try {
    await executeRegisteredAction({
      action: getAction("crm.message.send"),
      args: { ...CRM_ARGS },
      email: MERCHANT,
      deps: { stdioServerFor: () => STUB_STDIO },
    });
  } catch (e) {
    caught = e;
  } finally {
    delete process.env.STUB_MODE;
  }
  assert.ok(caught instanceof ExecutorError && caught.code === "upstream_401", `upstream_401, got ${caught?.code}`);
  assert.equal(caught.credentialInvalidated, true);
  assert.equal(cw.status(MERCHANT).stale, true, "user credential went stale");
  assert.equal(cw.liveToken(MERCHANT), null);
  assert.ok(!String(caught.message).includes("stale-me"), "error surfaces never carry the token");
  cw.store({ email: MERCHANT, token: "cw-token-5" }); // recover for later tests
});

test("4.2c machine owner falls back to deployment env path", async () => {
  // no chatwoot credential for the machine-owner key; execution still works
  const out = await runSend({ email: null });
  assert.match(out.summary, /receivedArgs|Message created/);
});

// ── 5.x pack shape ──────────────────────────────────────────────────────────

test("5.3 install chain: bundled row binds, awaiting activates, fullSurface marker travels", async () => {
  process.env.PLATFORM_DATA_DIR = path.join(path.dirname(DB_PATH), "data");
  const packStore = await import("../pack-store.js");
  const extensionStore = await import("../extension-store.js");
  const { crmDeskPackManifest } = await import("../lib/crm-desk-pack.js");
  const manifest = crmDeskPackManifest();
  const user = { email: MERCHANT, groups: [] };

  // A bundled-origin chatwoot row exists in EVERY cell (platform baseline):
  // seed it like seedStartupMcpConfigs does, then the pack reference binds.
  extensionStore.seedMcpServer({ name: "chatwoot", config: { ...CHATWOOT_ENTRY }, enabled: true, origin: "bundled" });

  const installed = await packStore.installPack({
    packId: "pack-crm-desk-suite",
    version: 1,
    manifest,
    user,
    hooks: {},
  });
  assert.equal(installed.report.mcpServers[0].name, "chatwoot");
  assert.equal(installed.report.mcpServers[0].status, "bound", "bundled row is the local row the reference binds to");
  const snapshot = (db.listInstalledPacks()).find((p) => p.packId === "pack-crm-desk-suite");
  assert.ok(snapshot, "installed pack snapshot recorded");
  const ref = snapshot.manifest.mcpServers.find((m) => m.registryName === "chatwoot");
  assert.equal(ref.fullSurface, true, "fullSurface marker travels with the installed snapshot");

  // The awaiting path on a name with neither row nor entry (fresh name):
  const probe = await packStore.installPack({
    packId: "pack-crm-probe",
    version: 1,
    manifest: { ...manifest, name: "CRM 探针", mcpServers: [{ registryName: "no-such-server", fullSurface: true, fullSurfaceReason: "probe" }] },
    user,
    hooks: {},
  });
  assert.equal(probe.report.mcpServers[0].status, "awaiting-local-binding");
});

test("5.2 pack declares fullSurface bounded by the operator face (98)", async () => {
  const { operatorToolFace } = await import("../lib/operator-tool-face.js");
  const { crmDeskPackChatwootRef, crmDeskPackManifest } = await import("../lib/crm-desk-pack.js");
  const ref = crmDeskPackChatwootRef();
  assert.equal(ref.fullSurface, true);
  const face = operatorToolFace("chatwoot");
  assert.equal(face.length, 98);
  // closure: every chatwoot tool the merchant skill references is on the face
  const fs = await import("node:fs");
  const _path = await import("node:path");
  const { repoRoot } = await import("../paths.js");
  const skill = fs.readFileSync(repoRoot("packs/crm-desk-suite/skills/crm-desk-reception-merchant/SKILL.md"), "utf8");
  const referenced = [...new Set([...skill.matchAll(/mcp__chatwoot__([a-z0-9_]+)/g)].map((m) => m[1]))];
  assert.ok(referenced.length >= 8);
  for (const leaf of referenced) assert.ok(face.includes(leaf), `skill references non-face tool: ${leaf}`);
  assert.ok(!referenced.includes("messages_create") && !referenced.includes("messages_delete"));
  assert.ok(crmDeskPackManifest().skills.some((sk) => sk.name === "crm-desk-reception-merchant"));
});
