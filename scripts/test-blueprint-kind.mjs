#!/usr/bin/env node
// ── Blueprint kind unification tests (add-agent-builder-workspace tasks 4.1-
//    4.3) ─────────────────────────────────────────────────────────────────────
//
// Route-level over the same injected seams as test-blueprints.mjs (tmp-file db,
// mocked publish/resolver, header identity). Pins:
//   4.1  存量无 kind 读出 team；POST 接 kind=agent 落轻骨架；kind 非法 400；
//        kind 创建后定死（PUT 改型 400）；agent 文档名字走 content.name
//   4.2  校验链 kind 感知矩阵：agent 跳过 fleet 段、manifest/凭据/数据源照跑；
//        agent 的 approve/cast/trial/signoff 显式 409（不靠 UI 藏按钮）
//   4.3  skills 入 content：含 skills 的文档过校验（绿）；assembleManifest 携
//        skills；发射产物与 content.skills 逐字段一致（旧工作室路径回归）
//
//   node --test scripts/test-blueprint-kind.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "blueprint-kind-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createBlueprintDatabase } = await import("../server/routes/blueprints-db.js");
const { createBlueprintRoutes } = await import("../server/routes/blueprints.js");
const { validateBlueprint, assembleManifest } = await import("../server/blueprint-validate.js");

// team 型全绿底稿（与 test-blueprints 的 VALID_CONTENT 同构的最小版）。
const TEAM_GREEN = {
  kind: "team",
  boundary: { name: "盯梢台", oneLine: "盯政策变化", outOfScope: "不做报关" },
  dataSources: [],
  fleet: {
    name: "盯梢台集群",
    members: [{ ref: "watch", title: "盯梢岗", target: { kind: "tool", id: "websearch::web_search" } }],
  },
  agents: [{ id: "watch-agent", name: "盯梢岗", persona: "你是盯梢岗。" }],
  mcpServers: [],
  monitoring: {},
  acceptance: [],
  board: {},
};

// agent 型轻骨架（无 boundary/fleet/acceptance；名字在顶层）。
const AGENT_GREEN = {
  kind: "agent",
  name: "合同速读员",
  description: "把合同读成一页要点",
  agents: [{ id: "agent-1", name: "速读员", persona: "你把合同读成一页要点。" }],
  mcpServers: [],
  skills: [],
};

function mount() {
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  const publishClient = { async publish() { return { ok: true, packId: "pk_x", version: 1, body: {} }; } };
  const packResolver = async ({ refs }) => Object.fromEntries(refs.map((r) => [r, { packId: `pk_${r}`, name: r }]));
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver, trialDeps: { runTrial: async () => { throw new Error("trial must never be reached for agent kind"); } } });
  const server = http.createServer(app);
  server.listen(0);
  return { server, store, base: `http://127.0.0.1:${server.address().port}` };
}

const as = (email, init = {}) => ({
  ...init,
  headers: { "Content-Type": "application/json", ...(email ? { "x-test-user": email } : {}), ...(init.headers ?? {}) },
});
const j = (res) => res.json();
const close = (server) => new Promise((r) => server.close(r));

test("4.1 存量记录无 kind：读出 team（缺省语义，零迁移）", async () => {
  const { server, store, base } = mount();
  try {
    // 直接经 store 写一份无 kind 的旧形状 content（模拟存量行）。
    const legacy = JSON.parse(JSON.stringify(TEAM_GREEN));
    delete legacy.kind;
    const created = store.createBlueprint({ id: "bp_legacy", ownerEmail: "alice@x", name: "盯梢台", content: legacy });
    assert.equal(created.content.kind, undefined); // 盘上真无字段
    const read = await fetch(`${base}/api/blueprints/bp_legacy`, as("alice@x")).then(j);
    assert.equal((read.blueprint.content.kind ?? "team"), "team");
    // 校验链同样按缺省 team 走（fleet 段照跑）。
    assert.equal(validateBlueprint(read.blueprint.content).ok, true);
  } finally {
    await close(server);
  }
});

test("4.1 POST kind=agent 落轻骨架；kind 非法 400；PUT 改型 400", async () => {
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ kind: "agent", name: "合同速读员", content: AGENT_GREEN }) })).then(j);
    assert.equal(created.blueprint.content.kind, "agent");
    assert.equal(created.blueprint.name, "合同速读员");
    assert.equal(created.blueprint.oneLine, "把合同读成一页要点");
    assert.equal(created.blueprint.content.boundary, undefined);
    assert.equal(created.blueprint.content.fleet, undefined);
    const id = created.blueprint.id;

    // 非法 kind 显式 400。
    assert.equal((await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ kind: "fleet", content: { name: "x" } }) }))).status, 400);

    // agent 文档名字走 content.name（PUT 无 name 参数时回退 content.name）。
    const renamed = { ...AGENT_GREEN, name: "速读员 v2" };
    const put = await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: renamed }) })).then(j);
    assert.equal(put.blueprint.name, "速读员 v2");

    // 改型显式 400（kind 创建后定死）。
    const flip = await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 2, content: { ...renamed, kind: "team" } }) }));
    assert.equal(flip.status, 400);
    assert.match((await flip.json()).error, /fixed at creation/);
  } finally {
    await close(server);
  }
});

