#!/usr/bin/env node
// ── Vendor supply-open tests (add-vendor-supply-open) ────────────────────────
//
// Mounts the REAL facets: vendor identity routes + onboarding routes + the
// pack publish path — exactly as facet/index.js/gateway/index.js assemble
// them — with two seams faked: the Logto session (x-test-session) and the
// registry write lane (defaultWriter replaced by an in-memory one, plus fake
// MCP probe). Everything else is production code: the review pipeline, the
// publish admission triple-lane, the attribution stamp and projection.
//
//   node --test scripts/test-vendor-supply-open.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import express from "express";
import { test, after } from "node:test";

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";
import { registerVendorRoutes } from "../gateway/vendors.js";
import { registerOnboardingRoutes } from "../gateway/vendor-onboarding.js";

const tmp = mkdtempSync(path.join(tmpdir(), "vendor-supply-open-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const registry = createPackRegistry({ file: path.join(tmp, "packs.db") });

// ── Tunable fake lanes (mutate per-test, production code reads them fresh) ───
const fake = {
  probeAnswer: null, // null = unreachable; string[] = tools/list
  writerCalls: [],
  writerError: null,
  tiers: { free: { servers: 99, publishesPerHour: 10 }, tiny: { servers: 1, publishesPerHour: 10 } },
};
const sessionFor = (email, groups = []) => JSON.stringify({ email, groups });
const resolveUser = (req) => {
  const raw = req.headers["x-test-session"];
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    return typeof doc?.email === "string" ? { email: doc.email, groups: doc.groups ?? [] } : null;
  } catch {
    return null;
  }
};
const rejectUnauthenticated = (_req, res) => res.status(401).json({ error: "Authentication required" });

const writer = {
  configured: true,
  async write(args) {
    if (fake.writerError) throw new Error(fake.writerError);
    fake.writerCalls.push(args);
    return { path: `/${args.serverName}/` };
  },
};
const probe = async () => fake.probeAnswer;

const app = express();
app.use(express.json({ limit: "1mb" }));
const ADMIN = ["admins"];
registerVendorRoutes(app, { vendors: registry.vendors, resolveUser, rejectUnauthenticated, adminGroups: ADMIN });
registerOnboardingRoutes(app, {
  vendors: registry.vendors,
  onboarding: registry.onboarding,
  resolveUser,
  rejectUnauthenticated,
  adminGroups: ADMIN,
  deps: { writer, probe, tiers: fake.tiers, log: { warn() {} } },
});
registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups: ["creators"],
  adminGroups: ADMIN,
  anonymousRead: true,
  vendors: registry.vendors,
});
const server = http.createServer(app);
const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
after(() => {
  server.closeAllConnections?.();
  server.close();
  registry.close();
});

const H = (email, groups = []) => ({ "x-test-session": sessionFor(email, groups), "Content-Type": "application/json" });
const post = (p, email, body, groups = []) => fetch(`${base}${p}`, { method: "POST", headers: H(email, groups), body: JSON.stringify(body) });
const get = (p, email, groups = []) => fetch(`${base}${p}`, { headers: H(email, groups) });
const patch = (p, email, body, groups = []) => fetch(`${base}${p}`, { method: "PATCH", headers: H(email, groups), body: JSON.stringify(body) });
const del = (p, email, groups = []) => fetch(`${base}${p}`, { method: "DELETE", headers: H(email, groups) });

const vendorUser = "owner@acme.test";
const member = "member@acme.test";
const outsider = "nobody@else.test";
const manifest = (name, extra = {}) => ({
  name,
  description: "vendor supply-open test",
  skills: [{ name: "s", description: "d", content: "# s\nbody" }],
  ...extra,
});
const goodMaterial = (endpoint = "https://mcp.acme.test/mcp") => ({
  serverEndpoint: endpoint,
  license: "MIT",
  domain: { name: "acme-supply" },
  surface: { tools: [{ name: "t1" }, { name: "t2" }], commercialTools: ["t1", "t2"], description: "demo" },
});

