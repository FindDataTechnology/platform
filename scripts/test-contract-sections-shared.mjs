// ── 契约渲染器只允许一份实现（surface-team-contract-on-console 1.2）──────────
//
// `acceptance[]` / `monitoring` 在三个面出现：市场详情页、壹座舰队页控制台、
// 谦面分享控制台。同一份声明若在两个页面用两套渲染，断言类型的中文名、顺序、
// 缺省文案都会漂——而这类漂移没有任何闸会红，只有用户看得出「这两个页面说的是
// 不同的东西」。
//
// 所以实现只允许存在于 `ContractSections.tsx`，其余消费方必须 import。
//
//   node --test scripts/test-contract-sections-shared.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web", "src");
const OWNER = "components/packs/ContractSections.tsx";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(SRC);

test("AcceptanceSection / MonitoringSection 的定义只出现在 ContractSections.tsx", () => {
  const definers = [];
  for (const f of files) {
    const rel = relative(SRC, f);
    const src = readFileSync(f, "utf8");
    if (/^(export\s+)?function\s+AcceptanceSection\s*\(/m.test(src) || /^(export\s+)?function\s+MonitoringSection\s*\(/m.test(src)) {
      definers.push(rel);
    }
  }
  assert.deepEqual(definers, [OWNER], `实现必须只有一处，实际出现在：${definers.join(", ")}`);
});

test("详情页从共用模块取，而不是自己实现", () => {
  const spec = readFileSync(join(SRC, "components", "packs", "AgentSpecSheet.tsx"), "utf8");
  assert.match(
    spec,
    /import\s*\{[^}]*AcceptanceSection[^}]*\}\s*from\s*"@\/components\/packs\/ContractSections"/,
    "AgentSpecSheet 必须从 ContractSections import AcceptanceSection",
  );
  assert.match(
    spec,
    /import\s*\{[^}]*MonitoringSection[^}]*\}\s*from\s*"@\/components\/packs\/ContractSections"/,
    "AgentSpecSheet 必须从 ContractSections import MonitoringSection",
  );
});

test("共用模块不判断 surface（裁剪是服务端的事）", () => {
  const src = readFileSync(join(SRC, OWNER), "utf8");
  assert.doesNotMatch(src, /surface\s*===|surface\s*!==/, "渲染器不得按 surface 自行裁剪——那会让「响应里有什么」与「页面显示什么」出现两个答案");
});

test("契约渲染复用 packs.specSheet 的词汇，不新造一套", () => {
  const src = readFileSync(join(SRC, OWNER), "utf8");
  for (const key of ["packs.specSheet.assertion.", "packs.specSheet.monitoringSeverityValue."]) {
    assert.ok(src.includes(key), `必须复用 ${key}——新造一套会让同一断言在两个页面叫两个名`);
  }
});
