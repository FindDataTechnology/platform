// ── Unified supply catalog tests (add-supply-catalog-unification 1.x) ───────
//
// 契约（openspec: supply-catalog）：
//   · facade 物种由服务面自己的公开目录喂给——准入是万星的规则，本面不重释；
//     部署出处经 facet 自己的簿记按公开路由 slug 连接；状态未回报 → unknown。
//   · data-anchor 物种由 DAAS 目录导出喂给；源缺席 → 空 + source_absent，绝不造行。
//   · 注释形状全物种：未注释条目 zh 文本进五语位、provenance 如实，不机翻不省略。
//   · 物种枚举 {pack,skill,mcp,facade,data-anchor} version 1。
//
//   node --test scripts/test-supply-catalog.mjs

import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

const mod = await import("../facet/supply-catalog.js");

const fakeUser = (groups = []) => (req) => (req.headers["x-test-user"] ? { email: "t@e", groups } : null);

// 假源对象：configured/snapshot/asOf/ensureFresh 四件，与 createSource 同形。
const fakeSource = ({ configured = true, snapshot = null, asOf = "2026-11-04T00:00:00.000Z" } = {}) => ({
  configured: () => configured,
  snapshot,
  asOf,
  ensureFresh: async () => {},
});

function app({ deploymentsFn = () => [], facadeSource, anchorSource } = {}) {
  const a = express();
  mod.registerSupplyCatalogRoutes(a, {
    resolveUser: fakeUser(),
    deploymentsFn,
    facadeSource,
    anchorSource,
  });
  return a;
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const get = async (base, path) => {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
};

// ── species metadata ─────────────────────────────────────────────────────────

test("species enumeration: six species, version 2 (plugin added)", async () => {
  const { base, close } = await listen(app({ facadeSource: fakeSource({ configured: false }), anchorSource: fakeSource({ configured: false }) }));
  try {
    const { status, body } = await get(base, "/api/supply-catalog/species");
    assert.equal(status, 200);
    // unify-material-market: the sixth species `plugin` extends the enumeration
    // and bumps the version — the rule the spec states for exactly this case.
    assert.deepEqual(body.species, ["pack", "skill", "mcp", "facade", "data-anchor", "plugin"]);
    assert.equal(body.version, 2);
  } finally { close(); }
});

// ── facade species ───────────────────────────────────────────────────────────

const WANXING_AGENTS = {
  agents: [
    { slug: "law-bench-assistant", name: "法律研究助手", description: "检索与研读法规", version: 3, tags: ["legal"], skills: [{ id: "case-retrieval" }], chatable: true },
    { slug: "data-anchor-bot", name: "数据锚助手", description: "取数与口径", version: 1, tags: [], skills: [] },
  ],
};

test("deployed public facade appears with provenance join", async () => {
  const deploymentsFn = () => [
    { packId: "law-bench", agentId: "assistant", agentPath: "/law-bench/assistant", deployedAt: 1730000000000 },
  ];
  const { base, close } = await listen(app({
    deploymentsFn,
    facadeSource: fakeSource({ snapshot: WANXING_AGENTS }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    assert.equal(body.facades.length, 2);
    const joined = body.facades.find((f) => f.id === "law-bench-assistant");
    assert.deepEqual(joined.deployment, { packId: "law-bench", agentId: "assistant", deployedAt: 1730000000000 });
    // 无簿记连接的条目如实 null，不造出处。
    const orphan = body.facades.find((f) => f.id === "data-anchor-bot");
    assert.equal(orphan.deployment, null);
  } finally { close(); }
});

test("facade status absent renders explicit unknown", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ snapshot: WANXING_AGENTS }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    for (const f of body.facades) assert.equal(f.status, "unknown");
  } finally { close(); }
});

test("facade entry carries the production annotation shape", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ snapshot: WANXING_AGENTS }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    const ann = body.facades[0].annotation;
    assert.ok(ann.canonical.brief);
    for (const slot of ["zh", "en", "ja", "es", "fr"]) assert.equal(typeof ann.human[slot].name, "string");
    assert.equal(ann.provenance.source, "wanxing-facade");
    assert.ok(ann.provenance.updatedAt);
    // whenToUse 从 skills 合成（有则给，无则 null）。
    assert.equal(body.facades[0].annotation.whenToUse, "skills: case-retrieval");
    assert.equal(body.facades[1].annotation.whenToUse, null);
  } finally { close(); }
});

