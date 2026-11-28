// ── Three-pillar derivation tests (openspec: pillar-surfaces 1.1-1.3) ──────
//
// The derivation is the ONE source every surface reads, so what is pinned here
// is the contract the surfaces rely on:
//   · corpus parity  — the real fleet-packs manifests derive to hand-checked
//                      counts (memory 7 / console 11 / the rest undeclared);
//   · bad designs    — each malformed declaration names its own path and comes
//                      back as `invalid`, never as a normal-looking default and
//                      never as a throw;
//   · purity         — same input twice, byte-equal; an agent-scoped result is a
//                      deterministic projection of the unscoped one; env is not
//                      an input.
//
//   node --test scripts/test-pack-pillars.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { derivePillars, PILLAR_ORDER, PILLAR_STATE } from "../lib/pack-pillars.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLEET_PACKS = join(HERE, "..", "..", "fleet-packs");

// A self-contained manifest for the PURITY cases. Their subject is the
// derivation's determinism, not the real corpus — pinning them to a sibling
// repo made them unjudgeable in CI for no gain. Deliberately minimal (two
// agents, no pillar declarations): the derivation must still be pure over it,
// and an empty-by-choice input proves more about purity than a rich one.
const INLINE_MANIFEST = {
  kind: "team",
  name: "内联纯度夹具",
  boundary: { name: "内联纯度夹具" },
  fleet: { name: "内联纯度夹具" },
  agents: [
    { id: "a-one", name: "一岗", persona: "你是一岗。" },
    { id: "a-two", name: "二岗", persona: "你是二岗。" },
  ],
};

// The corpus cases read ANOTHER repo (`fleet-packs`), reachable locally only by
// the sibling-directory accident `../fleet-packs`. The CI runner and the public
// snapshot have neither, so every one of these cases has been failing with
// ENOENT since it landed — a gate that never judged anything while reading as
// red noise. Missing fixture = cannot judge, said out loud; NOT a pass.
// (Same pattern and wording as test-blueprint-member-closure.mjs ⑦.)
const NO_CROSS_REPO = existsSync(FLEET_PACKS)
  ? false
  : "../fleet-packs 不在本树（跨仓夹具：CI runner 与公开快照都没有）——判不出，不是通过";
const load = (rel) => JSON.parse(readFileSync(join(FLEET_PACKS, rel), "utf8"));

function allManifests(dir = FLEET_PACKS, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) allManifests(full, out);
    else if (name === "manifest.json") out.push(full);
  }
  return out;
}

// ── corpus parity ───────────────────────────────────────────────────────────

test("存量语料：投研铸造舰三柱齐全且岗位收窄生效", { skip: NO_CROSS_REPO }, () => {
  const d = derivePillars(load("invest/invest-team-forge/manifest.json"));
  assert.equal(d.memory.state, PILLAR_STATE.PRESENT);
  assert.deepEqual(Object.keys(d.memory.axes).sort(), ["process", "read", "store", "write"]);
  assert.equal(d.memory.guidance.length, 3, "三岗各一条章程");

  assert.equal(d.toolkit.state, PILLAR_STATE.PRESENT);
  assert.equal(d.toolkit.servers.length, 4);
  assert.equal(d.toolkit.roles.length, 3);
  // 巡检岗与拍板岗都收窄了；设计岗收窄了 fleet-architect 的一条。
  assert.equal(d.toolkit.roles.filter((r) => r.narrowed).length, 2);

  const scout = d.toolkit.roles.find((r) => r.agentId === "inv-forge-scout");
  assert.deepEqual(scout.effective["fleet-architect"], ["fleet_list", "fleet_spec_read", "fleet_turns_read"]);
  assert.equal(scout.narrowed, true);

  assert.equal(d.dashboard.state, PILLAR_STATE.PRESENT);
  assert.equal(d.dashboard.headline, "decisions.open");
  assert.equal(d.dashboard.blocks.length, 5);
  // surfaces 缺省 = 两宿主都含；声明了 platform 的块不得在 share 出现。
  const decisions = d.dashboard.blocks.find((b) => b.block === "decisions");
  assert.deepEqual(decisions.surfaces, ["platform"]);
  assert.deepEqual(d.dashboard.blocks.find((b) => b.block === "team").surfaces, ["platform", "share"]);
});

