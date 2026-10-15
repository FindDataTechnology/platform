// Unit tests for the desktop Wanxing fleet plugin (add-desktop-fleet-runner).
// Covers the desktop-fleet-runner / desktop-supervisor spec scenarios:
//   - default install keeps the runner descriptor disabled (no spawn)
//   - enabling it injects the full desktop env (loopback host, pod mode,
//     seat fleet id, sentinel default id, bundled dsh entry)
//   - config.host defaults to 0.0.0.0 (cloud byte-identical) and honors the
//     injected loopback value
//   - the first-run seat id seed is minted once and stays stable
//   - sharding: the sentinel default id keeps untagged entries off the seat
//
// Run: node --test scripts/test-desktop-fleet-runner.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDescriptors } from "../supervisor/descriptors.js";
import { runFirstRun } from "../bootstrap/first-run.js";
import { createRegistryClient } from "../agent-runner/registry.js";

// The real repo root: the dsh dependency entry exists here, so the bundled
// argv assertions exercise the production branch.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function descriptorsFor(agentEnv = {}) {
  return getDescriptors({
    serverPort: 34567,
    projectRoot: REPO,
    nodeBin: "/app/node",
    dataDir: "/userdata",
    agentEnv,
  });
}

test("default install: runner descriptor present but disabled", () => {
  const list = descriptorsFor({});
  const runner = list.find((d) => d.id === "agent-runner-js");
  assert.ok(runner, "descriptor exists (preinstalled)");
  assert.equal(runner.enabled, false);
  assert.equal(runner.optional, true);
});

test("enabled plugin: descriptor starts with full desktop env", () => {
  const list = descriptorsFor({
    WANXING_PLUGIN_ENABLED: "1",
    WANXING_PLUGIN_RUNNER_ID: "desktop-abcd1234",
    AGENT_SERVING_REGISTRY_URL: "https://registry.example.test",
    AGENT_SERVING_REGISTRY_TOKEN: "tok",
  });
  const runner = list.find((d) => d.id === "agent-runner-js");
  assert.equal(runner.enabled, true);
  assert.equal(runner.healthPath, "/health");
  assert.match(runner.url, /^http:\/\/127\.0\.0\.1:8790$/);
  const env = runner.start.env;
  assert.equal(env.AGENT_RUNNER_HOST, "127.0.0.1");
  assert.equal(env.AGENT_RUNNER_POD_MODE, "1");
  assert.equal(env.AGENT_RUNNER_FLEET_ID, "desktop-abcd1234");
  assert.equal(env.AGENT_RUNNER_DEFAULT_ID, "cloud-default");
  assert.equal(env.AGENT_SERVING_REGISTRY_URL, "https://registry.example.test");
  assert.equal(env.AGENT_SERVING_REGISTRY_TOKEN, "tok");
  assert.equal(env.AGENT_RUNNER_HOME, path.join("/userdata", "wanxing-runner"));
  // dsh runs as the bundled node + dependency-tree entry (never a .bin shim)
  assert.equal(env.DSH_BIN, "/app/node");
  assert.deepEqual(JSON.parse(env.DSH_BIN_ARGS), [
    path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  ]);
});

test("missing seat id falls back to an ephemeral id, never the cloud default", () => {
  const list = descriptorsFor({ WANXING_PLUGIN_ENABLED: "1" });
  const env = list.find((d) => d.id === "agent-runner-js").start.env;
  assert.match(env.AGENT_RUNNER_FLEET_ID, /^desktop-ephemeral-/);
  assert.notEqual(env.AGENT_RUNNER_FLEET_ID, "runner-1");
});

test("runner config host: cloud default 0.0.0.0, desktop injection honored", async () => {
  const { loadConfig } = await import("../agent-runner/config.js");
  assert.equal(loadConfig({}).host, "0.0.0.0");
  assert.equal(loadConfig({ AGENT_RUNNER_HOST: "127.0.0.1" }).host, "127.0.0.1");
  // dshBinArgs parses a JSON argv array; junk is refused at config load.
  assert.deepEqual(loadConfig({ DSH_BIN_ARGS: JSON.stringify(["/x/dsh/lib/bin.js"]) }).dshBinArgs, ["/x/dsh/lib/bin.js"]);
  assert.throws(() => loadConfig({ DSH_BIN_ARGS: "not-json" }));
});

test("first-run seeds a stable seat id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-seat-"));
  const a = runFirstRun({ userDataDir: dir, defaultSettings: {} });
  assert.match(a.WANXING_PLUGIN_RUNNER_ID, /^desktop-[0-9a-f]{8}$/);
  // Idempotent: a second pass (even with different defaults) keeps the id.
  const b = runFirstRun({ userDataDir: dir, defaultSettings: { WANXING_PLUGIN_ENABLED: "1" } });
  assert.equal(b.WANXING_PLUGIN_RUNNER_ID, a.WANXING_PLUGIN_RUNNER_ID);
  // The settings file on disk carries the same id.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
  assert.equal(onDisk.WANXING_PLUGIN_RUNNER_ID, a.WANXING_PLUGIN_RUNNER_ID);
});

test("sharding: sentinel default id keeps untagged entries off the seat", async () => {
  const registryRows = [
    { is_enabled: true, supported_protocol: "a2a", metadata: { packId: "p1", runner_id: "desktop-abcd1234" }, path: "/a" },
    { is_enabled: true, supported_protocol: "a2a", metadata: { packId: "p2" }, path: "/b" },
    { is_enabled: true, supported_protocol: "a2a", metadata: { packId: "p3", runner_id: "runner-1" }, path: "/c" },
  ];
  const client = createRegistryClient({
    registryUrl: "https://registry.example.test",
    runnerId: "desktop-abcd1234",
    defaultRunnerId: "cloud-default",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ agents: registryRows }) }),
  });
  const served = await client.listServedAgents();
  assert.deepEqual(served.map((a) => a.path), ["/a"]);
});
