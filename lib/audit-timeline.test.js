// Unified audit timeline (unify-im-solution 4.3): "what did we say / do about X"
// answered from ONE face, merging outbound_ledger (said) + action_audit (did).
import test from "node:test";
import assert from "node:assert/strict";

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
