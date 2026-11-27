// Unified audit timeline (unify-im-solution 4.3): "what did we say / do about X"
// answered from ONE face, merging outbound_ledger (said) + action_audit (did).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the store: the counts here are EXACT ("length === 2"), so sharing a
// database with any other run makes them depend on whatever was left behind.
// `DB_PATH` is frozen at module load, so it must be set before the import.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "audit-timeline-")), "app.db");

import * as db from "../db.js";

await db.initDb();
const raw = db.getDb();

test("empty for an unknown subject", () => {
  assert.deepEqual(db.listAuditTimeline({ subject: "nobody-here" }), []);
});

test("merges said + did for the same subject, newest first", () => {
  // one speech row (outbound_ledger, INTEGER ms)
  db.insertOutboundLedger({ channel: "bot", principal: "a@x", audience: "slack:acme", discloseLevel: "public", contentDigest: "aa" });
  // one action row (action_audit, TEXT ISO) — older, so it sorts after
  raw.prepare(
    `INSERT INTO action_audit (line, action_id, args_digest, risk, target, impact_text, result_summary, created_at)
     VALUES ('lex','send','dd','low','acme','x','done', ?)`,
  ).run(new Date(Date.now() - 60_000).toISOString());

  const t = db.listAuditTimeline({ subject: "acme" });
  assert.equal(t.length, 2);
  const kinds = t.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ["did", "said"]);
  // newest first: the speech row (now) precedes the action (60s ago)
  assert.equal(t[0].kind, "said");
  assert.ok(t[0].ts >= t[1].ts);
});

test("subject filters both tables (an unrelated target is excluded)", () => {
  raw.prepare(
    `INSERT INTO action_audit (line, action_id, args_digest, risk, target, impact_text, result_summary, created_at)
     VALUES ('lex','send','dd','low','other-co','x','done', ?)`,
  ).run(new Date().toISOString());
  const t = db.listAuditTimeline({ subject: "acme" });
  assert.equal(t.filter((r) => r.subject_line.includes("acme")).length, t.length);
  assert.equal(t.some((r) => r.subject_line === "other-co"), false);
});

test("exact audience scopes the speech side; action_audit keys on target not audience", () => {
  // `audience` filters outbound_ledger only — action_audit has no audience
  // column (it keys on target), so with audience-only the action rows still
  // surface. Use subject to span both, or target to scope actions.
  const speechOnly = db.listAuditTimeline({ audience: "slack:acme" }).filter((r) => r.kind === "said");
  assert.ok(speechOnly.length >= 1);
  assert.ok(speechOnly.every((r) => r.subject_line === "slack:acme"));
  // target scopes action_audit exactly.
  const byTarget = db.listAuditTimeline({ target: "acme" }).filter((r) => r.kind === "did");
  assert.ok(byTarget.length >= 1);
  assert.ok(byTarget.every((r) => r.subject_line === "acme"));
});

// ── The four retrieval paths the spec names (bot-outbound-accountability 2.3)
// principal / subject / disclose level / revocability — each must actually
// narrow the result, not be accepted and ignored.
test("each of the four named retrievals narrows the speech side", () => {
  const mine = db.listAuditTimeline({ principal: "a@x" }).filter((r) => r.kind === "said");
  assert.ok(mine.length >= 1);
  assert.ok(mine.every((r) => r.principal === "a@x"), "principal must be honoured");

  // Two rows at DIFFERENT levels, so an ignored filter returns the other one and
  // the assertion is not vacuously true (it was: the fixture had one row, so
  // dropping the clause changed nothing — caught by the negative control).
  db.insertOutboundLedger({ channel: "bot", principal: "a@x", audience: "slack:acme", discloseLevel: "internal", contentDigest: "bb" });
  const byLevel = db.listAuditTimeline({ discloseLevel: "public" }).filter((r) => r.kind === "said");
  assert.ok(byLevel.length >= 1);
  assert.ok(byLevel.every((r) => r.discloseLevel === "public"), "disclose level must be honoured");
  assert.ok(!byLevel.some((r) => r.discloseLevel === "internal"), "the internal row must NOT leak into a public query");

  // The fixture above wrote one row with a future `reversibleUntil`; nothing
  // else in this file sets one, so the two answers must be disjoint and cover
  // every speech row.
  const open = db.listAuditTimeline({ revocable: true }).filter((r) => r.kind === "said");
  const closed = db.listAuditTimeline({ revocable: false }).filter((r) => r.kind === "said");
  assert.ok(open.every((r) => Number.isFinite(r.reversibleUntil) && r.reversibleUntil > Date.now()));
  assert.ok(closed.every((r) => !Number.isFinite(r.reversibleUntil) || r.reversibleUntil <= Date.now()));
  assert.equal(open.length + closed.length, db.listAuditTimeline({}).filter((r) => r.kind === "said").length,
    "revocable=true/false together cover every speech row (no row is in neither)");
});

test("the text itself is never stored — only its digest", () => {
  // A row without a digest is not recordable: it would answer "we said
  // something" with nothing verifiable.
  assert.throws(() => db.insertOutboundLedger({ channel: "bot", principal: "p", audience: "a", discloseLevel: "public" }),
    /contentDigest/, "a digest is required");
  const cols = raw.prepare("PRAGMA table_info(outbound_ledger)").all().map((c) => c.name);
  assert.ok(cols.includes("content_digest"));
  assert.equal(cols.some((c) => /^(text|body|content|message)$/.test(c)), false,
    "no column may hold the utterance itself");
});

test("a null disclose level is recorded as undeclared, not as the string \"undefined\"", () => {
  // The gate yields `discloseLevel: null` when a disclosure verdict failed.
  // Dropping the row would erase the speech; writing String(null) would store
  // "null". Both lose the fact — "we said it without establishing a level" is
  // itself the fact worth keeping.
  db.insertOutboundLedger({ channel: "wecom", principal: "p@x", audience: "wecom:zz", discloseLevel: null, contentDigest: "cc" });
  const row = raw.prepare("SELECT disclose_level AS lvl FROM outbound_ledger WHERE audience = ?").get("wecom:zz");
  assert.equal(row.lvl, "undeclared");
  // And a truly missing mandatory field is refused rather than coerced.
  assert.throws(() => db.insertOutboundLedger({ audience: "a", contentDigest: "d" }), /requires (channel|principal)/);
});
