// add-knowledge-memory-surface 2.1 (mount-chain regression): the library MCP
// server declared in mcp.json is seeded into the extensions store at boot, so
// EVERY dsh turn in the cell — chat, fleet execution, summoned room members —
// resolves it in its tool roster through the same deployment-level patch.
// The spike (design.md「Spike 结论」) proved the lanes share one mount; this
// pins the two ends of that chain: the committed mcp.example.json declaration
// (mcp.json is gitignored — §15.113: production truth is the configmap) and the seeded row.
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { readFileSync } from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "km-mount-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");

test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

test("mcp.example.json declares the library server (stdio, library-mcp.js)", () => {
  const cfg = JSON.parse(readFileSync(new URL("../mcp.example.json", import.meta.url), "utf8"));
  const lib = cfg.mcpServers?.library;
  assert.ok(lib, "mcp.example.json registers `library` (the committed template; production truth = the platform-mcp-config configmap, §15.113)" );
  assert.ok(Array.isArray(lib.args) && lib.args.some((a) => String(a).includes("library-mcp")), "points at library-mcp.js");
});

test("boot seeding plants library into the deployment MCP roster", async () => {
  const db = await import("../db.js");
  await db.initDb();
  const extensionStore = await import("../extension-store.js");
  const cfg = JSON.parse(readFileSync(new URL("../mcp.example.json", import.meta.url), "utf8"));
  // Exactly what server.js#seedStartupMcpConfigs does with mcp.json entries.
  extensionStore.seedMcpServer({ name: "library", config: cfg.mcpServers.library, enabled: true });
  const row = extensionStore.getMcpServer("library");
  assert.ok(row, "library is in the deployment MCP roster");
  assert.equal(row.enabled, true);
  assert.equal(row.origin, "user");
});