// ── 1.x vendor identity ─────────────────────────────────────────────────────
test("注册即得: 普通用户登记 vendor（无预审），201 + owner 绑定", async () => {
  const r = await post("/api/vendors", vendorUser, { slug: "acme", displayName: "Acme 供应", contact: "ops@acme.test" });
  assert.equal(r.status, 201);
  const { vendor } = await r.json();
  assert.equal(vendor.slug, "acme");
  const mine = await get("/api/vendors/mine", vendorUser);
  const { vendors } = await mine.json();
  assert.equal(vendors.length, 1);
  assert.equal(vendors[0].role, "owner");
});

test("主体名 409：大小写变体也视为占用", async () => {
  const r = await post("/api/vendors", outsider, { slug: "ACME", displayName: "Fake", contact: "x@y.test" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "vendor-name-conflict");
});

test("登记缺字段 400 并指名缺失", async () => {
  const r = await post("/api/vendors", outsider, { slug: "badprofile" });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).fields.includes("displayName"));
});

test("档案更新落审计（操作者/时间/字段）", async () => {
  const r = await patch("/api/vendors/acme", vendorUser, { contact: "new-ops@acme.test" });
  assert.equal(r.status, 200);
  const audit = await (await get("/api/vendors/acme/audit", vendorUser)).json();
  assert.equal(audit.audit.at(-1).action, "profile.create");
  const upd = audit.audit.find((a) => a.action === "profile.update");
  assert.ok(upd);
  assert.equal(upd.actor, vendorUser);
  assert.equal(upd.detail.fields.contact, "new-ops@acme.test");
});

test("成员管理：owner 加绑/成员可读/旁观者 403/最后 owner 不可删", async () => {
  assert.equal((await post("/api/vendors/acme/members", vendorUser, { email: member })).status, 200);
  assert.equal((await get("/api/vendors/acme", member)).status, 200);
  assert.equal((await get("/api/vendors/acme", outsider)).status, 403);
  const r = await del("/api/vendors/acme/members/owner@acme.test", vendorUser);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, "last-owner");
});

test("发布资格：绑定 vendor 的普通用户可发；非 creator 非 vendor 403 逐字节", async () => {
  const ok = await post("/api/packs", member, { manifest: manifest("vendor-pack-1") });
  assert.equal(ok.status, 200);
  const no = await post("/api/packs", outsider, { manifest: manifest("outsider-pack") });
  assert.equal(no.status, 403);
  assert.deepEqual(await no.json(), { error: "Creator group required" });
  // creator lane unchanged
  const cr = await post("/api/packs", "author@creators.test", { manifest: manifest("creator-pack") }, ["creators"]);
  assert.equal(cr.status, 200);
});

// ── 3.x 署名投影与发布门 ────────────────────────────────────────────────────
test("署名：绑定发布者声明归属 → 条目投影署名；改名后呈现随之更新", async () => {
  const r = await post("/api/packs", member, { manifest: manifest("acme-toolkit"), vendor: "acme" });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  let list = await (await get("/api/packs?search=acme-toolkit", outsider)).json();
  assert.deepEqual(list.packs[0].vendor, { slug: "acme", name: "Acme 供应" });
  let detail = await (await get(`/api/packs/${id}`, outsider)).json();
  assert.equal(detail.vendor.slug, "acme");
  // 署名投影=服务端档案当前值：主体改名后条目呈现即更新（stamp 不变）
  await patch("/api/vendors/acme", vendorUser, { displayName: "Acme Supply Co." });
  list = await (await get("/api/packs?search=acme-toolkit", outsider)).json();
  assert.deepEqual(list.packs[0].vendor, { slug: "acme", name: "Acme Supply Co." });
  detail = await (await get(`/api/packs/${id}`, outsider)).json();
  assert.equal(detail.vendor.name, "Acme Supply Co.");
});

