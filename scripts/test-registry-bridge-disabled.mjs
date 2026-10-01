// Without MARKET_REGISTRY_URL/REGISTRY_URL the bridge is a no-op: no fetch,
// no timer, empty accessors — the market serves the bundled catalog only
// (registry-backed-market spec: "no registry URL configured").

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.MARKET_REGISTRY_URL;
delete process.env.REGISTRY_URL;
process.env.MARKET_REGISTRY_TOKEN = "should-never-be-used";
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "registry-bridge-off-")));

const bridge = await import("../registry-bridge.js");
const extensionStore = await import("../extension-store.js");

test("no registry URL: no fetch, empty entries, market serves bundled only", async () => {
  let fetchCalled = false;
  const events = [];
  bridge.initRegistryBridge({
    broadcast: (e) => events.push(e),
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await bridge.refreshRegistry();

  assert.equal(fetchCalled, false, "no HTTP call without a URL");
  assert.deepEqual(bridge.getMarketEntries(), { mcpServers: [], skills: [] });
  assert.deepEqual(bridge.getAgentEntries(), []);
  assert.equal(events.filter((e) => e.type === "market_changed").length, 0);

  // Market still serves the bundled catalog.
  fs.writeFileSync(
    path.join(process.cwd(), "market-catalog.json"),
    JSON.stringify({
      mcpServers: [
        {
          name: "fetch",
          displayName: "Fetch",
          description: "d",
          category: "P",
          icon: "globe",
          configTemplate: { command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] },
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(process.cwd(), "market-catalog-skills.json"), JSON.stringify({ skills: [] }));
  extensionStore.clearMarketCatalogCache();
  const catalog = await extensionStore.getMarketCatalog(null);
  assert.equal(catalog.mcpServers.length, 1);
  assert.equal(catalog.skills.length, 0);
});
