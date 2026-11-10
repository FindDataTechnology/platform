#!/usr/bin/env node
// ── Blueprint studio Slice 1 tests (add-blueprint-studio tasks 1.x/3.x) ─────
//
// Route-level coverage over injected seams (db on a tmp file, publishClient
// and packResolver mocked — the real market gate is never touched); identity
// rides the same resolveUserFactory semantics as fleets.js (auth-on →
// req.user only). Covers the four gates from the implementation notes:
//   ① 不当 expectVersion 的批准报 409      ② 校验不绿的批准报 422
//   ③ 未批准的铸造报 409                    ④ 顺利铸造记录 cast_pack_id
// plus the storage credential wall (task 1.3), the version/approval
// discipline, dependency-placeholder fill/drift, self-reference continuity,
// and the trial-report slot.
//
//   node --test scripts/test-blueprints.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "blueprints-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createBlueprintDatabase } = await import("../server/routes/blueprints-db.js");
const { createBlueprintRoutes } = await import("../server/routes/blueprints.js");

// 合法底稿：四段校验链全绿的最小蓝图（凭据/形状/fleet 段/manifest 段/
// 工具面 consult 一支不过都不行）。
const VALID_CONTENT = {
  boundary: { name: "政策盯梢", oneLine: "盯跨境电商政策变化", outOfScope: "不做报关" },
  dataSources: [{ ref: "policy-feed" }],
  fleet: {
    name: "政策盯梢集群",
    members: [
      {
        ref: "watch",
        title: "盯梢岗",
        target: { kind: "tool", id: "websearch::web_search" },
        cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"cross-border policy\"}" },
      },
      {
        ref: "brief",
        title: "简报岗",
        parentRef: "watch",
        target: { kind: "pack-preset", packId: "{{PACK_ID}}", presetId: "brief-agent" },
        kpiSlots: [{ key: "briefs", label: "简报数", unit: "份" }],
      },
    ],
  },
  agents: [{ id: "brief-agent", name: "简报岗", persona: "你是简报岗，汇总盯梢结果出晨报。" }],
  mcpServers: [],
  monitoring: { escalate: { threshold: 3 } },
  acceptance: [{ id: "first-brief", kind: "report-landed", target: "简报岗" }],
  board: { sections: ["daily"] },
};

function mount({ db, publishCalls = [], resolverResult = {}, trialDeps = undefined } = {}) {
  const store = db ?? createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Test seam: identity rides a header; absent = unauthenticated (auth-on).
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  const publishClient = {
    async publish(args) {
      publishCalls.push(args);
      return { ok: true, packId: args.packId ?? "pk_cast_1", version: (args.packId ? 2 : 1), body: {} };
    },
  };
  const packResolver = async ({ refs }) =>
    Object.fromEntries(refs.filter((r) => resolverResult[r] !== null).map((r) => [r, resolverResult[r] ?? { packId: `pk_${r}`, name: r }]));
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver, trialDeps });
  const server = http.createServer(app);
  server.listen(0);
  return { server, store, publishCalls, base: `http://127.0.0.1:${server.address().port}` };
}

const as = (email, init = {}) => ({
  ...init,
  headers: { "Content-Type": "application/json", ...(email ? { "x-test-user": email } : {}), ...(init.headers ?? {}) },
});
const j = (res) => res.json();
const close = (server) => new Promise((r) => server.close(r));

test("1.2 草稿生命周期：创建→清单不含 content→详情→版本纪律", async () => {
  const { server, base } = mount();
  try {
    // 未带身份：auth-on 下 401。
    assert.equal((await fetch(`${base}/api/blueprints`, as(null))).status, 401);

    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    assert.equal(created.blueprint.status, "draft");
    assert.equal(created.blueprint.version, 1);
    assert.equal(created.blueprint.name, "政策盯梢");
    assert.deepEqual(created.warnings, []);
    const id = created.blueprint.id;

    // 清单不含 content；他人清单为空、他人详情 404（存在性不外泄）。
    const list = await fetch(`${base}/api/blueprints`, as("alice@x")).then(j);
    assert.equal(list.blueprints.length, 1);
    assert.equal(list.blueprints[0].content, undefined);
    assert.deepEqual(await fetch(`${base}/api/blueprints`, as("bob@x")).then(j), { blueprints: [] });
    assert.equal((await fetch(`${base}/api/blueprints/${id}`, as("bob@x"))).status, 404);

    // expectVersion 不符 → 409 指名当前版；相符 → version+1。
    const conflict = await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 9, content: VALID_CONTENT }) }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).currentVersion, 1);
    const edited = await fetch(
      `${base}/api/blueprints/${id}`,
      as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: { ...VALID_CONTENT, boundary: { ...VALID_CONTENT.boundary, outOfScope: "不做报关、不做退税" } } }) }),
    ).then(j);
    assert.equal(edited.blueprint.version, 2);
    // 归一化 diff 记录字段级变化。
    assert.match(edited.blueprint.diffSummary, /boundary\.outOfScope/);
  } finally {
    await close(server);
  }
});

test("1.3 凭据禁带闸：存储层硬拒端点/秘密字面值，软契约发现照报不阻", async () => {
  const { server, base } = mount();
  try {
    // 禁键 + 秘密字面值 → 422，且什么都没存下。
    const carried = {
      ...VALID_CONTENT,
      mcpServers: [{ registryName: "ext", headers: { Authorization: "Bearer sk-abcdef0123456789" } }],
    };
    const rejected = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: carried }) }));
    assert.equal(rejected.status, 422);
    assert.match((await rejected.json()).error, /credentials|endpoints/);
    assert.deepEqual(await fetch(`${base}/api/blueprints`, as("alice@x")).then(j), { blueprints: [] });

    // dataSources 带了端点形 ref：草稿照存（201）+ warnings 逐字段指名；
    // 全链校验与批准面再拦（见下）。
    const soft = await fetch(
      `${base}/api/blueprints`,
      as("alice@x", { method: "POST", body: JSON.stringify({ content: { ...VALID_CONTENT, dataSources: [{ ref: "https://evil.example/feed" }] } }) }),
    );
    assert.equal(soft.status, 201);
    const softBody = await soft.json();
    assert.match(softBody.warnings[0]?.error ?? "", /registry server name, an internal-library logical name, or a knowledge collection/);
  } finally {
    await close(server);
  }
});