test("署名闸：无权署名 403 / 未知主体 404 / manifest 自带署名 400 / 无声明不署名", async () => {
  // 「无权署名」的精确场景 = 发布资格通过（eligibleVendor）但声明的主体
  // 不是自己的绑定：member 绑 acme、声明 rival → vendor-binding-required。
  const rivalMk = await post("/api/vendors", "boss@rival.test", { slug: "rival", displayName: "Rival", contact: "r@r.test" });
  assert.ok([201, 409].includes(rivalMk.status));
  const unbound = await post("/api/packs", member, { manifest: manifest("x"), vendor: "rival" });
  assert.equal(unbound.status, 403);
  assert.equal((await unbound.json()).code, "vendor-binding-required");
  const ghost = await post("/api/packs", member, { manifest: manifest("x"), vendor: "ghost" });
  assert.equal(ghost.status, 404);
  const inManifest = await post("/api/packs", member, { manifest: { ...manifest("x"), vendor: "acme" } });
  assert.equal(inManifest.status, 400);
  assert.equal((await inManifest.json()).code, "manifest-attribution-forbidden");
  // 既往发布（vendor-pack-1，无声明）在列表无 vendor 键
  const list = await (await get("/api/packs?search=vendor-pack-1", outsider)).json();
  assert.equal(list.packs[0].vendor, undefined);
});

// ── 2.x onboarding ──────────────────────────────────────────────────────────
test("Happy path: vendor-hosted 全过 → 200 onboarded，writer 代客写入", async () => {
  fake.probeAnswer = ["t1", "t2"];
  const r = await post("/api/vendors/acme/onboarding", member, { serverName: "acme-tools", kind: "vendor-hosted", material: goodMaterial() });
  assert.equal(r.status, 200);
  const { submission } = await r.json();
  assert.equal(submission.status, "onboarded");
  assert.equal(fake.writerCalls.length, 1);
  assert.equal(fake.writerCalls[0].serverName, "acme-tools");
  assert.deepEqual(fake.writerCalls[0].surface.commercialTools, ["t1", "t2"]);
});

test("材料不全 422 material_incomplete 并指名缺失轴", async () => {
  fake.probeAnswer = ["t1"];
  const r = await post("/api/vendors/acme/onboarding", member, { serverName: "no-license", material: { serverEndpoint: "https://x.test/mcp", domain: { name: "n" }, surface: { tools: [{ name: "t1" }], commercialTools: ["t1"] } } });
  assert.equal(r.status, 422);
  const { submission } = await r.json();
  assert.equal(submission.status, "rejected");
  assert.equal(submission.axis, "material_incomplete");
  assert.match(submission.note, /license/);
});

test("禁证 422 license_prohibited", async () => {
  const m = { ...goodMaterial(), license: "AGPL-3.0" };
  const r = await post("/api/vendors/acme/onboarding", member, { serverName: "agpl-server", material: m });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).submission.axis, "license_prohibited");
});

test("同名槽位被另一 vendor 占用 422 duplicate_name", async () => {
  fake.probeAnswer = ["t1", "t2"];
  const r = await post("/api/vendors/rival/onboarding", "boss@rival.test", { serverName: "acme-tools", material: goodMaterial("https://mcp.rival.test/mcp") });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).submission.axis, "duplicate_name");
});

