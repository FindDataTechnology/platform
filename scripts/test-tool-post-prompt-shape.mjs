#!/usr/bin/env node
// ── Tool-post prompt shape rejected at creation (fix-cell-turn-throughput 4.1) ─
//
// 2026-11-08 live: 4 tasks on one cell failed EVERY fire with
//   "tool post promptTemplate must be a JSON object — it is the tool's arguments"
// Each is a deterministic misconfiguration — no retry can ever fix it, so the
// only useful place to fail is creation time.
//
// `server/tool-turn.js` still keeps its runtime check (a pre-existing task must
// fail honestly), but `addJob` now refuses the same shape up front.
//
//   node --test scripts/test-tool-post-prompt-shape.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Isolate cron storage before the module freezes its paths at load.
process.env.CRON_STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "toolpost-shape-"));

const cron = await import(path.join(here, "../cron.js"));

// addJob goes through the engine, which must be initialised first. The
// scheduler it arms keeps the process alive, so the suite shuts it down.
await cron.initCron({
  broadcast: () => {},
  runJobTurn: () => Promise.resolve({ ok: true }),
  isBusy: () => false,
});
test.after(() => {
  try {
    cron.shutdown();
  } catch { /* already down */ }
});

const base = {
  cron: "0 9 * * *",
  preset: "websearch::web_search",
  tool: "websearch::web_search",
  sessionTitle: "shape-test",
};

test("a tool post whose prompt is not a JSON object is rejected at creation", async () => {
  await assert.rejects(
    () => cron.addJob({ ...base, prompt: "just some prose" }),
    (err) => /tool post prompt must be a JSON object/.test(err.message),
  );
});

test("a JSON array is not an object and is rejected", async () => {
  await assert.rejects(
    () => cron.addJob({ ...base, prompt: '["a","b"]' }),
    (err) => /tool post prompt must be a JSON object/.test(err.message),
  );
});

test("a bare JSON scalar is rejected", async () => {
  await assert.rejects(
    () => cron.addJob({ ...base, prompt: '"string"' }),
    (err) => /tool post prompt must be a JSON object/.test(err.message),
  );
});

test("a JSON object prompt is accepted", async () => {
  const job = await cron.addJob({ ...base, prompt: '{"query":"hello"}' });
  assert.ok(job?.id, "the task is created");
});

test("a persona post is unaffected — prose prompts stay legal", async () => {
  const job = await cron.addJob({
    cron: "0 10 * * *",
    prompt: "普通的人格岗位提示词，不是 JSON",
    preset: "some-persona",
    sessionTitle: "persona-shape-test",
  });
  assert.ok(job?.id, "persona prompts are not JSON and must stay allowed");
});

// ── fix-cron-preset-shape: `server::tool` in `preset` without `tool` ─────────
//
// The other half of the same "creation face must agree with the execution face"
// rule. Measured 2026-11-14 (cell 1da519d4c1c0bf89, member_turn_events 8062 rows):
// `source=cron` rows carrying `Unknown agent preset: websearch::web_search` —
// 12 of them, latest 2026-11-13T03:05:45Z. `addJob` normalized `preset` verbatim
// and, with no `tool` given, classified the job as `targetType: "persona"`, so
// every fire died at the executor. No caller in THIS repo passes that shape
// (`grep -rn "preset:.*::"` → 0), so the fix cannot live at a call site: the
// caller is outside the repo (POST /api/cron/jobs, WS cron_add).
//
// The predicate is `::` alone, which is safe by construction: runtime persona ids
// are `[a-z0-9-]` only, so no real persona can contain it.

test("a tool reference passed as `preset` (no `tool`) is rejected at creation", async () => {
  const before = (await cron.listJobs?.({}) ?? []).length;
  await assert.rejects(
    () => cron.addJob({ cron: "0 9 * * *", preset: "websearch::web_search", prompt: "{}", sessionTitle: "bad-preset-shape" }),
    (err) => /looks like a tool reference/.test(err.message) && /websearch::web_search/.test(err.message),
    "a `::` preset without `tool` must be refused, not silently classified as a persona",
  );
  const after = (await cron.listJobs?.({}) ?? []).length;
  assert.equal(after, before, "no job may be created by the rejected call");
});

test("the correct tool-post spelling still creates a tool target", async () => {
  const job = await cron.addJob({
    cron: "0 11 * * *",
    prompt: '{"query":"hello"}',
    tool: "websearch::web_search",
    sessionTitle: "tool-shape-ok",
  });
  assert.ok(job?.id);
  // The client shape strips some internals — assert on the RAW record, the same
  // face the executor reads (`getTaskRecord` exists for exactly this: "tests
  // that need to assert evidence").
  const record = (await import(path.join(here, "../task-engine.js"))).getTaskRecord(job.id);
  assert.equal(record.targetType, "tool");
  assert.equal(record.preset, "websearch::web_search");
});

test("the EDIT face refuses the same shape (a healthy job cannot be re-pointed into it)", async () => {
  const job = await cron.addJob({
    cron: "0 13 * * *",
    prompt: "prose",
    preset: "policy-brief",
    sessionTitle: "edit-face",
  });
  assert.ok(job?.id);
  await assert.rejects(
    () => cron.updateJob(job.id, { preset: "websearch::web_search" }),
    (err) => /looks like a tool reference/.test(err.message),
    "updateJob rebinds targetType to persona with `preset` verbatim — it must ask the same question addJob asks",
  );
  // The record must be untouched by the rejected call.
  const record = (await import(path.join(here, "../task-engine.js"))).getTaskRecord(job.id);
  assert.equal(record.preset, "policy-brief");
  assert.equal(record.targetType, "persona");
  // The legitimate rebind to a tool post still works.
  const rebound = await cron.updateJob(job.id, { tool: "websearch::web_search", prompt: '{"query":"x"}' });
  assert.ok(rebound, "rebinding TO a tool post is the correct spelling and must pass");
  const after = (await import(path.join(here, "../task-engine.js"))).getTaskRecord(job.id);
  assert.equal(after.targetType, "tool");
});

test("ordinary ids are not swept up by the `::` rule", async () => {
  const a = await cron.addJob({ cron: "0 12 * * *", prompt: "prose", preset: "policy-brief", sessionTitle: "plain-persona" });
  assert.ok(a?.id, "a plain persona id keeps working");
  const b = await cron.addJob({ cron: "0 12 * * *", prompt: "prose", preset: "user.preset-7", sessionTitle: "dotted-persona" });
  assert.ok(b?.id, "a dotted user-preset id keeps working");
});

