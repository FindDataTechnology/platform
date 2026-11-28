#!/usr/bin/env node
// ── facets 兜底闸的自我检验 ───────────────────────────────────────────────────
//
// `scripts/check-facets-guards.mjs` 判「facets.lines/domains 读取必须有 `?? []`
// 兜底」。这条测试证明闸**两侧都真的会动**：漏兜底判红、带兜底判绿、注释里的
// 文字不被误判。没有红证的门是假门（本仓反复撞过这个形态）。
//
//   node --test scripts/test-check-facets-guards.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { findUnguardedReads } = await import("./check-facets-guards.mjs");

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "facets-guard-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test("an unguarded facets.lines read is flagged (red proof)", () => {
  const root = fixture({ "a.tsx": "const s = facets.lines.reduce((a, l) => a + l.count, 0);\n" });
  try {
    const bad = findUnguardedReads(root);
    assert.equal(bad.length, 1, "one unguarded read");
    assert.equal(bad[0].field, "lines");
    assert.match(bad[0].file, /a\.tsx$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guarded read (?? [] / || []) passes", () => {
  const root = fixture({
    "ok.tsx": [
      "const a = (facets.lines ?? []).reduce((a, l) => a + l.count, 0);",
      "const b = (facets.domains || []).map((d) => d.slug);",
    ].join("\n"),
  });
  try {
    assert.deepEqual(findUnguardedReads(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prose in a line comment mentioning facets.lines is not judged", () => {
  const root = fixture({ "c.tsx": "// 未归类计数：facets.lines 是声明全集的计数\nconst x = 1;\n" });
  try {
    assert.deepEqual(findUnguardedReads(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real web/src is clean (the fix that motivated the gate holds)", () => {
  assert.deepEqual(findUnguardedReads(), [], "no unguarded facets array reads in web/src");
});