test("存量语料：记忆已声明、控制台未声明（三态不合并）", { skip: NO_CROSS_REPO }, () => {
  const d = derivePillars(load("invest/invest-team-forge-roles/manifest.json"));
  assert.equal(d.memory.state, PILLAR_STATE.PRESENT);
  assert.equal(d.toolkit.state, PILLAR_STATE.PRESENT);
  assert.equal(d.dashboard.state, PILLAR_STATE.UNDECLARED);
  assert.equal(d.dashboard.blocks, undefined, "未声明不得造空 blocks");
});

test("存量语料：老包三柱全未声明，且不出现任何计数", { skip: NO_CROSS_REPO }, () => {
  const d = derivePillars(load("adopted/dev-review-team/manifest.json"));
  for (const p of PILLAR_ORDER) {
    assert.equal(d[p].state, PILLAR_STATE.UNDECLARED, `${p} 应为未声明`);
    assert.equal(d[p].blocks, undefined);
    assert.equal(d[p].servers, undefined);
  }
});

test("全量回归：全部语料零抛错，且 memory/console 声明计数与手工统计一致", { skip: NO_CROSS_REPO }, () => {
  const files = allManifests();
  assert.ok(files.length >= 60, `语料数量异常：${files.length}`);
  let mem = 0;
  let con = 0;
  let ben = 0;
  for (const f of files) {
    const m = JSON.parse(readFileSync(f, "utf8"));
    const d = derivePillars(m); // must never throw
    for (const p of PILLAR_ORDER) {
      assert.ok(
        [PILLAR_STATE.PRESENT, PILLAR_STATE.UNDECLARED, PILLAR_STATE.INVALID].includes(d[p].state),
        `${f} 的 ${p} 状态非法：${d[p].state}`,
      );
    }
    // A pack-level block or ANY role-level block makes the pillar declared —
    // the pack-level-only view of the corpus misses the岗位包 that carry only
    // per-role guidance (invest-team-forge-roles is one).
    const declaresMemory = Boolean(m.memory) || (m.agents ?? []).some((a) => a?.memory);
    if (declaresMemory) {
      assert.equal(d.memory.state, PILLAR_STATE.PRESENT, f);
      mem += 1;
    } else {
      assert.equal(d.memory.state, PILLAR_STATE.UNDECLARED, f);
    }
    if (d.dashboard.state === PILLAR_STATE.PRESENT) con += 1;
    if (d.bench.state === PILLAR_STATE.PRESENT) ben += 1;
  }
  assert.equal(mem, 35, "记忆声明份数（手工统计：35，fleet-packs 2026-11 补全后）");
  assert.equal(con, 32, "控制台声明份数（手工统计：32）");
  assert.equal(ben, 0, "bench 声明份数（本能力刚引入，语料尚未声明）");
});

// ── bad designs: each names its own path, never throws ──────────────────────

const base = () => ({
  name: "t",
  agents: [{ id: "a1", name: "A", persona: "p" }],
  mcpServers: [{ registryName: "srv", allowTools: ["x", "y"] }],
});

test("坏设计：未知记忆轴 → invalid 且指名轴路径", () => {
  const m = { ...base(), memory: { story: {} } };
  const d = derivePillars(m);
  assert.equal(d.memory.state, PILLAR_STATE.INVALID);
  assert.ok(d.memory.errors.some((e) => e.path === "memory.story"), JSON.stringify(d.memory.errors));
  // 其它柱不受牵连 —— 一柱坏不得让整页失败。
  assert.equal(d.toolkit.state, PILLAR_STATE.PRESENT);
});

test("坏设计：store.home 半寻址写法 → 用独立错误码区分「写了地址」", () => {
  const m = { ...base(), memory: { store: { home: "d/mypack/agentA" } } };
  const d = derivePillars(m);
  assert.equal(d.memory.state, PILLAR_STATE.INVALID);
  assert.equal(d.memory.errors[0].code, "store_home_addressed");
  assert.match(d.memory.errors[0].error, /address/i);
});

