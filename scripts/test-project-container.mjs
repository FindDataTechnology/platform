// add-web-project-container 1.2/1.3: the projects store — attach-by-path on
// reuse, rename-only identity, and path→id backtrace (design D2/D5). The route
// layer is a thin wrapper over these helpers (verified by typecheck + live
// smoke), so the behavioral contract lives here against a temp DB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// Isolate a fresh DB before importing db.js (it reads DB_PATH at import/init).
process.env.DB_PATH = join(tmpdir(), `paas-projects-${randomBytes(6).toString("hex")}.db`);

const db = await import("../db.js");
await db.initDb();
const ready = db.isDbReady();
const { upsertProjectByName, renameProject, listProjects, getProjectByPath, getProjectById } = db;

test("db ready on a temp file", () => {
  assert.equal(ready, true, "db.js must be ready after initDb()");
});

test("1.2 create mints an id + path and lists", () => {
  const path = "/projects/alpha";
  const p = upsertProjectByName("alpha", path);
  assert.ok(p, "create returns a row");
  assert.equal(p.name, "alpha");
  assert.equal(p.path, path);
  assert.equal(p.attached, false);
  assert.ok(typeof p.id === "string" && p.id.length > 0, "a fresh stable id");
  // Backtrace by path returns the same id.
  const back = getProjectByPath(path);
  assert.equal(back?.id, p.id);
  // It shows up in the list.
  assert.ok(listProjects().some((x) => x.id === p.id));
});

test("1.2 re-POSTing the same backing path attaches (same id, no dup)", () => {
  const path = "/projects/alpha";
  const again = upsertProjectByName("alpha", path);
  assert.equal(again.attached, true, "reuse attaches");
  assert.equal(again.id, getProjectByPath(path).id, "same id — attach not duplicate");
  // No second row.
  assert.equal(listProjects().filter((x) => x.backingPath === path).length, 1);
});

test("1.2 different paths are distinct projects", () => {
  const a = upsertProjectByName("a", "/projects/a");
  const b = upsertProjectByName("b", "/projects/b");
  assert.notEqual(a.id, b.id);
});

test("1.3 rename changes name only; id + path + attribution stay", () => {
  const { id, path } = upsertProjectByName("orig", "/projects/rename-me");
  const ok = renameProject(id, "renamed");
  assert.equal(ok, true);
  const row = getProjectById(id);
  assert.equal(row.name, "renamed");
  assert.equal(row.backingPath, path, "backing path never moves on rename");
  // A session/collection stamped by this id is still the same project.
  assert.equal(getProjectByPath(path).id, id);
});

test("1.3 rename of an unknown id reports not-found", () => {
  assert.equal(renameProject("does-not-exist", "x"), false);
});

test("2.1 backtrace helper is null for an unregistered path", () => {
  // better-sqlite3 .get() returns undefined for no row; callers check truthiness.
  assert.ok(!getProjectByPath("/projects/never-registered"));
  assert.ok(!getProjectById("nope"));
});

// 2.1 session attribution — stamped by path backtrace at the same point as the
// workspace column (design D2). Web project path → stamped; desktop local path
// (no project row) → NULL; a later turn with a changed workspace must not
// re-stamp the creation fact (write-once, like workspace itself).
test("2.1 a session in a project-backed workspace is attributed", () => {
  const p = upsertProjectByName("attr", "/projects/attr");
  db.upsertSession("sess-attr", "hello", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "/agent/sess.json", null, p.path);
  const row = db.getDb().prepare("SELECT project_id, workspace FROM chat_sessions WHERE id = ?").get("sess-attr");
  assert.equal(row.project_id, p.id, "web project workspace stamps the project id");
});

test("2.1 a desktop/local workspace (no project row) stays NULL", () => {
  db.upsertSession("sess-desktop", "local", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "/agent/d.json", null, "/Users/me/code/whatever");
  const row = db.getDb().prepare("SELECT project_id FROM chat_sessions WHERE id = ?").get("sess-desktop");
  assert.equal(row.project_id, null, "unknown path is unattributed (默认项目 fallback)");
});

test("2.1 attribution is write-once: a later turn cannot re-stamp", () => {
  db.upsertSession("sess-attr", "hello again", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", "/agent/sess.json", null, "/projects/other");
  const row = db.getDb().prepare("SELECT project_id FROM chat_sessions WHERE id = ?").get("sess-attr");
  assert.equal(row.project_id, getProjectByPath("/projects/attr").id, "original attribution survives a workspace change");
});

// 2.2 collections carry optional project attribution and filter by it.
// undefined = every collection (default view, unchanged); null = the
// unattributed (默认项目) bucket; an id = that project.
test("2.2 collections: attributed + NULL filter to the right buckets", () => {
  const p = upsertProjectByName("collproj", "/projects/collproj");
  db.createCollection({ id: "coll-a", name: "A", description: null, created_at: "2026-01-01T00:00:00Z", project_id: p.id });
  db.createCollection({ id: "coll-global", name: "Global", description: null, created_at: "2026-01-01T00:00:00Z", project_id: null });

  const all = db.listCollections();
  assert.ok(all.some((c) => c.id === "coll-a") && all.some((c) => c.id === "coll-global"), "default view sees both");

  const mine = db.listCollections({ projectId: p.id });
  assert.deepEqual(mine.map((c) => c.id), ["coll-a"], "project filter returns only its collections");

  const unattributed = db.listCollections({ projectId: null });
  assert.deepEqual(unattributed.map((c) => c.id), ["coll-global"], "default bucket = unattributed only");

  // The row carries projectId for the UI.
  assert.equal(db.getCollection("coll-a").projectId, p.id);
});
