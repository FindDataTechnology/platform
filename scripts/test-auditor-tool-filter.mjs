#!/usr/bin/env node
// ── Tool-filter doc carries the auditor face (harden-auditor-runtime-face 3.x) ─
//
// Two halves, both about the document `applyMcpToolRestrict` reads at preset
// mount:
//
//   A. WRITE — an auditor preset gets its own `byPreset` section carrying the
//      derived face; absent/empty input leaves the document byte-identical to
//      the pre-change shape.
//   B. READ — a preset with no section falls back to the whole-home map, and
//      that fallback is `{}` ⇒ zero filtering. This test pins that fallback so
//      nobody "fixes" it into something that reads as filtered when it is not;
//      the auditor's protection comes from A, not from B.
//
//   node --test scripts/test-auditor-tool-filter.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { auditorFacesByPreset } = await import(path.join(here, "../dsh-profile.js"));
const { auditorMcpFace, AUDITOR_TOOL_FACE } = await import(path.join(here, "../lib/auditor-tool-face.js"));
// The reader resolves FILTER_FILE at module load, so it is imported only after
// a home is pointed at — see the read half below.

const FACE = auditorMcpFace();

test("1. one section per auditor post, keyed by roster preset id", () => {
  const members = [
    { targetKind: "auditor", targetId: "user.preset-8" },
    { targetKind: "auditor", targetId: "user.deputy-t6ef3t" },
    { targetKind: "persona", targetId: "user.preset-4" },
    { targetKind: "persona", targetId: "user.preset-5" },
  ];
  const faces = auditorFacesByPreset(members, FACE);
  assert.deepEqual(Object.keys(faces).sort(), ["user-deputy-t6ef3t", "user-preset-8"]);
  for (const face of Object.values(faces)) assert.deepEqual(face, FACE);
});

test("2. no auditors ⇒ empty map (the document keeps its pre-change shape)", () => {
  assert.deepEqual(auditorFacesByPreset([{ targetKind: "persona", targetId: "x" }], FACE), {});
  assert.deepEqual(auditorFacesByPreset([], FACE), {});
});

test("3. an unusable face contributes nothing rather than an empty section", () => {
  // An empty section would mean "this preset sees no MCP tools at all" to the
  // reader — a dead watchdog. Nothing is the honest answer.
  const members = [{ targetKind: "auditor", targetId: "user.preset-8" }];
  for (const bad of [null, undefined, {}]) {
    assert.deepEqual(auditorFacesByPreset(members, bad), {});
  }
});

test("4. the section carries the face, not a copy someone can mutate later", () => {
  const members = [{ targetKind: "auditor", targetId: "user.preset-8" }];
  const faces = auditorFacesByPreset(members, FACE);
  faces["user-preset-8"].fleet.push("cron_create");
  assert.deepEqual(auditorFacesByPreset(members, FACE)["user-preset-8"], FACE);
});

test("5. every runtime face tool is on the auditor allowlist (no section-only tools)", () => {
  // The save-time validator checks AUDITOR_ALLOWED_TOOLS; the runtime section
  // must never carry a name that validator would refuse — otherwise a tool
  // works in production but cannot be declared, and the two drift forever.
  // (Test 4 in the other file deliberately mutated a copy; this reads the real
  // frozen face through the accessor.)
  const runtimeTools = new Set(Object.values(auditorMcpFace()).flat());
  const declared = new Set(Object.values(AUDITOR_TOOL_FACE).flat());
  for (const tool of runtimeTools) assert.ok(declared.has(tool), `${tool} 不在允许集里`);
  assert.equal(runtimeTools.has("cron_create"), false);
});

test("6. READ half: a preset with no section falls back to the whole-home map", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "auditor-filter-"));
  const filterFile = path.join(dir, "tool-filter.json");
  writeFileSync(
    filterFile,
    JSON.stringify({
      mcpTools: {},
      byPreset: { "inv-grade-auditor": { mcpTools: { fleet: ["auditor_submit_verdict"] } } },
    }),
  );
  // TOOL_FILTER_PATH is the reader's own re-anchoring seam (the same one its
  // tests use); it is read at module load, hence the cache-busting query.
  process.env.TOOL_FILTER_PATH = filterFile;
  const mod = await import(path.join(here, "../dsh-profile-template/platform-tool-scope.js?readtest"));
  // No section for this preset → the whole-home map, which here is empty. Pinned
  // because "no filter" is exactly what makes the WRITE half load-bearing.
  assert.equal(mod.readMcpToolFilterFor("user-preset-8"), null);
  // A preset that DOES have a section reads its own face (server → Set of names).
  const own = mod.readMcpToolFilterFor("inv-grade-auditor");
  assert.deepEqual([...own.fleet], ["auditor_submit_verdict"]);
});
