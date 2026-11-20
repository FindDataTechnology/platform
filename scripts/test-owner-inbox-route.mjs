// HTTP face of the owner inbox (openspec: owner-inbox 1.5 / 1.6).
//
// The route is thin, but two things here are contractual and were called out in
// the tasks:
//   • a lane that fails degrades ALONE and the request still answers 200 — one
//     broken store must not blank the surface;
//   • `/api/config` advertises `capabilities.ownerInbox` as a boolean, which is
//     how the three clients tell a new instance from an old one.
//
// Run: node --test scripts/test-owner-inbox-route.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "owner-inbox-route-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.CRON_STORAGE_PATH = tmpRoot;
process.env.DSH_HOME = path.join(tmpRoot, "dsh");
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const { initDb } = await import("../db.js");
const { createFleetDatabase, setFleetDatabase } = await import("../server/routes/fleets-db.js");
const { registerOwnerInboxRoutes } = await import("../server/routes/owner-inbox.js");

await initDb();
setFleetDatabase(createFleetDatabase({ file: path.join(tmpRoot, "fleets.db") }));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

async function startServer({ authEnabled = false, userHeader = null } = {}) {
  const app = express();
  app.use(express.json());
  if (userHeader) {
    app.use((req, _res, next) => {
      req.user = { email: userHeader, groups: [] };
      next();
    });
  }
  registerOwnerInboxRoutes(app, { app, authEnabled, cellUserEmail: "owner@test" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));
  return { server, get };
}

test("GET /api/inbox answers 200 with the lane envelope and counts", async () => {
  const { server, get } = await startServer();
  try {
    const r = await get("/api/inbox");
    assert.equal(r.status, 200);
    assert.equal(r.body.v, 1);
    assert.ok(Array.isArray(r.body.lanes) && r.body.lanes.length > 0);
    assert.equal(typeof r.body.counts.waiting, "number");
    assert.equal(typeof r.body.counts.inflight, "number");
    assert.equal(r.headers.get("cache-control"), "no-store", "a stale inbox is a lie about today");
    // Every lane declares its status so a client can tell an empty lane from a
    // broken one.
    for (const lane of r.body.lanes) {
      assert.ok(["ok", "error"].includes(lane.status));
      assert.ok(Array.isArray(lane.items));
    }
  } finally {
    server.close();
  }
});

test("?lanes= narrows the fan-out to the named lanes only", async () => {
  const { server, get } = await startServer();
  try {
    const r = await get("/api/inbox?lanes=skill-candidate");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.lanes.map((l) => l.id), ["skill-candidate"]);
  } finally {
    server.close();
  }
});

test("GET /api/inbox/lanes lists the lane roster as metadata", async () => {
  const { server, get } = await startServer();
  try {
    const r = await get("/api/inbox/lanes");
    assert.equal(r.status, 200);
    for (const id of ["fleet-decision", "input-request", "skill-candidate", "persona-candidate"]) {
      assert.ok(r.body.lanes.includes(id), `roster names ${id}`);
    }
  } finally {
    server.close();
  }
});

test("with auth on and no identity, the route refuses", async () => {
  const { server, get } = await startServer({ authEnabled: true });
  try {
    const r = await get("/api/inbox");
    assert.equal(r.status, 401);
  } finally {
    server.close();
  }
});

test("/api/config advertises the inbox capability as a boolean", async () => {
  // Read the source of truth rather than boot the whole server: the field is a
  // literal in the config handler, and this pins both its presence and shape.
  const src = fs.readFileSync(new URL("../server/routes/misc.js", import.meta.url), "utf8");
  assert.match(src, /capabilities:\s*\{[^}]*ownerInbox:\s*true/);
});