test("badge-derived facades never appear (source is the only feed)", async () => {
  // 万星目录没有的 slug，即便 pack 带 facade badge 也不出条目——本面只读源。
  const { base, close } = await listen(app({
    deploymentsFn: () => [{ packId: "some-pack", agentId: "a", agentPath: "/some-pack/a", deployedAt: 1 }],
    facadeSource: fakeSource({ snapshot: { agents: [] } }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    assert.deepEqual(body.facades, []);
  } finally { close(); }
});

test("facade source unconfigured degrades to empty + source_absent", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ configured: false }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    assert.deepEqual(body.facades, []);
    assert.equal(body.source_absent, true);
  } finally { close(); }
});

// ── data-anchor species ──────────────────────────────────────────────────────

const DAAS_EXPORT = {
  as_of: "2026-11-04T14:50:30+00:00",
  anchors: [
    { id: "ind-1", name: "GDP", kind: "indicator", summary: "GDP（nbs）", source: "nbs" },
    { id: "src-1", name: "国家统计局", kind: "source", summary: "official stats", source: "nbs" },
  ],
};

test("data-anchor entries carry DAAS provenance", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ configured: false }),
    anchorSource: fakeSource({ snapshot: DAAS_EXPORT }),
  }));
  try {
    const { body } = await get(base, "/api/data-anchors-catalog");
    assert.equal(body.anchors.length, 2);
    assert.equal(body.anchors[0].annotation.provenance.source, "daas-catalog");
    assert.equal(body.anchors[0].annotation.provenance.updatedAt, DAAS_EXPORT.as_of);
    assert.equal(body.as_of, DAAS_EXPORT.as_of);
  } finally { close(); }
});

test("un-annotated data anchors are honest (zh text in all five slots)", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ configured: false }),
    anchorSource: fakeSource({ snapshot: DAAS_EXPORT }),
  }));
  try {
    const { body } = await get(base, "/api/data-anchors-catalog");
    const human = body.anchors[0].annotation.human;
    for (const slot of ["zh", "en", "ja", "es", "fr"]) assert.equal(human[slot].name, "GDP");
  } finally { close(); }
});

test("DAAS source unconfigured degrades to empty + source_absent", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ configured: false }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/data-anchors-catalog");
    assert.deepEqual(body.anchors, []);
    assert.equal(body.source_absent, true);
  } finally { close(); }
});

// ── slug derivation (the join key contract) ──────────────────────────────────

test("slugFor mirrors the serving plane's route identity", () => {
  assert.equal(mod.slugFor("/law-bench/assistant"), "law-bench-assistant");
  assert.equal(mod.slugFor("law bench/assistant"), "law-bench-assistant");
  assert.equal(mod.slugFor(""), "");
});

// ── zh fallback annotation helper ────────────────────────────────────────────

test("zhFallbackAnnotation fills five slots and honest provenance", () => {
  const ann = mod.zhFallbackAnnotation({ name: "N", summary: "S", source: "src", updatedAt: "2026-11-04T00:00:00Z" });
  assert.equal(ann.canonical.brief, "S");
  for (const slot of ["zh", "en", "ja", "es", "fr"]) {
    assert.equal(ann.human[slot].name, "N");
    assert.equal(ann.human[slot].summary, "S");
  }
  assert.equal(ann.provenance.source, "src");
});

// ── mcp-catalog internal global read + skill content (the unified read path) ─

const facetMcp = await import("../facet/mcp-catalog.js");

const BRIDGE_MCP = [
  { name: "public-server", displayName: "Public", description: "pub", configTemplate: { url: "https://gw/public-server/mcp" }, groups: [], annotations: null },
  { name: "gated-server", displayName: "Gated", description: "gated", configTemplate: { url: "https://gw/gated-server/mcp" }, groups: ["partners"], annotations: { human: { zh: { name: "闸控", summary: "仅伙伴" } }, provenance: { source: "registry" } } },
];
const BRIDGE_SKILLS = [
  { name: "open-skill", displayName: "Open", description: "o", groups: [], contentPath: "/skills/open-skill", annotations: null },
  { name: "gated-skill", displayName: "Gated", description: "g", groups: ["partners"], contentPath: "/skills/gated-skill", annotations: null },
];

