// plaza site gates (add-agent-materials-plaza): five-locale key parity on the
// site copy, generated-artifact presence, and index.html reference integrity —
// the site-side siblings of check-locales and the export gates.
//
// Run: node --test scripts/test-plaza-site.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site-plaza");
const LOCALES = ["zh-CN", "en", "es", "fr", "ja"];

function keyPaths(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...keyPaths(v, p));
    else out.push(p);
  }
  return out.sort();
}

test("five locale files carry identical key sets (site-side parity gate)", () => {
  const dicts = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(dir, "locales", `${l}.json`), "utf8"))]));
  const base = keyPaths(dicts["zh-CN"]);
  for (const l of LOCALES.slice(1)) {
    const keys = keyPaths(dicts[l]);
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `locale ${l} key parity against zh-CN`);
  }
  // terminal-word discipline: the v5 brand string speaks the plaza name everywhere
  assert.ok(dicts["zh-CN"].brand.name.includes("素材广场"));
  assert.ok(dicts["en"].brand.name.includes("Materials Plaza"));
  assert.ok(dicts["es"].brand.name.includes("Plaza de Materiales"));
  assert.ok(dicts["fr"].brand.name.includes("Place des Matériaux"));
  assert.ok(dicts["ja"].brand.name.includes("素材広場"));
});

test("generated artifacts exist after a snapshot export (the page never ships empty)", () => {
  for (const f of ["catalog.json", "llms.txt", "llms-full.txt", "infrastructure.md", "counts.json", "snapshot.json"]) {
    assert.ok(fs.existsSync(path.join(dir, "generated", f)), `generated/${f} present`);
  }
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "generated", "catalog.json"), "utf8"));
  assert.equal(cat.count, cat.materials.length, "catalog count field agrees with the material array");
  for (const m of cat.materials) {
    assert.ok(fs.existsSync(path.join(dir, "generated", "materials", `${m.slug}.md`)), `material page ${m.slug}.md present`);
  }
});

test("index.html references resolve: every href/src/script target exists on disk", () => {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|data:|mailto:)/.test(ref)) continue; // external/inline
    const clean = ref.split("?")[0];
    assert.ok(fs.existsSync(path.join(dir, clean)), `reference ${ref} exists`);
  }
  // machine twins + JSON-LD present in the human face
  assert.ok(html.includes("application/ld+json"), "JSON-LD embedded");
  assert.ok(html.includes("generated/catalog.json"), "machine twin linked");
  assert.ok(html.includes("壹座·智能体素材广场"), "v5 brand string present");
});
