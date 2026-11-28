#!/usr/bin/env node
// ── Member closure gate (complete-team-authoring-loop 批 1) ─────────────────
//
// 洞的形状：pack-preset 成员的 presetId 必须命中同一包 agents[].id，但既有
// 形状校验不查指向；查不到时装台器把岗位标 degraded——照建、照在、能力没了、
// 无报错。本闸在铸造前判红。
//
// 矩阵：
//   ① 自引用 + 命中            → 无 finding
//   ② 自引用 + 未命中          → fleet_preset_unresolved，点名 ref 与 presetId
//   ③ {{PACK_ID:self}} 同 ②     → 同码
//   ④ 跨包 {{PACK_ID:<name>}}  → 豁免（市场解析在铸造期）
//   ⑤ 参数占位 ${param}        → 豁免（实化期才定值）
//   ⑥ 非 pack-preset 成员      → 豁免
//   ⑦ 存量资产全量重跑         → 零新增 finding
//
//   node --test scripts/test-blueprint-member-closure.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const { memberClosureFindings, validateBlueprint } = await import("../server/blueprint-validate.js");

const ROOT = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");

// ⑦ 扫的是**另一个仓**的存量蓝图（`fleet-packs`），它在本仓的任何 checkout 里都不存在：
// 本地工作区靠 `../fleet-packs` 这种兄弟目录巧合能跑，而 CI 的 runner 与公开快照里两条路都没有
// ⇒ 2026-11-16 实测 `ENOENT … /home/runner/work/platform/fleet-packs/blueprints`，这条用例从落地起
// 就没在 CI 里成功过一次。缺夹具＝判不出，用带原因的 skip 说出来；**不伪装成通过**。
// （同类成例：test-snapshot-build-info.mjs 的 NO_SNAPSHOT_SCRIPT、snapshot 排除一致性闸点名的
//  test-voice-container-gate.mjs。）
const CROSS_REPO_BLUEPRINTS = path.join(ROOT, "..", "fleet-packs", "blueprints");
const NO_CROSS_REPO = existsSync(CROSS_REPO_BLUEPRINTS)
  ? false
  : "../fleet-packs/blueprints 不在本树（跨仓夹具：CI runner 与公开快照都没有）——判不出，不是通过";

function doc(members, agents = []) {
  return { kind: "team", boundary: { name: "闭包测试" }, fleet: { name: "闭包测试", members }, agents };
}

const agent = (id) => ({ id, name: id, persona: `你是 ${id}。` });

