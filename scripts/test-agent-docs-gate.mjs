// Design-docs gate (docs/agent-domain-design-charter.md §7.3, the charter's
// quality gates). Ports the upstream discipline (dsh-superagent docs.spec):
//   1. numbered design docs (docs/NNN-*.md) may only link BACKWARD — a reader
//      never needs a concept that has not been introduced yet;
//   2. no merge-conflict markers anywhere in the design-doc set;
//   3. every local relative link inside the CORE design docs resolves to a
//      file on disk (anchors are not checked).
// The core set is explicit (charter + the orchestration proposal): widening it
// is a deliberate act, so historical docs with stale links stay out of scope.
//
// Run: node --test scripts/test-agent-docs-gate.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOCS = path.join(ROOT, "docs");

// The core design docs (charter §7.3 scope). Keep sorted by reading order.
const CORE_DOCS = [
  "docs/fleet-orchestration-modes.md", // 编排提案（宪章的姊妹底稿，在前）
  "docs/agent-domain-design-charter.md", // 设计宪章（合流后的事实基准）
].sort();

const CONFLICT_MARKERS = /^<{7}|^={7}$|^>{7}/;

function mdFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f));
}

function localLinks(file) {
  const text = fs.readFileSync(file, "utf8");
  const out = [];
  // [text](target) — skip http(s), anchors-only (#...), and code spans are not
  // special-cased (false positives would still point at real files).
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const target = m[1];
    if (/^https?:\/\//.test(target) || target.startsWith("#") || target.startsWith("mailto:")) continue;
    out.push({ target, raw: target });
  }
  return { text, links: out };
}

test("design docs carry no merge-conflict markers", () => {
  const files = mdFiles(DOCS).concat(CORE_DOCS.map((f) => path.join(ROOT, f)));
  const offenders = [];
  for (const f of new Set(files)) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CONFLICT_MARKERS.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `conflict markers found in:\n${offenders.join("\n")}`);
});

test("core design docs: every local relative link resolves to a file", () => {
  const broken = [];
  for (const rel of CORE_DOCS) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `core doc missing: ${rel}`);
    const { links } = localLinks(file);
    for (const { target, raw } of links) {
      const resolved = path.resolve(path.dirname(file), decodeURI(target.split("#")[0]));
      if (!fs.existsSync(resolved)) broken.push(`${rel} → ${raw}`);
    }
  }
  assert.deepEqual(broken, [], `broken local links in core docs:\n${broken.join("\n")}`);
});

test("numbered design docs only link backward (docs/NNN-*.md)", () => {
  const numbered = mdFiles(DOCS)
    .map((f) => ({ f, m: path.basename(f).match(/^(\d{3})-/) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  if (numbered.length === 0) return; // the discipline arms itself with the first numbered doc
  const order = new Map(numbered.map((x, i) => [path.basename(x.f), i]));
  const forward = [];
  for (const { f } of numbered) {
    const name = path.basename(f);
    for (const { target } of localLinks(f).links) {
      if (/^https?:\/\//.test(target) || target.startsWith("#")) continue;
      const linked = path.basename(decodeURI(target.split("#")[0]));
      if (order.has(linked) && order.get(linked) > order.get(name)) forward.push(`${name} → ${linked} (forward)`);
    }
  }
  assert.deepEqual(forward, [], `numbered docs link forward:\n${forward.join("\n")}`);
});
