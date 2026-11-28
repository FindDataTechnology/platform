#!/usr/bin/env node
// ── Data workspace volume (facet-mcp-foundation-v1 3.1) ─────────────────────
//
// Descriptor declaration → registry metadata, materialized <home>/data/,
// AGENT_DATA_DIR env wiring, quota guardrail, and the DSH_HOME-persistence
// rule: re-materialization (the upgrade path) and the session reap never
// touch data/. No test framework in this repo — plain node:assert.
//
// Run: node agent-runner/test/workspace.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { composeDescriptor } from "../../lib/agent-serving.js";
import { validatePackManifest } from "../../lib/pack-manifest.js";
import { materializeAgentHome, workspaceChildEnv } from "../compose.js";
import { ChildManager } from "../manager.js";

const tmpRoots = [];
const tmpDir = (label) => {
  const dir = mkdtempSync(path.join(tmpdir(), `ws-test-${label}-`));
  tmpRoots.push(dir);
  return dir;
};

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`  ${e?.stack || e}`);
    process.exitCode = 1;
  }
};

const agentWithServing = (workspace) => ({
  id: "analyst",
  name: "分析师",
  persona: "p",
  serving: { protocol: "a2a", ...(workspace ? { workspace } : {}) },
});
const descriptorOf = (workspace) =>
  composeDescriptor({ packId: "p", version: 1, manifest: { name: "pack", agents: [] }, agent: agentWithServing(workspace), skillPaths: [] });

// ── Descriptor (composeDescriptor → registry metadata) ──────────────────────

await test("descriptor: no workspace declaration → field absent (legacy metadata byte-identical)", () => {
  const d = descriptorOf(undefined);
  assert.equal(d.workspace, undefined);
  assert.equal(d.protocol, "a2a");
  assert.equal(d.agentId, "analyst");
});

await test("descriptor: enabled + quotaMb → { enabled, quotaMb }", () => {
  assert.deepEqual(descriptorOf({ enabled: true, quotaMb: 2048 }).workspace, { enabled: true, quotaMb: 2048 });
});

await test("descriptor: enabled without quotaMb → { enabled } only", () => {
  assert.deepEqual(descriptorOf({ enabled: true }).workspace, { enabled: true });
});

await test("descriptor: enabled:false → field absent (zero-change deployment)", () => {
  assert.equal(descriptorOf({ enabled: false, quotaMb: 10 }).workspace, undefined);
});

await test("descriptor: malformed quotaMb dropped, enabled kept (runner re-checks anyway)", () => {
  assert.deepEqual(descriptorOf({ enabled: true, quotaMb: "big" }).workspace, { enabled: true });
});

// ── Pack manifest gate (validatePackManifest, publish + install) ────────────

const manifestWith = (workspace) => ({
  name: "p",
  agents: [{ id: "a1", name: "A", persona: "x", serving: { protocol: "a2a", ...(workspace ? { workspace } : {}) } }],
});
const wsErrors = (manifest) => validatePackManifest(manifest).filter((e) => String(e.error).includes("workspace"));

await test("manifest: valid workspace declaration passes the gate", () => {
  assert.equal(wsErrors(manifestWith({ enabled: true, quotaMb: 1024 })).length, 0);
  assert.equal(wsErrors(manifestWith({ enabled: true })).length, 0);
  assert.equal(wsErrors(manifestWith(undefined)).length, 0);
});

await test("manifest: quotaMb out of bounds rejected (0 / negative / float / string / over cap)", () => {
  for (const quotaMb of [0, -1, 1.5, "big", 512 * 1024 + 1]) {
    const errs = wsErrors(manifestWith({ enabled: true, quotaMb }));
    assert.equal(errs.length, 1, `quotaMb=${quotaMb}`);
    assert.match(errs[0].error, /quotaMb/);
  }
});

await test("manifest: non-boolean enabled rejected", () => {
  assert.equal(wsErrors(manifestWith({ enabled: "yes" })).length, 1);
});

await test("manifest: runtime configuration cannot be smuggled into workspace (unknown key)", () => {
  const errs = wsErrors(manifestWith({ enabled: true, path: "/etc" }));
  assert.equal(errs.length, 1);
  assert.match(errs[0].error, /unknown key 'path'/);
});

// ── Materialization (compose.materializeAgentHome) ───────────────────────────

