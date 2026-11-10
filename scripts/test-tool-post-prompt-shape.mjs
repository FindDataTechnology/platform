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