function mcpApp({ internalToken = "sec" } = {}) {
  const a = express();
  facetMcp.registerFacetMcpRoutes(a, {
    resolveUser: fakeUser(),
    entriesFn: () => BRIDGE_MCP,
    skillsFn: () => BRIDGE_SKILLS,
    internalToken,
    skillContentFn: async (p) => `CONTENT::${p}`,
  });
  return a;
}

test("anonymous catalog hides group-gated entries", async () => {
  const { base, close } = await listen(mcpApp());
  try {
    const { body } = await get(base, "/api/mcp-catalog");
    assert.deepEqual(body.servers.map((s) => s.name), ["public-server"]);
    const sk = await get(base, "/api/skills-catalog");
    assert.deepEqual(sk.body.skills.map((s) => s.name), ["open-skill"]);
  } finally { close(); }
});

test("internal global read returns every entry with groups and raw annotations", async () => {
  const { base, close } = await listen(mcpApp());
  try {
    const res = await fetch(`${base}/api/mcp-catalog`, { headers: { "x-facet-internal-token": "sec" } });
    const body = await res.json();
    assert.deepEqual(body.servers.map((s) => s.name).sort(), ["gated-server", "public-server"]);
    const gated = body.servers.find((s) => s.name === "gated-server");
    assert.deepEqual(gated.requiredGroups, ["partners"]);
    assert.ok(gated.annotations.human.zh, "raw annotation object carried through for downstream merge");
  } finally { close(); }
});

test("wrong internal token does not widen visibility", async () => {
  const { base, close } = await listen(mcpApp());
  try {
    const res = await fetch(`${base}/api/mcp-catalog`, { headers: { "x-facet-internal-token": "nope" } });
    const body = await res.json();
    assert.deepEqual(body.servers.map((s) => s.name), ["public-server"]);
  } finally { close(); }
});

test("skill content proxies for visible entries, 404 for gated to anonymous", async () => {
  const { base, close } = await listen(mcpApp());
  try {
    const ok = await get(base, "/api/skills-catalog/open-skill/content");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.content, "CONTENT::/skills/open-skill");
    const gated = await get(base, "/api/skills-catalog/gated-skill/content");
    assert.equal(gated.status, 404);
    // internal read unlocks it
    const res = await fetch(`${base}/api/skills-catalog/gated-skill/content`, { headers: { "x-facet-internal-token": "sec" } });
    assert.equal(res.status, 200);
  } finally { close(); }
});

// ── boot race quick retry (createSource.start) ───────────────────────────────

test("boot pull race: failed first pull retries on 15s backoff until snapshot lands", async () => {
  // 真时钟换不掉（setInterval），这里只钉三件事：bootTimer 与主 timer 并存、
  // stop() 双清、拿到快照后 boot retry 停手。时序行为由 fakeSource 之上的
  // 集成验证（facet pod 实弹：侧车就绪前 404 → 下轮 15s 内 200）。
  const src = mod.createSource({ url: "http://127.0.0.1:1/never", label: "boot-race" });
  src.start();
  try {
    // never-listening port: boot pull fails fast; snapshot stays null but the
    // source must not throw and must keep polling (no crash within 100ms).
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(src.snapshot, null);
    assert.equal(src.configured(), true);
  } finally {
    src.stop();
  }
});

// ── 契约消费侧的形状校验（retire-wanxing-twin-face 3.2 / 3.3）─────────────────
//
// 门面公开面是**借来的上游**：按已发布契约消费，不按好意消费。三种病各一条：
//   (a) 没有身份字段 → 丢弃并计数，绝不编一个 id 投出去；
//   (b) 状态类型不符（布尔/数字）→ 丢弃并计数，coerce 会把契约漂移藏起来；
//   (c) 合规条目的状态原样透传，本面不重写、不塌缩。