test("selfcheck：不可达 / 声明缺失 / 商业集超集 各自如实拒", async () => {
  // 不可达
  fake.probeAnswer = null;
  let r = await post("/api/vendors/acme/onboarding", member, { serverName: "dark-server", material: goodMaterial("https://down.test/mcp") });
  assert.equal((await r.json()).submission.axis, "selfcheck_failed");
  // 声明了但实服务没有
  fake.probeAnswer = ["t1"];
  r = await post("/api/vendors/acme/onboarding", member, { serverName: "ghost-tools", material: goodMaterial() });
  const ghost = (await r.json()).submission;
  assert.equal(ghost.axis, "selfcheck_failed");
  assert.match(ghost.note, /t2/);
  // 实服务超出声明商业集（闭包超集）
  fake.probeAnswer = ["t1", "t9"];
  r = await post("/api/vendors/acme/onboarding", member, { serverName: "leaky", material: { ...goodMaterial(), surface: { tools: [{ name: "t1" }, { name: "t9" }], commercialTools: ["t1"] } } });
  const leaky = (await r.json()).submission;
  assert.equal(leaky.axis, "selfcheck_failed");
  assert.match(leaky.note, /commercial/);
});

test("配额过闸：tiny 档 1 台，第二张牌 quota_exceeded", async () => {
  await post("/api/vendors", "boss@squat.test", { slug: "squat", displayName: "Squat", contact: "s@s.test" });
  await patch("/api/vendors/squat", "root@admins.test", { quotaTier: "tiny" }, ["admins"]);
  fake.probeAnswer = ["t1", "t2"];
  const first = await post("/api/vendors/squat/onboarding", "boss@squat.test", { serverName: "squat-1", material: goodMaterial("https://mcp.squat.test/mcp") });
  assert.equal(first.status, 200);
  const second = await post("/api/vendors/squat/onboarding", "boss@squat.test", { serverName: "squat-2", material: goodMaterial("https://mcp.squat2.test/mcp") });
  const body = (await second.json()).submission;
  assert.equal(second.status, 422);
  assert.equal(body.axis, "quota_exceeded");
  assert.match(body.note, /1\/1/);
});

test("registry 写入失败挂起 in_review（不伪造在册），车道恢复后 retry 上牌", async () => {
  fake.probeAnswer = ["t1", "t2"];
  fake.writerError = "registry /api/servers/register HTTP 502";
  const r = await post("/api/vendors/acme/onboarding", member, { serverName: "half-lane", material: goodMaterial("https://mcp.acme2.test/mcp") });
  assert.equal(r.status, 202);
  const held = (await r.json()).submission;
  assert.equal(held.status, "in_review");
  assert.equal(held.axis, "registry_write_failed");
  fake.writerError = null;
  const retry = await post(`/api/vendors/acme/onboarding/${held.id}/retry`, member, {});
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).submission.status, "onboarded");
});

test("platform-hosted 先行如实驻留 in_review（托管通道挂账），不伪装", async () => {
  const r = await post("/api/vendors/acme/onboarding", member, { serverName: "hosted-acme", kind: "platform-hosted", material: goodMaterial("https://mcp.acme3.test/mcp") });
  assert.equal(r.status, 202);
  const held = (await r.json()).submission;
  assert.equal(held.status, "in_review");
  assert.equal(held.axis, "platform_hosted_pending");
});

test("资格闸：未绑定账号上牌 403 资格分类，registry 无写入", async () => {
  const calls = fake.writerCalls.length;
  const r = await post("/api/vendors/acme/onboarding", outsider, { serverName: "intruder", material: goodMaterial() });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "vendor-membership-required");
  assert.equal(fake.writerCalls.length, calls);
});

test("可见面：供应商只见自己名下上牌单，状态与台账一致", async () => {
  const list = await (await get("/api/vendors/acme/onboarding", member)).json();
  const names = list.submissions.map((s) => s.serverName);
  assert.ok(names.includes("acme-tools"));
  assert.ok(!names.includes("squat-1"));
  const onboarded = list.submissions.find((s) => s.serverName === "acme-tools");
  assert.equal(onboarded.status, "onboarded");
  const rejected = list.submissions.find((s) => s.serverName === "no-license");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.axis, "material_incomplete");
});