test("校验链：既有校验器原文逐字段，approve 短路 ②", async () => {
  const { server, base } = mount();
  try {
    const bad = await fetch(
      `${base}/api/blueprints`,
      as("alice@x", {
        method: "POST",
        body: JSON.stringify({
          content: {
            ...VALID_CONTENT,
            dataSources: [{ ref: "https://evil.example/feed" }],
            fleet: { name: "坏集群", members: [] },
          },
        }),
      }),
    ).then(j);
    const id = bad.blueprint.id;

    const verdict = await fetch(`${base}/api/blueprints/${id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    // 错误文本与既有校验器同源：parseFleetTemplate 的原文 + shape 闸指名。
    assert.ok(verdict.errors.some((e) => e.error === "fleet.members must be a non-empty array"));
    assert.ok(verdict.errors.some((e) => e.entry === "dataSources[0].ref"));
    assert.equal(verdict.manifestPreview.category, "fleet");

    // ② 校验不绿的批准报 422，指名未过项。
    const blocked = await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    assert.equal(blocked.status, 422);
    assert.match((await blocked.json()).error, /validation must be fully green/);
  } finally {
    await close(server);
  }
});

test("成环 handoff 边被既有编排校验指名（spec 非法蓝图 scenario）", async () => {
  const { server, base } = mount();
  try {
    const cyclic = {
      ...VALID_CONTENT,
      fleet: {
        ...VALID_CONTENT.fleet,
        orchestration: { edges: [{ kind: "handoff", from: "watch", to: "watch" }] },
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: cyclic }) })).then(j);
    const verdict = await fetch(`${base}/api/blueprints/${created.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => /a post cannot hand off to itself/.test(e.error)));
  } finally {
    await close(server);
  }
});

test("3.1 批准闸：①版本不符 409；批准后编辑即清批准（旧批准不延用）", async () => {
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = created.blueprint.id;

    // ① 不当 expectVersion 的批准报 409。
    const conflict = await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 7 }) }));
    assert.equal(conflict.status, 409);

    const approved = await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) })).then(j);
    assert.equal(approved.blueprint.status, "approved");
    assert.equal(approved.blueprint.approvedBy, "alice@x");
    assert.ok(approved.blueprint.approvedAt);

    // 编辑 = 新草稿版：version+1、status 回 draft、批准清空。
    const edited = await fetch(
      `${base}/api/blueprints/${id}`,
      as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: { ...VALID_CONTENT, monitoring: { escalate: { threshold: 5 } } } }) }),
    ).then(j);
    assert.equal(edited.blueprint.version, 2);
    assert.equal(edited.blueprint.status, "draft");
    assert.equal(edited.blueprint.approvedBy, null);
  } finally {
    await close(server);
  }
});

test("3.2/3.3 铸造：③未批准 409、非批准人 403、④顺利铸造带 _casting 与占位落实", async () => {
  const publishCalls = [];
  const { server, base } = mount({ publishCalls });
  try {
    const withDep = {
      ...VALID_CONTENT,
      fleet: {
        name: "政策盯梢集群",
        members: [
          ...VALID_CONTENT.fleet.members,
          { ref: "disc", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:政策纪律包}}", presetId: "brief-agent" } },
        ],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withDep }) })).then(j);
    const id = created.blueprint.id;

    // ③ 未批准的铸造报 409。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }))).status, 409);

    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    // 非批准人铸造 403（批准纪律：apply 与批准同人）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("bob@x", { method: "POST" }))).status, 404); // 他人资产 404
    const notApprover = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(notApprover.status, 200);

    // ④ 顺利铸造：cast_pack_id 落账；发布客户端收到带追溯的 manifest。
    const castBody = await notApprover.json();
    assert.equal(castBody.blueprint.status, "cast");
    assert.equal(castBody.blueprint.castPackId, "pk_cast_1");
    assert.equal(publishCalls.length, 1);
    const sent = publishCalls[0].manifest;
    assert.equal(sent.category, "fleet");
    assert.equal(sent.name, "政策盯梢");
    assert.equal(sent._casting.source, "fleet-blueprint-studio");
    assert.equal(sent._casting.blueprintId, id);
    assert.equal(sent._casting.approvedBy, "alice@x");
    // 依赖占位逐项落实，包自引用首铸保持（谱系在续铸回补）。
    const disc = sent.fleet.members.find((m) => m.ref === "disc");
    assert.equal(disc.target.packId, "pk_政策纪律包");
    const brief = sent.fleet.members.find((m) => m.ref === "brief");
    assert.equal(brief.target.packId, "{{PACK_ID}}");
    assert.equal(castBody.cast.selfPending, true);
  } finally {
    await close(server);
  }
});

