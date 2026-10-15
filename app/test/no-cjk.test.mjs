// The i18n lint gate (task 5.3): no CJK literals in app source — every
// user-visible string resolves through the i18n bundles. Scans src/ minus
// the i18n directory itself; fails naming file and line.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../src");
const CJK = /[\u4e00-\u9fff]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "i18n") continue; // the bundles themselves
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

test("no hardcoded CJK copy outside the i18n bundles", () => {
  const offenders = [];
  for (const file of walk(ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      // Skip comment-only lines — code comments may stay Chinese (house style).
      const code = line.replace(/\/\/.*$/, "");
      if (CJK.test(code)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, [], "user-visible copy must ride the i18n bundles");
});
