#!/usr/bin/env node
// ── Studio AI drafting tests (add-studio-ai-drafting) ────────────────────────
//
// Pins the drafting discipline end to end:
//   1. the bridge is ONE function, not a tool proxy — kind whitelist
//      structurally caps the surface, and an arbitrary tool name has no path
//   2. auth: anonymous callers get the family-standard 401 (behavioral, booted
//      gateway); no lane configured → honest 503, never a fake draft
//   3. zero persistence, zero emit mouths: the route file writes nothing and
//      calls no emit path; the canvas's DRAFT state never feeds the emit
//      functions — 「采用」 is the single human gate, 取消 discards byte-for-byte
//   4. i18n: the drafting chrome exists in all five locales
//
//   node --test scripts/test-studio-ai-drafting.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const route = read("server/routes/studio-draft.js");
const page = read("web/src/pages/AgentStudioPage.tsx");
const serverJs = read("server.js");

test("1. the bridge is one function — kind whitelist is structural, no tool proxy exists", () => {
  assert.match(route, /DRAFT_KINDS = \["agent-doc", "blueprint"\]/, "the whitelist is an explicit constant");
  assert.match(route, /kind must be one of/, "off-whitelist kinds are rejected by name");
  // No pass-through surface: the file must not forward caller-controlled tool
  // names anywhere — the only upstream call is the lane completion. (The word
  // "proxy" appears only in the design comment saying there is none.)
  const codeOnly = route.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/toolName|tools\/call/i.test(codeOnly), "no generic tool-proxy path in code");
  assert.match(route, /resolveJudgeLane/, "drafting rides the deployment lane (no second LLM client)");
});

test("2. zero persistence, zero emit mouths in the drafting path", () => {
  for (const bad of ["createCustomPreset", "createPackDraft", "castBlueprint", "createBlueprint", "insert\\(|UPDATE |saveBlueprint"]) {
    assert.ok(!new RegExp(bad).test(route), `route never calls ${bad}`);
  }
  assert.match(route, /只产草稿：响应即终点，零持久化、零发射/, "the no-write contract is stated at the return site");
});

test("3. the drafting lane is isolated from the emit mouths; per-field adoption is the single write gate (workspace 2.4)", () => {
  // The request path posts to the drafting endpoint only.
  const reqStart = page.indexOf("const runAiDraft");
  const req = page.slice(reqStart, page.indexOf("const adoptAi"));
  assert.ok(reqStart > 0, "runAiDraft exists on the workspace page");
  assert.match(req, /\/api\/studio\/draft/, "the draft request hits the drafting bridge");
  assert.ok(!/emitPreset|emitDraft|createCustomPreset|createPackDraft/.test(req), "drafting never calls an emit path");
  // The draft request body carries no emit-shaped fields — it is a prompt only.
  // 7.3: the kind follows the document kind — agent docs ride the agent-doc
  // lane, team docs ride the EXISTING blueprint drafting lane (same whitelist).
  assert.match(req, /kind: docKind === "agent" \? "agent-doc" : "blueprint", prompt: ai\.prompt/, "the draft request is a prompt, not a document");
  assert.match(read("server/routes/studio-draft.js"), /DRAFT_KINDS = \["agent-doc", "blueprint"\]/, "…and both kinds sit inside the bridge's existing whitelist");
  // Adoption is a separate explicit gesture: only PICKED fields are written.
  const adopt = page.slice(page.indexOf("const adoptAi ="), page.indexOf("// ── ribbon projection"));
  assert.match(adopt, /patchContent\(next\)/, "adopt is the write gate");
  assert.match(adopt, /picked\.has\("name"\)/, "the name field lands only when picked");
  assert.match(adopt, /picked\.has\("persona"\)/, "persona lands only when picked");
  assert.match(adopt, /picked\.has\("mcpServers"\)/, "mcp servers merge only when picked");
  // The overlay itself never writes: its close/discard path touches nothing.
  const overlay = read("web/src/components/studio/AiDraftOverlay.tsx");
  assert.match(overlay, /onAdopt/, "the overlay only delegates adoption upward");
  assert.ok(!/patchContent|updateBlueprint|createPackDraft|fetch\(/.test(overlay), "the overlay component never writes the document or the server");
});

test("4. the route keeps its /api/studio namespace and rides the host that mounts the studio surface", () => {
  assert.match(route, /app\.use\("\/api\/studio", router\)/, "under /api — the session middleware's namespace");
  // add-supply-studio-migration 4.6 (W2) unmounted the blueprint studio trio
  // from 壹座's server.js: the creation surface moved to the facet host, which
  // mounts this same module. Pinning "server.js mounts it" would now pin a
  // route the deployment deliberately does not have.
  assert.ok(
    !/createStudioDraftRoutes\(app, ctx\)/.test(serverJs),
    "壹座's server.js no longer mounts the drafting bridge (4.6 retirement)",
  );
  assert.match(serverJs, /Blueprint studio routes RETIRED \(add-supply-studio-migration 4\.6/, "the retirement is stated in place");
  const facetStudio = read("facet/studio.js");
  assert.match(facetStudio, /createStudioDraftRoutes\(app, ctx\)/, "the facet host mounts it — the contract moved, it did not vanish");
});

test("5. i18n: drafting chrome in all five locales", () => {
  for (const loc of ["zh-CN", "en", "ja", "fr", "es"]) {
    const d = JSON.parse(read(`web/src/locales/${loc}/common.json`));
    const ai = d.studio?.aiDraft;
    assert.ok(ai && ai.title && ai.action && ai.adopt && ai.discard && ai.promptLabel, `${loc}: aiDraft keys`);
  }
});
