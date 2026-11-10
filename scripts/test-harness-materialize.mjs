#!/usr/bin/env node
// ── ACP workspace materialization tests (add-harness-materializer 1.1–1.3) ──
//
// Unit coverage for the serving plane's half of the pack materializer: the
// harness-native layout (CLAUDE.md persona + .claude/skills + data volume),
// the bare degradation for unmapped harnesses, the ACP wire row shape for
// registry MCP references, and the credential policy pair (billing override
// env, secrets refusal). The manager-level dispatch and the wire passthrough
// live in test-agent-runner.mjs / test-harness-adapter.mjs.
//
//   node --test scripts/test-harness-materialize.mjs

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  materializeAcpWorkspace,
  acpLayoutFor,
  acpMcpServers,
  acpCredentialEnv,
  acpSecretsRefusal,
} from "../agent-runner/compose-acp.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "acp-mat-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const SERVING_SUFFIX = "\n\nYou are serving as a standing A2A agent service; answer in text.";

const skills = {
  "packs/p1/skills/alpha": "# alpha\nstep one",
  "packs/p1/skills/beta": "# beta\nstep two",
};

function entryFixture(over = {}) {
  return {
    path: "/packs/p1/a1",
    name: "Probe Agent",
    description: "probe",
    metadata: {
      packId: "p1",
      packVersion: 2,
      agentId: "a1",
      agentName: "探针",
      persona: "你是探针代理。",
      skills: ["packs/p1/skills/alpha", "packs/p1/skills/beta"],
      mcpServers: ["legal"],
      workspace: { enabled: true, quotaMb: 64 },
      ...over,
    },
  };
}

// ── 1.1 the claude-code layout ───────────────────────────────────────────────

test("1.1 the claude layout lands persona + skills + data in the workspace", () => {
  const root = mkdtempSync(path.join(tmpRoot, "lay-"));
  const spec = materializeAcpWorkspace({
    homeRoot: root,
    agentKey: "packs-p1-a1",
    entry: entryFixture(),
    skillContents: skills,
    harnessName: "acp-claude-code",
    log: { log() {}, warn() {}, error() {} },
  });
  assert.equal(spec.layout, "claude-code");
  assert.deepEqual(spec.unmapped, []);
  const claude = readFileSync(path.join(spec.workspace, "CLAUDE.md"), "utf8");
  assert.equal(claude, `你是探针代理。${SERVING_SUFFIX}`, "the persona file is the persona plus the shared serving suffix");
  for (const name of ["alpha", "beta"]) {
    const body = readFileSync(path.join(spec.workspace, ".claude", "skills", name, "SKILL.md"), "utf8");
    assert.ok(body.startsWith(`# ${name}`), `skill ${name} landed as a native Agent Skill`);
  }
  assert.ok(spec.dataDir && existsSync(spec.dataDir), "the declared data workspace was created");
  assert.equal(spec.dataQuotaMb, 64);
});

test("1.1 the persona text stays in lockstep with the dsh preset row", () => {
  // The suffix literal must be IDENTICAL in compose.js (the dsh persona
  // preset row) and compose-acp.js (this file's CLAUDE.md). One voice across
  // harnesses — this source read is the drift tripwire.
  const composeSrc = readFileSync(path.join(REPO_ROOT, "agent-runner", "compose.js"), "utf8");
  const acpSrc = readFileSync(path.join(REPO_ROOT, "agent-runner", "compose-acp.js"), "utf8");
  const needle = "\\n\\nYou are serving as a standing A2A agent service; answer in text.";
  assert.ok(composeSrc.includes(needle), "compose.js still carries the shared serving suffix");
  assert.ok(acpSrc.includes(needle), "compose-acp.js carries the same literal");
});

test("1.1 a missing skill body fails the composition loudly", () => {
  const root = mkdtempSync(path.join(tmpRoot, "miss-"));
  assert.throws(
    () =>
      materializeAcpWorkspace({
        homeRoot: root,
        agentKey: "k",
        entry: entryFixture(),
        skillContents: { "packs/p1/skills/alpha": "x" }, // beta missing
        harnessName: "acp-claude-code",
        log: { log() {}, warn() {}, error() {} },
      }),
    /skill content unavailable for packs\/p1\/skills\/beta/,
    "the same refusal shape the dsh composer uses",
  );
});

// ── 1.2 idempotency + bare degradation ──────────────────────────────────────

test("1.2 re-materialization replaces pack content and never removes data", () => {
  const root = mkdtempSync(path.join(tmpRoot, "re-"));
  const log = { log() {}, warn() {}, error() {} };
  const first = materializeAcpWorkspace({ homeRoot: root, agentKey: "k", entry: entryFixture(), skillContents: skills, harnessName: "acp-claude-code", log });
  writeFileSync(path.join(first.dataDir, "marker.txt"), "keep");
  const second = materializeAcpWorkspace({
    homeRoot: root,
    agentKey: "k",
    entry: entryFixture({ persona: "你是新版人格。" }),
    skillContents: { "packs/p1/skills/alpha": "# alpha v2", "packs/p1/skills/beta": "# beta v2" },
    harnessName: "acp-claude-code",
    log,
  });
  assert.equal(second.workspace, first.workspace);
  assert.equal(readFileSync(path.join(second.workspace, "CLAUDE.md"), "utf8"), `你是新版人格。${SERVING_SUFFIX}`, "the persona file was replaced");
  assert.equal(readFileSync(path.join(second.workspace, ".claude", "skills", "alpha", "SKILL.md"), "utf8"), "# alpha v2", "skills were replaced");
  assert.equal(readFileSync(path.join(second.dataDir, "marker.txt"), "utf8"), "keep", "the data volume survived");
});

