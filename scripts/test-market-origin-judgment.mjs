// ── 市场来源的唯一判据（align-yizuo-market-origin-judgment 1.1 / 5.1）─────────
//
//   node --test scripts/test-market-origin-judgment.mjs
//
// 「这条目是不是来自市场」必须前后端同一个答案。市场两个通道：
//   registry       旧 feed
//   facet-catalog  谦面目录投影
//
// 2026-11-22 实测的漂移：服务端已双认，前端六处 + 服务端一处过滤仍只认
// registry。后果不是「少个徽标」——工具选择器漏条目、安装表单让用户填服务端
// 必定丢弃的密钥。
//
// 这个文件钉三件事：
//   1. 判据本身的三态（registry 真 / facet-catalog 真 / bundled 假 / 未知假）；
//   2. 源码里不再有手写的 origin 比较（漂移的机制，不是结果）；
//   3. 判据只有一处定义（core），别处只能导入。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMarketOrigin, MARKET_ORIGINS } from "../packages/core/src/api/market-origin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// ── 1. 判据语义 ──────────────────────────────────────────────────────────────

test("both market channels are market provenance", () => {
  assert.equal(isMarketOrigin("registry"), true);
  assert.equal(isMarketOrigin("facet-catalog"), true);
});

test("bundled starters are NOT market provenance", () => {
  // 自带起步件确实可被作者引用，但那需要「市场来源 ∪ bundled」显式叠加，
  // 不能把 bundled 塞进市场判据——否则安装表单会把自带工具当成市场条目去要凭据。
  assert.equal(isMarketOrigin("bundled"), false);
});

test("unknown and absent origins answer false, never a guess", () => {
  assert.equal(isMarketOrigin(undefined), false);
  assert.equal(isMarketOrigin(null), false);
  assert.equal(isMarketOrigin(""), false);
  assert.equal(isMarketOrigin("something-new"), false);
});

test("the origin set names exactly the two channels", () => {
  assert.deepEqual([...MARKET_ORIGINS].sort(), ["facet-catalog", "registry"]);
});

// ── 2. 反漂移：源码里不得再有手写的 origin 比较 ─────────────────────────────

const SCAN_DIRS = ["web/src", "server", "lib", "gateway", "facet", "packages/core/src"];
const SCAN_FILES = ["registry-bridge.js", "extension-store.js"];

function walk(dir, out = []) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", "archive", ".git", "graphify-out"].includes(e.name)) continue;
      walk(rel, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("no source compares origin against a channel name by hand", () => {
  // lib/market-annotations.js 的 `origin !== "registry"` 是**注释文件的来源校验**
  // （registry | yizuo-file），与「条目从哪个市场来」是不同语义，不在本判据射程内。
  const EXEMPT = new Set(["lib/market-annotations.js"]);
  const files = [...SCAN_FILES, ...SCAN_DIRS.flatMap((d) => walk(d))].filter((f) => !EXEMPT.has(f));
  // 判据的唯一允许位置：core（定义它）与 registry-bridge（服务端的具名出口，
  // 内部用 core 的集合）。
  const HANDWRITTEN = /origin\s*[!=]==?\s*["'](registry|facet-catalog)["']/;
  const offenders = [];
  for (const f of files) {
    if (f.startsWith("packages/core/src/api/market-origin")) continue;
    const src = read(f);
    if (HANDWRITTEN.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `hand-written origin comparisons remain in: ${offenders.join(", ")}`);
});

// ── 3. 判据只有一处定义 ──────────────────────────────────────────────────────

test("MARKET_ORIGINS is defined in core and nowhere else", () => {
  const files = [...SCAN_FILES, ...SCAN_DIRS.flatMap((d) => walk(d))];
  const definers = files.filter((f) => /(?:const|export const)\s+MARKET_ORIGINS\s*=/.test(read(f)));
  assert.deepEqual(definers, ["packages/core/src/api/market-origin.ts"],
    "the market-origin set must be defined once, in core — every other file imports it");
});
