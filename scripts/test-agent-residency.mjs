#!/usr/bin/env node
// ── Agent residency tests (add-agent-residency, tasks 1.1, 3.x, 4.x, 5.x) ────
//
// Level tests for the resident lifecycle chain, module by module:
//
//   rhythm       — shape parsing and due math (every/daily, tz-correct daily);
//   manifest     — serving.rhythm validation (both shapes, mutual exclusion,
//                  floor, forbidden/unknown keys, do bounds);
//   (later groups land here as tasks 3–5 complete: warm zone, scheduler,
//    rollover.)
//
//   node --test scripts/test-agent-residency.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const rhythm = await import("../lib/rhythm.js");
const { parseEveryMinutes, parseDaily, zonedParts, nextDailyDue, nextDue } = rhythm;
const { validatePackManifest } = await import("../lib/pack-manifest.js");

const BASE_AGENT = { id: "analyst", name: "分析官", persona: "你是分析官。" };
const manifestWith = (serving) => ({
  name: "驻留包",
  skills: [{ name: "s1", description: "d", content: "# c" }],
  agents: [{ ...BASE_AGENT, serving }],
});

// ── rhythm parsing ────────────────────────────────────────────────────────────

test("every parses minutes and hours with a 5m floor", () => {
  assert.equal(parseEveryMinutes("90m"), 90);
  assert.equal(parseEveryMinutes("2h"), 120);
  assert.equal(parseEveryMinutes(" 30m "), 30);
  assert.equal(parseEveryMinutes("3m"), null); // below floor
  assert.equal(parseEveryMinutes("0h"), null);
  assert.equal(parseEveryMinutes("2d"), null); // wrong unit
  assert.equal(parseEveryMinutes(90), null); // wrong type
});

test("daily parses HH:MM within the 24h clock", () => {
  assert.deepEqual(parseDaily("09:30"), { hour: 9, minute: 30 });
  assert.deepEqual(parseDaily("23:59"), { hour: 23, minute: 59 });
  assert.deepEqual(parseDaily("0:05"), { hour: 0, minute: 5 });
  assert.equal(parseDaily("24:00"), null);
  assert.equal(parseDaily("09:60"), null);
  assert.equal(parseDaily("9am"), null);
});

test("zonedParts reads the wall clock in the named zone", () => {
  // 2026-10-02T18:30:00Z is 02:30 on Oct 3 in Asia/Shanghai (UTC+8, no DST).
  const p = zonedParts(new Date("2026-10-02T18:30:00Z"), "Asia/Shanghai");
  assert.equal(p.day, 3);
  assert.equal(p.hour, 2);
  assert.equal(p.minute, 30);
  const u = zonedParts(new Date("2026-10-02T18:30:00Z"), "UTC");
  assert.equal(u.day, 2);
  assert.equal(u.hour, 18);
});

test("nextDailyDue picks today's slot when ahead and tomorrow's when passed", () => {
  // 18:00Z — a 19:00Z (== 03:00+8d Shanghai next day… keep tz simple: UTC) slot is ahead.
  const from = new Date("2026-10-02T18:00:00Z");
  const ahead = nextDailyDue({ hour: 19, minute: 0 }, from, "UTC");
  assert.equal(ahead.toISOString(), "2026-10-02T19:00:00.000Z");
  const passed = nextDailyDue({ hour: 6, minute: 0 }, from, "UTC");
  assert.equal(passed.toISOString(), "2026-10-03T06:00:00.000Z");
});

test("nextDailyDue crosses a timezone offset correctly", () => {
  // 18:00Z == 02:00 next day in Shanghai; a Shanghai 09:00 slot is at 01:00Z on Oct 3.
  const from = new Date("2026-10-02T18:00:00Z");
  const due = nextDailyDue({ hour: 9, minute: 0 }, from, "Asia/Shanghai");
  assert.equal(due.toISOString(), "2026-10-03T01:00:00.000Z");
});

test("nextDue maps interval and daily entries", () => {
  const from = new Date("2026-10-02T00:00:00Z");
  assert.equal(nextDue({ every: "90m" }, from).toISOString(), "2026-10-02T01:30:00.000Z");
  assert.equal(nextDue({ daily: "09:30" }, from, "UTC").toISOString(), "2026-10-02T09:30:00.000Z");
  assert.equal(nextDue({ every: "bogus" }, from), null);
  assert.equal(nextDue({}, from), null);
});

// ── manifest serving.rhythm validation ────────────────────────────────────────

test("both rhythm shapes validate; no rhythm stays valid", () => {
  assert.deepEqual(
    validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ every: "5m" }, { daily: "09:30", do: "巡检数据源并汇总异常" }] })),
    [],
  );
  assert.deepEqual(validatePackManifest(manifestWith({ protocol: "a2a" })), []);
});

test("rhythm entries must carry exactly one of every|daily", () => {
  const both = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ every: "10m", daily: "09:00" }] }));
  assert.ok(both.some((e) => /exactly one/.test(e.error)));
  const neither = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ do: "x" }] }));
  assert.ok(neither.some((e) => /exactly one/.test(e.error)));
});

test("interval floor and daily format are enforced", () => {
  const floor = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ every: "3m" }] }));
  assert.ok(floor.some((e) => /minimum of 5 minutes/.test(e.error)));
  const badDaily = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ daily: "25:00" }] }));
  assert.ok(badDaily.some((e) => /HH:MM/.test(e.error)));
});

test("rhythm cannot smuggle runtime configuration and rejects unknown keys", () => {
  const smuggle = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ every: "10m", model: "gpt-9" }] }));
  assert.ok(smuggle.some((e) => /rhythm declares cadence, not runtime configuration/.test(e.error)));
  const unknown = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ every: "10m", cron: "* * *" }] }));
  assert.ok(unknown.some((e) => /unknown key 'cron'/.test(e.error)));
});

test("rhythm array bounds and do length bounds are enforced", () => {
  const empty = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [] }));
  assert.ok(empty.some((e) => /non-empty array/.test(e.error)));
  const longDo = validatePackManifest(manifestWith({ protocol: "a2a", rhythm: [{ every: "10m", do: "x".repeat(2001) }] }));
  assert.ok(longDo.some((e) => /do must be/.test(e.error)));
});