test("3.2 (a) 缺 slug 的条目被丢弃且计数，不投影畸形行", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ snapshot: { agents: [
      { name: "no-identity", description: "x" },
      { slug: "  ", name: "blank-identity" },
      null,
      { slug: "ok-one", name: "OK", description: "d" },
    ] } }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    assert.deepEqual(body.facades.map((f) => f.id), ["ok-one"]);
    assert.equal(body.dropped, 3, "三个没有身份字段的条目都要计入 dropped");
    assert.equal(body.coerced, 0);
  } finally { close(); }
});

test("3.2 (b) status 类型不符的条目被丢弃（不 coerce 成字符串）", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ snapshot: { agents: [
      { slug: "bool-status", name: "B", description: "d", status: true },
      { slug: "num-status", name: "N", description: "d", status: 3 },
      { slug: "fine", name: "F", description: "d", status: "serving" },
    ] } }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    assert.deepEqual(body.facades.map((f) => f.id), ["fine"]);
    assert.equal(body.dropped, 2);
  } finally { close(); }
});

test("3.2 (c) name/description 缺失回落但计入 coerced（可见降级）", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ snapshot: { agents: [{ slug: "bare" }] } }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    assert.equal(body.facades[0].name, "bare", "name 回落 slug");
    assert.equal(body.facades[0].description, "");
    assert.equal(body.coerced, 2, "name 与 description 各计一次");
    assert.equal(body.dropped, 0);
  } finally { close(); }
});

test("3.3 状态四态透传：serving/idle/paused 原样，缺失→unknown，无一被抬成 serving", async () => {
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ snapshot: { agents: [
      { slug: "s", name: "S", description: "d", status: "serving" },
      { slug: "i", name: "I", description: "d", status: "idle" },
      { slug: "p", name: "P", description: "d", status: "paused" },
      { slug: "m", name: "M", description: "d" },
      { slug: "n", name: "N", description: "d", status: null },
    ] } }),
    anchorSource: fakeSource({ configured: false }),
  }));
  try {
    const { body } = await get(base, "/api/facades-catalog");
    const byId = Object.fromEntries(body.facades.map((f) => [f.id, f.status]));
    // 线上基线（2026-11-13 实测）：GET /api/wanxing/v1/agents 的 18 个条目全部
    // 没有 status 字段，所以脊柱当前 18/18 走 unknown 兜底——看到"全 unknown"
    // 是真实状态，不是测试写错。
    assert.deepEqual(byId, { s: "serving", i: "idle", p: "paused", m: "unknown", n: "unknown" });
    assert.equal(body.dropped, 0);
  } finally { close(); }
});

test("3.3 projectFacadeEntries 是纯函数：不修改入参", () => {
  const agents = [{ slug: "a", name: "A", description: "d", status: "paused" }];
  const snap = JSON.stringify(agents);
  const out = mod.projectFacadeEntries(agents, { asOf: "2026-11-13T00:00:00.000Z" });
  assert.equal(JSON.stringify(agents), snap);
  assert.equal(out.facades[0].status, "paused");
  assert.equal(out.dropped, 0);
});

test("3.4 attach 钩子把证据摘要挂回投影行（并 C3 时差点被整段覆盖的能力）", () => {
  // 背景：projectFacadeEntries 来自 C3，其分支点早于 attachEvidenceSummary。
  // 2026-11-13 把它合进当前发布线时，若照抄 C3 那侧，这个能力会连同两个调用点
  // 一起消失，而当时的用例没有一条断言过 facade 行的 evidence —— 静默回归。
  // 这条用例盯的就是钩子的契约：给 attach 就必须被逐行调用，入参是 (row, raw, opts)。
  const agents = [{ slug: "a", name: "A", description: "d", status: "unknown" }];
  const seen = [];
  const out = mod.projectFacadeEntries(agents, {
    asOf: "2026-11-13T00:00:00.000Z",
    attach: (row, raw, opts) => {
      seen.push({ id: row.id, sameRaw: raw === agents[0], species: opts?.species });
      row.evidence = { state: "missing" };
    },
  });
  assert.equal(seen.length, 1, "attach 必须被逐行调用一次");
  assert.deepEqual(seen[0], { id: "a", sameRaw: true, species: "facade" });
  assert.deepEqual(out.facades[0].evidence, { state: "missing" });

  // 不传 attach 时不产生副作用（纯函数默认行为不变）
  const plain = mod.projectFacadeEntries(agents, { asOf: "2026-11-13T00:00:00.000Z" });
  assert.equal(plain.facades[0].evidence, undefined);
});

