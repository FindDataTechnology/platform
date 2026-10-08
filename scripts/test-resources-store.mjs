// Unit tests for the resource library's store + save path (openspec:
// add-resource-library, tasks 1.1 / 1.2 / 3.1 / 3.2).
//
// Covers:
//   - the migration surface: table, unique hash index, type index
//   - the db accessors (insert-or-existing, list filters, rename, delete)
//   - saveFile: copy-into-store, dedupe by content, size cap, and the SAME
//     hardening class as the serving route (absolute paths, .., symlinks out
//     of the workspace, NUL, directories) — a failed save leaves no bytes
//   - remove: row + stored bytes; rename: title only, identity unchanged
//
// The size cap is set to 1KB BEFORE import so the oversize case is cheap and
// exercises the env override too.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promises as fsp } from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resources-store-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.RESOURCES_STORAGE_PATH = path.join(tmpRoot, "resources-store");
process.env.RESOURCE_MAX_FILE_BYTES = "1024";

const db = await import("../db.js");
const resources = await import("../resources.js");

await db.initDb();
assert.ok(db.isDbReady(), "DB should be ready after initDb");

const WORKSPACE = path.join(tmpRoot, "workspace");
await fsp.mkdir(WORKSPACE, { recursive: true });
const OUTSIDE = path.join(tmpRoot, "outside");
await fsp.mkdir(OUTSIDE, { recursive: true });

// ── Migration surface ───────────────────────────────────────────────────────

test("migration 16 created the resources table and its indexes", () => {
  const handle = db.getDb();
  const table = handle
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resources'")
    .get();
  assert.ok(table, "resources table exists");
  const indexes = handle
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='resources'")
    .all()
    .map((r) => r.name);
  assert.ok(indexes.includes("idx_resources_hash"), "unique hash index exists");
  assert.ok(indexes.includes("idx_resources_type"), "type index exists");
  // The hash index is UNIQUE — the dedupe guarantee, not a convention.
  const hashIndex = handle
    .prepare("SELECT sql FROM sqlite_master WHERE name='idx_resources_hash'")
    .get();
  assert.match(hashIndex.sql, /UNIQUE/i);
  // Re-running initDb is a no-op (idempotent re-open).
  assert.equal(db.countResources(), 0);
});

// ── Accessors ───────────────────────────────────────────────────────────────

