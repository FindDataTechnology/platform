// facet MCP Registry 投影（add-marketplace-projection-fanout）
// 公开面形状：server.json schema 2025-12-11 必填字段、单一可见性规则复用、
// 坏条目不毒化整批、凭据门拒绝而非清洗、免键（零 headers）。
// 运行：node --test scripts/test-facet-mcp-registry-json.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const load = (rel) => import(pathToFileURL(path.join(here, "..", rel)).href);

const mod = await load("facet/mcp-registry-json.js");
const catalogMod = await load("facet/mcp-catalog.js");
const {
  projectServerJson,
  projectAllServers,
  registerMcpRegistryJson,
  McpRegistryError,
  SERVER_JSON_SCHEMA,
  NAMESPACE,
  PLACEHOLDER_VERSION,
  FUNNEL_COPY,
} = mod;
const { visibleTo } = catalogMod;

// 条目形状实测自 registry-bridge.js mapServer：没有 version 字段；
// configTemplate.headers 里是字面量占位符 `Bearer <your_token>`。
const server = (name, extra = {}) => ({
  name,
  displayName: `${name} 显示名`,
  description: `${name} 描述`,
  category: "Registry",
  configTemplate: { url: `https://mcp.finddatatech.cloud/${name}/mcp`, headers: { Authorization: "Bearer <your_token>" } },
  groups: [],
  ...extra,
});

async function boot(entries) {
  const app = express();
  registerMcpRegistryJson(app, { entriesFn: () => entries });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => srv.close() };
}

// 2025-12-11 形状的结构校验（官方 schema 必填项 + 反向 DNS pattern）。
// 与官方文档逐条对齐；schema 仍在冻结期，官方正文一变这里跟着改（design Risks）。
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
function assertRegistryShape(doc) {
  assert.equal(doc.$schema, SERVER_JSON_SCHEMA);
  assert.equal(typeof doc.name, "string");
  assert.equal(doc.name.split("/").length, 2, `name 必须恰好一个斜杠：${doc.name}`);
  assert.match(doc.name, NAME_RE);
  assert.equal(typeof doc.description, "string");
  assert.ok(doc.description.length > 0, "description 必填且非空");
  assert.equal(typeof doc.version, "string");
  assert.ok(Array.isArray(doc.remotes) && doc.remotes.length >= 1, "至少一条 remotes");
  for (const r of doc.remotes) {
    assert.ok(["streamable-http", "sse"].includes(r.type), `未知 remote type：${r.type}`);
    assert.equal(typeof r.url, "string");
    assert.ok(r.url.startsWith("http"), "remote url 必须是绝对 URL");
  }
  assert.ok(!("repository" in doc) || typeof doc.repository === "string");
}

test("公开 server 产出合法 server.json（且过形状校验）", async () => {
  const { base, close } = await boot([server("law-bench")]);
  try {
    const r = await fetch(`${base}/api/mcp-registry.json`);
    assert.equal(r.status, 200);
    const cache = r.headers.get("cache-control") || "";
    assert.match(cache, /max-age=(\d+)/);
    assert.ok(Number(cache.match(/max-age=(\d+)/)[1]) <= 3600, "缓存 ≤ 1h");

    const { servers } = await r.json();
    assert.equal(servers.length, 1);
    const doc = servers[0];
    assertRegistryShape(doc);
    assert.equal(doc.name, `${NAMESPACE}/law-bench`);
    // 漏斗钩子（design D6）只加在 description 尾部，不改结构字段。
    assert.equal(doc.description, `law-bench 描述 — ${FUNNEL_COPY}`);
    assert.ok(!JSON.stringify(doc).includes("萬星") === false, "尾部引导文案在册");
    assert.equal(doc.version, PLACEHOLDER_VERSION, "server 无版本语义 → 固定占位");
    assert.equal(doc.title, "law-bench 显示名", "displayName 与 name 不同时带 title");
    assert.deepEqual(doc.remotes, [
      { type: "streamable-http", url: "https://mcp.finddatatech.cloud/law-bench/mcp" },
    ]);

    // 单条路由同形；缓存头一致。
    const one = await fetch(`${base}/api/mcp-registry/law-bench.json`);
    assert.equal(one.status, 200);
    assert.match(one.headers.get("cache-control") || "", /max-age=\d+/);
    assert.deepEqual(await one.json(), doc);
  } finally { close(); }
});

