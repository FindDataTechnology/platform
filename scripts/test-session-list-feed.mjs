// Unit tests for the session-list feed filter (openspec: slim-session-list-feed,
// task 5.1–5.3).
//
// The lived problem: 99% of `chat_sessions` rows are automation records — one
// per scheduled round (`cron-<taskId>--r<ts>`), per cluster member
// (`cron-<id>--<agentKey>`), per a2a delegation (`task-<id>`). The user-facing
// feed shipped all of them (1.6 MB, three times, on every cold open) while the
// sidebar rendered five.
//
// Runs against an isolated DB_PATH under os.tmpdir().

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-feed-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.SESSIONS_STORE_DIR = path.join(tmpRoot, "sessions-store");
fs.mkdirSync(process.env.SESSIONS_STORE_DIR, { recursive: true });

const db = await import("../db.js");
const chatHistory = await import("../chat-history.js");

await db.initDb();

// Seed one row per shape, all owned by the same (auth-off) deployment.
const HUMAN = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const AUTOMATED = [
  "cron-task_1794000000000_abc123", // schedule base session
  "cron-task_1794000000000_abc123--r1795173240122", // one scheduled round
  "cron-task_1794000000000_abc123--researcher", // one cluster member
  "task-task_1794000000000_def456", // an a2a delegation
];
const ids = [...HUMAN, ...AUTOMATED];
for (const id of ids) chatHistory.createSession(id);
ids.forEach((id, i) => {
  chatHistory.recordMessage(id, "user", `message ${i}`);
});

const listIds = (scope) =>
  db.listChatSessions(scope).map((s) => s.id);

test("5.1 excludeAutomated drops cron-/task- rows and keeps human ones", () => {
  const all = listIds();
  assert.equal(all.length, ids.length, "the unfiltered list still returns everything");

  const filtered = listIds({ excludeAutomated: true });
  assert.deepEqual(
    filtered.sort(),
    [...HUMAN].sort(),
    "only the human sessions survive the feed filter",
  );
});

test("5.1 the filter is opt-in — an absent flag is byte-identical to today", () => {
  assert.deepEqual(listIds().sort(), [...ids].sort());
  assert.deepEqual(listIds({}).sort(), [...ids].sort());
});

test("5.1 the owner scope and the automation filter compose", () => {
  db.stampSessionOwner(HUMAN[0], "alice@example.com");
  db.stampSessionOwner(AUTOMATED[0], "alice@example.com");

  const alice = listIds({ owner: "alice@example.com", excludeAutomated: true });
  assert.deepEqual(alice, [HUMAN[0]], "owner scope applies, then automation is dropped");
});

test("5.2 the automated-prefix list is the single source of truth", () => {
  // Every seeded automation id must be covered by a declared prefix; a future
  // session kind that forgets to register its prefix fails here instead of
  // silently flooding the sidebar.
  for (const id of AUTOMATED) {
    assert.ok(
      db.AUTOMATED_SESSION_PREFIXES.some((p) => id.startsWith(p)),
      `${id} is not covered by AUTOMATED_SESSION_PREFIXES (${db.AUTOMATED_SESSION_PREFIXES.join(", ")}) — register its prefix`,
    );
  }
  // ...and no human session may accidentally match one.
  for (const id of HUMAN) {
    assert.ok(
      !db.AUTOMATED_SESSION_PREFIXES.some((p) => id.startsWith(p)),
      `human session ${id} would be filtered out by prefix ${db.AUTOMATED_SESSION_PREFIXES.find((p) => id.startsWith(p))}`,
    );
  }
});

test("5.3 ensureSessionInList puts the viewed automation session back", () => {
  const rows = db.listChatSessions({ excludeAutomated: true });
  const viewed = AUTOMATED[1];

  const withViewed = chatHistory.ensureSessionInList(rows, viewed, undefined);
  assert.ok(
    withViewed.some((s) => s.id === viewed),
    "opening a scheduled run from the tasks page must leave a row to name it",
  );
  assert.equal(withViewed.length, rows.length + 1, "exactly one row is added");

  // Idempotent: an already-present session is not duplicated.
  const again = chatHistory.ensureSessionInList(withViewed, viewed, undefined);
  assert.equal(again.length, withViewed.length);
  // Array identity is preserved when nothing is added, so callers can chain.
  assert.equal(again, withViewed);
});

test("5.3 a human viewed session needs no repair", () => {
  const rows = db.listChatSessions({ excludeAutomated: true });
  assert.equal(chatHistory.ensureSessionInList(rows, HUMAN[0], undefined), rows);
});

test("5.3 ensureSessionInList does not leak across an owner scope", () => {
  const rows = db.listChatSessions({ owner: "nobody@example.com", excludeAutomated: true });
  // AUTOMATED[1] is unowned; a scoped requester must not gain a row for it.
  const out = chatHistory.ensureSessionInList(rows, AUTOMATED[1], { owner: "nobody@example.com" });
  assert.equal(out.some((s) => s.id === AUTOMATED[1]), false);
});

test("5.5 repeated refreshes do not grow with the number of automation rows", () => {
  // Pin the regime the change exists to fix: adding automation rounds must not
  // change what the user-facing feed carries.
  const before = db.listChatSessions({ excludeAutomated: true }).length;
  const allBefore = db.listChatSessions().length;
  // Distinct from every seeded id — createSession is idempotent, so a collision
  // would silently create fewer rows than the loop claims (CI caught this).
  for (let i = 0; i < 50; i++) {
    const id = `cron-task_1796000000000_round${i}`;
    chatHistory.createSession(id);
    chatHistory.recordMessage(id, "user", `round ${i}`);
  }
  assert.equal(
    db.listChatSessions({ excludeAutomated: true }).length,
    before,
    "50 more rounds, zero more feed rows",
  );
  assert.equal(db.listChatSessions().length, allBefore + 50, "...while they all exist");
});