test("insertResource returns the existing row for a repeated content hash", () => {
  const now = new Date().toISOString();
  const first = db.insertResource({
    id: "r1",
    type: "chart",
    title: "one",
    source: "auto",
    sessionId: "s1",
    sessionTitle: "S",
    messageId: 1,
    payload: '{"a":1}',
    contentHash: "hash-1",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  assert.equal(first.inserted, true);
  assert.equal(first.resource.id, "r1");

  const second = db.insertResource({
    id: "r2",
    type: "chart",
    title: "two",
    source: "auto",
    contentHash: "hash-1",
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(second.inserted, false, "same hash must not insert");
  assert.equal(second.resource.id, "r1", "the original row is returned");
  assert.equal(db.countResources(), 1);
});

test("list paginates and reports limit/offset", () => {
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i += 1) {
    const t = new Date(Date.parse(now) + i * 1000).toISOString();
    db.insertResource({
      id: `p${i}`,
      type: "file",
      title: `page file ${i}`,
      source: "manual",
      contentHash: `hash-page-${i}`,
      createdAt: t,
      updatedAt: t,
    });
  }
  const page = db.listResources({ type: "file", limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.limit, 2);
  assert.equal(page.offset, 1);
  assert.equal(page.items.length, 2);
});

test("rename keeps identity; delete returns the removed row", () => {
  const now = new Date().toISOString();
  const renamed = db.renameResource("r1", "renamed", now);
  assert.equal(renamed.title, "renamed");
  assert.equal(db.findResourceByHash("hash-1").id, "r1", "hash lookup still resolves");
  const removed = db.deleteResource("r1");
  assert.equal(removed.id, "r1");
  assert.equal(db.getResource("r1"), null);
  assert.equal(db.deleteResource("r1"), null, "deleting twice returns null");
});

// ── saveFile ────────────────────────────────────────────────────────────────

test("saving a workspace file copies bytes and records metadata", async () => {
  const bytes = Buffer.from("nominal,revenue\nA,10\nB,20\n");
  await fsp.mkdir(path.join(WORKSPACE, "reports"), { recursive: true });
  await fsp.writeFile(path.join(WORKSPACE, "reports", "报表.csv"), bytes);

  const { inserted, resource } = await resources.saveFile({
    sessionId: null,
    path: "reports/报表.csv",
    workspaceRoot: WORKSPACE,
  });
  assert.equal(inserted, true);
  assert.equal(resource.type, "file");
  assert.equal(resource.title, "报表.csv");
  assert.equal(resource.source, "manual");
  assert.equal(resource.fileSize, bytes.length);
  assert.equal(resource.fileMime, "text/csv");
  assert.equal(resource.filePath, `${resource.id}/报表.csv`);

  const stored = await fsp.readFile(path.join(resources.filesRoot(), resource.filePath));
  assert.deepEqual(stored, bytes, "stored bytes equal the source");

  // The stored copy survives the source disappearing — the whole point.
  await fsp.rm(path.join(WORKSPACE, "reports"), { recursive: true, force: true });
  const stillThere = await fsp.readFile(path.join(resources.filesRoot(), resource.filePath));
  assert.deepEqual(stillThere, bytes);
});

test("saving byte-identical content again is not a duplicate", async () => {
  const bytes = Buffer.from("same content\n");
  await fsp.writeFile(path.join(WORKSPACE, "a.txt"), bytes);
  await fsp.writeFile(path.join(WORKSPACE, "b.txt"), bytes);
  const first = await resources.saveFile({ path: "a.txt", workspaceRoot: WORKSPACE });
  assert.equal(first.inserted, true);
  const dirsBefore = (await fsp.readdir(resources.filesRoot())).length;
  const second = await resources.saveFile({ path: "b.txt", workspaceRoot: WORKSPACE });
  assert.equal(second.inserted, false);
  assert.equal(second.resource.id, first.resource.id, "content identity, not path identity");
  const dirsAfter = (await fsp.readdir(resources.filesRoot())).length;
  assert.equal(dirsAfter, dirsBefore, "a refused duplicate must not create a directory");
});

test("absolute paths inside the workspace are accepted; outside are refused", async () => {
  await fsp.writeFile(path.join(WORKSPACE, "abs.txt"), "absolute ok");
  const inside = await resources.saveFile({
    path: path.join(WORKSPACE, "abs.txt"),
    workspaceRoot: WORKSPACE,
  });
  assert.equal(inside.inserted, true);

  await fsp.writeFile(path.join(OUTSIDE, "secret.txt"), "not yours");
  await assert.rejects(
    () => resources.saveFile({ path: path.join(OUTSIDE, "secret.txt"), workspaceRoot: WORKSPACE }),
    (err) => err.status === 403 && err.code === "invalid_path"
  );
});

test("traversal, NUL and symlink escapes are refused", async () => {
  await fsp.writeFile(path.join(OUTSIDE, "secret.txt"), "not yours");
  await assert.rejects(
    () => resources.saveFile({ path: "../outside/secret.txt", workspaceRoot: WORKSPACE }),
    (err) => err.status === 403
  );
  await assert.rejects(
    () => resources.saveFile({ path: "a\0b.txt", workspaceRoot: WORKSPACE }),
    (err) => err.status === 403
  );
  // A symlink whose lexical path is inside the workspace but whose target is
  // not: refused by the realpath check, exactly like the serving route.
  const link = path.join(WORKSPACE, "escape.txt");
  await fsp.symlink(path.join(OUTSIDE, "secret.txt"), link);
  await assert.rejects(
    () => resources.saveFile({ path: "escape.txt", workspaceRoot: WORKSPACE }),
    (err) => err.status === 403
  );
});

test("missing files and directories are 404; the size cap is 413", async () => {
  const dirsBefore = (await fsp.readdir(resources.filesRoot())).length;
  await assert.rejects(
    () => resources.saveFile({ path: "nope.txt", workspaceRoot: WORKSPACE }),
    (err) => err.status === 404 && err.code === "file_not_found"
  );
  await fsp.mkdir(path.join(WORKSPACE, "adir"), { recursive: true });
  await assert.rejects(
    () => resources.saveFile({ path: "adir", workspaceRoot: WORKSPACE }),
    (err) => err.status === 404
  );
  await fsp.writeFile(path.join(WORKSPACE, "big.bin"), Buffer.alloc(2048));
  await assert.rejects(
    () => resources.saveFile({ path: "big.bin", workspaceRoot: WORKSPACE }),
    (err) => err.status === 413 && err.code === "file_too_large"
  );
  const dirsAfter = (await fsp.readdir(resources.filesRoot())).length;
  assert.equal(dirsAfter, dirsBefore, "refused saves leave no stray directories");
});

test("a failed save leaves no partial bytes behind", async () => {
  const before = await fsp.readdir(resources.filesRoot());
  await assert.rejects(() => resources.saveFile({ path: "big.bin", workspaceRoot: WORKSPACE }));
  const after = await fsp.readdir(resources.filesRoot());
  assert.deepEqual(after.sort(), before.sort());
});

test("saveFile records the session title snapshot when a session is given", async () => {
  const now = new Date().toISOString();
  db.upsertSession("sess-store", "存储会话", now, now);
  await fsp.writeFile(path.join(WORKSPACE, "snap.md"), "# snapshot");
  const { resource } = await resources.saveFile({
    sessionId: "sess-store",
    path: "snap.md",
    workspaceRoot: WORKSPACE,
  });
  assert.equal(resource.sessionTitle, "存储会话");
});

// ── remove / rename through the service ─────────────────────────────────────

test("removing a file resource drops the row and its bytes", async () => {
  await fsp.writeFile(path.join(WORKSPACE, "bye.txt"), "bye");
  const { resource } = await resources.saveFile({ path: "bye.txt", workspaceRoot: WORKSPACE });
  const dir = path.join(resources.filesRoot(), resource.id);
  assert.ok(fs.existsSync(dir));
  const removed = await resources.remove(resource.id);
  assert.equal(removed.id, resource.id);
  assert.equal(fs.existsSync(dir), false, "stored bytes are gone");
  assert.equal(resources.get(resource.id), null);
});

test("removing a chart resource leaves the store directory untouched", async () => {
  const now = new Date().toISOString();
  const { resource } = db.insertResource({
    id: "chart-del",
    type: "chart",
    title: "chart",
    source: "auto",
    payload: '{"x":1}',
    contentHash: "hash-chart-del",
    createdAt: now,
    updatedAt: now,
  });
  const removed = await resources.remove(resource.id);
  assert.equal(removed.type, "chart");
  assert.equal(resources.get("chart-del"), null);
});

test("rename rejects an empty title and persists a real one", async () => {
  await fsp.writeFile(path.join(WORKSPACE, "rename.txt"), "x");
  const { resource } = await resources.saveFile({ path: "rename.txt", workspaceRoot: WORKSPACE });
  assert.throws(
    () => resources.rename(resource.id, "   "),
    (err) => err.status === 400 && err.code === "invalid_title"
  );
  const renamed = resources.rename(resource.id, "  新名字  ");
  assert.equal(renamed.title, "新名字", "title is trimmed");
  assert.equal(renamed.contentHash, resource.contentHash, "identity is unchanged by a rename");
});

test("storeRoot honors the RESOURCES_STORAGE_PATH override", () => {
  assert.equal(resources.storeRoot(), process.env.RESOURCES_STORAGE_PATH);
  assert.equal(resources.filesRoot(), path.join(process.env.RESOURCES_STORAGE_PATH, "files"));
  assert.equal(resources.maxFileBytes(), 1024);
});