await test("materialize: enabled → <home>/data created; UPGRADE (re-materialize) preserves its content", async () => {
  const homeRoot = tmpDir("upgrade");
  const skillPath = "packs/p/analyst-report";
  const entry = {
    path: "/packs/p/analyst",
    name: "分析师",
    metadata: composeDescriptor({ packId: "p", version: 1, manifest: { name: "pack", agents: [] }, agent: agentWithServing({ enabled: true, quotaMb: 2048 }), skillPaths: [skillPath] }),
  };
  const skillContents = { [skillPath]: "---\nname: analyst-report\n---\nbody" };
  const spec = await materializeAgentHome({ homeRoot, agentKey: "packs-p-analyst", entry, skillContents, mcpServers: [] });
  assert.equal(spec.dataDir, path.join(homeRoot, "packs-p-analyst", "data"));
  assert.equal(spec.dataQuotaMb, 2048);
  assert.ok(existsSync(spec.dataDir));
  writeFileSync(path.join(spec.dataDir, "report.db"), Buffer.alloc(64 * 1024, 7));

  // In-place upgrade = materializeAgentHome again over the same home: skills
  // are recomposed (rmSync scope), the data volume must not lose a byte.
  const spec2 = await materializeAgentHome({ homeRoot, agentKey: "packs-p-analyst", entry, skillContents, mcpServers: [] });
  assert.equal(spec2.dataDir, spec.dataDir);
  assert.ok(existsSync(path.join(spec2.dataDir, "report.db")), "data/report.db survived re-materialization");
  assert.ok(existsSync(path.join(spec2.skillsRoot, "analyst-report", "SKILL.md")), "skillsRoot recomposed");
});

await test("materialize: enabled later turned off → existing data dir still never deleted", async () => {
  const homeRoot = tmpDir("off");
  const entry = { path: "/packs/p/analyst", metadata: descriptorOf({ enabled: true }) };
  const spec = await materializeAgentHome({ homeRoot, agentKey: "packs-p-analyst", entry, skillContents: {}, mcpServers: [] });
  writeFileSync(path.join(spec.dataDir, "keep.db"), "x");
  await materializeAgentHome({ homeRoot, agentKey: "packs-p-analyst", entry: { ...entry, metadata: descriptorOf(undefined) }, skillContents: {}, mcpServers: [] });
  assert.ok(existsSync(path.join(homeRoot, "packs-p-analyst", "data", "keep.db")));
});

await test("materialize: no declaration → zero change: no data dir, null spec fields", async () => {
  const homeRoot = tmpDir("legacy");
  const entry = { path: "/packs/p/analyst", metadata: descriptorOf(undefined) };
  const spec = await materializeAgentHome({ homeRoot, agentKey: "packs-p-analyst", entry, skillContents: {}, mcpServers: [] });
  assert.equal(spec.dataDir, null);
  assert.equal(spec.dataQuotaMb, null);
  assert.ok(!existsSync(path.join(homeRoot, "packs-p-analyst", "data")));
  assert.ok(existsSync(spec.home), "legacy composition still materializes");
});

await test("workspaceChildEnv: enabled → AGENT_DATA_DIR (+ AGENT_DATA_QUOTA_MB) alongside scrubbed env", () => {
  const env = workspaceChildEnv({ dataDir: "/h/k/data", dataQuotaMb: 2048 }, { LLM_API_KEY: "x" });
  assert.equal(env.AGENT_DATA_DIR, "/h/k/data");
  assert.equal(env.AGENT_DATA_QUOTA_MB, "2048");
  assert.equal(env.LLM_API_KEY, "x");
  const noQuota = workspaceChildEnv({ dataDir: "/h/k/data", dataQuotaMb: null }, {});
  assert.equal(noQuota.AGENT_DATA_QUOTA_MB, undefined);
  const legacy = { LLM_API_KEY: "x" };
  assert.equal(workspaceChildEnv({ dataDir: null }, legacy), legacy, "legacy env passes through untouched");
});

// ── Sandbox writable root (spawn cwd = data dir) ────────────────────────────
// fix-agent-data-workspace-writes: dsh derives the workspace-write boundary
// from the session cwd (initialize cwd, else the spawn process cwd), so a
// workspace-declared child must be spawned WITH the data dir as cwd. Driven
// through the real spawn path (ChildManager.acquire → #spawnChild → AgentChild)
// with a stub harness client, capturing the launch spec.