test("1.2 an unmapped harness serves bare with the gap named", () => {
  const root = mkdtempSync(path.join(tmpRoot, "bare-"));
  const warns = [];
  const spec = materializeAcpWorkspace({
    homeRoot: root,
    agentKey: "k",
    entry: entryFixture(),
    skillContents: skills,
    harnessName: "acp-gemini-x",
    log: { log() {}, warn: (m) => warns.push(m), error() {} },
  });
  assert.equal(spec.layout, null);
  assert.ok(existsSync(spec.workspace), "the bare workspace still exists — the adapter needs an absolute cwd");
  assert.ok(!existsSync(path.join(spec.workspace, "CLAUDE.md")), "no persona file was pretended");
  assert.ok(!existsSync(path.join(spec.workspace, ".claude")), "no skills were pretended");
  assert.deepEqual(spec.unmapped, ["persona", "skills", "mcpServers"], "every declared-but-unmapped part is named");
  assert.equal(warns.length, 1);
  assert.match(warns[0], /acp-gemini-x.*persona, skills, mcpServers/);
  assert.ok(spec.dataDir && existsSync(spec.dataDir), "the data workspace is harness-neutral and still lands");
});

test("1.2 a persona-less entry on a mapped layout warns but composes", () => {
  const root = mkdtempSync(path.join(tmpRoot, "noper-"));
  const warns = [];
  const spec = materializeAcpWorkspace({
    homeRoot: root,
    agentKey: "k",
    // Persona-less means the WHOLE fallback chain is empty — the dsh composer
    // falls back to entry name/agentName the same way, so the fixture clears
    // those too (the code's fallback is the shared behavior, not a defect).
    entry: { ...entryFixture({ persona: null, agentName: null, skills: [], mcpServers: [], workspace: null }), name: null },
    skillContents: {},
    harnessName: "acp-claude-code",
    log: { log() {}, warn: (m) => warns.push(m), error() {} },
  });
  assert.equal(spec.layout, "claude-code");
  assert.ok(!existsSync(path.join(spec.workspace, "CLAUDE.md")), "no persona was invented");
  assert.equal(warns.filter((w) => /no persona/.test(w)).length, 1, "the gap is named, not swallowed");
});

test("1.2 acpLayoutFor answers null outside the table", () => {
  assert.equal(acpLayoutFor("acp-claude-code"), "claude-code");
  assert.equal(acpLayoutFor("acp-codex"), null);
  assert.equal(acpLayoutFor(""), null);
});

// ── 1.3 the ACP wire row + the credential policy pair ───────────────────────

test("1.3 acpMcpServers emits the SDK http shape with the registry credential", () => {
  const registryClient = { mcpUrlFor: (n) => `https://reg.example.test/${n}/mcp` };
  const [row] = acpMcpServers(["legal"], registryClient, "tok");
  assert.deepEqual(row, {
    type: "http",
    name: "legal",
    url: "https://reg.example.test/legal/mcp",
    headers: [{ name: "Authorization", value: "Bearer tok" }],
  }, "headers is an ENTRY ARRAY ({name,value}) — the installed SDK 0.14.1 schema shape claude-code-acp maps onto its header record");
  const [anon] = acpMcpServers(["x"], registryClient, null);
  assert.deepEqual(anon.headers, [], "no token still satisfies the schema's required field with an empty array");
});

test("1.3 acpCredentialEnv overrides BOTH credential vars or none", () => {
  assert.equal(acpCredentialEnv(null), null);
  assert.equal(acpCredentialEnv(""), null);
  assert.deepEqual(acpCredentialEnv("sk-deployer"), { ANTHROPIC_API_KEY: "sk-deployer", ANTHROPIC_AUTH_TOKEN: "sk-deployer" });
});

test("1.3 acpSecretsRefusal fails closed with a channel-naming error", () => {
  assert.equal(acpSecretsRefusal({}, "acp-claude-code"), null);
  assert.equal(acpSecretsRefusal(undefined, "acp-claude-code"), null);
  const err = acpSecretsRefusal({ wgk_pat: "ref-1", api_tok: "ref-2" }, "acp-claude-code");
  assert.equal(err.code, "HARNESS_SECRETS_UNSUPPORTED");
  assert.equal(err.harness, "acp-claude-code");
  assert.deepEqual(err.secrets, ["wgk_pat", "api_tok"]);
  assert.match(err.message, /wgk_pat, api_tok/);
  assert.match(err.message, /no controlled secrets channel/);
});