test("① 自引用命中 agents 不报", () => {
  const findings = memberClosureFindings(
    doc([{ ref: "brief", title: "简报岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "brief-agent" } }], [agent("brief-agent")]),
  );
  assert.deepEqual(findings, []);
});

test("② 自引用未命中逐字段指名", () => {
  const findings = memberClosureFindings(
    doc([{ ref: "ghost", title: "幽灵岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "ghost-post" } }], [agent("brief-agent")]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "fleet_preset_unresolved");
  assert.equal(findings[0].entry, "fleet.members[0].target.presetId");
  assert.match(findings[0].error, /ghost/);
  assert.match(findings[0].error, /ghost-post/);
});

test("③ {{PACK_ID:self}} 与裸自引用同判", () => {
  const findings = memberClosureFindings(
    doc([{ ref: "ghost", title: "幽灵岗", target: { kind: "pack-preset", packId: "{{PACK_ID:self}}", presetId: "ghost-post" } }], []),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "fleet_preset_unresolved");
});

test("④ 跨包引用豁免（presetId 在本包查不到也不报）", () => {
  const findings = memberClosureFindings(
    doc([{ ref: "policy", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:policy-pack}}", presetId: "any-id" } }], []),
  );
  assert.deepEqual(findings, []);
});

test("⑤ 参数占位豁免", () => {
  const findings = memberClosureFindings(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS a ${...} placeholder — that is the case under test
    doc([{ ref: "chief", title: "首席", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "${chiefAgent}" } }], []),
  );
  assert.deepEqual(findings, []);
});

test("⑥ 非 pack-preset 成员不受影响", () => {
  const findings = memberClosureFindings(
    doc([
      { ref: "tool", title: "工具岗", target: { kind: "tool", id: "websearch::web_search" } },
      { ref: "persona", title: "引用岗", target: { kind: "existing-persona", id: "some-elsewhere-preset" } },
    ], []),
  );
  assert.deepEqual(findings, []);
});

test("形状已报缺字段的成员不重复报", () => {
  const findings = memberClosureFindings(
    doc([{ ref: "broken", title: "坏岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}" } }], []),
  );
  assert.deepEqual(findings, [], "presetId 缺席属于形状段，闭包段不接手");
});

test("⑦ 存量官方种子零新增 finding", () => {
  const dir = path.join(ROOT, "docs", "fleet-templates");
  const files = readdirSync(dir).filter((f) => f.endsWith(".seed.json"));
  assert.ok(files.length > 0, "种子目录非空");
  let members = 0;
  for (const f of files) {
    const seed = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    const findings = memberClosureFindings(seed);
    members += Array.isArray(seed?.fleet?.members) ? seed.fleet.members.length : 0;
    assert.deepEqual(findings, [], `${f} 不应新增闭包 finding`);
  }
  assert.ok(members > 0, `扫到 ${members} 个成员`);
});

test("⑦ 存量蓝图零新增 finding（agents:[] 的跨包蓝图落豁免侧）", { skip: NO_CROSS_REPO }, () => {
  const dir = CROSS_REPO_BLUEPRINTS;
  let checked = 0;
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name, "blueprint.json");
    let bp;
    try {
      bp = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const findings = memberClosureFindings(bp);
    assert.deepEqual(findings, [], `${name} 不应新增闭包 finding`);
    checked += 1;
  }
  assert.ok(checked > 0, `扫到 ${checked} 份蓝图`);
});

test("闭包段合入校验链：错 presetId 让整份文档校验红并进 memberClosure 桶", () => {
  const broken = {
    kind: "team",
    boundary: { name: "闭包链测试", oneLine: "接线测试", outOfScope: "" },
    dataSources: [{ ref: "library:policy" }],
    fleet: {
      name: "闭包链测试",
      members: [
        { ref: "brief", title: "简报岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "missing-agent" }, cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "报数" } },
      ],
    },
    agents: [agent("brief-agent")],
    mcpServers: [],
    acceptance: [{ id: "a1", kind: "report-landed", target: "简报岗" }],
  };
  const verdict = validateBlueprint(broken);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.findings.memberClosure.length, 1);
  assert.equal(verdict.findings.memberClosure[0].code, "fleet_preset_unresolved");
  assert.ok(verdict.errors.some((e) => e.code === "fleet_preset_unresolved"), "摊平后的 errors 也带该 finding");
});

test("闭包段合入校验链：自引用命中则 memberClosure 桶为空", () => {
  const good = {
    kind: "team",
    boundary: { name: "闭包链测试", oneLine: "接线测试", outOfScope: "" },
    dataSources: [],
    fleet: {
      name: "闭包链测试",
      members: [
        { ref: "brief", title: "简报岗", target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "brief-agent" }, cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "报数" } },
      ],
    },
    agents: [agent("brief-agent")],
    mcpServers: [],
    acceptance: [{ id: "a1", kind: "report-landed", target: "简报岗" }],
  };
  const verdict = validateBlueprint(good);
  assert.deepEqual(verdict.findings.memberClosure, []);
});

test("agent 型文档没有 fleet 段，闭包段空跑", () => {
  const verdict = validateBlueprint({ kind: "agent", name: "单岗", description: "", agents: [agent("solo")], mcpServers: [], skills: [] });
  assert.deepEqual(verdict.findings.memberClosure, []);
});