const spawnedWith = async (workspace) => {
  const homeRoot = tmpDir("spawn");
  let spawned = null;
  const manager = new ChildManager({
    config: { homeRoot, cwd: "/srv/app", maxChildren: 4, turnTimeoutMs: 180_000 },
    registryClient: {},
    clientFactory: (spec) => (inner) => {
      spawned = { spec, inner };
      return {
        start: () => {},
        initialize: async () => ({ serverInfo: { name: "stub", version: "0" } }),
        subscribe: () => ({ next: () => new Promise(() => {}) }),
        stop: () => {},
      };
    },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const entry = { path: "/packs/p/analyst", name: "分析师", metadata: descriptorOf(workspace) };
  await manager.acquire(entry);
  return { spawned, homeRoot };
};

await test("spawn cwd: declared workspace → child cwd is the data dir (the writable root), AGENT_DATA_DIR rides the env", async () => {
  const { spawned, homeRoot } = await spawnedWith({ enabled: true, quotaMb: 2048 });
  const dataDir = path.join(homeRoot, "packs-p-analyst", "data");
  assert.equal(spawned.spec.dataDir, dataDir);
  assert.equal(spawned.inner.cwd, dataDir, "child spawns/initializes in its data workspace");
  assert.equal(spawned.inner.env.AGENT_DATA_DIR, dataDir);
  assert.ok(existsSync(dataDir));
});

await test("spawn cwd: no declaration → deployment default cwd (legacy launch byte-identical)", async () => {
  const { spawned } = await spawnedWith(undefined);
  assert.equal(spawned.spec.dataDir, null);
  assert.equal(spawned.inner.cwd, "/srv/app");
  assert.equal(spawned.inner.env.AGENT_DATA_DIR, undefined);
});

// ── Quota guardrail (manager.checkWorkspaceQuotas) ──────────────────────────

const managerFor = (homeRoot, entries, { meterFile, log, events }) => {
  const manager = new ChildManager({
    config: { homeRoot, meterFile, externalContextTtlSecs: 86_400 },
    registryClient: {},
    clientFactory: () => null,
    log,
    events,
  });
  manager.entries = entries; // the constructor seeds its own map — inject the fixture's
  return manager;
};

await test("quota guard: over-quota logs once per episode + meter line + fleet event; never deletes", () => {
  const homeRoot = tmpDir("quota");
  const key = "packs-p-analyst";
  mkdirSync(path.join(homeRoot, key, "data"), { recursive: true });
  writeFileSync(path.join(homeRoot, key, "data", "big.db"), Buffer.alloc(1536 * 1024, 1)); // ~1.5MB
  const meterFile = path.join(homeRoot, "meter.jsonl");
  const warnings = [];
  const events = [];
  const manager = managerFor(homeRoot, new Map([[key, { path: "/packs/p/analyst", metadata: { workspace: { enabled: true, quotaMb: 1 } } }]]), {
    meterFile,
    log: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    events: (ev) => events.push(ev),
  });

  manager.checkWorkspaceQuotas();
  assert.equal(warnings.length, 1, "one warn on breach");
  assert.match(warnings[0], /over quota/);
  assert.ok(existsSync(path.join(homeRoot, key, "data", "big.db")), "guardrail only speaks — nothing deleted");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "workspace_quota_exceeded");
  assert.ok(events[0].payload.usage_mb > 1);
  assert.equal(events[0].payload.quota_mb, 1);
  const line = JSON.parse(readFileSync(meterFile, "utf8").trim());
  assert.equal(line.kind, "workspace_quota");
  assert.equal(line.agent, key);

  manager.checkWorkspaceQuotas();
  assert.equal(warnings.length, 1, "same episode → no duplicate meter spam");

  writeFileSync(path.join(homeRoot, key, "data", "big.db"), Buffer.alloc(1024, 1)); // back under
  manager.checkWorkspaceQuotas();
  assert.equal(warnings.length, 1, "under quota → silent");
  writeFileSync(path.join(homeRoot, key, "data", "big.db"), Buffer.alloc(1536 * 1024, 1)); // breach again
  manager.checkWorkspaceQuotas();
  assert.equal(warnings.length, 2, "new episode → alerts anew");
});

await test("quota guard: no quotaMb declared / workspace disabled → skipped entirely", () => {
  const homeRoot = tmpDir("quota-skip");
  const key = "packs-p-analyst";
  mkdirSync(path.join(homeRoot, key, "data"), { recursive: true });
  writeFileSync(path.join(homeRoot, key, "data", "x.db"), Buffer.alloc(2048 * 1024, 1)); // would breach 1MB if checked
  const warnings = [];
  const events = [];
  const manager = managerFor(
    homeRoot,
    new Map([
      [key, { path: "/packs/p/analyst", metadata: { workspace: { enabled: true } } }], // no quota
      ["packs-p-other", { path: "/packs/p/other", metadata: { workspace: { enabled: false, quotaMb: 1 } } }], // disabled
      ["packs-p-plain", { path: "/packs/p/plain", metadata: {} }], // legacy entry
    ]),
    { meterFile: path.join(homeRoot, "meter.jsonl"), log: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} }, events: (ev) => events.push(ev) },
  );
  manager.checkWorkspaceQuotas();
  assert.equal(warnings.length, 0);
  assert.equal(events.length, 0);
});

// ── Shutdown/reap paths never touch data/ (DSH_HOME persistence caliber) ────

await test("external-context reap: stale srv-wx-* session reaped, data/ untouched", () => {
  const homeRoot = tmpDir("reap");
  const key = "packs-p-analyst";
  const stale = path.join(homeRoot, key, "sessions", "srv-wx-old");
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, "t.jsonl"), "{}");
  // #lastTouched takes the newest mtime across the session dir AND one level
  // of children — age the whole subtree past any TTL.
  utimesSync(stale, 0, 0);
  utimesSync(path.join(stale, "t.jsonl"), 0, 0);
  mkdirSync(path.join(homeRoot, key, "data"), { recursive: true });
  writeFileSync(path.join(homeRoot, key, "data", "keep.db"), "durable");
  const manager = managerFor(homeRoot, new Map(), { meterFile: path.join(homeRoot, "meter.jsonl"), log: console, events: null });
  const n = manager.reapExternalContexts();
  assert.equal(n, 1);
  assert.ok(!existsSync(stale), "stale wx session reaped");
  assert.ok(existsSync(path.join(homeRoot, key, "data", "keep.db")), "data/ never touched by reaping");
});

// ── Cleanup + summary ────────────────────────────────────────────────────────

for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