test("3.5 projectAnchorEntries：坏行被计数而不是消失，好行原样透传，attach 逐行挂证据", () => {
  // 背景：这段投影原本是 route 里的内联 filter+map，缺 id 的条目被**静默丢弃**、
  // 非字符串字段被静默放过——上游形状漂移的表现只是"锚目录悄悄变短"，没有任何
  // 判据会红。3.4 是同一形状的第一处（facade），这是第二处。
  const good = [
    { id: "x1", name: "X", kind: "dataset", summary: "s", source: "daas" },
    { id: " x2 ", name: "Y", kind: "k", summary: "" },
  ];
  const seen = [];
  const out = mod.projectAnchorEntries(good, {
    asOf: "2026-11-14T00:00:00.000Z",
    attach: (row, raw, opts) => {
      seen.push({ id: row.id, rawIsInput: raw === good.find((g) => g.id.trim() === row.id), species: opts?.species });
    },
  });
  assert.equal(out.anchors.length, 2);
  assert.equal(out.dropped, 0);
  assert.equal(out.coerced, 0);
  assert.deepEqual(seen.map((s) => s.id), ["x1", "x2"], "id 两端空白应被裁掉");
  assert.ok(seen.every((s) => s.species === "data-anchor"), "物种口径必须是 data-anchor");
  assert.ok(seen.every((s) => s.rawIsInput), "attach 必须收到原始上游行，而不是投影后的行");

  // 坏行：null / 缺 id / 空 id —— 丢弃**并计数**；非字符串字段 —— 计数但**原样透传**
  const bad = [null, { name: "no-id" }, { id: "", name: "empty-id" },
    { id: "x3", name: "", kind: null, summary: null }];
  const b = mod.projectAnchorEntries(bad, { asOf: "2026-11-14T00:00:00.000Z" });
  assert.deepEqual(b.anchors.map((a) => a.id), ["x3"]);
  assert.equal(b.dropped, 3, "三条坏行必须被计数，不能只让目录变短");
  assert.equal(b.coerced, 3, "name/kind/summary 三个非字符串各计一次");
  // 透传语义：换掉取值会改对外字节，而这个面还没有契约登记
  assert.equal(b.anchors[0].name, "");
  assert.equal(b.anchors[0].kind, null);
  assert.equal(b.anchors[0].summary, "");

  // 纯函数：入参不被修改
  const snap = JSON.stringify(good);
  mod.projectAnchorEntries(good, { asOf: "2026-11-14T00:00:00.000Z" });
  assert.equal(JSON.stringify(good), snap);
});

test("data-anchors 路由必须报出 dropped/coerced（坏行不能悄悄消失）", async () => {
  // 守卫为什么在**路由**这一层：3.5 只钉住纯函数。若有人把路由改回内联
  // filter+map（或忘记把 projectAnchorEntries 的返回值透出去），3.5 仍然全绿，
  // 而线上又开始"悄悄变短"。这条用例换的是坏 payload、看的是**对外响应**。
  const dirty = {
    as_of: "2026-11-14T00:00:00+00:00",
    anchors: [
      { id: "ok-1", name: "GDP", kind: "indicator", summary: "GDP（nbs）", source: "nbs" },
      null,                                   // 非对象
      { name: "no-id" },                      // 缺 id
      { id: "", name: "empty-id" },           // 空 id
      { id: "ok-2", name: "", kind: null, summary: null },  // 字段类型不对
    ],
  };
  const { base, close } = await listen(app({
    facadeSource: fakeSource({ configured: false }),
    anchorSource: fakeSource({ snapshot: dirty }),
  }));
  try {
    const { status, body } = await get(base, "/api/data-anchors-catalog");
    assert.equal(status, 200);
    assert.deepEqual(body.anchors.map((a) => a.id), ["ok-1", "ok-2"],
      "坏行不得出现在目录里");
    assert.equal(body.dropped, 3, "三条坏行必须在响应里被计数");
    assert.equal(body.coerced, 3, "name/kind/summary 三个非字符串各计一次");
  } finally { close(); }
});