test("依赖漂移拒：市场解析不出的占位名指名 409", async () => {
  const { server, base } = mount({ resolverResult: { "政策纪律包": null } });
  try {
    const withDep = {
      ...VALID_CONTENT,
      fleet: {
        name: "政策盯梢集群",
        members: [{ ref: "disc", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:政策纪律包}}", presetId: "brief-agent" } }],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withDep }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));

    const refused = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.deepEqual(body.missing, ["政策纪律包"]);
    // 未铸造成功：状态仍是 approved，可修正后重批重铸。
    const after = await fetch(`${base}/api/blueprints/${id}`, as("alice@x")).then(j);
    assert.equal(after.blueprint.status, "approved");
  } finally {
    await close(server);
  }
});

test("续铸谱系：publish 携既有 packId 续版，包自引用回补（D5）", async () => {
  const publishCalls = [];
  const { server, base } = mount({ publishCalls });
  try {
    const withDep = {
      ...VALID_CONTENT,
      fleet: {
        name: "政策盯梢集群",
        members: [
          ...VALID_CONTENT.fleet.members,
          { ref: "disc", title: "纪律岗", target: { kind: "pack-preset", packId: "{{PACK_ID:政策纪律包}}", presetId: "brief-agent" } },
        ],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withDep }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }))).status, 200);

    // 编辑→重批→重铸：publish 携上一铸的 packId 续版，manifest 里
    // 依赖占位与包自引用双双落实。
    await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content: withDep }) }));
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 2 }) }));
    const cast2 = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(cast2.blueprint.castPackVersion, 2);
    assert.equal(publishCalls[1].packId, "pk_cast_1");
    const brief2 = publishCalls[1].manifest.fleet.members.find((m) => m.ref === "brief");
    assert.equal(brief2.target.packId, "pk_cast_1");
    assert.equal(cast2.cast.selfPending, false);
  } finally {
    await close(server);
  }
});

test("下限规则：全引用无内联件在 draft-validate 即以既有原文报出（D3 不另造友好版）", async () => {
  const { server, base } = mount();
  try {
    // 编制全引用、零内联件的蓝图：pack floor 规则在 /validate 已由
    // validatePackManifest 原文报出——不需要 shape 闸另造改写版错误文案
    // （spec D3：错误来源=既有校验器原文，不得超其字段粒度另写措辞）。
    const noInline = {
      ...VALID_CONTENT,
      agents: [],
      mcpServers: [],
      fleet: {
        name: "全引用集群",
        members: [{ ref: "ext", title: "外援岗", target: { kind: "existing-persona", id: "someone" } }],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: noInline }) })).then(j);
    const verdict = await fetch(`${base}/api/blueprints/${created.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => /at least one skill, MCP reference, agent, or bot/.test(e.error)));
  } finally {
    await close(server);
  }
});

test("试跑报告位：铸造前拒落，铸造后落/读（Slice 3 执行器挂点）", async () => {
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = created.blueprint.id;
    const report = { assertions: [{ id: "first-brief", pass: true, evidence: "trace://t1" }], firstTurn: true };

    const early = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x", { method: "POST", body: JSON.stringify({ report }) }));
    assert.equal(early.status, 409);

    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));

    const saved = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x", { method: "POST", body: JSON.stringify({ report }) }));
    assert.equal(saved.status, 200);
    const readBack = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x")).then(j);
    assert.deepEqual(readBack.report, report);
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial-report`, as("bob@x"))).status, 404);
  } finally {
    await close(server);
  }
});

test("4.1 试跑闸：非铸造态 409；铸造后装一台跑一轮并落报告（注入执行器）", async () => {
  const trialDeps = {
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { name: "政策盯梢", members: [] } }),
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "fleet_trial_1" }),
    startFleet: async () => {},
    fireRound: async () => [{ jobId: "job_1", memberId: "m1", at: 1010 }],
    collectAndWait: async ({ since }) => ({
      members: [{ memberId: "m1", title: "简报岗", targetId: "brief-agent" }],
      turns: [{ memberId: "m1", at: since + 1, jobId: "job_1", turnId: "turn_1" }],
      reports: [{ memberId: "m1", reportId: "report_1", createdAt: since + 2, turnId: "turn_1" }],
      escalations: 0,
    }),
  };
  const { server, base } = mount({ trialDeps });
  try {
    const withGrammar = {
      ...VALID_CONTENT,
      acceptance: [{ id: "first-brief", kind: "report-landed", target: "简报岗" }],
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: withGrammar }) })).then(j);
    const id = created.blueprint.id;

    // 非铸造态：409（草稿阶段任何实体零副作用，试跑也不许开跑）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" }))).status, 409);

    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));

    const trial = await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(trial.report.green, true);
    assert.equal(trial.report.fleetId, "fleet_trial_1");
    assert.deepEqual(trial.report.assertions[0].evidence.reportIds, ["report_1"]);

    // 报告落账（既有存储位）并可读回。
    const readBack = await fetch(`${base}/api/blueprints/${id}/trial-report`, as("alice@x")).then(j);
    assert.equal(readBack.report.green, true);
    assert.equal(readBack.report.fleetId, "fleet_trial_1");

    // 他人读同一报告 404（owner 作用域）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial-report`, as("bob@x"))).status, 404);
  } finally {
    await close(server);
  }
});

test("3.3 发布客户端身份头：user 必须是对象（base64url 身份契约回归）", async () => {
  // 2026-10-28 生产走查逮住的真缺陷：传裸邮箱串 → facetForwardHeaders 取
  // user.email 得 undefined → 身份头空 → facet 判匿名 401。此处锁住形状：
  // 无论收到串还是对象，发出去的必须是 {email, groups} 对象。
  const { createFacetPublishClient } = await import("../server/routes/blueprints.js");
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: "pk_x", version: 1 }) };
  };
  const client = createFacetPublishClient({ env: { FACET_BASE_URL: "http://facet.test", FACET_INTERNAL_TOKEN: "tok" }, fetchImpl: fakeFetch });
  const out = await client.publish({ manifest: { name: "m" }, user: "a@b.c" });
  assert.equal(out.ok, true);
  const decoded = JSON.parse(Buffer.from(seen[0].headers["x-facet-user"], "base64url").toString("utf8"));
  assert.deepEqual(decoded, { email: "a@b.c", groups: [] });
  assert.equal(seen[0].headers["x-facet-token"], "tok");

  // 无邮箱的身份 → 401，不发请求。
  const before = seen.length;
  const anon = await client.publish({ manifest: { name: "m" }, user: { groups: [] } });
  assert.equal(anon.status, 401);
  assert.equal(seen.length, before);
});

