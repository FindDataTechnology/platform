// Route tests — team console authority (change add-pack-console, task 3.3/6.1).
// Run: node --test scripts/test-pack-console-route.mjs
//
// What is pinned here is the AUTHORITY boundary, not the block content:
//   - the platform surface is owner (or admin) only;
//   - the share surface is anonymous but answers 404 for anything not
//     published — an unpublished fleet is indistinguishable from a missing one,
//     so a slug guess cannot confirm that a team exists;
//   - a fleet with no template lineage has no console and still answers 200
//     with an honest empty block list (an empty console is not an error).

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-route-"));
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const cron = await import("../cron.js");
const chatHistory = await import("../chat-history.js");
const { initDb, upsertInstalledPack } = await import("../db.js");
const engine = await import("../task-engine.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { createFleetRoutes } = await import("../server/routes/fleets.js");

await initDb();
await chatHistory.initChatHistory();
fs.writeFileSync(path.join(tmpRoot, "jobs.json"), "[]");
await engine.initTaskEngine({ broadcast: () => {}, runTurn: async () => ({ ok: true }), isBusy: () => false });

after(() => {
  cron.shutdown?.();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let db;
beforeEach(() => {
  db = createFleetDatabase({
    file: path.join(tmpRoot, `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`),
  });
  setFleetDatabase(db);
});

async function startServer(ctx) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const u = req.headers["x-test-user"];
    if (u) req.user = { email: u, groups: [] };
    next();
  });
  createFleetRoutes(app, ctx);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    // method-aware: the publication tests POST, and a GET-shaped helper would
    // silently turn them into 404s (caught the first time these tests ran).
    call: (p, headers = {}, method = "GET", body) =>
      fetch(`${base}${p}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
  };
}

function scene({ ownerEmail = "owner@test", consoleSlug = null, name = "电商团队", id = "fleet_console" } = {}) {
  const fleet = db.createFleet({ id, name, ownerEmail, state: "active" });
  if (consoleSlug) db.updateFleet(fleet.id, { consoleSlug, consolePublishedAt: Date.now() });
  return db.getFleet(fleet.id);
}

// Install a pack carrying a console declaration so publish/serve have a
// section to work with. The installer API is the same one the routes use.
function installConsolePack(packId = "console-pack") {
  // The installed manifest is what the console route reads. Writing the row
  // directly is the same state a completed install leaves behind; the full
  // install pipeline is covered by its own suite.
  upsertInstalledPack({
    packId,
    name: "Console Pack",
    version: "1.0.0",
    manifest: {
      name: "Console Pack",
      mcpServers: [{ name: "filesystem", registryName: "filesystem" }],
      console: { blocks: [{ block: "team", surfaces: ["platform", "share"] }] },
    },
    source: "test",
  });
  return packId;
}

test("owner reads the console; a fleet without a template answers an empty console", async () => {
  scene();
  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    const res = await call("/api/fleets/fleet_console/console");
    assert.equal(res.status, 200);
    assert.equal(res.body.v, 1);
    assert.equal(res.body.surface, "platform");
    assert.deepEqual(res.body.blocks, [], "no template ⇒ no declared blocks, not an error");
  } finally {
    server.close();
  }
});

test("auth-on without an identity is 401", async () => {
  scene();
  const { server, call } = await startServer({ authEnabled: true });
  try {
    const res = await call("/api/fleets/fleet_console/console");
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test("another owner is 403 (platform surface is not shared)", async () => {
  scene({ ownerEmail: "owner@test" });
  const { server, call } = await startServer({ authEnabled: true });
  try {
    const res = await call("/api/fleets/fleet_console/console", { "x-test-user": "stranger@test" });
    assert.equal(res.status, 403);
  } finally {
    server.close();
  }
});

test("an admin may read another owner's console", async () => {
  scene({ ownerEmail: "owner@test" });
  const { server, call } = await startServer({ authEnabled: true, isAdminUser: (u) => u.email === "admin@test" });
  try {
    const res = await call("/api/fleets/fleet_console/console", { "x-test-user": "admin@test" });
    assert.equal(res.status, 200);
  } finally {
    server.close();
  }
});

test("an unpublished fleet answers 404 on the share surface, even with a slug", async () => {
  scene();
  const { server, call } = await startServer({ authEnabled: true });
  try {
    const guessed = await call("/api/fleets/fleet_console/console?surface=share&slug=ec-team");
    assert.equal(guessed.status, 404);
    assert.equal(guessed.body.error, "Not published");
    // No slug at all is the same answer — a probe learns nothing either way.
    const bare = await call("/api/fleets/fleet_console/console?surface=share");
    assert.equal(bare.status, 404);
  } finally {
    server.close();
  }
});

test("an unknown fleet is 404 on both surfaces", async () => {
  scene();
  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    assert.equal((await call("/api/fleets/nope/console")).status, 404);
    assert.equal((await call("/api/fleets/nope/console?surface=share")).status, 404);
  } finally {
    server.close();
  }
});

// ── publication (task 6.1) ───────────────────────────────────────────────────

test("publishing derives a readable slug and makes the share surface serve it", async () => {
  const packId = installConsolePack();
  scene({ id: "fleet_console", name: "电商团队" });
  db.updateFleet("fleet_console", { sourceTemplate: { packId, version: "1.0.0" } });

  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    const published = await call("/api/fleets/fleet_console/console/publish", {}, "POST");
    assert.equal(published.status, 200);
    // CJK is kept: a Chinese-first product must be able to read its own link.
    assert.equal(published.body.slug, "电商团队");

    const share = await call(`/api/fleets/fleet_console/console?surface=share&slug=${encodeURIComponent("电商团队")}`);
    assert.equal(share.status, 200);
    assert.equal(share.body.surface, "share");
    assert.deepEqual(share.body.blocks.map((b) => b.block), ["team"]);

    // The slug address works without ever knowing the fleet id.
    const bySlug = await call(`/api/fleets/by-slug/${encodeURIComponent("电商团队")}/console?surface=share&slug=${encodeURIComponent("电商团队")}`);
    assert.equal(bySlug.status, 200);
  } finally {
    server.close();
  }
});

test("a wrong slug on a published fleet is 404, not the console", async () => {
  const packId = installConsolePack();
  scene({ id: "fleet_console", name: "电商团队" });
  db.updateFleet("fleet_console", { sourceTemplate: { packId, version: "1.0.0" } });
  db.updateFleet("fleet_console", { consoleSlug: "ec-team", consolePublishedAt: Date.now() });

  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    const wrong = await call("/api/fleets/fleet_console/console?surface=share&slug=not-the-slug");
    assert.equal(wrong.status, 404);
    const right = await call("/api/fleets/fleet_console/console?surface=share&slug=ec-team");
    assert.equal(right.status, 200);
  } finally {
    server.close();
  }
});

test("publishing a team with no console declaration is refused", async () => {
  scene({ id: "fleet_plain", name: "无控制台团队" });
  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    const res = await call("/api/fleets/fleet_plain/console/publish", {}, "POST");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /declares no console/);
  } finally {
    server.close();
  }
});

test("two teams with the same name get distinct addresses", async () => {
  const packId = installConsolePack();
  scene({ id: "fleet_a", name: "内容组" });
  scene({ id: "fleet_b", name: "内容组" });
  db.updateFleet("fleet_a", { sourceTemplate: { packId, version: "1.0.0" } });
  db.updateFleet("fleet_b", { sourceTemplate: { packId, version: "1.0.0" } });

  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    const a = await call("/api/fleets/fleet_a/console/publish", {}, "POST");
    const b = await call("/api/fleets/fleet_b/console/publish", {}, "POST");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.slug, b.body.slug, "same-name teams must not share one address");
  } finally {
    server.close();
  }
});

test("unpublishing closes the share surface again", async () => {
  const packId = installConsolePack();
  scene({ id: "fleet_console", name: "电商团队" });
  db.updateFleet("fleet_console", { sourceTemplate: { packId, version: "1.0.0" } });

  const { server, call } = await startServer({ authEnabled: false, cellUserEmail: "owner@test" });
  try {
    const published = await call("/api/fleets/fleet_console/console/publish", {}, "POST");
    const slug = published.body.slug;
    assert.equal((await call(`/api/fleets/fleet_console/console?surface=share&slug=${encodeURIComponent(slug)}`)).status, 200);

    const off = await call("/api/fleets/fleet_console/console/unpublish", {}, "POST");
    assert.equal(off.status, 200);
    assert.equal(off.body.slug, null);
    const after = await call(`/api/fleets/fleet_console/console?surface=share&slug=${encodeURIComponent(slug)}`);
    assert.equal(after.status, 404, "an unpublished console stops answering immediately");
  } finally {
    server.close();
  }
});
