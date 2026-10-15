// Unit tests for the desktop fleet console lane (add-desktop-fleet-console).
// Covers the desktop-fleet-console spec scenarios:
//   - live proxies the local runner's /health verbatim
//   - a runner that is not running degrades to 503 runner_not_running
//   - catalog proxies the registry directory as a read-only projection
//   - an unconfigured registry degrades to 503 registry_not_configured
//
// Run: node --test scripts/test-desktop-fleet-console.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerWanxingFleetRoutes } from "../server/routes/wanxing-fleet.js";

function appWith({ env = {}, fetchImpl } = {}) {
  const app = express();
  app.use(express.json()); // the real cell app parses JSON bodies globally
  registerWanxingFleetRoutes({ app, env, fleetFetchImpl: fetchImpl });
  return app;
}

const handle = (app, path) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}${path}`)
        .then(async (r) => resolve({ status: r.status, body: await r.json() }))
        .finally(() => server.close());
    });
  });

const post = (app, path, body) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (r) => resolve({ status: r.status, body: await r.json() }))
        .finally(() => server.close());
    });
  });

const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test("live proxies the runner health verbatim", async () => {
  const health = { ok: true, agents: [{ key: "k", path: "/p", port: 8819, state: "resident", version: 3 }], children: 1, queued: 0, budget: 210, budgetMb: 2048 };
  const app = appWith({ fetchImpl: okJson(health) });
  const { status, body } = await handle(app, "/api/wanxing/fleet/live");
  assert.equal(status, 200);
  assert.deepEqual(body, health);
});

test("runner down degrades to 503 runner_not_running", async () => {
  const app = appWith({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  const { status, body } = await handle(app, "/api/wanxing/fleet/live");
  assert.equal(status, 503);
  assert.equal(body.error, "runner_not_running");
});

test("catalog projects the registry directory read-only", async () => {
  const dir = {
    agents: [
      { path: "/a", name: "A", description: "d", version: "2", tags: ["t"], is_enabled: true, supported_protocol: "a2a", metadata: { secret: "x" } },
      { path: "/b", name: "B", is_enabled: false, supported_protocol: "a2a" },
      { path: "/c", name: "C", is_enabled: true, supported_protocol: "mcp" },
    ],
  };
  const app = appWith({
    env: { AGENT_SERVING_REGISTRY_URL: "https://reg.example.test", AGENT_SERVING_REGISTRY_TOKEN: "tok" },
    fetchImpl: okJson(dir),
  });
  const { status, body } = await handle(app, "/api/wanxing/fleet/catalog");
  assert.equal(status, 200);
  assert.deepEqual(body.agents, [{ path: "/a", name: "A", description: "d", version: "2", tags: ["t"] }]);
});

test("unconfigured registry degrades to 503 registry_not_configured", async () => {
  const app = appWith({ env: {}, fetchImpl: okJson({ agents: [] }) });
  const { status, body } = await handle(app, "/api/wanxing/fleet/catalog");
  assert.equal(status, 503);
  assert.equal(body.error, "registry_not_configured");
});

test("registry failure surfaces as 502 registry_unreachable", async () => {
  const app = appWith({
    env: { AGENT_SERVING_REGISTRY_URL: "https://reg.example.test" },
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const { status, body } = await handle(app, "/api/wanxing/fleet/catalog");
  assert.equal(status, 502);
  assert.equal(body.error, "registry_unreachable");
});

// Pairing (slice ③): the redeem call goes out with the seat id from the
// process env; success persists the uplink credentials into settings.json.
test("pair redeems server-side and persists uplink credentials", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wx-pair-"));
  let seen = null;
  const app = appWith({
    env: {
      PLATFORM_DATA_DIR: tmpDir,
      WANXING_PLUGIN_RUNNER_ID: "desktop-ab12cd34",
      WANXING_CONSOLE_URL: "https://wanxing.example.test",
    },
    fetchImpl: async (u, i) => {
      seen = { url: u, body: JSON.parse(i.body) };
      return { ok: true, status: 201, json: async () => ({ runnerId: "desktop-ab12cd34", fleetUrl: "https://wanxing.example.test/api/wanxing/v1/fleet", fleetToken: "wxdesk-abc" }) };
    },
  });
  const { status, body } = await post(app, "/api/wanxing/fleet/pair", { code: "123456", machineName: "书房 Mac" });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(seen.url, "https://wanxing.example.test/api/wanxing/v1/console/devices/redeem");
  assert.equal(seen.body.runnerId, "desktop-ab12cd34");
  assert.equal(seen.body.machineName, "书房 Mac");
  const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, "settings.json"), "utf8"));
  assert.equal(saved.AGENT_RUNNER_FLEET_URL, "https://wanxing.example.test/api/wanxing/v1/fleet");
  assert.equal(saved.AGENT_RUNNER_FLEET_TOKEN, "wxdesk-abc");
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("pair rejects a malformed code without touching the console", async () => {
  const app = appWith({ env: { WANXING_PLUGIN_RUNNER_ID: "desktop-ab12cd34" }, fetchImpl: async () => { throw new Error("must not be called"); } });
  const { status, body } = await post(app, "/api/wanxing/fleet/pair", { code: "abc" });
  assert.equal(status, 400);
  assert.equal(body.error, "bad_code");
});
