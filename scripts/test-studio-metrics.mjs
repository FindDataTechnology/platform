#!/usr/bin/env node
// ── studio metrics contract tests (add-agent-builder-workspace 8.4) ─────────
// Source assertions: all seven metric points are wired in the page, the ring
// is bounded, and the aggregator computes the three spec'd numbers from a
// known fixture (golden values).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const page = fs.readFileSync(path.join(root, "web/src/pages/AgentStudioPage.tsx"), "utf8");
const panel = fs.readFileSync(path.join(root, "web/src/components/studio/ValidationPanel.tsx"), "utf8");
const lib = fs.readFileSync(path.join(root, "web/src/lib/studio-metrics.ts"), "utf8");

test("8.4: all metric points wired", () => {
  for (const needle of [
    'type: "doc_created"', 'type: "emit", at: Date.now(), docId: doc.id, emit: "preset"',
    'type: "emit", at: Date.now(), docId: doc.id, emit: "draft"',
    'type: "validation_error_seen"', 'type: "cast"', 'type: "deploy"',
  ]) assert.ok(page.includes(needle), `page misses ${needle}`);
  assert.ok(panel.includes('type: "validation_jump"'), "panel misses jump metric");
  assert.ok(lib.includes("MAX_EVENTS = 2000"), "the ring is bounded");
});

test("8.4: aggregator golden values from a known fixture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-metrics-"));
  const file = path.join(dir, "m.json");
  fs.writeFileSync(file, JSON.stringify([
    { type: "doc_created", at: 1_000_000, docId: "d1", kind: "team" },
    { type: "validation_error_seen", at: 1_020_000, docId: "d1", count: 2 },
    { type: "validation_jump", at: 1_050_000, docId: "d1" },
    { type: "emit", at: 1_900_000, docId: "d1", emit: "preset" },
    { type: "cast", at: 2_000_000, docId: "d1", packId: "pk_1" },
    { type: "deploy", at: 2_100_000, docId: "d1", fleetId: "f1" },
  ]));
  const out = execFileSync("node", [path.join(root, "scripts/aggregate-studio-metrics.mjs"), file], { encoding: "utf8" });
  assert.match(out, /median 15\.0m \(n=1\)/, "ttfe = 1,900,000-1,000,000 = 900s");
  assert.match(out, /1\/1 episodes \(100%\)/, "the single seen-episode is closed by its jump");
  assert.match(out, /1\/1 \(100%\)/, "cast→deploy");
  fs.rmSync(dir, { recursive: true, force: true });
});
