// add-crm-desk-bridge — unit tests for the CRM desk agent bridge pieces:
//   1.3 requiresEnv omission semantics at MCP-patch composition
//   2.x operator tool face (list snapshot + derivation across modes)
//   3.x action-gate crm line (registry, preflight, stdio executor branch)
//   4.x reception skill (loading + referenced tool names ⊆ operator face)
//   5.x end-to-end composition assertions + mutation checks
//
// Drives the REAL writeMcpPatch against a temp DSH_HOME (paths resolve at
// import time, so env is set before the dynamic import — the established
// dsh-profile test pattern, see scripts/test-scoped-relay-host.mjs).
//
// Run: node scripts/test-crm-desk-bridge.mjs   (also picked up by test:unit)

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

const tmp = mkdtempSync(join(tmpdir(), "crm-desk-test-"));
process.env.DSH_HOME = join(tmp, "dsh-home");
process.env.MCP_CONFIG_PATH = join(tmp, "mcp.json");
// Deterministic env for the omission branches (chatwoot envs are the SUT).
delete process.env.CHATWOOT_BASE_URL;
delete process.env.CHATWOOT_API_TOKEN;

const { writeMcpPatch } = await import("../dsh-profile.js");
const PATCH = join(process.env.DSH_HOME, "profiles", "platform", "mcp.patch.yml");

function writeConfig(servers) {
  writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: servers }));
}
function patchEntry(name) {
  const doc = yaml.load(readFileSync(PATCH, "utf8"));
  return (doc[0]?.insert ?? []).find((e) => e.config.serverName === name) ?? null;
}

const CHATWOOT_ENTRY = {
  command: "node",
  args: ["node_modules/@fazer-ai/mcp-chatwoot/dist/index.js"],
  requiresEnv: ["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"],
  envRefs: ["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"],
};

// ── 1.3 requiresEnv omission ────────────────────────────────────────────────

test("1.3a requiresEnv all unset → entry omitted entirely (no patch, not dead entry)", async () => {
  writeConfig({ chatwoot: CHATWOOT_ENTRY });
  rmSync(PATCH, { force: true });
  const result = await writeMcpPatch();
  assert.equal(result, null, "no servers survive → patch skipped");
  assert.equal(existsSync(PATCH), false, "no patch file written");
});

test("1.3b requiresEnv all set → entry present with env forwarded", async () => {
  process.env.CHATWOOT_BASE_URL = "https://desk.finddatatech.cloud";
  process.env.CHATWOOT_API_TOKEN = "unit-token-not-real";
  try {
    writeConfig({ chatwoot: CHATWOOT_ENTRY });
    await writeMcpPatch();
    const entry = patchEntry("chatwoot");
    assert.ok(entry, "chatwoot entry present");
    assert.equal(entry.config.command, "node");
    assert.deepEqual(entry.config.env, {
      CHATWOOT_BASE_URL: "https://desk.finddatatech.cloud",
      CHATWOOT_API_TOKEN: "unit-token-not-real",
    });
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
  }
});

test("1.3c partial presence → entry kept, set value forwarded (envRefs degrade semantics)", async () => {
  process.env.CHATWOOT_BASE_URL = "https://desk.finddatatech.cloud";
  try {
    writeConfig({ chatwoot: CHATWOOT_ENTRY });
    await writeMcpPatch();
    const entry = patchEntry("chatwoot");
    assert.ok(entry, "partial presence keeps the entry (server reports its own missing-env error)");
    assert.deepEqual(entry.config.env, { CHATWOOT_BASE_URL: "https://desk.finddatatech.cloud" });
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
  }
});

