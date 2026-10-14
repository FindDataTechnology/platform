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
  db.exec("CREATE TABLE bots (id TEXT PRIMARY KEY)");
  db.exec("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, owner TEXT)");
  db.exec("CREATE TABLE user_preferences (key TEXT PRIMARY KEY, value TEXT)");
  for (const id of bots) db.prepare("INSERT INTO bots (id) VALUES (?)").run(id);
  if (owner) db.prepare("INSERT INTO chat_sessions (id, owner) VALUES ('s1', ?)").run(owner);
  db.close();
  return dir;
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const BOT = "bot-1111";

test("resolves a bot to its owning cell, with an owner from sessions", () => {
  makeCell("aaaaaaaaaaaaaaaa", { bots: [], owner: "someone@example.com" }); // decoy
  makeCell("bbbbbbbbbbbbbbbb", { bots: [BOT], owner: "aloadtree@gmail.com" });
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  const hit = router.resolve(BOT);
  assert.equal(hit.email, "aloadtree@gmail.com");
  assert.equal(hit.userId, "bbbbbbbbbbbbbbbb");
});

test("falls back to an email-shaped binding key when no owned session exists", () => {
  const dir = makeCell("cccccccccccccccc", { bots: ["bot-2222"] });
  const db = new Database(path.join(dir, "data", "data", "app.db"));
  db.prepare("INSERT INTO user_preferences (key, value) VALUES ('user.old@example.com.model', 'x')").run();
  db.close();
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal(router.resolve("bot-2222").email, "old@example.com");
});

test("unknown bots and unresolvable owners miss; non-cell dirs and junk files are skipped", () => {
  writeFileSync(path.join(tmp, "not-a-cell"), "junk");
  mkdirSync(path.join(tmp, "deadbeefdeadbeef", "data", "data"), { recursive: true });
  writeFileSync(path.join(tmp, "deadbeefdeadbeef", "data", "data", "app.db"), "not a sqlite file");
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal(router.resolve("nope").email, null);
  // A bot whose cell has no owner trace is unrouteable, not guessed.
  makeCell("dddddddddddddddd", { bots: ["bot-3333"], owner: null });
  assert.equal(router.resolve("bot-3333").email, null);
});

test("caching: a miss is remembered briefly, then a later write is found", () => {
  const userId = "eeeeeeeeeeeeeeee";
  makeCell(userId, { owner: "late@example.com" });
  const router = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal(router.resolve("bot-late").email, null);
  const db = new Database(path.join(tmp, userId, "data", "data", "app.db"));
  db.prepare("INSERT INTO bots (id) VALUES ('bot-late')").run();
  db.close();
  // The negative cache still holds…
  assert.equal(router.resolve("bot-late").email, null);
  // …and a fresh router (expired cache) finds it.
  const fresh = createBotWebhookRouter({ dataRoot: tmp, openDb: (p) => new Database(p, { readonly: true }) });
  assert.equal(fresh.resolve("bot-late").email, "late@example.com");
});