test("group-gated server 恒缺席（与 mcp-catalog 同一规则）", async () => {
  const publicEntry = server("open-server");
  const gated = server("legal-server", { groups: ["legal"] });
  const { base, close } = await boot([publicEntry, gated]);
  try {
    const { servers } = await (await fetch(`${base}/api/mcp-registry.json`)).json();
    assert.deepEqual(servers.map((s) => s.name), [`${NAMESPACE}/open-server`]);
    // 单条路由不给信息（404 姿态，与 /api/mcp-catalog/:name 一致）
    const gatedOne = await fetch(`${base}/api/mcp-registry/legal-server.json`);
    assert.equal(gatedOne.status, 404);
    // 规则本身确实来自 catalog 的导出函数，不是本模块重写。
    assert.equal(visibleTo(gated, null), false);
    assert.equal(visibleTo(publicEntry, null), true);
  } finally { close(); }
});

test("坏条目跳过其余照出（缺 description / 缺 url / 空名）", async () => {
  const good = server("good-one");
  const noDesc = server("no-desc", { description: "" });
  const noUrl = server("no-url", { configTemplate: { url: "" } });
  const noName = server("", {});
  const { base, close } = await boot([good, noDesc, noUrl, noName]);
  try {
    const { servers } = await (await fetch(`${base}/api/mcp-registry.json`)).json();
    assert.deepEqual(servers.map((s) => s.name), [`${NAMESPACE}/good-one`]);

    // 跳过原因可报告（dry-run 报告用）
    const result = projectAllServers({ entriesFn: () => [good, noDesc, noUrl, noName] });
    assert.equal(result.servers.length, 1);
    assert.deepEqual(result.skipped.map((s) => s.reason), [
      "missing description",
      "missing configTemplate.url",
      "missing name",
    ]);
  } finally { close(); }
});

test("把条目塞进骨架后：单条不可投影返回 null，批次仍只含其余", () => {
  assert.equal(projectServerJson({ name: "x", description: "", configTemplate: { url: "https://a/b" } }), null);
  assert.equal(projectServerJson({ name: "x", description: "d", configTemplate: {} }), null);
  assert.equal(projectServerJson(null), null);
});

test("凭据门：命中 sk- 形状串 → PROJECT_REJECTED 且不写（整批拒绝）", async () => {
  const leaky = server("leaky", { description: "带 sk-abcdefghijklmnopqrstuvwxyz 的脏描述" });
  assert.throws(() => projectAllServers({ entriesFn: () => [server("clean"), leaky] }), (err) => {
    assert.ok(err instanceof McpRegistryError);
    assert.equal(err.code, "PROJECT_REJECTED");
    return true;
  });

  const { base, close } = await boot([leaky]);
  try {
    const r = await fetch(`${base}/api/mcp-registry.json`);
    assert.equal(r.status, 503, "拒绝是响亮的 503，不是静默部分产出");
    assert.equal((await r.json()).code, "PROJECT_REJECTED");
    const one = await fetch(`${base}/api/mcp-registry/leaky.json`);
    assert.equal(one.status, 503);
  } finally { close(); }
});

test("免键：remotes 一律没有 headers 块（占位符也不写）", async () => {
  const { servers } = projectAllServers({ entriesFn: () => [server("keyless")] });
  const doc = servers[0];
  for (const r of doc.remotes) {
    assert.ok(!("headers" in r), "remotes[].headers 必须整块省略");
  }
  assert.doesNotMatch(JSON.stringify(doc), /Bearer|your_token|Authorization/i);
});

test("单条路由：未知名字 404、同名带命名空间也命中", async () => {
  const { base, close } = await boot([server("known")]);
  try {
    assert.equal((await fetch(`${base}/api/mcp-registry/nope.json`)).status, 404);
    const full = await fetch(`${base}/api/mcp-registry/${encodeURIComponent(`${NAMESPACE}/known`)}.json`);
    assert.equal(full.status, 200);
  } finally { close(); }
});

