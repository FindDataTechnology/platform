// Unit tests — the read face's two dimensions (change add-curation-evidence-gate,
// tasks 2.1 / 2.2 / 2.3).
// Run: node --test scripts/test-curation-readface.mjs
//
// Three properties, each of which was a real failure mode in sibling systems:
//   · supply state and evidence state are ORTHOGONAL — a catalogued plugin can be
//     unsupplied and reviewed, or supplied and unreviewed, and the read face says
//     both;
//   · the market/facet annotation carries the outward summary and never the
//     reviewer;
//   · existing entries without evidence are labelled, not dropped — the supply
//     state they had before is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPluginCatalog, pluginEvidenceState, pluginSupplyState } from "../server/plugin-catalog.js";
import { attachEvidenceSummary } from "../facet/supply-catalog.js";

const tmp = mkdtempSync(path.join(tmpdir(), "curation-readface-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function evidence(over = {}) {
  return {
    axes: {
      security: { verdict: "pass", reason: "只读" },
      licence: { verdict: "pass", reason: "MIT-0" },
      quality: { verdict: "pass", reason: "有用例" },
      P1: { verdict: "pass", reason: "供给面只读" },
      P2: { verdict: "pass", reason: "无运行期下载" },
    },
    pin: { repo: "github.com/acme/tool", tag: "v1.2.0" },
    licence: "MIT-0",
    egress: "none",
    reviewedBy: "ops@acme",
    reviewedAt: "2026-11-01",
    ...over,
  };
}

function catalogFile(plugins) {
  const file = path.join(tmp, `catalog-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
  return file;
}

test("evidence rides through the catalogue reader intact", () => {
  const file = catalogFile([{ id: "pdf-kit", species: "plugin", evidence: evidence() }]);
  const { plugins } = loadPluginCatalog({ env: { PLUGIN_CATALOG_FILE: file } });
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].evidence.reviewedBy, "ops@acme", "the gate needs the whole block");
  assert.equal(plugins[0].species, "plugin");
});

test("supply state and evidence state are orthogonal (2.1)", () => {
  const file = catalogFile([
    { id: "reviewed-but-absent", species: "plugin", evidence: evidence() },
    { id: "supplied-but-unreviewed", species: "plugin" },
  ]);
  const { plugins } = loadPluginCatalog({ env: { PLUGIN_CATALOG_FILE: file } });
  const roster = [{ id: "supplied-but-unreviewed", enabled: true }];

  const absent = plugins.find((p) => p.id === "reviewed-but-absent");
  assert.equal(pluginSupplyState(absent, roster), "unsupplied");
  assert.equal(pluginEvidenceState(absent, { today: "2026-11-12" }).state, "complete");

  const supplied = plugins.find((p) => p.id === "supplied-but-unreviewed");
  assert.equal(pluginSupplyState(supplied, roster), "enabled");
  assert.equal(pluginEvidenceState(supplied, { today: "2026-11-12" }).state, "missing");
});

test("an expired review reads as stale, not as missing or as complete", () => {
  const file = catalogFile([{ id: "aged", species: "plugin", evidence: evidence({ reviewValidUntil: "2026-01-01" }) }]);
  const { plugins } = loadPluginCatalog({ env: { PLUGIN_CATALOG_FILE: file } });
  assert.equal(pluginEvidenceState(plugins[0], { today: "2026-11-12" }).state, "stale");
});

test("entries without evidence are kept and labelled (2.3)", () => {
  const file = catalogFile([
    { id: "legacy-a", name: "A" },
    { id: "legacy-b", name: "B", licence: "Apache-2.0", reviewedAt: "2026-09-01" },
  ]);
  const { plugins } = loadPluginCatalog({ env: { PLUGIN_CATALOG_FILE: file } });
  assert.equal(plugins.length, 2, "nothing is dropped for lacking evidence");
  for (const entry of plugins) {
    assert.equal(pluginEvidenceState(entry).state, "missing");
    assert.equal(pluginSupplyState(entry, []), "unsupplied", "supply state is unchanged by the new rule");
  }
});

test("the facet annotation carries the outward summary and never the reviewer (2.2)", () => {
  // A facade carries the three base axes only: P1/P2 are plugin-specific, and an
  // axis for the wrong species is itself a shape error (test-curation-evidence).
  const facadeEvidence = evidence({
    axes: {
      security: { verdict: "pass", reason: "只读" },
      licence: { verdict: "pass", reason: "MIT-0" },
      quality: { verdict: "pass", reason: "有用例" },
    },
  });
  const raw = { id: "facade-a", evidence: facadeEvidence };
  const row = attachEvidenceSummary({ id: "facade-a" }, raw, { species: "facade", today: "2026-11-12" });
  assert.ok(row.evidence, "summary attached");
  assert.equal(row.evidence.state, "complete");
  assert.equal(row.evidence.licence, "MIT-0");
  const blob = JSON.stringify(row);
  for (const leak of ["ops@acme", "reviewedBy", "reason"]) {
    assert.equal(blob.includes(leak), false, `response must not carry ${leak}`);
  }
});

test("a complete entry still carries its re-review deadline (never an implied 'forever')", () => {
  // A facade carries the three base axes only (see the 2.2 case below).
  const facadeEvidence = evidence({
    reviewValidUntil: "2027-11-01",
    axes: {
      security: { verdict: "pass", reason: "只读" },
      licence: { verdict: "pass", reason: "MIT-0" },
      quality: { verdict: "pass", reason: "有用例" },
    },
  });
  const row = attachEvidenceSummary(
    { id: "facade-c" },
    { id: "facade-c", evidence: facadeEvidence },
    { species: "facade", today: "2026-11-12" },
  );
  assert.equal(row.evidence.state, "complete");
  assert.equal(row.evidence.reviewValidUntil, "2027-11-01", "the surface can say until when");
  assert.equal(JSON.stringify(row).includes("ops@acme"), false);
});

test("a row without evidence is left untouched (the market face still renders)", () => {
  const row = attachEvidenceSummary({ id: "facade-b" }, { id: "facade-b" }, { species: "facade" });
  assert.equal("evidence" in row, false);});
