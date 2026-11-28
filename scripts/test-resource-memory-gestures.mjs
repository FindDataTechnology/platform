// Route-level tests for the tier/tags gesture face (openspec:
// add-unified-memory-and-outputs, task 3.4).
//
// The gestures write to fd-memory first and mirror locally (single-writer
// discipline). The case worth pinning is the ordering one found in production
// acceptance: marking 正典 before ever clicking 记住 used to 500 because the
// reference page did not exist yet. Registering the mirror on demand IS the
// remember gesture, so the route must create it, not demand a prior click.
//
//   node --test scripts/test-resource-memory-gestures.mjs

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = await mkdtemp(path.join(tmpdir(), "resource-memory-gestures-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");
process.env.CELL_MEMORY_ENABLED = "1";
process.env.CELL_MEMORY_URL = "http://memory.stub";
process.env.CELL_MEMORY_PLATFORM_TOKEN = "platform-token";
process.env.CELL_MEMORY_DATA = path.join(tmpRoot, "cell-memory");

const express = (await import("express")).default;
const db = await import("../db.js");
const resources = await import("../resources.js");
const { registerResourceRoutes } = await import("../server/routes/resources.js");

await db.initDb();
const WORKSPACE = path.join(tmpRoot, "workspace");
await resources.initStore({ broadcast: () => {} });

// ── fd-memory stand-in ────────────────────────────────────────────────────────
// Records the write-master calls in order so the assertions can prove the
// route registered the page before mutating it.
const calls = [];
let mutateStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ u, m: init.method ?? "GET", body });
  const json = (status, payload) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  if (u.endsWith("/admin/mint")) return json(200, { token: "person-token" });
  if (u.endsWith("/pages/write")) return json(201, { path: `default/references/${body.slug}.md`, created: true });
  if (u.endsWith("/pages/mutate")) {
    if (mutateStatus !== 200) return json(mutateStatus, { error: "not_found" });
    return json(200, { path: body.path, changed: true, changes: [] });
  }
  return json(404, { error: "unexpected" });
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { email: "owner@example.com" };
  next();
});
registerResourceRoutes({ app, db, dshBridge: { getCwd: () => WORKSPACE } });
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message, code: "error" }));

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
            server.close();
            resolve({ status: res.statusCode, json });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function seed(id, title = id) {
  return db.insertResource({
    id,
    type: "document",
    title,
    source: "manual",
    sessionId: `sess-${id}`,
    sessionTitle: "测试舰队",
    payload: JSON.stringify({ kind: "file" }),
    filePath: path.join(WORKSPACE, `${id}.md`),
    contentHash: `hash-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

test("set_tier on an un-remembered output registers the reference first", async () => {
  seed("res-tier-1", "政策草稿");
  calls.length = 0;
  const r = await call("POST", "/api/resources/res-tier-1/tier", { tier: "canonical" });
  assert.equal(r.status, 200);
  assert.equal(r.json.resource.tier, "canonical");
  assert.ok(r.json.resource.memoryRefPath, "mirror path recorded on the row");
  const kinds = calls.filter((c) => c.u.includes("/pages/")).map((c) => c.u.split("/pages/")[1]);
  assert.deepEqual(kinds, ["write", "mutate"], "page created, then mutated");
  const write = calls.find((c) => c.u.endsWith("/pages/write"));
  assert.equal(write.body.type, "reference");
  assert.equal(write.body.source_ref, "resource:res-tier-1");
  const mutate = calls.find((c) => c.u.endsWith("/pages/mutate"));
  assert.equal(mutate.body.op, "set_tier");
  assert.equal(mutate.body.tier, "canonical");
  assert.equal(mutate.body.origin, "human");
});

test("set_tags replaces the tag set and mirrors it", async () => {
  seed("res-tags-1", "图表一");
  calls.length = 0;
  const r = await call("POST", "/api/resources/res-tags-1/tags", { tags: ["行业政策", "跨境电商"] });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.json.resource.tags), ["行业政策", "跨境电商"]);
  const mutate = calls.find((c) => c.u.endsWith("/pages/mutate"));
  assert.equal(mutate.body.op, "set_tags");
  assert.deepEqual(mutate.body.tags, ["行业政策", "跨境电商"]);
});

test("tags are capped at five and a non-array body is a 400", async () => {
  const bad = await call("POST", "/api/resources/res-tags-1/tags", { tags: "行业政策" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "invalid_tags");
  const capped = await call("POST", "/api/resources/res-tags-1/tags", { tags: ["a", "b", "c", "d", "e", "f"] });
  assert.equal(capped.status, 200);
  assert.deepEqual(JSON.parse(capped.json.resource.tags), ["a", "b", "c", "d", "e"]);
});

test("an fd-memory 404 surfaces as reference_missing, not a 500", async () => {
  seed("res-missing-1", "无页条目");
  mutateStatus = 404;
  const r = await call("POST", "/api/resources/res-missing-1/tier", { tier: "stable" });
  mutateStatus = 200;
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "reference_missing");
});

test("an invalid tier never reaches fd-memory", async () => {
  seed("res-bad-tier-1", "坏级");
  calls.length = 0;
  const r = await call("POST", "/api/resources/res-bad-tier-1/tier", { tier: "legendary" });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "invalid_tier");
  assert.equal(calls.filter((c) => c.u.includes("/pages/")).length, 0);
});

test("unknown resource is a 404", async () => {
  const r = await call("POST", "/api/resources/nope/tier", { tier: "stable" });
  assert.equal(r.status, 404);
});

// Restore the real fetch so a later test file in the same process is unaffected.
test.after(() => {
  globalThis.fetch = realFetch;
});
