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
// ── Delivery-status lookup (openspec: add-artifact-delivery, task 4.2) ──────

test("lookup answers hash questions for captured charts", async () => {
  const hash = "a".repeat(64);
  db.insertResource({
    id: "lookup-chart-1",
    type: "chart",
    title: "t",
    source: "auto",
    sessionId: null,
    sessionTitle: null,
    messageId: null,
    payload: "{}",
    contentHash: hash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  const res = await call("POST", "/api/resources/lookup", {
    hashes: [hash, "b".repeat(64)],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.hashes[hash], true);
  assert.equal(res.json.hashes["b".repeat(64)], false);
});

test("lookup answers path questions by content, with containment", async () => {
  const target = path.join(WORKSPACE, "lookup-target.md");
  await fsp.writeFile(target, "lookup-bytes-α", "utf8");
  // Saved elsewhere in the conversation? No row yet → unsaved.
  const before = await call("POST", "/api/resources/lookup", { paths: [target] });
  assert.equal(before.status, 200);
  assert.equal(before.json.paths[target], "unsaved");

  // Save it through the real service, then the same path must read "saved".
  await resources.saveFile({ path: target, workspaceRoot: WORKSPACE });
  const after = await call("POST", "/api/resources/lookup", { paths: [target] });
  assert.equal(after.json.paths[target], "saved");

  // A deleted file reports missing; an escaping path is refused.
  await fsp.rm(target);
  const missing = await call("POST", "/api/resources/lookup", { paths: [target] });
  assert.equal(missing.json.paths[target], "missing");
  const escapeTry = await call("POST", "/api/resources/lookup", { paths: ["../../etc/hosts"] });
  assert.equal(escapeTry.json.paths["../../etc/hosts"], "invalid");
  // Non-hash strings are dropped rather than trusted.
  const junk = await call("POST", "/api/resources/lookup", { hashes: ["not-a-hash"] });
  assert.equal(junk.status, 200);
  assert.deepEqual(junk.json.hashes, {});
});

// ── List filters (openspec: add-resource-filters, task 1.3) ──────────────────
//
// The route's own job: parse and validate the filter parameters, then hand them
// to the service. The filtering semantics themselves are covered in
// test-resource-filters.mjs against the store; here only the HTTP contract —
// valid values pass through, invalid ones are a 400 with a reason code.

test("list accepts type groups and a time window", async () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  db.insertResource({
    id: "f-pdf",
    type: "file",
    title: "近期报告.pdf",
    source: "manual",
    filePath: "u/近期报告.pdf",
    contentHash: "hash-f-pdf",
    createdAt: now,
    updatedAt: now,
  });
  db.insertResource({
    id: "f-old-pdf",
    type: "file",
    title: "旧报告.pdf",
    source: "manual",
    filePath: "u/旧报告.pdf",
    contentHash: "hash-f-old-pdf",
    createdAt: old,
    updatedAt: old,
  });
  db.insertResource({
    id: "f-csv",
    type: "file",
    title: "数据.csv",
    source: "manual",
    filePath: "u/数据.csv",
    contentHash: "hash-f-csv",
    createdAt: now,
    updatedAt: now,
  });
  db.insertResource({
    id: "f-json",
    type: "file",
    title: "配置.json",
    source: "manual",
    filePath: "u/配置.json",
    contentHash: "hash-f-json",
    createdAt: now,
    updatedAt: now,
  });

  const grouped = await call("GET", "/api/resources?groups=document,spreadsheet");
  assert.equal(grouped.status, 200);
  const ids = grouped.json.items.map((r) => r.id);
  for (const id of ["f-csv", "f-old-pdf", "f-pdf"]) {
    assert.ok(ids.includes(id), `document/spreadsheet group must include ${id}`);
  }
  assert.ok(!ids.includes("f-json"), "a json row is neither document nor spreadsheet");

  const windowed = await call("GET", `/api/resources?since=${encodeURIComponent(old)}&until=${encodeURIComponent(now)}`);
  assert.equal(windowed.status, 200);
  assert.ok(windowed.json.items.some((r) => r.id === "f-old-pdf"));

  // facets ride the same response and are keyed by every group
  assert.ok(grouped.json.facets.document >= 2, "both PDFs count as documents");
  assert.ok(grouped.json.facets.spreadsheet >= 1);
  assert.ok(grouped.json.facets.data >= 1, "facets count the unchecked data group too");
  assert.equal(typeof grouped.json.facets.chart, "number", "every group key is present");
});

test("list rejects unusable filter values with a reason code", async () => {
  const badGroup = await call("GET", "/api/resources?groups=document,nonsense");
  assert.equal(badGroup.status, 400);
  assert.equal(badGroup.json.code, "invalid_group");
  assert.ok(Array.isArray(badGroup.json.allowed), "the rejection names the valid groups");

  const badSince = await call("GET", "/api/resources?since=yesterday");
  assert.equal(badSince.status, 400);
  assert.equal(badSince.json.code, "invalid_since");

  const badUntil = await call("GET", "/api/resources?until=2026-10-16");
  assert.equal(badUntil.status, 400);
  assert.equal(badUntil.json.code, "invalid_until");

  // An omitted filter is not an invalid one — the plain list still works.
  const plain = await call("GET", "/api/resources");
  assert.equal(plain.status, 200);
  assert.ok(plain.json.facets);
});

// ── The model save channel (openspec: add-save-to-library-tool, task 1.2) ────
//
// The route is the truth layer: per-path results, the per-call cap, and the
// same store gate a user save takes. The loopback exemption itself is verified
// behaviorally in test-cell-containment.mjs (same convention as the other
// bridges — the predicate is not exported, and a source assertion proves
// nothing about the running gate).

test("save-declared ingests workspace files per-path with model provenance", async () => {
  await fsp.writeFile(path.join(WORKSPACE, "declared.csv"), "k,v\n1,2\n");
  await fsp.mkdir(path.join(WORKSPACE, "subdir"), { recursive: true });

  const res = await call("POST", "/api/resources/save-declared", {
    paths: ["declared.csv", "subdir", "nope.txt"],
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.ok);
  const byPath = new Map(res.json.results.map((r) => [r.path, r]));
  assert.deepEqual(byPath.get("declared.csv").status, "saved");
  assert.ok(byPath.get("declared.csv").id);
  assert.deepEqual(byPath.get("subdir").status, "refused");
  assert.deepEqual(byPath.get("subdir").reason, "not_a_file", "a directory says why");
  assert.deepEqual(byPath.get("nope.txt").status, "refused");
  assert.deepEqual(byPath.get("nope.txt").reason, "file_not_found");

  const row = db.getResource(byPath.get("declared.csv").id);
  assert.equal(row.source, "model", "the row is attributable to the model channel");
  assert.equal(row.sessionId, null, "no session context in this harness — provenance stays null");

  // Same bytes again: already-saved, no second row.
  const again = await call("POST", "/api/resources/save-declared", { paths: ["declared.csv"] });
  assert.deepEqual(again.json.results[0].status, "already-saved");
  assert.equal(again.json.results[0].id, byPath.get("declared.csv").id);
});

test("save-declared caps the per-call path count at ten, refusing the excess", async () => {
  const paths = [];
  for (let i = 0; i < 12; i += 1) {
    const name = `cap-${i}.txt`;
    await fsp.writeFile(path.join(WORKSPACE, name), `cap ${i}`);
    paths.push(name);
  }
  const res = await call("POST", "/api/resources/save-declared", { paths });
  assert.equal(res.status, 200);
  const statuses = res.json.results.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === "saved").length, 10, "the first ten save");
  const excess = res.json.results.slice(10);
  assert.ok(
    excess.every((r) => r.status === "refused" && r.reason === "too_many_paths"),
    "the excess are refused with the cap reason, not silently dropped",
  );
});

test("save-declared records the current session when one is wired", async () => {
  // The route reads ctx.dshSessionId; this harness registered the routes
  // without one, so prove the wiring by re-registering with a session present.
  const express2 = (await import("express")).default;
  const app2 = express2();
  app2.use(express2.json());
  const { registerResourceRoutes: register } = await import("../server/routes/resources.js");
  register({ app: app2, db, dshBridge: { getCwd: () => WORKSPACE }, dshSessionId: "sess-model-1" });
  db.upsertSession("sess-model-1", "模型保存会话", new Date().toISOString(), new Date().toISOString());
  await fsp.writeFile(path.join(WORKSPACE, "sessioned.txt"), "with session");
  const holder = { app: app2 };
  const server2 = createServer(holder.app);
  server2.unref();
  await new Promise((resolve) => server2.listen(0, "127.0.0.1", resolve));
  const port2 = server2.address().port;
  const payload = JSON.stringify({ paths: ["sessioned.txt"] });
  const raw = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: port2, path: "/api/resources/save-declared", method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (r) => { const c = []; r.on("data", (x) => c.push(x)); r.on("end", () => resolve(Buffer.concat(c).toString())); },
    );
    req.on("error", reject);
    req.end(payload);
  });
  server2.close();
  const json = JSON.parse(raw);
  const id = json.results[0].id;
  const row = db.getResource(id);
  assert.equal(row.sessionId, "sess-model-1");
  assert.equal(row.sessionTitle, "模型保存会话");
  assert.equal(row.source, "model");
});
