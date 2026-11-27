// Unit tests for the gateway's bot-webhook router (add-user-questions): botId
// resolves to the owning cell across a shared data root — from the cell's own
// DB, owner from the session-ownership column (binding-key fallback), with
// positive/negative caching and tolerance for foreign or locked files.

import assert from "assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createBotWebhookRouter } from "../gateway/bot-webhooks.js";

const tmp = mkdtempSync(path.join(tmpdir(), "bot-webhooks-"));

// One cell dir with the minimum schema the router reads.
function makeCell(userId, { bots = [], owner = null }) {
  const dir = path.join(tmp, userId);
  mkdirSync(path.join(dir, "data", "data"), { recursive: true });
  const db = new Database(path.join(dir, "data", "data", "app.db"));
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, owner_email TEXT)");
  db.exec("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, owner TEXT)");
  db.exec("CREATE TABLE user_preferences (key TEXT PRIMARY KEY, value TEXT)");
  for (const id of bots) db.prepare("INSERT INTO bots (id) VALUES (?)").run(id);
  if (owner) db.prepare("INSERT INTO chat_sessions (id, owner) VALUES ('s1', ?)").run(owner);
  db.close();
  return dir;
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const BOT = "bot-1111";

test("resolves a bot to its owning cell, with an owner from sessions", async () => {
  makeCell("aaaaaaaaaaaaaaaa", { bots: [], owner: "someone@example.com" }); // decoy
  makeCell("bbbbbbbbbbbbbbbb", { bots: [BOT], owner: "aloadtree@gmail.com" });
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  const hit = await router.resolve(BOT);
  assert.equal(hit.email, "aloadtree@gmail.com");
  assert.equal(hit.userId, "bbbbbbbbbbbbbbbb");
});

test("falls back to an email-shaped binding key when no owned session exists", async () => {
  const dir = makeCell("cccccccccccccccc", { bots: ["bot-2222"] });
  const db = new Database(path.join(dir, "data", "data", "app.db"));
  db.prepare("INSERT INTO user_preferences (key, value) VALUES ('user.old@example.com.model', 'x')").run();
  db.close();
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal((await router.resolve("bot-2222")).email, "old@example.com");
});

test("unknown bots and unresolvable owners miss; non-cell dirs and junk files are skipped", async () => {
  writeFileSync(path.join(tmp, "not-a-cell"), "junk");
  mkdirSync(path.join(tmp, "deadbeefdeadbeef", "data", "data"), { recursive: true });
  writeFileSync(path.join(tmp, "deadbeefdeadbeef", "data", "data", "app.db"), "not a sqlite file");
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal((await router.resolve("nope")).email, null);
  // A bot whose cell has no owner trace is unrouteable, not guessed.
  makeCell("dddddddddddddddd", { bots: ["bot-3333"], owner: null });
  assert.equal((await router.resolve("bot-3333")).email, null);
});

test("caching: a miss is remembered briefly, then a later write is found", async () => {
  const userId = "eeeeeeeeeeeeeeee";
  makeCell(userId, { owner: "late@example.com" });
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal((await router.resolve("bot-late")).email, null);
  const db = new Database(path.join(tmp, userId, "data", "data", "app.db"));
  db.prepare("INSERT INTO bots (id) VALUES ('bot-late')").run();
  db.close();
  // The negative cache still holds…
  assert.equal((await router.resolve("bot-late")).email, null);
  // …and a fresh router (expired cache) finds it.
  const fresh = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal((await fresh.resolve("bot-late")).email, "late@example.com");
});

test("the registry's owner of the cell beats session inference", async () => {
  // fd-prod: a legacy bot (owner_email NULL) sat in a cell that ALSO held
  // another user's session. Inference picked that other person, so the
  // webhook was routed to their cell and refused as "unknown". The registry
  // knows the cell's real owner.
  const userId = "ffffffffffffffff";
  makeCell(userId, { bots: ["bot-4444"], owner: "stale-session@example.com" });
  const reg = new Database(path.join(tmp, "cells-registry.db"));
  reg.exec("CREATE TABLE IF NOT EXISTS cell_registry (cell_id TEXT PRIMARY KEY, owner_email TEXT)");
  reg.prepare("INSERT OR REPLACE INTO cell_registry (cell_id, owner_email) VALUES (?, ?)").run(userId, "real-owner@example.com");
  reg.close();
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal((await router.resolve("bot-4444")).email, "real-owner@example.com");
});

