#!/usr/bin/env node
// ── Preset → pack-draft bridge tests (add-preset-to-pack-bridge, tasks 1.2–1.3)
//
// Module-level: conversion semantics against injected sources (all-migratable,
// foreign pack skill flagged naming its owner, server pending variants,
// failed market refresh keeping the last-good snapshot, agent-id suggestion).
// Route-level: the bridge endpoint's gate parity (403 leaves nothing behind),
// 404 on an unknown preset, and the 201 shape over the real draft store.
//
//   node --test scripts/test-preset-pack-bridge.mjs

import assert from "node:assert/strict";
import express from "express";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "preset-bridge-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const db = await import("../db.js");
await db.initDb();
const { composePackDraftFromPreset, suggestAgentId } = await import("../preset-pack-bridge.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const PRESET = {
  id: "user.demo",
  name: "Market Watcher",
  persona: "You watch the market.",
  skills: ["own-skill", "pack-skill", "ghost-skill"],
  mcpServers: ["fd-open-data-mcp", "local-server", "operator-server", "gone-server"],
  tags: ["demo"],
  icon: "📈",
};

const DEPS = {
  skills: [
    { name: "own-skill", description: "mine", content: "# body", enabled: true, originPackId: null },
    { name: "pack-skill", description: "theirs", content: "# body", enabled: true, originPackId: "vertical-finance" },
    { name: "disabled-skill", description: "off", content: "# body", enabled: false, originPackId: null },
  ],
  extensions: [
    { name: "fd-open-data-mcp", type: "mcp", enabled: true, origin: "registry" },
    { name: "local-server", type: "mcp", enabled: true, origin: "manual" },
    { name: "gone-server", type: "mcp", enabled: true, origin: "registry" },
    { name: "disabled-server", type: "mcp", enabled: false, origin: "registry" },
  ],
  operatorNames: ["operator-server"],
  findMarketEntry: async (name) =>
    name === "fd-open-data-mcp" ? { name, origin: "registry" } : null,
  refresh: async () => {},
};

test("all-migratable references inline; foreign and unmatched are flagged", async () => {
  const { draft, report } = await composePackDraftFromPreset(PRESET, DEPS);

  assert.deepEqual(report.inlinedSkills, ["own-skill"]);
  assert.deepEqual(report.mcpServers, ["fd-open-data-mcp"]);
  assert.deepEqual(report.pendingSkills, [
    { name: "pack-skill", reason: "pack", pack: "vertical-finance" },
    { name: "ghost-skill", reason: "unavailable" },
  ]);
  assert.deepEqual(report.pendingServers, [
    { name: "local-server", reason: "local" },
    { name: "operator-server", reason: "operator" },
    { name: "gone-server", reason: "local" },
  ]);

  assert.equal(draft.name, "Market Watcher");
  assert.deepEqual(draft.entries.skills, [{ name: "own-skill", description: "mine", content: "# body" }]);
  assert.deepEqual(draft.entries.mcpServers, [{ registryName: "fd-open-data-mcp" }]);
  const [agent] = draft.entries.agents;
  assert.equal(agent.name, "Market Watcher");
  assert.equal(agent.persona, "You watch the market.");
  assert.deepEqual(agent.serving, { protocol: "a2a" });
  assert.deepEqual(agent.tags, ["demo"]);
  assert.equal(agent.icon, "📈");
  // The suggested id is a legal pack agent id — not under the reserved namespace.
  assert.match(agent.id, /^[A-Za-z0-9._-]{1,64}$/);
  assert.ok(!agent.id.startsWith("user."));
});

test("a failed market refresh keeps the last-good snapshot and tells the truth", async () => {
  const { report } = await composePackDraftFromPreset(PRESET, {
    ...DEPS,
    refresh: async () => {
      throw new Error("registry unreachable");
    },
  });
  // Resolution ran against the stale snapshot exactly as provided.
  assert.deepEqual(report.mcpServers, ["fd-open-data-mcp"]);
  assert.deepEqual(report.pendingServers, [
    { name: "local-server", reason: "local" },
    { name: "operator-server", reason: "operator" },
    { name: "gone-server", reason: "local" },
  ]);
});

test("agent id suggestion slugs ASCII and falls back for non-ASCII names", () => {
  assert.equal(suggestAgentId("Market Watcher!"), "Market-Watcher");
  assert.equal(suggestAgentId("金融分析"), "agent");
  assert.equal(suggestAgentId("---"), "agent");
  // A preset named like the reserved namespace still yields a legal id.
  assert.equal(suggestAgentId("user.x"), "x");
  assert.equal(suggestAgentId("user."), "user");
});

// ── Route (task 1.3) ──────────────────────────────────────────────────────────

async function bridgeApp(overrides = {}) {
  const ctx = {
    app: null,
    db,
    broadcast: () => {},
    isStreaming: false,
    currentPreset: "standard",
    requireMcpManage: (_req, res) => {
      res.status(403).json({ error: "Admin group or cell ownership required" });
      return false;
    },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  ctx.app = app;
  const { registerCustomPresetRoutes } = await import("../server/routes/custom-presets.js");
  registerCustomPresetRoutes(ctx);
  return { app, ctx };
}

function request(app, { method = "GET", path: p, body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1", port, path: p, method,
          headers: payload
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let out = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { out += c; });
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

test("route: gate rejection leaves nothing behind", async () => {
  const preset = db.createUserPreset({ name: "Gated", persona: "p", skills: [], mcpServers: [] });
  const { app } = await bridgeApp();
  const res = await request(app, { method: "POST", path: `/api/agent/presets/${preset.id}/pack-draft` });
  assert.equal(res.status, 403);
  assert.equal(db.listPackDrafts().length, 0);
});

test("route: unknown preset is 404", async () => {
  const { app } = await bridgeApp({ requireMcpManage: () => true });
  const res = await request(app, { method: "POST", path: "/api/agent/presets/user.nope/pack-draft" });
  assert.equal(res.status, 404);
});

test("route: conversion creates an ordinary draft and returns the report", async () => {
  const preset = db.createUserPreset({
    name: "Bridged Role",
    persona: "persona text",
    skills: ["bridge-own"],
    mcpServers: [],
    tags: ["t"],
  });
  db.addCustomSkill({ name: "bridge-own", description: "d", content: "# c", enabled: true });

  const { app } = await bridgeApp({ requireMcpManage: () => true });
  const res = await request(app, { method: "POST", path: `/api/agent/presets/${preset.id}/pack-draft` });
  assert.equal(res.status, 201);
  assert.equal(res.body.draft.name, "Bridged Role");
  assert.deepEqual(res.body.draft.entries.agents[0].serving, { protocol: "a2a" });
  assert.ok(Array.isArray(res.body.report.inlinedSkills));
  // The stored draft is discoverable through the ordinary drafts list.
  assert.ok(db.listPackDrafts().some((d) => d.id === res.body.draft.id));
});
