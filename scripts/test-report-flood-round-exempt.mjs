#!/usr/bin/env node
// ── A round's first report is never swallowed by the flood window ───────────
//
// Live 2026-11-09 (openspec: fix-fleet-report-delivery): the proposal post
// produced a fully correct report — three slots, `proposals_rejected` carrying
// "未取得（decision_queue 403），非 0 拒" plus the previous round's un-repeated
// items for the owner to reconcile — and the server rejected it wholesale:
//
//   report limit reached (3 per 720 minutes) — next window at …
//
// The third slot had been consumed by a `summary:"probe"` report filed from a
// platform chat session. The ledger kept an empty `metrics:{}` row, so the
// symptom read as "the model never reported" and cost a full forensic detour.
//
// The invariant pinned here: flood control throttles a post that keeps
// re-reporting WITHIN a round, never a round that has not reported yet.
//
//   node --test scripts/test-report-flood-round-exempt.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { checkFlood, floodWindowMs } = await import(path.join(here, "../server/fleet-reports.js"));

const WINDOW = 720 * 60 * 1000; // a daily cadence: half a period = 12h
const NOW = 1_800_000_000_000;

test("window math: a daily cadence yields a 12h window (not the 10min floor)", () => {
  // cronPeriodMs is the window's only input besides the floor.
  const day = 24 * 60 * 60 * 1000;
  assert.equal(floodWindowMs({ cron: "0 9 * * *", tz: "UTC" }, () => day), WINDOW);
});

test("the round's first report passes even when the window is full", () => {
  const out = checkFlood({
    countSince: 3, // full: three reports already in the window
    roundReports: 0, // …but none from THIS round
    windowMs: WINDOW,
    now: NOW,
    oldestInWindowAt: NOW - 1000,
  });
  assert.equal(out.ok, true, "a round that has not reported yet must never be throttled");
});

test("a second report in the same round is still throttled once the window is full", () => {
  const out = checkFlood({
    countSince: 3,
    roundReports: 1,
    windowMs: WINDOW,
    now: NOW,
    oldestInWindowAt: NOW - 1000,
  });
  assert.equal(out.ok, false, "flood control still applies within a round");
  assert.match(out.error, /report limit reached \(3 per 720 minutes\)/);
  assert.equal(out.windowResetsAt, NOW - 1000 + WINDOW, "reset = oldest in window + window");
});

test("below the cap, reports are unaffected regardless of round count", () => {
  const out = checkFlood({ countSince: 2, roundReports: 2, windowMs: WINDOW, now: NOW });
  assert.equal(out.ok, true);
});

test("the live incident shape: 2 real + 1 stray probe ⇒ the next round still reports", () => {
  // Reports at 01:53 and 07:41 (real rounds), then a probe at 11:51 from a
  // platform session. The proposal post's 11:52 round had filed nothing yet.
  const reports = [
    { createdAt: NOW - 10 * 3600_000, sessionId: "cron-job_A" },
    { createdAt: NOW - 4 * 3600_000, sessionId: "cron-job_B" },
    { createdAt: NOW - 60_000, sessionId: "platform-probe" },
  ];
  const inWindow = reports.filter((r) => r.createdAt > NOW - WINDOW);
  const roundReports = inWindow.filter((r) => r.sessionId === "cron-job_C").length;
  const out = checkFlood({
    countSince: inWindow.length,
    roundReports,
    windowMs: WINDOW,
    now: NOW,
    oldestInWindowAt: inWindow[0].createdAt,
  });
  assert.equal(out.ok, true, "the honest round must land despite the stray probe filling the window");
});