test("1.3d entries without requiresEnv are unaffected (websearch degrade-not-omit contract)", async () => {
  delete process.env.SEARCH_RELAY_URL;
  delete process.env.SEARCH_RELAY_TOKEN;
  delete process.env.SEARCH_RELAY_SCOPED_MASTER;
  writeConfig({
    websearch: { command: "node", args: ["server/websearch-mcp.js"], envRefs: ["SEARCH_RELAY_URL", "SEARCH_RELAY_TOKEN"] },
  });
  await writeMcpPatch();
  const entry = patchEntry("websearch");
  assert.ok(entry, "no requiresEnv ⇒ absence semantics unchanged (entry still written)");
});

// ── 2.1 operator face snapshot ──────────────────────────────────────────────

const { operatorToolFace } = await import("../lib/operator-tool-face.js");

test("2.1a chatwoot face = 98 leaves, generated shape, no fork/send leakage", () => {
  const face = operatorToolFace("chatwoot");
  assert.equal(face.length, 98, "123 tools - 23 fork - 2 send-class = 98");
  assert.equal(new Set(face).size, 98, "no duplicates");
  for (const leaf of face) {
    assert.match(leaf, /^[a-z0-9_]+$/, `leaf shape: ${leaf}`);
    assert.ok(!leaf.startsWith("kanban"), `fork kanban leaked: ${leaf}`);
    assert.ok(!leaf.includes("scheduled_messages"), `fork scheduled leaked: ${leaf}`);
    assert.ok(leaf !== "messages_create" && leaf !== "messages_delete", `send-class leaked: ${leaf}`);
  }
});

test("2.1b the reception workflow's core reads are on the face", () => {
  const face = operatorToolFace("chatwoot");
  for (const leaf of [
    "conversations_list", "conversations_get", "conversations_meta", "conversations_filter",
    "messages_list", "contacts_list", "contacts_get", "contacts_search", "contacts_conversations",
    "inboxes_list", "canned_responses_list", "conversations_toggle_status",
    "conversations_get_labels", "conversations_set_labels",
  ]) {
    assert.ok(face.includes(leaf), `reception core tool missing: ${leaf}`);
  }
});

// ── 2.2 operator ceiling derivation ─────────────────────────────────────────

const { capByOperatorFace } = await import("../lib/full-mode-tool-scope.js");

const FAKE_FACE = ["alpha", "beta", "gamma"];
const faceFor = (server) => (server === "stub" ? FAKE_FACE : null);

test("2.2a no operator-face server present → input passes through unchanged (never discards an existing filter)", () => {
  assert.equal(capByOperatorFace(null, ["other", "library"]), null);
  const map = { other: ["x"] };
  assert.equal(capByOperatorFace(map, ["other"]), map, "a map without capped servers stays itself (identity, not null)");
});

test("2.2b present without existing filter → the face IS the filter (baseline/full-surface routes)", () => {
  const out = capByOperatorFace(null, ["stub"], { faceFor });
  assert.deepEqual(out, { stub: FAKE_FACE });
});

test("2.2c existing allowlist intersects the face (pack cannot widen past the ceiling)", () => {
  const out = capByOperatorFace({ stub: ["alpha", "delta", "messages_create"], other: ["x"] }, ["stub", "other"], { faceFor });
  assert.deepEqual(out.stub, ["alpha"], "outside-face leaves are cut even when the pack declared them");
  assert.deepEqual(out.other, ["x"], "other servers' filters untouched");
});

test("2.2d empty intersection is emitted as [] — honest hide-all, not filter-lift", () => {
  const out = capByOperatorFace({ stub: ["delta"] }, ["stub"], { faceFor });
  assert.deepEqual(out.stub, [], "intersection empty ⇒ nothing visible (never full-surface fallback)");
});

// ── 2.3 guard denial copy distinguishes platform bound from role narrowing ──

const FILTER_TMP = join(tmp, "tool-filter.json");
process.env.TOOL_FILTER_PATH = FILTER_TMP;
writeFileSync(FILTER_TMP, JSON.stringify({
  mcpTools: { stub: ["alpha", "beta"] },
  operatorFaces: { stub: ["alpha", "beta", "gamma"] },
}));
const { mcpToolGuardReason } = await import("../dsh-profile-template/platform-tool-scope.js");

