// ── facade 物种的去重：同一支 agent 只能出一行 ───────────────────────────────
//
// 2026-11-24 真机走查发现：`/api/facades-catalog` 返回 56 行，但只有 32 个唯一
// agent —— 24 支被列了两遍，同一页上一行说 `serving`、另一行说 `undeployed`。
//
// 根因是两个来源给同一支 agent 的 slug 大小写不同：
//   万星 serving 面  packs-ut_bjmuw5kxad83kimpmlg-reception
//   registry AgentCard  packs-Ut_bJMuW5KxAD83KImPmlg-reception
// 去重用精确字符串比较，于是漏掉。slug 是 pack id 的派生，大小写不承载语义，
// 归一是安全的。
//
// 这个缺陷有两层危害：目录上的 facade 计数是虚的（56 而非 32），而同一支 agent
// 一条说正在服务、一条说未部署 —— 读者无法判断哪个是真的。
//
//   node --test scripts/test-facade-dedupe.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { projectFacadeEntries } from "../facet/supply-catalog.js";

test("同一 agent 的两个来源大小写不同也只出一行", () => {
  const agents = [
    {
      slug: "packs-ut_bjmuw5kxad83kimpmlg-reception",
      name: "寻数分身",
      description: "d",
      status: "serving",
      deploymentState: "serving",
    },
  ];
  const cards = [
    { slug: "packs-Ut_bJMuW5KxAD83KImPmlg-reception", name: "寻数分身", description: "d" },
  ];
  const { facades } = projectFacadeEntries(agents, { registrations: cards, asOf: "2026-11-24" });

  assert.equal(facades.length, 1, `同一支 agent 必须只出一行，实际 ${facades.length}`);
  assert.equal(
    facades[0].deployment.state,
    "serving",
    "serving 面必须赢过 registry 卡片的 undeployed —— 否则读者看到的是「未部署」",
  );
});

test("大小写不同的重复不会把真实不同的 agent 也吞掉", () => {
  const agents = [{ slug: "a-one", name: "A", description: "d", status: "serving" }];
  const cards = [
    { slug: "A-ONE", name: "A", description: "d" }, // 同一支，应被去重
    { slug: "b-two", name: "B", description: "d" }, // 另一支，应保留
  ];
  const { facades } = projectFacadeEntries(agents, { registrations: cards, asOf: "x" });
  assert.equal(facades.length, 2, `期望 2 行（A、B），实际 ${facades.length}`);
  assert.deepEqual(
    facades.map((f) => f.id).sort(),
    ["a-one", "b-two"],
  );
});

test("去重后每个 agent 只出现一次（对真实形状的批量核对）", () => {
  // 用线上观测到的形态造 5 组大小写配对的条目。
  const base = ["reception", "lex-console-copilot", "pack-wire-strategy-lab", "builder", "intro-facet"];
  const agents = base.map((s) => ({ slug: `packs-${s}`, name: s, description: "d", status: "serving" }));
  const cards = base.map((s) => ({ slug: `packs-${s.toUpperCase()}`, name: s, description: "d" }));
  const { facades } = projectFacadeEntries(agents, { registrations: cards, asOf: "x" });
  assert.equal(facades.length, base.length, "配对的 10 条输入应收敛成 5 行");
  assert.equal(new Set(facades.map((f) => f.id.toLowerCase())).size, facades.length, "不应有大小写重复");
});
