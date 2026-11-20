#!/usr/bin/env node
// ── Tuning scorecard route tests (add-bench-verdict-read-face) ───────────────
//
// What these pin, in the order each one used to break:
//   • unconfigured ≠ empty. An absent BENCH_URL must not render as "no verdicts
//     yet" — those two states send the owner to different places.
//   • `inconclusive` counted apart from failures. Folding them into "未通过"
//     teaches the owner to read the number in the wrong direction.
//   • the subject KIND matters. "builder" the preset and "builder" the pack are
//     different objects (different rulers); matching on key alone merges them.
//   • pure read: no write path, no evaluation triggered.
//
// No sockets, no real cell DB: both collaborators come through the route's
// `ctx.benchVerdictDeps` seam.

import assert from "node:assert/strict";
import { test } from "node:test";

const { createTuningVerdictRoutes } = await import("../server/tuning-verdict-routes.js");

function v(over) {
  return { subject_kind: "preset", subject_key: "x", outcome: "pass", provisional: false, ...over };
}

const ENV_OK = {
  BENCH_URL: "http://bench.test",
  BENCH_CONSUMER_TOKEN: "token",
  BENCH_PROPOSAL_DOMAIN: "legal",
};

/** Run the real handler with injected collaborators; restore env afterwards. */
async function callRoute({ env = {}, tables = {}, listed = [], listError = null, user } = {}) {
  const keys = ["BENCH_URL", "BENCH_CONSUMER_TOKEN", "BENCH_PROPOSAL_DOMAIN"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (k in env) process.env[k] = env[k];
    else delete process.env[k];
  }
  let handler = null;
  // Minimal express Router double: the module only calls `router.get(path, h)`.
  const app = { use(_prefix, router) { handler = router.__handlers.get.handler; } };
  const queries = [];
  createTuningVerdictRoutes(app, {
    authEnabled: false,
    cellUserEmail: "owner@local",
    benchVerdictDeps: {
      getDb: () => ({
        prepare(sql) {
          queries.push(sql);
          const table = /FROM (\w+)/.exec(sql)?.[1];
          return { all: () => (tables[table] ?? []).map((name) => ({ name })) };
        },
      }),
      listVerdicts: async () => {
        if (listError) throw listError;
        return { count: listed.length, verdicts: listed };
      },
    },
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = { user: user ?? { email: "owner@local" }, method: "GET" };
      const res = {
        status(code) { this._code = code; return this; },
        json(body) { resolve({ code: this._code ?? 200, body, queries }); },
      };
      try { handler(req, res); } catch (err) { reject(err); }
    });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("unconfigured names the missing env vars, never an empty ledger", async () => {
  const res = await callRoute({ env: {}, tables: {} });
  assert.equal(res.code, 200);
  assert.equal(res.body.available, false);
  assert.match(res.body.reason, /BENCH_URL/);
  assert.deepEqual(res.body.verdicts, []);
});

test("inconclusive is counted apart from fail", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"], custom_skills: ["quote"] },
    listed: [
      v({ subject_kind: "preset", subject_key: "builder", outcome: "pass" }),
      v({ subject_kind: "skill", subject_key: "quote", outcome: "fail" }),
      v({ subject_kind: "preset", subject_key: "builder", outcome: "inconclusive" }),
    ],
  });
  assert.deepEqual(res.body.counts, { pass: 1, fail: 1, inconclusive: 1 });
});

test("same key under a different kind is a different object", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [
      v({ subject_kind: "preset", subject_key: "builder", outcome: "pass" }),
      v({ subject_kind: "pack", subject_key: "builder", outcome: "fail" }),
    ],
  });
  assert.equal(res.body.verdicts.length, 1);
  assert.equal(res.body.verdicts[0].outcome, "pass");
});

test("an unowned object never reaches the response", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: {},
    listed: [v({ subject_kind: "preset", subject_key: "someone-else", outcome: "pass" })],
  });
  assert.deepEqual(res.body.verdicts, []);
  assert.equal(res.body.counts.pass, 0);
});

test("provisional rows are surfaced, not dropped", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [v({ subject_kind: "preset", subject_key: "builder", provisional: true })],
  });
  assert.equal(res.body.provisionalCount, 1);
  assert.equal(res.body.verdicts[0].provisional, true);
});

