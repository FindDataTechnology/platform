// At-rest encryption for the legacy credential tables
// (openspec: add-user-supplied-credentials — the debt this change inherited).
//
// Two properties, both load-bearing:
//   1. what lands in the column is ciphertext, not the token;
//   2. a row written BEFORE encryption still reads back correctly — the
//      migration must not require a backfill (production has 29 such rows and
//      no window in which to rewrite them all at once).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cred-enc-"));
process.env.PLATFORM_DATA_DIR = tmpRoot;
process.env.CREDENTIAL_SECRET = "test-credential-material";

const db = await import("../db.js");
await db.initDb();

test.after(() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} });

test("registry credential lands as ciphertext, never the token", () => {
  db.setRegistryCredential({ email: "enc@x.io", token: "sk-must-not-be-readable" });
  const raw = db.getDb()
    .prepare("SELECT token FROM user_registry_credentials WHERE email = ?")
    .get("enc@x.io");
  assert.ok(raw, "row stored");
  assert.equal(raw.token.startsWith("v1."), true, "stored value is an envelope");
  assert.equal(raw.token.includes("sk-must-not-be-readable"), false, "plaintext absent from disk");
});

test("reading returns the plaintext token", () => {
  db.setRegistryCredential({ email: "rt@x.io", token: "sk-roundtrip" });
  assert.equal(db.getRegistryCredential("rt@x.io").token, "sk-roundtrip");
});

test("a pre-encryption plaintext row still reads (no backfill needed)", () => {
  const c = db.getDb();
  c.prepare(
    `INSERT INTO user_registry_credentials (email, token, expires_at, stale, source, updated_at)
     VALUES (?, ?, NULL, 0, 'sso', ?)`,
  ).run("legacy@x.io", "sk-legacy-plaintext", new Date().toISOString());
  assert.equal(db.getRegistryCredential("legacy@x.io").token, "sk-legacy-plaintext");
});

test("writing over a legacy row upgrades it to ciphertext", () => {
  db.setRegistryCredential({ email: "upgrade@x.io", token: "sk-first" });
  assert.equal(db.getRegistryCredential("upgrade@x.io").token, "sk-first");
  const raw = db.getDb()
    .prepare("SELECT token FROM user_registry_credentials WHERE email = ?")
    .get("upgrade@x.io");
  assert.equal(raw.token.startsWith("v1."), true);
});

test("every legacy credential table stores ciphertext", () => {
  const c = db.getDb();
  db.setSearchCredential("s@x.io", "sk-search");
  db.setPaperTradingCredential("p@x.io", "sk-paper");
  db.setChatwootCredential({ email: "c@x.io", token: "sk-chatwoot", loginPassword: "pw" });
  db.setLineCredential({ email: "l@x.io", line: "wire-customer", token: "sk-line" });

  const check = (sql, email, label) => {
    const row = c.prepare(sql).get(email);
    assert.ok(row, `${label}: row exists`);
    assert.equal(row.token.startsWith("v1."), true, `${label}: stored as envelope`);
    assert.equal(/^sk-/.test(row.token), false, `${label}: no plaintext prefix`);
  };
  check("SELECT token FROM user_search_credentials WHERE email = ?", "s@x.io", "search");
  check("SELECT token FROM user_paper_trading_credentials WHERE email = ?", "p@x.io", "paper");
  check("SELECT token FROM user_chatwoot_credentials WHERE email = ?", "c@x.io", "chatwoot");
  check("SELECT token FROM user_line_credentials WHERE email = ?", "l@x.io", "line");
});

test("all of them still read back as plaintext", () => {
  assert.equal(db.getSearchCredential("s@x.io").token, "sk-search");
  assert.equal(db.getPaperTradingCredential("p@x.io").token, "sk-paper");
  assert.equal(db.getChatwootCredential("c@x.io").token, "sk-chatwoot");
  assert.equal(db.getLineCredential("l@x.io", "wire-customer").token, "sk-line");
});