test("2.3a leaf outside the operator face → platform-bound denial, no escape hatch", () => {
  const reason = mcpToolGuardReason("mcp__stub__messages_create");
  assert.match(reason, /outside the platform tool face/);
  assert.ok(!reason.includes("Settings"), "no escape-hatch pointer for platform governance");
});

test("2.3b leaf inside the face but outside the role allowlist → role-narrowing denial with escape hatch", () => {
  const reason = mcpToolGuardReason("mcp__stub__gamma");
  assert.match(reason, /outside this role's tool allowlist/);
  assert.match(reason, /Settings → MCP/);
});

test("2.3c allowlisted and unfiltered names pass; doc without operatorFaces keeps the legacy copy", () => {
  assert.equal(mcpToolGuardReason("mcp__stub__alpha"), undefined);
  assert.equal(mcpToolGuardReason("mcp__unmapped__whatever"), undefined);
  writeFileSync(FILTER_TMP, JSON.stringify({ mcpTools: { stub: ["alpha"] } }));
  const reason = mcpToolGuardReason("mcp__stub__beta");
  assert.match(reason, /outside this role's tool allowlist/);
});

// ── 3.x action gate: crm line ───────────────────────────────────────────────

const { getAction, isRegistered, validateArgs, filterKnownArgs } = await import("../lib/action-registry.js");
const { requireServerEnv } = await import("../lib/action-preflight.js");
const {
  executeRegisteredAction,
  ExecutorError,
  resolveStdioServerConfig,
} = await import("../lib/action-executor.js");

test("3.1a crm.message.send is registered with the pinned tool face and arg keys", () => {
  const action = getAction("crm.message.send");
  assert.ok(action, "registered");
  assert.equal(action.line, "crm");
  assert.equal(action.server, "chatwoot");
  assert.equal(action.tool, "messages_create");
  assert.equal(action.risk, "write");
  assert.deepEqual(action.argKeys, ["account_id", "conversation_id", "content"]);
  assert.deepEqual(action.requiredArgs, ["account_id", "conversation_id", "content"]);
  assert.ok(!isRegistered("crm.message.delete"), "messages_delete deliberately unregistered");
  assert.ok(!isRegistered("messages_delete"), "bare tool name is not an action id either");
});

test("3.1b a proposal missing required args is refused before storage", () => {
  const shape = validateArgs("crm.message.send", { account_id: 1, conversation_id: 5 });
  assert.equal(shape.ok, false);
  assert.deepEqual(shape.missing, ["content"]);
});

test("3.2 requireServerEnv: env present passes, absent refuses with config pointer", async () => {
  const hook = requireServerEnv(["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"], "CRM 客服台");
  process.env.CHATWOOT_BASE_URL = "https://desk.finddatatech.cloud";
  process.env.CHATWOOT_API_TOKEN = "unit";
  try {
    assert.deepEqual(await hook({}, {}, getAction("crm.message.send")), { ok: true });
  } finally {
    delete process.env.CHATWOOT_API_TOKEN;
  }
  const refused = await hook({}, {}, getAction("crm.message.send"));
  assert.equal(refused.ok, false);
  assert.match(refused.details, /CHATWOOT_API_TOKEN/);
  assert.match(refused.details, /平台管理员/);
  delete process.env.CHATWOOT_BASE_URL;
});

test("3.3a resolveStdioServerConfig mirrors the patch composition and its omission rule", () => {
  const stubEnv = { CHATWOOT_BASE_URL: "https://x", CHATWOOT_API_TOKEN: "y" };
  const cfg = resolveStdioServerConfig("chatwoot", { env: stubEnv });
  assert.ok(cfg, "bundle-declared stdio server resolves");
  assert.equal(cfg.command, "node");
  const omitted = resolveStdioServerConfig("chatwoot", { env: {} });
  assert.equal(omitted, null, "requiresEnv all absent ⇒ not stdio-hosted (honest unreachable)");
  const partial = resolveStdioServerConfig("chatwoot", { env: { CHATWOOT_BASE_URL: "https://x" } });
  assert.ok(partial, "partial presence keeps the entry (server reports its own missing-env)");
  assert.equal(resolveStdioServerConfig("facet-market-mcp", { env: stubEnv }), null, "http catalog server is not stdio-hosted");
});

const STUB_STDIO = { command: process.execPath, args: ["scripts/fixtures/stub-crm-mcp.mjs"] };
const CRM_ARGS = { account_id: 1, conversation_id: 42, content: "您好，已收到您的反馈。" };
const crmAction = () => getAction("crm.message.send");

async function runStdio(mode) {
  process.env.STUB_MODE = mode;
  try {
    return await executeRegisteredAction({
      action: crmAction(),
      args: { ...CRM_ARGS },
      email: "ops@findmail.com",
      deps: { stdioServerFor: () => STUB_STDIO },
    });
  } finally {
    delete process.env.STUB_MODE;
  }
}
async function runStdioExpectError(mode, code) {
  try {
    await runStdio(mode);
    assert.fail(`expected ExecutorError ${code}`);
  } catch (err) {
    assert.ok(err instanceof ExecutorError, `ExecutorError, got ${err?.constructor?.name}`);
    assert.equal(err.code, code);
    return err;
  }
}

test("3.3b stdio execution happy path returns the tool text", async () => {
  const out = await runStdio("ok");
  assert.match(out.summary, /Message created \(stub\)/);
  assert.equal(out.server, "chatwoot");
});

test("3.3c tool-level 401 → upstream_401 with 凭据无效 and no user-credential invalidation", async () => {
  const err = await runStdioExpectError("401", "upstream_401");
  assert.match(err.message, /凭据无效/);
  assert.equal(err.credentialInvalidated, undefined, "no per-user ref on this branch");
});

test("3.3d Chatwoot fallback-worded 422 → upstream_422 with verbatim detail", async () => {
  const err = await runStdioExpectError("422", "upstream_422");
  assert.match(err.message, /Unprocessable Entity/);
});

test("3.3e joined-errors wording (no status) → tool_error carrying the verbatim text", async () => {
  const err = await runStdioExpectError("plain", "tool_error");
  assert.match(err.message, /Email has already been taken/);
});

test("3.3f spawn failure → transport_error with unreachable wording", async () => {
  try {
    await executeRegisteredAction({
      action: crmAction(),
      args: { ...CRM_ARGS },
      email: "ops@findmail.com",
      deps: { stdioServerFor: () => ({ command: "/nonexistent/definitely-not-node" }) },
    });
    assert.fail("expected transport_error");
  } catch (err) {
    assert.equal(err.code, "transport_error");
    assert.match(err.message, /网络不可达|未能启动/);
  }
});

test("3.4 audit surfaces carry no credential: filterKnownArgs drops token-shaped extras, summary stays clean", async () => {
  // The propose path stores args_json AFTER filterKnownArgs — a model trying
  // to smuggle the env token into args must see it dropped before storage.
  const filtered = filterKnownArgs("crm.message.send", {
    ...CRM_ARGS,
    CHATWOOT_API_TOKEN: "leak-attempt",
    api_access_token: "leak-attempt-2",
  });
  assert.deepEqual(Object.keys(filtered).sort(), ["account_id", "content", "conversation_id"]);
  const impact = crmAction().impact(filtered);
  assert.ok(!impact.includes("leak"), "impact text carries no credential");
  const out = await runStdio("echo");
  assert.ok(!out.summary.includes("leak-attempt"), "execution result carries no credential");
  const echoed = JSON.parse(out.summary).receivedArgs;
  assert.deepEqual(Object.keys(echoed).sort(), ["account_id", "content", "conversation_id"], "the tool received exactly the known args");
});

// ── 4.x reception skill ─────────────────────────────────────────────────────

const { getFileSkills, expandSkillContent } = await import("../server/skills.js");

function repoRootPath() {
  // resolve the repo root from this test file's location (test runs from repo cwd too)
  return new URL("..", import.meta.url).pathname.replace(/\/$/, "");
}
const SKILLS_DIR = join(repoRootPath(), "skills");

test("4.2a the skill loads from the repo skills dir with frontmatter", async () => {
  const skills = getFileSkills(SKILLS_DIR);
  const hit = skills.find((s) => s.name === "crm-desk-reception");
  assert.ok(hit, "getFileSkills finds crm-desk-reception");
  assert.ok(hit.description.length > 20, "description present");
  const body = await expandSkillContent(hit, "");
  assert.match(body, /account_id: 1/, "pins the A-tenant account id");
  assert.match(body, /crm\.message\.send/, "names the gated send action");
});

test("4.2b every mcp__chatwoot__ tool the skill references is on the 98-leaf face", async () => {
  const skills = getFileSkills(SKILLS_DIR);
  const hit = skills.find((s) => s.name === "crm-desk-reception");
  const raw = readFileSync(hit.filePath, "utf8");
  const referenced = [...new Set([...raw.matchAll(/mcp__chatwoot__([a-z0-9_]+)/g)].map((m) => m[1]))];
  assert.ok(referenced.length >= 8, `skill references a meaningful tool set (got ${referenced.length})`);
  const face = new Set(operatorToolFace("chatwoot"));
  for (const leaf of referenced) {
    assert.ok(face.has(leaf), `skill references non-face tool: ${leaf}`);
  }
  assert.ok(!referenced.includes("messages_create") && !referenced.includes("messages_delete"),
    "send-class tools appear only as forbidden names, never as callable references");
});

// ── 5.1 composition: patch + materialized tool filter ──────────────────────

const FILTER_FILE_COMPOSED = join(process.env.DSH_HOME, "profiles", "platform", "tool-filter.json");

test("5.1a env present: patch carries the chatwoot entry and the materialized face is exactly the 98 leaves", async () => {
  process.env.CHATWOOT_BASE_URL = "https://desk.finddatatech.cloud";
  process.env.CHATWOOT_API_TOKEN = "unit-token";
  try {
    writeConfig({ chatwoot: CHATWOOT_ENTRY });
    await writeMcpPatch();
    const entry = patchEntry("chatwoot");
    assert.ok(entry, "patch entry present");
    const doc = JSON.parse(readFileSync(FILTER_FILE_COMPOSED, "utf8"));
    assert.deepEqual([...doc.mcpTools.chatwoot].sort(), operatorToolFace("chatwoot"),
      "materialized chatwoot face = the operator face (no pack input, governance-only)");
    assert.deepEqual([...doc.operatorFaces.chatwoot].sort(), operatorToolFace("chatwoot"),
      "provenance section rides the doc for the guard's denial copy");
  } finally {
    delete process.env.CHATWOOT_BASE_URL;
    delete process.env.CHATWOOT_API_TOKEN;
  }
});

test("5.1b env absent: no patch entry AND no chatwoot tool-filter entry", async () => {
  writeConfig({ chatwoot: CHATWOOT_ENTRY, websearch: { command: "node", args: ["server/websearch-mcp.js"], envRefsOptional: ["SEARCH_USER_KEY"] } });
  await writeMcpPatch();
  assert.equal(patchEntry("chatwoot"), null, "omitted server leaves no patch entry");
  const doc = JSON.parse(readFileSync(FILTER_FILE_COMPOSED, "utf8"));
  assert.equal(doc.mcpTools.chatwoot, undefined, "a server absent from the composition gets no face row");
  assert.equal(doc.operatorFaces, undefined, "no provenance without the server present");
});