// ── binding-keyed resolution (fd-bot subscriber lane) ──────────────────────────
// fd-bot's envelope names the BINDING, never our bot id — the second address
// must find the same cell, and the two caches must never answer for each other.
function makeBindingCell(userId, { id, binding, owner = null }) {
  const dir = path.join(tmp, userId);
  mkdirSync(path.join(dir, "data", "data"), { recursive: true });
  const db = new Database(path.join(dir, "data", "data", "app.db"));
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, owner_email TEXT, fd_bot_binding_id TEXT)");
  db.exec("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, owner TEXT)");
  db.exec("CREATE TABLE user_preferences (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO bots (id, fd_bot_binding_id) VALUES (?, ?)").run(id, binding);
  if (owner) db.prepare("INSERT INTO chat_sessions (id, owner) VALUES ('s1', ?)").run(owner);
  db.close();
  return dir;
}

test("resolveByBinding finds the owning cell by fd_bot_binding_id", async () => {
  makeBindingCell("1111111111111111", { id: "bot-r1", binding: "b_route1", owner: "bind@example.com" });
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  const hit = await router.resolveByBinding("b_route1");
  assert.equal(hit.email, "bind@example.com");
  assert.equal(hit.userId, "1111111111111111");
});

test("resolveByBinding misses an unknown binding; the two key spaces stay separate", async () => {
  makeBindingCell("2222222222222222", { id: "bot-only-id", binding: "b_route2", owner: "sep@example.com" });
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal((await router.resolveByBinding("nope")).email, null);
  // A bot id is not a binding id.
  assert.equal((await router.resolveByBinding("bot-only-id")).email, null);
  // …and a negatived binding id does not poison the bot-id cache.
  assert.equal((await router.resolve("bot-only-id")).email, "sep@example.com");
});

// ── reverse index (harden-cell-isolation 2.1) ─────────────────────────────────
// With an index present, resolution is ONE query: a hit never opens a cell
// database, and an unknown id is refused without touching tenant data.
test("indexed resolution opens no cell database — unknown ids are refused blind", async (t) => {
  const { createCellRegistryDb } = await import("../gateway/cell-registry.js");
  const indexDir = mkdtempSync(path.join(tmpdir(), "bot-index-"));
  t.after(() => rmSync(indexDir, { recursive: true, force: true }));
  const registryDb = createCellRegistryDb({ file: path.join(indexDir, "cells-registry.db") });
  t.after(() => registryDb.close());
  registryDb.botIndexPut({ key: "bot-indexed", kind: "bot", cellId: "abcdefabcdefabcd", ownerEmail: "indexed@example.com" });
  let opens = 0;
  const router = createBotWebhookRouter({
    dataRoot: indexDir,
    openDb: () => { opens += 1; throw new Error("cell db must not be opened"); },
    registryDb,
  });
  const hit = await router.resolve("bot-indexed");
  assert.equal(hit.email, "indexed@example.com");
  assert.equal(hit.userId, "abcdefabcdefabcd");
  assert.equal((await router.resolve("bot-unknown")).email, null);
  assert.equal(opens, 0, "an indexed world never scans a cell database");
});

test("a pre-index deployment is populated once, then never scanned again", async (t) => {
  const { createCellRegistryDb } = await import("../gateway/cell-registry.js");
  const indexDir = mkdtempSync(path.join(tmpdir(), "bot-index-pop-"));
  t.after(() => rmSync(indexDir, { recursive: true, force: true }));
  const dir = path.join(indexDir, "1234123412341234");
  mkdirSync(path.join(dir, "data", "data"), { recursive: true });
  const db = new Database(path.join(dir, "data", "data", "app.db"));
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, owner_email TEXT)");
  db.prepare("INSERT INTO bots (id, owner_email) VALUES ('legacy-bot', 'legacy@example.com')").run();
  db.exec("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, owner TEXT)");
  db.exec("CREATE TABLE user_preferences (key TEXT PRIMARY KEY, value TEXT)");
  db.close();
  const registryDb = createCellRegistryDb({ file: path.join(indexDir, "cells-registry.db") });
  t.after(() => registryDb.close());
  let opens = 0;
  const router = createBotWebhookRouter({
    dataRoot: indexDir,
    openDb: (p) => { opens += 1; return new Database(p, { readonly: true }); },
    registryDb,
  });
  assert.equal((await router.resolve("legacy-bot")).email, "legacy@example.com");
  const afterFirst = opens;
  assert.ok(afterFirst >= 1, "the one-time populate reads the cells");
  assert.equal((await router.resolve("still-unknown")).email, null);
  assert.equal((await router.resolve("legacy-bot")).email, "legacy@example.com");
  assert.equal(opens, afterFirst, "after the populate, no further cell databases are opened");
});