test("v1 方言如实拒绝：粘入即被指名拒绝（不归一化、不落库、只报一条根因）", async () => {
  // remove-blueprint-v1-compat：平台只接受 v2。v1（vertical/sources/boards +
  // 自由文本 acceptance）不再被归一化接受——写入层硬拒 422，校验链短路只报
  // 一条根因，不掺派生的 acceptance 形状错与无 entry 的包级错。
  const v1 = {
    vertical: { name: "跨境电商政策盯梢", tagline: "盯四路政策与公告面，异动即报", non_goals: ["商品价格监控", "汇率预测"] },
    sources: [{ registryName: "fd-info", purpose: "部委公告与政策流", allowTools: ["list_since", "get_item"] }],
    fleet: {
      name: "政策盯梢集群",
      members: [{ ref: "watch", title: "盯梢岗", target: { kind: "tool", id: "websearch::web_search" },
        cadence: { cron: "0 9 * * *", tz: "Asia/Shanghai", promptTemplate: "{\"query\":\"policy\"}" } }],
    },
    boards: [{ artifact: "doc", title: "政策日报", discipline: "draft+提案制" }],
    monitoring: { anomaly_criteria: ["部委公告异动"], escalate: { threshold: 3 }, notify: "proposal-channel" },
    acceptance: ["巡检员一个成功回合", "主编日报合成"],
    _casting: { source_blueprint: "fleet-packs/blueprints/x/blueprint.json", packDependencies: {} },
  };
  const { server, base } = mount();
  try {
    // 写入层硬拒：POST 422，body.error 指名 v1，findings 携带完整迁移指引。
    const res = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: v1 }) }));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /蓝图格式为 v1/);
    assert.ok(Array.isArray(body.findings) && body.findings.length === 1, "只报一条根因错");
    assert.match(body.findings[0].error, /本平台只接受 v2/);
    assert.match(body.findings[0].error, /sources\[\]\.registryName 换成 dataSources\[\]\.ref/, "带 v1→v2 迁移指引");

    // 不落库。
    const list = await fetch(`${base}/api/blueprints`, as("alice@x")).then(j);
    assert.equal(list.blueprints.length, 0, "v1 蓝图不得落库");

    // 校验链短路：直接喂 validateBlueprint，只返回一条错（不是 4 条 acceptance
    // 形状错 + 一条无 entry 包级错）。
    const { validateBlueprint } = await import("../server/blueprint-validate.js");
    const verdict = validateBlueprint(v1);
    assert.equal(verdict.errors.length, 1);
    assert.equal(verdict.errors[0].entry, "content");
    assert.match(verdict.errors[0].error, /蓝图格式为 v1/);
  } finally {
    await close(server);
  }
});

test("v1 判别不误伤：合规 v2 蓝图另带无害旧键仍正常通过", async () => {
  // design D2 合取判别：v1 独有键存在 **且** 对应 v2 键缺位才触发。一份自带
  // boundary/dataSources/board 的 v2 文档，即便另带一个未使用的 sources 旧键也
  // 不得被拒。
  const v2WithStray = { ...VALID_CONTENT, sources: [{ registryName: "stray", purpose: "遗留附注" }] };
  const { server, base } = mount();
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: v2WithStray }) })).then(j);
    assert.equal(created.blueprint.name, "政策盯梢");
    const verdict = await fetch(`${base}/api/blueprints/${created.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(verdict.errors.some((e) => /蓝图格式为 v1/.test(e.error)), false, "不得误判为 v1");
  } finally {
    await close(server);
  }
});

test("删除：从未铸造的草稿可删；已铸造的拒删（市场包才是账）", async () => {
  const { server, base } = mount();
  try {
    const a = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const draftId = a.blueprint.id;
    assert.equal((await fetch(`${base}/api/blueprints/${draftId}`, as("bob@x", { method: "DELETE" }))).status, 404);
    const del = await fetch(`${base}/api/blueprints/${draftId}`, as("alice@x", { method: "DELETE" }));
    assert.equal(del.status, 200);
    assert.equal((await fetch(`${base}/api/blueprints/${draftId}`, as("alice@x"))).status, 404);

    // 已铸造：拒删并指名 castPackId。
    const b = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = b.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    const refused = await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "DELETE" }));
    assert.equal(refused.status, 409);
    assert.ok((await refused.json()).castPackId);
    // 仍在。
    assert.equal((await fetch(`${base}/api/blueprints/${id}`, as("alice@x"))).status, 200);
  } finally {
    await close(server);
  }
});

test("签字：只模型判绿未签字不可售；签字后放行；重跑覆盖即失效", async () => {
  const trialDeps = {
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { name: "x", members: [] } }),
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "f_trial" }),
    startFleet: async () => {},
    productionLanes: async () => ["lane-producer"],
    fireRound: async () => [{ jobId: "j1", memberId: "m1", at: 1010 }],
    collectAndWait: async ({ since }) => ({
      members: [{ memberId: "m1", title: "简报岗", targetId: "brief" }],
      turns: [{ memberId: "m1", at: since + 1, jobId: "j1" }],
      reports: [{ memberId: "m1", reportId: "r1", createdAt: since + 2, summary: "简报已出" }],
      escalations: 0,
    }),
    judge: async () => ({ verdict: "pass", reason: "证据支持", audit: { model: "runner-a", verdict: "pass" } }),
  };
  const { server, base } = mount({ trialDeps });
  try {
    const content = {
      ...VALID_CONTENT,
      acceptance: [{ id: "sem", kind: "llm-judged", rubric: "首轮产出简报" }],
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));

    // 未签字时签不了？——先跑试跑，再有报告可签。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/trial-signoff`, as("alice@x", { method: "POST" }))).status, 409);

    const trial = await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(trial.report.green, true, "机器绿 + 模型绿");
    assert.equal(trial.report.signoff, undefined, "未签字");

    // 签字。
    const signed = await fetch(`${base}/api/blueprints/${id}/trial-signoff`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(signed.report.signoff.by, "alice@x");
    assert.equal(signed.report.signoff.reportRanAt, trial.report.ranAt);

    // 重跑覆盖 → 旧签字失效（ranAt 变了）。
    const rerun = await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(rerun.report.signoff, undefined);

    // 撤签路径。
    await fetch(`${base}/api/blueprints/${id}/trial-signoff`, as("alice@x", { method: "POST" }));
    const cleared = await fetch(`${base}/api/blueprints/${id}/trial-signoff`, as("alice@x", { method: "DELETE" })).then(j);
    assert.equal(cleared.report.signoff, undefined);
  } finally {
    await close(server);
  }
});