test("坏设计：未知 console 块 id → invalid 且指名块路径", () => {
  const m = { ...base(), console: { blocks: [{ block: "team" }, { block: "sales-funnel" }] } };
  const d = derivePillars(m);
  assert.equal(d.dashboard.state, PILLAR_STATE.INVALID);
  assert.ok(d.dashboard.errors.some((e) => /console\.blocks\[1\]\.block/.test(e.path)), JSON.stringify(d.dashboard.errors));
});

test("坏设计：resources.mcpTools 指向未声明的 server → invalid 且指名角色与 server", () => {
  const m = { ...base(), agents: [{ id: "a1", name: "A", persona: "p", resources: { mcpTools: { ghost: ["z"] } } }] };
  const d = derivePillars(m);
  assert.equal(d.toolkit.state, PILLAR_STATE.INVALID);
  assert.equal(d.toolkit.errors[0].code, "mcp_tools_undeclared_server");
  assert.match(d.toolkit.errors[0].path, /agents\[a1\]\.resources\.mcpTools\['ghost'\]/);
});

test("一柱坏不牵连另一柱：坏记忆 + 好控制台", () => {
  const m = { ...base(), memory: { nope: {} }, console: { blocks: [{ block: "team" }] } };
  const d = derivePillars(m);
  assert.equal(d.memory.state, PILLAR_STATE.INVALID);
  assert.equal(d.dashboard.state, PILLAR_STATE.PRESENT);
});

// ── purity + scoped projection ──────────────────────────────────────────────

test("纯函数：同一输入连跑两次逐字段相等", () => {
  const m = INLINE_MANIFEST;
  assert.deepEqual(derivePillars(m), derivePillars(m));
});

