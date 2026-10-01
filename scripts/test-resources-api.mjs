// Route-level tests for the resource library REST surface (openspec:
// add-resource-library, task 4.3).
//
// The service's own behavior is covered by test-resources-store.mjs /
// test-resources-capture.mjs; this file asserts the HTTP contract: status
// codes, response shapes, the save → list round trip, and the thin broadcast
// the clients reconcile against. The auth gate is verified behaviorally in
// test-cell-containment.mjs (a real cell with AUTH_MODE=forward_auth), since
// the exemption list is not exported and a source-level assertion would prove
// nothing about the running gate.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = await mkdtemp(path.join(tmpdir(), "resources-api-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");

const express = (await import("express")).default;
const db = await import("../db.js");
const resources = await import("../resources.js");
const { registerResourceRoutes } = await import("../server/routes/resources.js");

await db.initDb();
assert.ok(db.isDbReady());

const WORKSPACE = path.join(tmpRoot, "workspace");
await fsp.mkdir(WORKSPACE, { recursive: true });

const events = [];
const app = express();
app.use(express.json());
await resources.initStore({ broadcast: (msg) => events.push(msg) });
registerResourceRoutes({ app, db, dshBridge: { getCwd: () => WORKSPACE } });
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

function call(method, route, body) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: route,
          method,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              /* non-JSON body (not expected here) */
            }
            resolve({ status: res.statusCode, json, text });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

test("an empty library lists as a well-formed page", async () => {
  const res = await call("GET", "/api/resources");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.items, []);
  assert.equal(res.json.total, 0);
  assert.equal(res.json.limit, 50);
  assert.equal(res.json.offset, 0);
});

test("save → list round trip, with the created broadcast", async () => {
  await fsp.writeFile(path.join(WORKSPACE, "report.xlsx"), "fake xlsx bytes");
  const save = await call("POST", "/api/resources", { path: "report.xlsx" });
  assert.equal(save.status, 200);
  assert.equal(save.json.inserted, true);
  assert.equal(save.json.resource.type, "file");
  assert.equal(save.json.resource.title, "report.xlsx");
  assert.match(save.json.resource.filePath, /^[0-9a-f-]{36}\/report\.xlsx$/);

  const list = await call("GET", "/api/resources?type=file");
  assert.equal(list.json.total, 1);
  assert.equal(list.json.items[0].id, save.json.resource.id);
  assert.equal(list.json.items[0].fileSize, 15);

  assert.deepEqual(
    events.map((e) => e.action),
    ["created"],
  );
  assert.equal(events[0].type, "resources_changed");
  assert.equal(events[0].resourceType, "file");
});

test("a repeat save reports already-in-library instead of duplicating", async () => {
  await fsp.writeFile(path.join(WORKSPACE, "copy.xlsx"), "fake xlsx bytes");
  const again = await call("POST", "/api/resources", { path: "copy.xlsx" });
  assert.equal(again.status, 200);
  assert.equal(again.json.inserted, false);
  assert.equal(again.json.resource.title, "report.xlsx", "the original row is returned");
  assert.equal((await call("GET", "/api/resources")).json.total, 1);
});

test("bad saves are refused with a machine-readable code", async () => {
  const missing = await call("POST", "/api/resources", { path: "nope.xlsx" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "file_not_found");

  const traversal = await call("POST", "/api/resources", { path: "../outside.txt" });
  assert.equal(traversal.status, 403);
  assert.equal(traversal.json.code, "invalid_path");

  const absolute = await call("POST", "/api/resources", { path: "/etc/passwd" });
  assert.equal(absolute.status, 403);
});

test("chart payloads are served inline in the list (no second request)", async () => {
  const now = new Date().toISOString();
  db.insertResource({
    id: "api-chart",
    type: "chart",
    title: "API chart",
    source: "auto",
    sessionId: "s-api",
    sessionTitle: "S",
    payload: JSON.stringify({ title: { text: "API chart" }, series: [] }),
    contentHash: "api-chart-hash",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  const res = await call("GET", "/api/resources?type=chart");
  assert.equal(res.json.total, 1);
  assert.deepEqual(JSON.parse(res.json.items[0].payload), { title: { text: "API chart" }, series: [] });
  assert.equal(res.json.items[0].sessionTitle, "S", "provenance travels with the row");
});

test("rename round-trips and 404s on an unknown id", async () => {
  const list = await call("GET", "/api/resources?type=file");
  const id = list.json.items[0].id;
  const renamed = await call("PATCH", `/api/resources/${id}`, { title: "季度报表" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.resource.title, "季度报表");
  const search = await call("GET", `/api/resources?q=${encodeURIComponent("季度")}`);
  assert.equal(search.json.total, 1);

  const empty = await call("PATCH", `/api/resources/${id}`, { title: "   " });
  assert.equal(empty.status, 400);
  assert.equal(empty.json.code, "invalid_title");

  const ghost = await call("PATCH", "/api/resources/does-not-exist", { title: "x" });
  assert.equal(ghost.status, 404);
});

test("delete removes the row, its bytes, and broadcasts", async () => {
  const list = await call("GET", "/api/resources?type=file");
  const { id, filePath } = list.json.items[0];
  const storedPath = path.join(resources.filesRoot(), filePath);
  await fsp.stat(storedPath); // throws if the stored copy is missing

  const del = await call("DELETE", `/api/resources/${id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.json.removed, { id, type: "file" });
  await assert.rejects(() => fsp.stat(storedPath));
  assert.equal((await call("GET", "/api/resources?type=file")).json.total, 0);
  assert.equal(events.at(-1).type, "resources_changed");
  assert.equal(events.at(-1).action, "deleted");

  const again = await call("DELETE", `/api/resources/${id}`);
  assert.equal(again.status, 404);
});