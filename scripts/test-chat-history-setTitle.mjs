// Unit tests for chat-history.setTitle (chat-main-page-polish change C).
//
// Exercises the contract scenarios from tasks.md 8.7:
//   - happy path: title updated, updated_at bumped
//   - reject empty / overlong / control-character titles
//   - reject unknown id (not_found)

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-setTitle-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();
assert.ok(db.isDbReady());

const S1 = "s-" + Date.now();
const S2 = "s-" + Date.now() + "-b";
const t0 = new Date("2024-01-01T00:00:00Z").toISOString();
db.upsertSession(S1, "original", t0, t0);
db.upsertSession(S2, "untouched", t0, t0);

test("happy path: setTitle returns the trimmed value and bumps updated_at", () => {
  const out = chatHistory.setTitle(S1, "  My new title  ");
  assert.equal(out, "My new title");
  const meta = db.getSessionMeta(S1);
  assert.equal(meta.title, "My new title");
  assert.notEqual(meta.updatedAt, t0, "updated_at should be bumped");
});

test("rejects empty title with code 'empty'", () => {
  assert.throws(() => chatHistory.setTitle(S1, "   "), (err) => err.code === "empty");
  assert.throws(() => chatHistory.setTitle(S1, ""), (err) => err.code === "empty");
  assert.throws(() => chatHistory.setTitle(S1, null), (err) => err.code === "empty");
});

test("rejects overlong title with code 'too_long'", () => {
  const big = "x".repeat(201);
  assert.throws(() => chatHistory.setTitle(S1, big), (err) => err.code === "too_long");
});

test("accepts the boundary length (200 chars)", () => {
  const ok = "y".repeat(200);
  const out = chatHistory.setTitle(S1, ok);
  assert.equal(out, ok);
});

test("rejects control characters with code 'control_chars'", () => {
  assert.throws(() => chatHistory.setTitle(S1, "hi\nthere"), (err) => err.code === "control_chars");
  assert.throws(() => chatHistory.setTitle(S1, "tab\there"), (err) => err.code === "control_chars");
  assert.throws(() => chatHistory.setTitle(S1, "nul\0here"), (err) => err.code === "control_chars");
});

test("rejects unknown id with code 'not_found'", () => {
  assert.throws(
    () => chatHistory.setTitle("nope-" + Date.now(), "x"),
    (err) => err.code === "not_found",
  );
});

test("rejects missing id with code 'not_found'", () => {
  assert.throws(() => chatHistory.setTitle("", "x"), (err) => err.code === "not_found");
});

test("does not modify other sessions", () => {
  chatHistory.setTitle(S1, "renamed again");
  const meta = db.getSessionMeta(S2);
  assert.equal(meta.title, "untouched");
});