test("registryName 引用回归：既有语义逐字节（声明工具的引用走原发布门）", async () => {
  // Onboarded vendor server rides the SAME registry-name reference contract as
  // any entry — the publish tool gate is the PRODUCTION gate: manifest with no
  // tool declarations bypasses it identically for every server (vendor or not).
  const r = await post("/api/packs", member, {
    manifest: manifest("uses-acme", { mcpServers: [{ registryName: "acme-tools" }] }),
    vendor: "acme",
  });
  assert.equal(r.status, 200);
});

test("发布门对 vendor 同轨：manifest 校验在 vendor 发布者身上同拒", async () => {
  const r = await post("/api/packs", member, { manifest: { name: "" } });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(await r.json()), /Invalid manifest|manifest/);
});

// ── 写入通道 env 切换 (vendor 4.2 fork lane) ──────────────────────────────────
test("defaultWriter: service-token 车道跨 bearer 与路径 (fork 车道), cookie 兜底不变", async () => {
  const { defaultWriter } = await import("../gateway/vendor-onboarding.js");
  const requests = [];
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return ok(); };
  try {
    const w1 = defaultWriter({ MARKET_REGISTRY_URL: "https://mcp.example", REGISTRY_VENDOR_LANE: "service-token", VENDOR_LANE_TOKEN: "srf_tok123" });
    await w1.write({ serverName: "acme-tools", endpoint: "https://mcp.acme.test/mcp", surface: { description: "d", tools: [{ name: "t1" }], commercialTools: ["t1"] }, vendorSlug: "acme" });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /api\/vendor-servers\/register$/);
    assert.match(requests[1].url, /api\/vendor-servers\/toggle$/);
    assert.equal(requests[0].init.headers.Authorization, "Bearer srf_tok123");
    requests.length = 0;
    const w2 = defaultWriter({ MARKET_REGISTRY_URL: "https://mcp.example", REGISTRY_COOKIE: "c=1", REGISTRY_CSRF: "tok" });
    await w2.write({ serverName: "acme-tools", endpoint: "https://mcp.acme.test/mcp", surface: { description: "d", tools: [{ name: "t1" }], commercialTools: ["t1"] }, vendorSlug: "acme" });
    assert.match(requests[0].url, /api\/servers\/register$/);
    assert.equal(requests[0].init.headers["X-CSRF-Token"], "tok");
    assert.equal(requests[0].init.headers.Cookie, "c=1");
    // 未配配置的通道如实不可用（如实降级由冲 in_review 挂账承担, 写入口直接抛错）
    const w3 = defaultWriter({ MARKET_REGISTRY_URL: "https://mcp.example", REGISTRY_VENDOR_LANE: "service-token" });
    assert.equal(w3.configured, false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// ── 缺陷回归（2026-10-28 真机 A3 逮住）: 空 env 的 tierQuotas 必须走内置档 ──
test("tierQuotas: 空/非法/部分覆盖 env 都不产生空档 (quota.servers 崩溃回归)", async () => {
  const { tierQuotas } = await import("../gateway/vendor-onboarding.js");
  const old = process.env.VENDOR_TIER_QUOTAS;
  try {
    delete process.env.VENDOR_TIER_QUOTAS;
    let t = tierQuotas();
    assert.equal(t.free.servers, 3, "空 env=内置 free 档");
    process.env.VENDOR_TIER_QUOTAS = "{}";
    t = tierQuotas();
    assert.equal(t.free.servers, 3, "显式空对象也保内置档");
    process.env.VENDOR_TIER_QUOTAS = "{bad json";
    t = tierQuotas();
    assert.equal(t.free.servers, 3, "非法 JSON 保内置档");
    process.env.VENDOR_TIER_QUOTAS = '{"tiny":{"servers":1}}';
    t = tierQuotas();
    assert.equal(t.tiny.servers, 1);
    assert.equal(t.free.servers, 3, "部分覆盖不吞默认档");
  } finally {
    if (old === undefined) delete process.env.VENDOR_TIER_QUOTAS; else process.env.VENDOR_TIER_QUOTAS = old;
  }
});
