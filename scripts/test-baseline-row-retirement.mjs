// The operator baseline (mcp.json) is the seed source for extension MCP rows,
// and the market catalog is the endpoint authority for market-installed rows
// (fix-trading-pack-composition 3.2/5.1):
//   ① retireSeededRowsNotInBaseline removes rows the SEED owns (source
//      "startup", origin "user") once the baseline stops declaring them —
//      never user-created rows, never bundled rows;
//   ② syncMarketRowUrls rewrites a market-installed row's URL when the
//      catalog entry moved, preserving the credential ref and enable state.
// Run: node --test scripts/test-baseline-row-retirement.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retire-")), "app.db");

const db = await import("../db.js");
const extensionStore = await import("../extension-store.js");
await db.initDb();

test("① retired seeded rows: removed when the baseline stops declaring them", () => {
  extensionStore.seedMcpServer({ name: "stay-a", config: { url: "https://a.example/mcp" } });
  extensionStore.seedMcpServer({ name: "stay-b", config: { url: "https://b.example/mcp" } });
  extensionStore.seedMcpServer({
    name: "paper-trading",
    config: { url: "https://mcp.example/fd-paper-trading/mcp", credentialRef: "paper-trading" },
  });
  const removed = extensionStore.retireSeededRowsNotInBaseline(["stay-a", "stay-b"]);
  assert.deepEqual(removed, ["paper-trading"]);
  assert.equal(extensionStore.getMcpServer("paper-trading"), null);
  assert.ok(extensionStore.getMcpServer("stay-a"));
  assert.ok(extensionStore.getMcpServer("stay-b"));
});

test("② user-created and bundled rows are never retired", () => {
  extensionStore.seedMcpServer({ name: "keep-x", config: { url: "https://x.example/mcp" } });
  extensionStore.addMcpServer({ name: "user-row", config: { url: "https://u.example/mcp" } });
  extensionStore.seedMcpServer({ name: "bundled-row", config: { command: "node", args: ["x.js"] }, origin: "bundled" });
  const removed = extensionStore.retireSeededRowsNotInBaseline(["keep-x"]);
  assert.deepEqual(removed.sort(), ["stay-a", "stay-b"], "only seed-owned rows outside the baseline go");
  assert.ok(extensionStore.getMcpServer("keep-x"));
  assert.ok(extensionStore.getMcpServer("user-row"));
  assert.ok(extensionStore.getMcpServer("bundled-row"));
});

test("③ market row follows the catalog endpoint, credential ref preserved", () => {
  // Market installs go through addMcpServer (source "user"), not the baseline seed.
  extensionStore.addMcpServer({
    name: "fd-paper-trading",
    config: { url: "https://mcp.example/fd-paper-trading/mcp", credentialRef: "paper-trading" },
  });
  const moved = extensionStore.syncMarketRowUrls([
    { name: "fd-paper-trading", configTemplate: { url: "https://paper.example/fd-paper-trading/mcp/" } },
  ]);
  assert.equal(moved.length, 1);
  const row = extensionStore.getMcpServer("fd-paper-trading");
  assert.equal(row.config.url, "https://paper.example/fd-paper-trading/mcp/");
  assert.equal(row.config.credentialRef, "paper-trading");
  assert.equal(row.enabled, true);
});

test("④ rows without the market-install shape or disabled are untouched", () => {
  extensionStore.addMcpServer({ name: "hand-built", config: { url: "https://hand.example/mcp" } });
  extensionStore.seedMcpServer({
    name: "disabled-row",
    config: { url: "https://old.example/mcp", credentialRef: "r" },
    enabled: false,
  });
  const moved = extensionStore.syncMarketRowUrls([
    { name: "hand-built", configTemplate: { url: "https://market.example/hand/mcp" } },
    { name: "disabled-row", configTemplate: { url: "https://market.example/disabled/mcp" } },
    { name: "unknown-row", configTemplate: { url: "https://market.example/unknown/mcp" } },
  ]);
  assert.deepEqual(moved, [], "no credentialRef / disabled / unmatched rows never move");
  assert.equal(extensionStore.getMcpServer("hand-built").config.url, "https://hand.example/mcp");
  assert.equal(extensionStore.getMcpServer("disabled-row").config.url, "https://old.example/mcp");
});
