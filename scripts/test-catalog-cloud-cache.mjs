// The durable last-good cloud catalog (production 2026-10-20): a cell that
// boots while AGENTS_CONFIG_URL is unreachable must still compose the cloud
// agents it has EVER fetched — otherwise a deployment whose preset is one
// (pack-contract-reviewer) fails every prompt until the fetch recovers.
//
// The scenario is the live one: an unreachable cloud URL at boot, a cache file
// left by a previous successful fetch, and the assertion that the merged
// catalog (and the preset roster generated from it) still carries the agent.
// The second test runs a fresh module instance against a local, reachable
// "cloud" and asserts the cache is (re)written on success — in a child
// process, because CLOUD_URL binds at import.
//
// Run: node --test scripts/test-catalog-cloud-cache.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-cloud-cache-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
process.env.DSH_HOME = path.join(tmpRoot, "dsh-home");
process.env.MCP_CONFIG_PATH = path.join(tmpRoot, "mcp.json");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
process.env.CATALOG_REFRESH_SECS = "0";
// Nothing listens on port 9 (discard): every fetch fails — the outage.
process.env.AGENTS_CONFIG_URL = "http://127.0.0.1:9/outage";
fs.mkdirSync(process.env.PLATFORM_DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.PLATFORM_DATA_DIR, "data"), { recursive: true });
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });
fs.writeFileSync(process.env.MCP_CONFIG_PATH, JSON.stringify({ mcpServers: {} }));

// catalog.js binds its agents.json at import; the repo's own must never load.
const cwdFixture = path.join(tmpRoot, "cwd");
fs.mkdirSync(cwdFixture, { recursive: true });
fs.writeFileSync(path.join(cwdFixture, "agents.json"), JSON.stringify({ agents: [], apps: [] }));
process.chdir(cwdFixture);

const CLOUD_AGENT = {
  id: "pack-outage-reviewer",
  type: "agent-remote",
  mode: "chat",
  name: "Outage Reviewer",
  description: "cached cloud agent",
  baseUrl: "https://example.test/v1",
  model: "some-model",
};
const CACHE_PATH = path.join(process.env.PLATFORM_DATA_DIR, "data", "catalog-cloud-last-good.json");

// What a previous, successful fetch left behind (the shape persistCloudCache
// writes: the VALIDATED document).
fs.writeFileSync(CACHE_PATH, JSON.stringify({ agents: [CLOUD_AGENT], apps: [] }));

const db = await import("../db.js");
const catalog = await import("../catalog.js");
const dshProfile = await import("../dsh-profile.js");

await db.initDb();

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("a cell booting during a cloud outage still serves the cached cloud agents", async () => {
  await catalog.initCatalog({ broadcast: () => {}, onChange: () => {} });
  // Let the doomed initial fetch fail; the cached doc must already be serving.
  await new Promise((r) => setTimeout(r, 300));

  const entries = catalog.getChatAgentEntries();
  const cached = entries.find((e) => e.id === "pack-outage-reviewer");
  assert.ok(cached, `cached cloud agent must be in the merged catalog; got ${entries.map((e) => e.id).join(",")}`);

  // The generated persona preset exists for it → a deployment preset pointing
  // at this id stays composable (the "Unknown agent preset" failure mode).
  const result = dshProfile.writeCatalogAgentPresets(entries);
  assert.ok(result.ids.includes("pack-outage-reviewer"), `roster must generate its preset; got ${result.ids.join(",")}`);
  assert.equal(dshProfile.hasCatalogAgentPreset("pack-outage-reviewer"), true);

  // A failed fetch must not clobber the cache.
  const onDisk = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  assert.deepEqual(onDisk, { agents: [CLOUD_AGENT], apps: [] });
});

test("a successful fetch writes the cache; a fresh boot seeds from it", async () => {
  const { createServer } = await import("node:http");
  const served = { agents: [{ ...CLOUD_AGENT, id: "pack-live-agent", name: "Live" }], apps: [] };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(served));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/agents.json`;
  const cachePath = path.join(tmpRoot, "child-data");
  fs.rmSync(cachePath, { recursive: true, force: true });
  fs.mkdirSync(path.join(cachePath, "data"), { recursive: true });

  // Child process: fresh module instances, reachable "cloud", empty cache.
const { initCatalogPath } = { initCatalogPath: new URL("../catalog.js", import.meta.url).pathname };
const childScript = `
process.env.DB_PATH = ${JSON.stringify(path.join(tmpRoot, "child.db"))};
process.env.PLATFORM_DATA_DIR = ${JSON.stringify(cachePath)};
process.env.DSH_HOME = ${JSON.stringify(path.join(tmpRoot, "dsh-home"))};
process.env.MCP_CONFIG_PATH = ${JSON.stringify(process.env.MCP_CONFIG_PATH)};
process.env.SESSIONS_STORE_DIR = ${JSON.stringify(path.join(tmpRoot, "sessions-store"))};
process.env.CATALOG_REFRESH_SECS = "0";
process.env.AGENTS_CONFIG_URL = ${JSON.stringify(url)};
const { initCatalog, getChatAgentEntries } = await import(${JSON.stringify(initCatalogPath)});
await initCatalog({ broadcast: () => {}, onChange: () => {} });
await new Promise((r) => setTimeout(r, 400));
console.log(JSON.stringify({ entries: getChatAgentEntries().map((e) => e.id) }));
`;
  const { execFile } = await import("node:child_process");
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", childScript], { cwd: cwdFixture }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      resolve(stdout);
    });
  });
  server.close();
  const { entries } = JSON.parse(out);
  assert.ok(entries.includes("pack-live-agent"), `live cloud agent must be served; got ${entries.join(",")}`);
  const written = JSON.parse(fs.readFileSync(path.join(cachePath, "data", "catalog-cloud-last-good.json"), "utf8"));
  assert.deepEqual(
    written.agents.map((a) => a.id),
    ["pack-live-agent"],
    "a successful fetch persists the validated cloud doc",
  );
});