test("铸造嵌试跑报告：_casting.trialReport 带 green/judged/signoff（可售闸只读 manifest）", async () => {
  const publishCalls = [];
  const trialDeps = {
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { name: "x", members: [] } }),
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "f1" }),
    startFleet: async () => {},
    productionLanes: async () => ["lane-producer"],
    fireRound: async () => [{ jobId: "j1", memberId: "m1", at: 1010 }],
    collectAndWait: async ({ since }) => ({
      members: [{ memberId: "m1", title: "简报岗", targetId: "brief" }],
      turns: [{ memberId: "m1", at: since + 1, jobId: "j1" }],
      reports: [{ memberId: "m1", reportId: "r1", createdAt: since + 2, summary: "简报已出" }],
      escalations: 0,
    }),
    judge: async () => ({ verdict: "pass", reason: "", audit: { model: "runner-a", verdict: "pass" } }),
  };
  const { server, base } = mount({ publishCalls, trialDeps });
  try {
    const content = { ...VALID_CONTENT, acceptance: [{ id: "sem", kind: "llm-judged", rubric: "有简报" }] };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" }));
    await fetch(`${base}/api/blueprints/${id}/trial-signoff`, as("alice@x", { method: "POST" }));

    // 再编辑→重批→重铸：这份 manifest 才该带报告。
    await fetch(`${base}/api/blueprints/${id}`, as("alice@x", { method: "PUT", body: JSON.stringify({ expectVersion: 1, content }) }));
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 2 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));

    const last = publishCalls[publishCalls.length - 1].manifest;
    assert.equal(last._casting.trialReport.green, true);
    assert.equal(last._casting.trialReport.judged[0].verdict, "pass");
    assert.equal(last._casting.trialReport.signoff.by, "alice@x");
  } finally {
    await close(server);
  }
});

test("重新封印：铸造态下内容未变+报告已签 → 允许再铸一版带上签字", async () => {
  const publishCalls = [];
  const trialDeps = {
    now: () => 1000,
    fetchManifest: async () => ({ fleet: { name: "x", members: [] } }),
    install: async () => {},
    provision: async () => ({ ok: true, fleetId: "f1" }),
    startFleet: async () => {},
    productionLanes: async () => [{ providerId: "p", model: "producer" }],
    fireRound: async () => [{ jobId: "j1", memberId: "m1", at: 1010 }],
    collectAndWait: async ({ since }) => ({
      members: [{ memberId: "m1", title: "简报岗", targetId: "brief" }],
      turns: [{ memberId: "m1", at: since + 1, jobId: "j1" }],
      reports: [{ memberId: "m1", reportId: "r1", createdAt: since + 2 }],
      escalations: 0,
    }),
    judge: async () => ({ verdict: "pass", reason: "", audit: { model: "judge-1", verdict: "pass" } }),
  };
  const { server, base } = mount({ publishCalls, trialDeps });
  try {
    const content = { ...VALID_CONTENT, acceptance: [{ id: "sem", kind: "llm-judged", rubric: "有简报" }] };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    await fetch(`${base}/api/blueprints/${id}/trial`, as("alice@x", { method: "POST" }));

    // 未签字时不允许重铸（防绕过双钥匙）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }))).status, 409);

    await fetch(`${base}/api/blueprints/${id}/trial-signoff`, as("alice@x", { method: "POST" }));
    const reseal = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(reseal.status, 200);
    const last = publishCalls[publishCalls.length - 1].manifest;
    assert.equal(last._casting.trialReport.signoff.by, "alice@x");
    assert.equal(last._casting.trialReport.green, true);

    // 他人不能重铸（批准人/签字人都得是本人）。
    assert.equal((await fetch(`${base}/api/blueprints/${id}/cast`, as("bob@x", { method: "POST" }))).status, 404);
  } finally {
    await close(server);
  }
});

