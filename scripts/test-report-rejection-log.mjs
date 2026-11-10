#!/usr/bin/env node
// ── Refused reports must be countable by the operator ───────────────────────
//
// fix-fleet-report-delivery 3.1/3.2. The one-shot stash lets a single turn row
// say "the server refused my report", but it cannot answer "is this post being
// refused over and over?" — that needs a window. Without it a post can be
// silently muzzled for the whole flood window and the operator sees only an
// empty ledger.
//
// Pinned here:
//   1. counts accumulate per post inside the window
//   2. entries older than the window age out — on write AND on read
//   3. a post with no refusals is ABSENT, never zero-padded
//   4. the list is bounded (a stuck loop cannot grow memory without limit)
//   5. malformed entries are ignored, not counted
//
//   node --test scripts/test-report-rejection-log.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { recordRejection, prune, summarizeRejections, DEFAULT_WINDOW_MS } = await import(
  path.join(here, "../lib/report-rejection-log.js")
);

const NOW = 1_800_000_000_000;

test("1. refusals accumulate per post inside the window", () => {
  const log = [];
  recordRejection(log, { memberId: "m_a", at: NOW - 1000 }, { now: NOW });
  recordRejection(log, { memberId: "m_a", at: NOW - 500 }, { now: NOW });
  recordRejection(log, { memberId: "m_b", at: NOW - 100 }, { now: NOW });
  const s = summarizeRejections(log, { now: NOW });
  assert.equal(s.total, 3);
  assert.equal(s.byMember.m_a.count, 2);
  assert.equal(s.byMember.m_b.count, 1);
  assert.equal(s.byMember.m_a.lastAt, NOW - 500, "lastAt is the newest refusal, not the oldest");
});

test("2. entries older than the window age out on write", () => {
  const log = [];
  recordRejection(log, { memberId: "m_old", at: NOW - DEFAULT_WINDOW_MS - 1 }, { now: NOW });
  recordRejection(log, { memberId: "m_new", at: NOW }, { now: NOW });
  assert.equal(log.length, 1, "the stale entry is dropped as the new one lands");
  assert.equal(summarizeRejections(log, { now: NOW }).byMember.m_old, undefined);
});

test("3. a window that rolls past every entry reads as empty (no zero-padded rows)", () => {
  const log = [];
  recordRejection(log, { memberId: "m_a", at: NOW }, { now: NOW });
  const later = NOW + DEFAULT_WINDOW_MS + 1;
  const s = summarizeRejections(log, { now: later });
  assert.equal(s.total, 0);
  assert.deepEqual(s.byMember, {});
});

test("4. the log is bounded — a stuck retry loop cannot grow it without limit", () => {
  const log = [];
  for (let i = 0; i < 700; i += 1) recordRejection(log, { memberId: "m_loop", at: NOW + i }, { now: NOW + i });
  assert.ok(log.length <= 500, `expected <=500 entries, got ${log.length}`);
});

test("5. malformed entries are ignored, never counted", () => {
  const log = [];
  recordRejection(log, { memberId: "", at: NOW }, { now: NOW });
  recordRejection(log, null, { now: NOW });
  recordRejection(log, { memberId: "m_ok", at: NOW }, { now: NOW });
  assert.equal(log.length, 1);
  const s = summarizeRejections([...log, { memberId: 42, at: NOW }, null], { now: NOW });
  assert.equal(s.total, 1, "a non-string memberId is not a post");
});

test("6. prune is idempotent and safe on a non-array", () => {
  assert.deepEqual(prune(null, { now: NOW }), []);
  const log = [{ memberId: "m", at: NOW }];
  prune(log, { now: NOW });
  prune(log, { now: NOW });
  assert.equal(log.length, 1);
});