// The registry enforces `description` <= 100 characters. Found the hard way on
// the first real publish: 8 of 14 servers were refused with
// `{"errors":[{"message":"expected length <= 100","location":"body.description"}]}`
// while the 6 short ones went through. The budget is shared with the funnel
// tail, so long descriptions must be truncated — on code-point boundaries, with
// an ellipsis, and the result must still fit.
test("描述超长按码点截断，整条仍在 registry 的 100 字符上限内", () => {
  const { MAX_DESCRIPTION, composeDescription, projectAllServers } = mod;
  assert.equal(MAX_DESCRIPTION, 100);

  const long = "识律线操作 MCP（C4）：线全景导览（self-describing）+账户视图（me/usage/billing/quota）+检索凭据生命周期（list/mint/revoke，owner-only 上游判定）；Logto ID token 原样转发";
  const doc = projectAllServers({ entriesFn: () => [server("long-desc", { description: long })] }).servers[0];
  assert.ok(Array.from(doc.description).length <= 100, `描述超限：${Array.from(doc.description).length}`);
  assert.ok(doc.description.includes(FUNNEL_COPY), "漏斗文案仍应在尾部");
  assert.ok(doc.description.includes("…"), "截断处应有省略号标记");

  // 短描述一字不改，只加尾缀。
  assert.equal(composeDescription("简短描述"), `简短描述 — ${FUNNEL_COPY}`);

  // 恰好边界：不截断。
  const tail = ` — ${FUNNEL_COPY}`;
  const exact = "a".repeat(100 - Array.from(tail).length);
  assert.equal(composeDescription(exact), `${exact}${tail}`);

  // 任意长度都不越界（含 emoji 这类代理对字符，不能截半个）。
  for (const n of [0, 1, 50, 81, 82, 83, 99, 200]) {
    const s = composeDescription("字".repeat(n));
    assert.ok(Array.from(s).length <= 100, `n=${n} 超限`);
    assert.ok(!s.includes("\uFFFD"), `n=${n} 出现截断坏字符`);
  }
});

test("内网/非 https 端点不投影（public listing 不得泄漏集群地址）", async () => {
  const internal = [
    server("mesh-one", { configTemplate: { url: "http://cheap6.mesh.finddata.cn:31893/mcp" } }),
    server("loopback", { configTemplate: { url: "http://127.0.0.1:3000/mcp" } }),
    server("rfc1918", { configTemplate: { url: "http://10.0.3.7:8080/mcp" } }),
    server("plain-http", { configTemplate: { url: "http://mcp.finddatatech.cloud/x/mcp" } }),
  ];
  const good = server("public-one");
  const { servers, skipped } = projectAllServers({ entriesFn: () => [...internal, good] });

  assert.deepEqual(servers.map((s) => s.name), [`${NAMESPACE}/public-one`], "只留公网可达的那条");
  assert.equal(skipped.length, internal.length);
  for (const s of skipped) {
    assert.equal(s.reason, "endpoint not publicly reachable (internal host or non-https)");
  }
  // 单条也拒绝，且不留信息。
  assert.equal(projectServerJson(internal[0]), null);

  // 判据本身可独立调用（发布脚本与单测共用同一函数，不是各写一份）。
  const { isPubliclyReachable } = await load("facet/mcp-registry-json.js");
  for (const u of [
    "http://cheap6.mesh.finddata.cn:31893/mcp",
    "https://cheap5.finddata.cn/mcp",
    "https://localhost/mcp",
    "https://10.0.0.1/mcp",
    "https://192.168.1.5/mcp",
    "https://172.20.0.9/mcp",
    "http://mcp.finddatatech.cloud/x/mcp",
  ]) {
    assert.equal(isPubliclyReachable(u), false, `应判不可达：${u}`);
  }
  assert.equal(isPubliclyReachable("https://mcp.finddatatech.cloud/fd-info/mcp"), true);
});