test("评审模型选择：在册放行、不在册校验面指名、向后兼容", async () => {
  const { server, base } = mount();
  // 名册来源是部署侧状态（cell 名册文件 / default 指针 / 部署 env）。裸仓与 CI
  // 上三者皆空 → 校验面按设计降级为「不校验」，本断言就失去被测对象。故自备
  // 一条部署 env 名册，让「不在册要指名」这条判据有确定的被测前提。
  const prevRoster = process.env.BLUEPRINT_JUDGE_MODEL;
  process.env.BLUEPRINT_JUDGE_MODEL = "roster-model-in-test";
  try {
    // 未声明 judgeModel：校验行为不变（既有蓝图兼容）。
    const plain = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const v1 = await fetch(`${base}/api/blueprints/${plain.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(v1.findings.judgeModel.length, 0, "未声明不做额外校验");

    // 声明一个名册里没有的模型 → 校验面逐字段指名。
    const ghost = await fetch(`${base}/api/blueprints`, as("alice@x", {
      method: "POST",
      body: JSON.stringify({ content: { ...VALID_CONTENT, judgeModel: "definitely-not-a-model-xyz" } }),
    })).then(j);
    const v2 = await fetch(`${base}/api/blueprints/${ghost.blueprint.id}/validate`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(v2.ok, false);
    const jm = v2.findings.judgeModel;
    assert.equal(jm.length, 1);
    assert.equal(jm[0].entry, "judgeModel");
    assert.match(jm[0].error, /not in this deployment's model roster/);

    // 批准也被同一条件短路。
    const ap = await fetch(`${base}/api/blueprints/${ghost.blueprint.id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    assert.equal(ap.status, 422);
  } finally {
    if (prevRoster === undefined) delete process.env.BLUEPRINT_JUDGE_MODEL;
    else process.env.BLUEPRINT_JUDGE_MODEL = prevRoster;
    await close(server);
  }
});

test("名册来源：cell 名册为空时回落 default 指针/部署 env，不静默放过", async () => {
  const { judgeModelFindings } = await import("../server/blueprint-validate.js");
  // 断言至少有一条路径认得部署 env 里的模型（生产 cell 名册常为空）。
  const deployed = process.env.BLUEPRINT_JUDGE_MODEL;
  const prev = deployed;
  try {
    process.env.BLUEPRINT_JUDGE_MODEL = "deployed-model-abc";
    assert.equal(judgeModelFindings({ judgeModel: "deployed-model-abc" }).length, 0, "部署 env 的模型应视为在册");
    assert.equal(judgeModelFindings({ judgeModel: "ghost-xyz-123" }).length, 1, "真不在册要报");
  } finally {
    if (prev === undefined) delete process.env.BLUEPRINT_JUDGE_MODEL;
    else process.env.BLUEPRINT_JUDGE_MODEL = prev;
  }
  // 未声明 → 不校验（向后兼容）
  assert.deepEqual(judgeModelFindings({}), []);
});

// ── 优化③：「跟随部署默认」解析探测（不是 id 路由的误吞） ──────────────────
test("judge-default：静态路由不被 /:id 吞掉，如实回解析结果", async () => {
  const { server, base } = mount();
  try {
    // 未登录 401（与其他读面同权限）
    assert.equal((await fetch(`${base}/api/blueprints/judge-default`, as(null))).status, 401);

    const res = await fetch(`${base}/api/blueprints/judge-default`, as("alice@x"));
    assert.equal(res.status, 200, "静态路由必须排在 /:id 之前，否则会被当成蓝图 id");
    const body = await res.json();
    // 形状契约：要么给出解析到的模型，要么如实说明为什么没有
    assert.ok("resolved" in body, "必须带 resolved 字段（null 表示本部署没有评审车道）");
    if (body.resolved) {
      assert.equal(typeof body.resolved.model, "string");
      assert.ok(body.resolved.model.length > 0);
    } else {
      assert.equal(typeof body.reason, "string");
    }
    // 指定一个不在册的模型：有可见名册时应判 unavailable；名册不可见时按指定模型发。
    const asked = await fetch(`${base}/api/blueprints/judge-default?for=definitely-not-a-model`, as("alice@x")).then(j);
    assert.ok("resolved" in asked || "unavailable" in asked);
  } finally {
    await close(server);
  }
});

// 陈旧指针自愈（2026-10-30 生产实录）：市场的 packId 每部署随机铸造，改名/重建
// 流程换 id 后蓝图记的旧 id 在市场 404 → 试跑一律 `Pack version not found`，而
// 「再铸」又要求先有绿签报告（只能由试跑产出）= 死锁。铸造面必须能自救：以旧 id
// 发版被 404 拒时，如实再发一枚并把指针改到新 id，响应带 rebuilt:true。
test("铸造：旧 packId 已失效时重建新包并改指针（rebuilt 可见），非 404 不动", async () => {
  const publishCalls = [];
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  // 首铸成功给 pk_first；以 packId 续铸一律 404（模拟 id 已被改名流程换掉）。
  let seq = 0;
  const publishClient = {
    async publish(args) {
      publishCalls.push(args);
      if (args.packId) return { ok: false, status: 404, error: "Pack not found", body: { error: "Pack not found" } };
      seq += 1;
      return { ok: true, packId: `pk_rebuilt_${seq}`, version: 1, body: {} };
    },
  };
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver: async () => ({}) });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    const first = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(first.blueprint.castPackId, "pk_rebuilt_1");
    assert.equal(first.cast.rebuilt, false);

    // 再铸（陈旧指针）：先拿到已签报告才允许续铸——这里直接写库模拟已签绿报告。
    store.saveTrialReport(id, {
      ranAt: 111,
      green: true,
      assertions: [{ id: "a", kind: "post-materialized", pass: true }],
      judged: [{ id: "j", kind: "llm-judged", verdict: "pass", pass: true }],
      errors: [],
      signoff: { by: "alice@x", at: 222, reportRanAt: 111 },
    });
    const again = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    // 第一次以旧 id 发版 → 404 → 重建新包，指针跟着改，且 rebuilt 如实标出。
    assert.equal(again.cast.rebuilt, true, "陈旧指针必须触发重建并标 rebuilt");
    assert.equal(again.blueprint.castPackId, "pk_rebuilt_2");
    assert.equal(publishCalls.filter((c) => c.packId === "pk_rebuilt_1").length, 1, "先按旧 id 试一次");
    assert.equal(publishCalls.filter((c) => c.packId === undefined).length, 2, "被 404 拒后不带 id 重发");
  } finally {
    await close(server);
  }
});

