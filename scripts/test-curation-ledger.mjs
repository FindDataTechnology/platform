// Unit tests — generated ledger (change add-curation-evidence-gate, 4.1 / 4.2).
// Run: node --test scripts/test-curation-ledger.mjs
//
// The ledger is the document a human reads to answer "what was reviewed and by
// whom". Two properties matter, and they pull in opposite directions:
//   · the TABLE must be generated (a hand edit is drift, and CI must say so);
//   · the PROSE must never be regenerated — the first-batch rationale and the
//     exclusions live there, and "generate the whole file" would delete them.
// So the generator owns a marked block; these cases pin both sides of that line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { renderLedgerBlock, spliceBlock, BEGIN_MARK, END_MARK } from "../scripts/gen-curation-ledger.mjs";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = mkdtempSync(path.join(tmpdir(), "curation-ledger-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function evidence(over = {}) {
  return {
    axes: {
      security: { verdict: "pass", reason: "只读" },
      licence: { verdict: "pass", reason: "MIT-0" },
      quality: { verdict: "pass", reason: "有用例" },
      P1: { verdict: "pass", reason: "只读面" },
      P2: { verdict: "pass", reason: "无下载" },
    },
    pin: { repo: "github.com/acme/x", commit: "abcdef1234567890" },
    licence: "MIT-0",
    egress: "allowlist(api.example.com)",
    reviewedBy: "ops@acme",
    reviewedAt: "2026-11-01",
    reviewValidUntil: "2027-11-01",
    ...over,
  };
}

function root(plugins, prose = "# 台账\n\n人手写的第一批理由与排除项。\n") {
  const dir = mkdtempSync(path.join(tmp, "root-"));
  mkdirSync(path.join(dir, "packs"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "packs", "plugin-catalog.json"), `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
  writeFileSync(path.join(dir, "docs", "ecosystem-curation-ledger.md"), prose);
  return dir;
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts/gen-curation-ledger.mjs"), "--root", dir, ...args], {
    encoding: "utf8",
  });
}

test("the block lists whitelisted fields only, sorted by entry id", () => {
  const block = renderLedgerBlock({
    plugins: [
      { id: "zeta", species: "plugin", evidence: evidence() },
      { id: "alpha", species: "plugin", evidence: evidence({ reviewValidUntil: "2020-01-01" }) },
    ],
    today: "2026-11-12",
  });
  const rows = block.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| 条目") && !l.startsWith("|---"));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("alpha"), "sorted by id");
  assert.ok(rows[0].includes("stale"), "an expired entry is marked, not silently listed as reviewed");
  assert.ok(rows[1].includes("github.com/acme/x@abcdef123456"), "pin is rendered with a short ref");
  assert.ok(rows[1].includes("MIT-0") && rows[1].includes("allowlist(api.example.com)"));
  assert.ok(rows[1].includes("security:pass") && rows[1].includes("P2:pass"));
  assert.ok(rows[1].includes("永久") === false, "a dated validity is printed as the date");
});

test("prose outside the markers survives generation untouched", () => {
  const prose = "# 台账\n\n第一批 12 条 MCP server 的理由。\n\n## 拒收\nfirecrawl —— AGPL。\n";
  const dir = root([{ id: "alpha", species: "plugin", evidence: evidence() }], prose);
  assert.equal(run(dir).status, 0);
  const text = readFileSync(path.join(dir, "docs", "ecosystem-curation-ledger.md"), "utf8");
  assert.ok(text.startsWith(prose), "the human prose is byte-identical at the head");
  assert.ok(text.includes(BEGIN_MARK) && text.includes(END_MARK));
  assert.ok(text.includes("| alpha |"), "the table landed inside the block");
});

test("two generations are byte-identical (4.1 determinism)", () => {
  const dir = root([{ id: "alpha", species: "plugin", evidence: evidence() }]);
  assert.equal(run(dir).status, 0);
  const first = readFileSync(path.join(dir, "docs", "ecosystem-curation-ledger.md"), "utf8");
  assert.equal(run(dir).status, 0);
  assert.equal(readFileSync(path.join(dir, "docs", "ecosystem-curation-ledger.md"), "utf8"), first);
});

test("regenerating replaces the block instead of appending a second one", () => {
  const dir = root([{ id: "alpha", species: "plugin", evidence: evidence() }]);
  run(dir);
  run(dir);
  const text = readFileSync(path.join(dir, "docs", "ecosystem-curation-ledger.md"), "utf8");
  assert.equal(text.split(BEGIN_MARK).length - 1, 1, "exactly one generated block");
});

test("a hand-edited table fails --check (4.2)", () => {
  const dir = root([{ id: "alpha", species: "plugin", evidence: evidence() }]);
  assert.equal(run(dir).status, 0);
  const file = path.join(dir, "docs", "ecosystem-curation-ledger.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("| alpha |", "| alpha-hand-edited |"));
  const check = run(dir, "--check");
  assert.equal(check.status, 1);
  assert.match(check.stderr, /drifted from the catalogue/);
});

test("editing the prose does NOT fail --check (the block is the contract)", () => {
  const dir = root([{ id: "alpha", species: "plugin", evidence: evidence() }]);
  assert.equal(run(dir).status, 0);
  const file = path.join(dir, "docs", "ecosystem-curation-ledger.md");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n补一句运维备注。\n`);
  const check = run(dir, "--check");
  assert.equal(check.status, 0, check.stderr);
});

test("an empty catalogue yields an honest empty block, never a deleted ledger", () => {
  const dir = root([]);
  assert.equal(run(dir).status, 0);
  const text = readFileSync(path.join(dir, "docs", "ecosystem-curation-ledger.md"), "utf8");
  assert.match(text, /目录中还没有条目/);
  assert.ok(text.includes("人手写的第一批理由"), "prose still there");
});

test("spliceBlock appends a block to a file that has none", () => {
  const out = spliceBlock("prose only\n", `${BEGIN_MARK}\nx\n${END_MARK}\n`);
  assert.ok(out.startsWith("prose only\n"));
  assert.ok(out.includes(BEGIN_MARK));
});