test("派生不读 env：改环境变量后结果不变", () => {
  const m = INLINE_MANIFEST;
  const before = derivePillars(m);
  const saved = { ...process.env };
  try {
    process.env.PACK_MAX_AGENTS = "1";
    process.env.CELL_MEMORY_URL = "http://127.0.0.1:1";
    process.env.PACK_MEMORY_DEFAULT_SCOPE = "off";
    assert.deepEqual(derivePillars(m), before);
  } finally {
    for (const k of ["PACK_MAX_AGENTS", "CELL_MEMORY_URL", "PACK_MEMORY_DEFAULT_SCOPE"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("作用域派生是全局派生的确定性投影", { skip: NO_CROSS_REPO }, () => {
  const m = load("invest/invest-team-forge/manifest.json");
  const all = derivePillars(m);
  const one = derivePillars(m, { agentId: "inv-forge-designer" });

  assert.equal(one.toolkit.roles.length, 1);
  assert.deepEqual(one.toolkit.roles[0], all.toolkit.roles.find((r) => r.agentId === "inv-forge-designer"));
  // 包级事实不因作用域而变。
  assert.deepEqual(one.toolkit.servers, all.toolkit.servers);
  assert.deepEqual(one.dashboard, all.dashboard);
  assert.deepEqual(one.memory.rows, all.memory.rows);
  // 章程按岗位过滤，不新增不改写。
  assert.equal(one.memory.guidance.length, 1);
  assert.deepEqual(one.memory.guidance[0], all.memory.guidance.find((g) => g.agentId === "inv-forge-designer"));
});

test("未知 agentId 不报错：包级事实照常，岗位维度为空", { skip: NO_CROSS_REPO }, () => {
  const m = load("invest/invest-team-forge/manifest.json");
  const d = derivePillars(m, { agentId: "no-such-role" });
  assert.equal(d.toolkit.roles.length, 0, "指名一个不存在的角色不得回落成全量");
  assert.equal(d.memory.guidance.length, 0);
  assert.equal(d.toolkit.state, PILLAR_STATE.PRESENT);
  assert.equal(d.memory.rows["store.home"].effective, "member", "包级事实仍然可读");
});

test("仅岗位级记忆声明：整柱有值，且按岗位给出各自的解析链", { skip: NO_CROSS_REPO }, () => {
  const d = derivePillars(load("invest/invest-team-forge-roles/manifest.json"));
  assert.equal(d.memory.state, PILLAR_STATE.PRESENT);
  assert.deepEqual(d.memory.axes, {}, "没有包级轴 —— 不造");
  assert.equal(d.memory.roles.length, 3);
  assert.equal(d.memory.guidance.length, 3);
  // 作用域到其中一个岗位：只剩它自己那一条链。
  const one = derivePillars(load("invest/invest-team-forge-roles/manifest.json"), { agentId: d.memory.roles[0].agentId });
  assert.equal(one.memory.roles, undefined, "作用域下不再重复列全岗位");
  assert.equal(one.memory.guidance.length, 1);
});

test("toolTotals 是可选富化：缺席即为无键（未知≠零）", () => {
  const m = base();
  assert.equal(derivePillars(m).toolkit.servers[0].totalTools, undefined);
  assert.equal(derivePillars(m, { toolTotals: { srv: 12 } }).toolkit.servers[0].totalTools, 12);
});

// ── 6.1 编辑器往返不丢段 ────────────────────────────────────────────────────
//
// 编辑器与导入都曾静默丢掉 memory/console/fleet：manifest 一直是合法字段，
// 只是搬运路径没带它们。这条闸读源码断言「编译器把三段原样带出」，因为
// compiler 是纯函数、但依赖 web 的 TS 模块（无 DOM 测试跑器）。
test("6.1 草稿编译器与导入反编译都原样携带三支柱声明", async () => {
  const fs = await import("node:fs");
  const read = (p) => fs.readFileSync(p, "utf8");
  const compiler = read("web/src/components/packs/PackDraftsView.tsx");
  for (const key of ["memory", "console", "fleet"]) {
    assert.ok(
      new RegExp(`\\{\\s*${key}: entries\\.${key}`).test(compiler),
      `编译器必须把 entries.${key} 带进 manifest`,
    );
  }
  const importRoute = read("server/routes/packs.js");
  for (const key of ["memory", "console", "fleet"]) {
    assert.ok(
      importRoute.includes(`manifest.${key} ? { ${key}: manifest.${key} }`),
      `导入反编译必须回填 ${key}`,
    );
  }
});

// ── 7.3 统一详情页不越权 ────────────────────────────────────────────────────
//
// 详情面 = `/api/packs/:id` + `derivePillars(manifest)`。两者都只碰「声明」，
// 不碰「运行」：没有任何条目、回合数或成员邮箱。这条闸把该边界钉住——因为
// 「有一个统一详情页」最容易被误读成「所有数据都能在这一页看到」。
test("7.3 派生结果只含声明事实：无运行态条目、回合数、成员邮箱", { skip: NO_CROSS_REPO }, () => {
  const m = load("invest/invest-team-forge/manifest.json");
  const d = derivePillars(m);
  const wire = JSON.stringify(d);
  for (const forbidden of ["turns7d", "memberId", "lastTurn", "@", "email", "status_as_of"]) {
    assert.equal(wire.includes(forbidden), false, `派生结果不得携带运行态字段：${forbidden}`);
  }
  // 记忆四轴与章程在（作者的声明），但它们属于「声明」，不是「谁跑过什么」。
  assert.ok(wire.includes("store"));
  assert.ok(d.memory.guidance.every((g) => typeof g.text === "string"));
});

test("7.3 console 块在派生里只有声明（id/params/surfaces），无块数据", { skip: NO_CROSS_REPO }, () => {
  const d = derivePillars(load("invest/invest-team-forge/manifest.json"));
  for (const b of d.dashboard.blocks ?? []) {
    // Declared shape only: the block id, the author's params, the surfaces.
    // `data` / `absentReason` belong to the console READ face (which knows the
    // runtime); a market derivation carrying them would be publishing a
    // half-filled board.
    for (const key of Object.keys(b)) {
      assert.ok(["block", "params", "surfaces"].includes(key), `块 ${b.block} 出现了非声明字段 ${key}`);
    }
    assert.equal("data" in b, false, "块数据属于控制台读面，不进市场派生");
    assert.equal("absentReason" in b, false);
  }
});