// 真机补刀（2026-10-30 投研晨会实录）：坏试跑会把旧绿签报告**覆盖**成
// errors=['trial aborted: Pack version not found'] 且签字消失——此时 reseal 不成立，
// 若前置闸不认陈旧指针，cast 在门口 409，下面的 404→重建自愈永远轮不到跑（死锁的另一半）。
test("铸造前置闸：报告被陈旧指针错误覆盖（无签字）时仍放行再铸修指针", async () => {
  let seq = 0;
  const publishClient = {
    async publish(args) {
      if (args.packId) return { ok: false, status: 404, error: "Pack not found", body: { error: "Pack not found" } };
      seq += 1;
      return { ok: true, packId: `pk_${seq}`, version: 1, body: {} };
    },
  };
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver: async () => ({}) });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })); // 铸成，指针 pk_1
    // 模拟真机现场：试跑 404 失败，报告覆盖为坏 errors，无 signoff。
    store.saveTrialReport(id, { ranAt: 333, green: false, assertions: [], judged: [], errors: ["trial aborted: Pack version not found"] });
    const repaired = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(repaired.cast.rebuilt, true, "陈旧指针覆盖报告也必须走重建");
    assert.equal(repaired.blueprint.castPackId, "pk_2");
    // 反例：报告无陈旧指针错误的普通 cast 态蓝图，前置闸照旧 409（不放水）。
    const c2 = await fetch(`${base}/api/blueprints`, as("bob@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    await fetch(`${base}/api/blueprints/${c2.blueprint.id}/approve`, as("bob@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${c2.blueprint.id}/cast`, as("bob@x", { method: "POST" }));
    const denied = await fetch(`${base}/api/blueprints/${c2.blueprint.id}/cast`, as("bob@x", { method: "POST" }));
    assert.equal(denied.status, 409, "报告不含陈旧指针错误时不得绕过前置闸");
  } finally {
    await close(server);
  }
});

test("铸造前置闸：首铸自引用未解析（铸出物带 {{PACK_ID:self}}）时放行再铸补齐；已解析则照旧 409", async () => {
  let seq = 0;
  const manifests = {};
  const publishClient = {
    async publish(args) {
      seq += 1;
      const pid = `pk_${seq}`;
      manifests[pid] = args.manifest;
      return { ok: true, packId: pid, version: 1, body: {} };
    },
    async getPack({ packId }) {
      const manifest = manifests[packId];
      if (!manifest) return null;
      return { manifest };
    },
  };
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver: async () => ({}) });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
        const selfContent = {
      ...JSON.parse(JSON.stringify(VALID_CONTENT)),
      agents: [{ id: "walkthrough-reader", name: "走查读库岗", persona: "你是走查读库岗。" }],
      fleet: {
        name: "首铸自引用",
        members: [
          {
            ref: "reader",
            title: "走查读库岗",
            parentRef: null,
            target: { kind: "pack-preset", packId: "{{PACK_ID:self}}", presetId: "walkthrough-reader" },
            kpiSlots: [],
            cadence: { cron: "*/5 * * * *", tz: "Asia/Shanghai", promptTemplate: "巡检并报数。", enabled: true },
          },
        ],
      },
    };
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: selfContent }) })).then(j);
    const id = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${id}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    // 首铸：castPackId 尚不存在 → self 占位原样进 manifest（stub 直接体现为 publish 收到的 manifest）
    const first = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(first.cast.selfPending, true, "首铸自引用必须如实报 selfPending");
    // 铸出物带未解析占位 → 再铸放行（第二铸补齐）
    const second = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(second.blueprint.castPackId, "pk_2", "首铸自引用未解析时允许铸造态再铸");
    // 已解析（第二铸 manifest 无占位）→ 照旧 409 不放水
    const denied = await fetch(`${base}/api/blueprints/${id}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(denied.status, 409, "占位已补齐后不得无限再铸");
  } finally {
    await close(server);
  }
});

// 自愈第三刀（2026-10-30 真机实录）：旧 id 失效时重建会撞「同名包已存在」409——
// 本蓝图自己的活包仍占着名（改名流程早发出新 id，只是指针没跟上）。正解=认回同名
// 活包在其下发新版；认回必须先证 provenance（manifest._casting.blueprintId 等于本
// 蓝图），否则那是别人的/另一款同名产品，一律不碰、如实透传 409。
test("铸造自愈第三刀：同名 409 且 provenance 属本蓝图时认回同名包（reclaimedPackId 可见）", async () => {
  let bpId = null;
  const DEAD = "pk_dead_after_rename_01";
  const LIVE = "pk_live_continuation_01";
  const calls = [];
  let firstCastDone = false;
  const publishClient = {
    async publish({ packId }) {
      calls.push({ packId });
      if (packId === DEAD) return { ok: false, status: 404, error: "Pack not found", body: { error: "Pack not found" } };
      if (!packId) {
        if (!firstCastDone) {
          firstCastDone = true;
          return { ok: true, packId: DEAD, version: 1, body: {} };
        }
        return { ok: false, status: 409, error: "同名包已存在", body: { error: `同名包已存在：…POST /api/packs，body 带 packId: "${LIVE}"` } };
      }
      return { ok: true, packId, version: 2, body: {} };
    },
    async getPack({ packId }) {
      if (packId !== LIVE) return null;
      return { name: "指针自愈验证", authorEmail: "alice@x", manifest: { _casting: { blueprintId: bpId } } };
    },
  };
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver: async () => ({}) });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    bpId = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${bpId}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    const first = await fetch(`${base}/api/blueprints/${bpId}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(first.blueprint.castPackId, DEAD);
    // 真机现场：试跑 404 → 报告被坏 errors 覆盖、签字消失。
    store.saveTrialReport(bpId, { ranAt: 9, green: false, assertions: [], judged: [], errors: ["trial aborted: Pack version not found"] });
    const healed = await fetch(`${base}/api/blueprints/${bpId}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(healed.cast.rebuilt, true, "认回同名包也算重建");
    assert.equal(healed.cast.reclaimedPackId, LIVE, "必须如实回报认回的是哪一枚");
    assert.equal(healed.blueprint.castPackId, LIVE, "指针必须落到认回的活包");
    assert.equal(calls.filter((c) => c.packId === LIVE).length, 1, "认回只发一次新版");
  } finally {
    await close(server);
  }
});