test("4.2 校验矩阵：agent 跳过 fleet 段；凭据/数据源/manifest 照跑", () => {
  // agent 绿。
  assert.equal(validateBlueprint(AGENT_GREEN).ok, true);
  // agent 带 junk fleet：fleet 段跳过（不因误带段永久卡死），其余照跑。
  const withJunkFleet = { ...AGENT_GREEN, fleet: { name: "x", members: [] } };
  assert.equal(validateBlueprint(withJunkFleet).ok, true);
  // manifest 段照跑：agent 名超长照报（entry-less，原文逐字 + 稳定 code）。
  const badName = { ...AGENT_GREEN, name: "N".repeat(90) };
  const v = validateBlueprint(badName);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, [{ error: "name must be a non-empty string of at most 80 characters", code: "name_too_long" }]);
  // 凭据闸照跑：agent 文档带秘密字面值照拒。
  const leaky = { ...AGENT_GREEN, agents: [{ id: "agent-1", name: "A", persona: "key sk-abcdefghijklmnop here" }] };
  assert.equal(validateBlueprint(leaky).ok, false);
  // team 行为不变（回归）。
  assert.equal(validateBlueprint(TEAM_GREEN).ok, true);
  // team 的 fleet 段照跑（kind 感知不豁免 team）。
  const brokenTeam = { ...TEAM_GREEN, fleet: { name: "T", members: [] } };
  const vt = validateBlueprint(brokenTeam);
  assert.equal(vt.ok, false);
  assert.ok(vt.errors.some((e) => e.entry === "fleet"));
});

test("4.2 agent 的 approve/cast/trial/signoff 显式 409（服务端闸，不靠 UI 藏）", async () => {
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ kind: "agent", content: AGENT_GREEN }) })).then(j);
    const id = created.blueprint.id;
    const ver = created.blueprint.version;
    for (const [path, body] of [
      ["/approve", { expectVersion: ver }],
      ["/cast", {}],
      ["/trial", {}],
      ["/trial-signoff", {}],
    ]) {
      const r = await fetch(`${base}/api/blueprints/${id}${path}`, as("alice@x", { method: "POST", body: JSON.stringify(body) }));
      assert.equal(r.status, 409, `${path} must 409 for agent kind`);
      assert.equal((await r.json()).kind, "agent");
    }
    // validate 对 agent 照常可用（发射前自检通道）。
    const val = await fetch(`${base}/api/blueprints/${id}/validate`, as("alice@x", { method: "POST" }));
    assert.equal(val.status, 200);
    assert.equal((await val.json()).ok, true);
  } finally {
    await close(server);
  }
});

test("4.3 skills 入 content：绿路径 + assembleManifest 携带 + 发射产物逐字段一致", () => {
  const skills = [
    { name: "contract-scan", description: "扫关键条款", content: "# 扫描\n检查违约与终止条款。" },
    { name: "one-pager", description: "出一页要点", content: "# 输出\n五条要点。" },
  ];
  const withSkills = { ...AGENT_GREEN, skills };
  // 含 skills 的 agent 文档过校验（技能段 = validatePackManifest 同函数）。
  assert.equal(validateBlueprint(withSkills).ok, true, JSON.stringify(validateBlueprint(withSkills).errors));
  // 清单携带逐字段一致（发射/铸造同源——不再静默丢技能桶）。
  const manifest = assembleManifest(withSkills);
  assert.deepEqual(manifest.skills, skills);
  // 坏技能照样报（技能段全量照跑）：重名。
  const dup = { ...AGENT_GREEN, skills: [skills[0], { ...skills[0] }] };
  assert.equal(validateBlueprint(dup).ok, false);
  // team 文档同样可携 skills（统一桶，不二义）。
  const teamWithSkills = { ...TEAM_GREEN, skills: [skills[0]] };
  assert.equal(validateBlueprint(teamWithSkills).ok, true, JSON.stringify(validateBlueprint(teamWithSkills).errors));
  assert.deepEqual(assembleManifest(teamWithSkills).skills, [skills[0]]);
});
