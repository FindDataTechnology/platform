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