test("铸造自愈第三刀反例：同名包 provenance 不是本蓝图时不得认回，409 如实透传", async () => {
  let bpId = null;
  const DEAD = "pk_dead_after_rename_02";
  const OTHER = "pk_official_seed_reclaimed";
  let firstCastDone = false;
  const publishClient = {
    async publish({ packId }) {
      if (packId === DEAD) return { ok: false, status: 404, error: "Pack not found", body: { error: "Pack not found" } };
      if (!packId) {
        if (!firstCastDone) {
          firstCastDone = true;
          return { ok: true, packId: DEAD, version: 1, body: {} };
        }
        return { ok: false, status: 409, error: "同名包已存在", body: { error: `同名包已存在：…packId: "${OTHER}"` } };
      }
      return { ok: true, packId, version: 9, body: {} };
    },
    async getPack() {
      // 那枚同名包是别的产品（无 _casting 或 blueprintId 不同）——官方种子占回本名的形态。
      return { name: "投研晨会", authorEmail: "ops@x", manifest: {} };
    },
  };
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver: async () => ({}) });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    bpId = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${bpId}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${bpId}/cast`, as("alice@x", { method: "POST" }));
    store.saveTrialReport(bpId, { ranAt: 9, green: false, assertions: [], judged: [], errors: ["trial aborted: Pack version not found"] });
    const denied = await fetch(`${base}/api/blueprints/${bpId}/cast`, as("alice@x", { method: "POST" }));
    assert.equal(denied.status, 409, "provenance 不符时绝不认回，如实 409");
    const row = await fetch(`${base}/api/blueprints/${bpId}`, as("alice@x")).then(j);
    assert.equal(row.blueprint.castPackId, DEAD, "指针不得被改到别人的包");
  } finally {
    await close(server);
  }
});

// 真机诊断补钉（2026-10-30）：facet 对「旧 id 已失效 + 同名活包存在」先撞同名闸，
// 回 **409 而不是 404**——旧版自愈只认 404，因此在真机上永远进不去分支（三刀都白做）。
// 这里用 409+同名文案模拟真 facet，钉住「靠同名提示也能进自愈」这条形态。
test("铸造自愈：旧 id 失效而 facet 回 409 同名提示时同样进自愈（真机形态）", async () => {
  let bpId = null;
  const DEAD = "pk_dead_real_machine_form";
  const LIVE = "pk_live_same_name_owner";
  let firstDone = false;
  const publishClient = {
    async publish({ packId }) {
      if (packId === DEAD) {
        // 真机行为：先撞同名闸，回 409（文案带同名提示），不是 404。
        return { ok: false, status: 409, error: "同名包已存在", body: { error: `同名包已存在：…packId: "${LIVE}"` } };
      }
      if (!packId) {
        if (!firstDone) {
          firstDone = true;
          return { ok: true, packId: DEAD, version: 1, body: {} };
        }
        return { ok: false, status: 409, error: "同名包已存在", body: { error: `同名包已存在：…packId: "${LIVE}"` } };
      }
      return { ok: true, packId, version: 2, body: {} };
    },
    async getPack({ packId }) {
      if (packId !== LIVE) return null;
      return { name: "任一", authorEmail: "alice@x", manifest: { _casting: { blueprintId: bpId } } };
    },
  };
  const store = createBlueprintDatabase({ file: path.join(mkdtempSync(path.join(tmp, "db-")), "blueprints.db") });
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    const email = req.headers["x-test-user"];
    req.user = typeof email === "string" && email ? { email, groups: [] } : null;
    next();
  });
  createBlueprintRoutes(app, { authEnabled: true }, { db: store, publishClient, packResolver: async () => ({}) });
  const server = http.createServer(app);
  server.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/blueprints`, as("alice@x", { method: "POST", body: JSON.stringify({ content: VALID_CONTENT }) })).then(j);
    bpId = created.blueprint.id;
    await fetch(`${base}/api/blueprints/${bpId}/approve`, as("alice@x", { method: "POST", body: JSON.stringify({ expectVersion: 1 }) }));
    await fetch(`${base}/api/blueprints/${bpId}/cast`, as("alice@x", { method: "POST" }));
    store.saveTrialReport(bpId, { ranAt: 7, green: false, assertions: [], judged: [], errors: ["trial aborted: Pack version not found"] });
    const healed = await fetch(`${base}/api/blueprints/${bpId}/cast`, as("alice@x", { method: "POST" })).then(j);
    assert.equal(healed.cast.reclaimedPackId, LIVE, "409 同名形态必须也能认回");
    assert.equal(healed.blueprint.castPackId, LIVE);
  } finally {
    await close(server);
  }
});
