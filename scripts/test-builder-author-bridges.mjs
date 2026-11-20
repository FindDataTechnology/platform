#!/usr/bin/env node
// ── Builder bridges tests (add-builder-team-templates) ──────────────────────
//
// Pins the two builder bridges (blueprint-author / pack-author) and the
// narrowness of their MCP children:
//   - blueprint save REFUSES a red draft (nothing lands in the pool) and
//     lands a green one into the SAME pool the Studio's paste channel writes
//   - blueprint validate persists nothing
//   - pack save refuses a red manifest; a green one lands as an EDITABLE
//     draft (entries projected), save is not publish (no packId minting)
//   - the MCP children's toolsets are narrow: no approve/cast/trial/delete on
//     the blueprint side, no publish/pricing/deploy/mint on the pack side
//   - boundary declarations ride the seed personas (spec: 分工互斥)
//
//   node --test scripts/test-builder-author-bridges.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "builder-bridges-"));
process.env.DB_PATH = path.join(tmp, "app.db");
process.env.PLATFORM_DATA_DIR = tmp;

const { initDb } = await import("../db.js");
await initDb();
// blueprint-author bridge RETIRED (add-supply-studio-migration 4.6): the
// creation surface moved to the facet host; the bridge's consumers (agent-
// builder drafting tools) retire with the blueprint endpoints. Pack-author
// bridge stays (unmounted separately per d5784e8e was wanxing ops only).
const { registerPackAuthorRoutes } = await import("../server/pack-author.js");

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function httpApp(mount) {
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  mount(app);
  const server = http.createServer(app);
  server.listen(0);
  return server;
}

const call = (server, method, p, body) =>
  fetch(`http://127.0.0.1:${server.address().port}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// ── fixtures ────────────────────────────────────────────────────────────────

// corpus validates (boundary/dataSources/fleet/agents/monitoring/acceptance).

const PACK_MANIFEST = () => ({
  name: "周报工具包",
  description: "把要点整理成周报的通用工具包",
  tags: ["工具"],
  skills: [{ name: "weekly-digest", description: "周报整理", content: "# 周报整理\n\n按板块归并要点。" }],
  agents: [{ id: "digest", name: "周报员", persona: "你负责周报" }],
});

// ── blueprint-author bridge: RETIRED (add-supply-studio-migration 4.6) ──────
// The bridge rode the blueprint endpoints; both retired with the W2 move to
// the facet host. Its tests die with it (the pack bridge below survives).





// ── pack-author bridge ──────────────────────────────────────────────────────

test("pack bridge: save refuses a red manifest; green lands an editable draft (no publish)", async () => {
  const server = httpApp((app) => registerPackAuthorRoutes(app, { cellUserEmail: "owner@test" }));
  try {
    const bad = PACK_MANIFEST();
    bad.skills[0].name = "bad name!"; // illegal identifier → validator red
    const v = await call(server, "POST", "/api/pack-author/validate", { manifest: bad });
    assert.equal(v.body.ok, false);
    const s = await call(server, "POST", "/api/pack-author/save", { manifest: bad });
    assert.equal(s.status, 422, "a red manifest refuses to land");
    assert.equal((await call(server, "GET", "/api/pack-author/drafts")).body.drafts.length, 0);

    const ok = await call(server, "POST", "/api/pack-author/save", { manifest: PACK_MANIFEST() });
    assert.equal(ok.status, 201);
    assert.match(ok.body.note, /not publish/i, "save is not publish — the red line is stated in the response");
    const drafts = (await call(server, "GET", "/api/pack-author/drafts")).body.drafts;
    const mine = drafts.find((d) => d.id === ok.body.draft.id);
    assert.ok(mine, "the green save landed a draft");
    assert.equal(mine.counts.skills, 1, "manifest projected onto draft entries");
    assert.equal(mine.publishedPackId ?? null, null, "no packId minting on save");
  } finally {
    server.close();
  }
});

test("pack bridge: save updates an existing draft by id", async () => {
  const server = httpApp((app) => registerPackAuthorRoutes(app, { cellUserEmail: "owner@test" }));
  try {
    const first = await call(server, "POST", "/api/pack-author/save", { manifest: PACK_MANIFEST() });
    const v2 = PACK_MANIFEST();
    v2.description = "更新后的描述";
    const second = await call(server, "POST", "/api/pack-author/save", { manifest: v2, draftId: first.body.draft.id });
    assert.equal(second.status, 200, "update, not a second draft");
    const drafts = (await call(server, "GET", "/api/pack-author/drafts")).body.drafts;
    assert.equal(drafts.filter((d) => d.id === first.body.draft.id).length, 1, "updated in place — no draft sprawl");
  } finally {
    server.close();
  }
});

// ── toolset narrowness (the structural no-越权 guarantee) ───────────────────

test("MCP children: toolsets carry no owner-gate verbs", async () => {
  const { readFileSync } = await import("node:fs");
  const bp = readFileSync(path.resolve("server/blueprint-author-mcp.js"), "utf8");
  const pk = readFileSync(path.resolve("server/pack-author-mcp.js"), "utf8");
  for (const verb of ["blueprint_approve", "blueprint_cast", "blueprint_trial", "blueprint_delete", "blueprint_apply"]) {
    assert.equal(new RegExp(`name: "${verb}"`).test(bp), false, `blueprint toolset must not carry ${verb}`);
  }
  for (const verb of ["pack_publish", "pack_price", "pack_deploy", "pack_mint", "pack_delete"]) {
    assert.equal(new RegExp(`name: "${verb}"`).test(pk), false, `pack toolset must not carry ${verb}`);
  }
  // And the bridges expose no such route either (toolset lies are caught; the
  // HTTP surface is the structural guarantee).
  const bpBridge = readFileSync(path.resolve("server/blueprint-author.js"), "utf8");
  for (const route of ['"/approve"', '"/cast"', '"/trial"', '"/delete"']) {
    assert.equal(bpBridge.includes(route), false, `blueprint bridge must not expose ${route}`);
  }
  const pkBridge = readFileSync(path.resolve("server/pack-author.js"), "utf8");
  for (const route of '"/publish" "/subscribe" "/deploy"'.split(" ")) {
    assert.equal(pkBridge.includes(route), false, `pack bridge must not expose ${route}`);
  }
});

test("seed personas carry the mutual-exclusion boundary declarations", async () => {
  const { readFileSync } = await import("node:fs");
  const seeds = {
    architect: JSON.parse(readFileSync(path.resolve("docs/fleet-architect.seed.json"), "utf8")),
    blueprint: JSON.parse(readFileSync(path.resolve("docs/blueprint-architect.seed.json"), "utf8")),
    packAuthor: JSON.parse(readFileSync(path.resolve("docs/pack-author.seed.json"), "utf8")),
  };
  assert.match(seeds.blueprint.agents[0].persona, /团队架构师/, "blueprint persona hands live teams to the architect");
  assert.match(seeds.architect.agents[0].persona, /蓝图/, "architect persona acknowledges the template lane");
  assert.match(seeds.packAuthor.agents[0].persona, /发布/, "pack-author persona points publishing at the editor's gate");
});