test("a peer refusal surfaces its kind so the page can name the fix", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: {},
    listError: Object.assign(new Error("404: the fleet machine surface is not deployed"), {
      kind: "not_deployed",
    }),
  });
  assert.equal(res.body.available, false);
  assert.equal(res.body.kind, "not_deployed");
});

test("the read is pure — no write-shaped query is ever prepared", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [v({ subject_kind: "preset", subject_key: "builder" })],
  });
  for (const sql of res.queries) {
    assert.match(sql.trim(), /^SELECT /i, `unexpected write-shaped query: ${sql}`);
  }
});

test("unauthenticated callers are refused before any peer read", async () => {
  let reached = false;
  const app = { use(_p, router) { handler = router.__handlers.get.handler; } };
  let handler;
  createTuningVerdictRoutes(app, {
    authEnabled: true, // no req.user ⇒ unauthenticated
    benchVerdictDeps: {
      getDb: () => { throw new Error("must not touch the DB"); },
      listVerdicts: async () => { reached = true; return { count: 0, verdicts: [] }; },
    },
  });
  const out = await new Promise((resolve) => {
    const res = { status(code) { this._code = code; return this; }, json(b) { resolve({ code: this._code, b }); } };
    handler({ method: "GET" }, res);
  });
  assert.equal(out.code, 401);
  assert.equal(reached, false);
});

// ── baseline comparison states ──────────────────────────────────────────────

test("no baseline recorded reads as no-baseline, never as progress", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [
      v({ id: 2, subject_kind: "preset", subject_key: "builder", baseline_run_id: null, n_passed: 3 }),
    ],
  });
  const s = res.body.subjects[0];
  assert.equal(s.comparison, "no-baseline");
  assert.equal(s.delta, null, "an unbaselined run has no delta to show");
});

test("a different ruler digest is a migration, not a comparison", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [
      v({ id: 3, subject_kind: "preset", subject_key: "builder", baseline_run_id: 2,
          ruler_digest: "b".repeat(64), n_passed: 3 }),
      v({ id: 2, subject_kind: "preset", subject_key: "builder",
          ruler_digest: "a".repeat(64), n_passed: 1 }),
    ],
  });
  const s = res.body.subjects[0];
  assert.equal(s.comparison, "ruler-migrated");
  assert.equal(s.delta, null, "a number here would invite the forbidden comparison");
});

test("same ruler digest yields a comparable delta", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [
      v({ id: 5, subject_kind: "preset", subject_key: "builder", baseline_run_id: 4,
          ruler_digest: "c".repeat(64), n_passed: 4 }),
      v({ id: 4, subject_kind: "preset", subject_key: "builder",
          ruler_digest: "c".repeat(64), n_passed: 2 }),
    ],
  });
  const s = res.body.subjects[0];
  assert.equal(s.comparison, "comparable");
  assert.equal(s.delta, 2);
  assert.equal(s.latestId, 5);
  assert.equal(s.baselineId, 4);
});

// ── legacy-only rows (measured on production 2026-11-18) ────────────────────

test("rows with no identity are reported as unattributed, not as absent", async () => {
  // Production held 6 rows, all legacy (subject_kind null). "You have no
  // verdicts" and "the bench has 6 verdicts that predate object identity" lead
  // the owner to different places; the payload must distinguish them.
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [
      v({ id: 9, subject_kind: null, subject_key: null, outcome: null }),
      v({ id: 8, subject_kind: null, subject_key: null, outcome: null }),
    ],
  });
  assert.equal(res.body.available, true);
  assert.equal(res.body.peerRows, 2);
  assert.equal(res.body.unattributed, 2);
  assert.deepEqual(res.body.verdicts, []);
});

test("a ledger row is not counted as unattributed", async () => {
  const res = await callRoute({
    env: ENV_OK,
    tables: { user_presets: ["builder"] },
    listed: [v({ id: 30, subject_kind: "preset", subject_key: "builder", outcome: "pass" })],
  });
  assert.equal(res.body.peerRows, 1);
  assert.equal(res.body.unattributed, 0);
  assert.equal(res.body.verdicts.length, 1);
});
