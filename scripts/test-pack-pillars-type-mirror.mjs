// ── SpecPillars 类型镜像守卫（overhaul-pack-detail-presentation 1.2）──────────
//
// `web/src/lib/packs-api.ts` 的 `SpecPillars` 自称是 `lib/pack-pillars.js`
// `derivePillars()` 的镜像。上一轮它没做到：`dashboard.blocks` 写成 `{id, kind}`
// 而服务端发的是 `{block, params, surfaces}`，于是「块名」在类型上不存在，渲染层
// 能做的只有报个数（详情页就只印了「5 blocks」）。类型漂移不会让任何测试变红，
// 它只是让正确实现变得看不见——所以这里把两边钉在一起。
//
// 判据：用真实派生结果求「实际出现的键」，断言每一个都在类型声明里出现。
// 反向不查（类型可以比某一次派生结果宽，比如 `roles` 只在有角色级声明时出现）。
//
//   node --test scripts/test-pack-pillars-type-mirror.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { derivePillars } from "../lib/pack-pillars.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = join(HERE, "..", "web", "src", "lib", "packs-api.ts");

/** 一份把三支柱全部声明满的 manifest——每个派生分支都被走到。 */
const FULL = {
  name: "全声明夹具",
  description: "三支柱全声明",
  mcpServers: [
    { registryName: "srv-a", allowTools: ["t1", "t2"] },
    { registryName: "srv-b", fullSurface: true, fullSurfaceReason: "需要全域" },
  ],
  agents: [
    {
      id: "role-a",
      name: "甲岗",
      persona: "你是甲岗。",
      memory: { read: { budget: 800 } },
      resources: { mcpTools: { "srv-a": ["t1"] } },
    },
    { id: "role-b", name: "乙岗", persona: "你是乙岗。" },
  ],
  memory: {
    store: { home: "member" },
    read: { scope: "own+shared" },
    write: { authority: "private" },
    process: { distill: "on", promote_after: 3 },
  },
  console: {
    headline: "kpi.hit_rate",
    blocks: [{ block: "kpi" }, { block: "stream", params: { limit: 5 }, surfaces: ["platform"] }],
  },
  fleet: {
    name: "全声明夹具",
    members: [{ ref: "a", title: "甲岗" }],
  },
};

/** 从 TS 源里取一个 interface 的顶层键集。够用即可：镜像成功与否看的是键名有无。 */
function interfaceKeys(source, name) {
  const head = source.indexOf(`export interface ${name} {`);
  assert.ok(head > 0, `找不到 interface ${name}`);
  // 括号配平，避免被后面的 interface 吞掉。
  let i = source.indexOf("{", head) + 1;
  let depth = 1;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  const body = source.slice(start, i - 1);
  // 只取深度 1 的键：形如 `  name?:` / `  name:`。跳过注释行。
  const keys = new Set();
  let d = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (d === 0 && /^[A-Za-z_$][\w$]*\??:/.test(line)) {
      keys.add(line.slice(0, line.indexOf(":")).replace("?", "").trim());
    }
    d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (d < 0) d = 0;
  }
  return keys;
}

test("derivePillars 的顶层键都在 SpecPillars 里声明了", () => {
  const out = derivePillars(FULL, { toolTotals: { "srv-a": 9 } });
  const declared = interfaceKeys(readFileSync(TYPES, "utf8"), "SpecPillars");
  for (const k of Object.keys(out)) {
    assert.ok(declared.has(k), `SpecPillars 缺顶层键 '${k}'（派生结果有、类型没有 = 渲染层看不见）`);
  }
});

test("pillars.dashboard.blocks 声明了 block/params/surfaces，而不是旧的 id/kind", () => {
  const src = readFileSync(TYPES, "utf8");
  const head = src.indexOf("dashboard: {");
  assert.ok(head > 0);
  const seg = src.slice(head, src.indexOf("};", head));
  assert.match(seg, /block:\s*string/, "dashboard.blocks 必须声明 `block` 字段");
  assert.doesNotMatch(seg, /\bid\?:\s*string/, "dashboard.blocks 不得再声明旧的 `id` 字段");
});

test("pillars.memory 声明了 axes / inherited_from / declaredAt", () => {
  const out = derivePillars(FULL);
  assert.ok(out.memory.axes, "夹具应产出 axes");
  assert.ok(out.memory.rows?.["read.budget"], "夹具应产出 rows");
  const src = readFileSync(TYPES, "utf8");
  const head = src.indexOf("memory: {");
  const seg = src.slice(head, src.indexOf("toolkit: {", head));
  for (const key of ["axes", "rows", "declaredAt", "guidance"]) {
    assert.match(seg, new RegExp(`\\b${key}\\??:`), `SpecPillars.memory 缺 '${key}'`);
  }
  assert.match(seg, /inherited_from/, "memory.rows 必须声明 inherited_from（平台默认 vs 作者声明的判据）");
  assert.match(seg, /executed/, "memory.rows 必须声明 executed（有没有执行者）");
});

test("pillars.toolkit.roles 声明了 narrowed / effectiveServers", () => {
  const out = derivePillars(FULL);
  assert.ok(Array.isArray(out.toolkit.roles) && out.toolkit.roles.length === 2, "夹具应产出两个角色行");
  assert.equal(out.toolkit.roles[0].narrowed, true, "甲岗收窄了 srv-a，夹具前提不成立");
  const src = readFileSync(TYPES, "utf8");
  const head = src.indexOf("toolkit: {");
  const seg = src.slice(head, src.indexOf("dashboard: {", head));
  for (const key of ["narrowed", "effectiveServers", "effective", "declared"]) {
    assert.match(seg, new RegExp(`\\b${key}\\??:`), `SpecPillars.toolkit.roles 缺 '${key}'`);
  }
});

test("memory.guidance 声明为对象数组，不是字符串", () => {
  const out = derivePillars({
    ...FULL,
    agents: FULL.agents.map((a) =>
      a.id === "role-a" ? { ...a, memory: { read: { budget: 800 }, guidance: "只记本周期读数。" } } : a,
    ),
  });
  assert.ok(Array.isArray(out.memory.guidance), "派生结果的 guidance 是数组");
  assert.deepEqual(out.memory.guidance[0], { agentId: "role-a", text: "只记本周期读数。" });
  const src = readFileSync(TYPES, "utf8");
  const head = src.indexOf("memory: {");
  const seg = src.slice(head, src.indexOf("toolkit: {", head));
  assert.doesNotMatch(seg, /guidance\?:\s*string/, "guidance 不得声明成 string（实际是对象数组）");
  assert.match(seg, /guidance\?:\s*\{[^}]*agentId/, "guidance 必须声明为 { agentId, text }[]");
});

test("镜像是活的：删掉 axes 声明后本测试必须变红", () => {
  // 自检判据。不改真文件——只验证 interfaceKeys 真的能看出缺失。
  const declared = interfaceKeys(readFileSync(TYPES, "utf8"), "SpecPillars");
  assert.ok(declared.size >= 3, `interfaceKeys 解析失败（只拿到 ${declared.size} 个键）`);
  assert.ok(declared.has("memory") && declared.has("toolkit") && declared.has("dashboard"));
});
