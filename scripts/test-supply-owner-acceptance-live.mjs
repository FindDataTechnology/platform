#!/usr/bin/env node
// ── 真机验收：供应开放+主人经营四棒 (add-*-supply/owner batch, §15.69/70) ─────
//
// 对生产门面的全真旅程，分两档跑：
//   A) 无新密领地（内部身份注入面）: vendor 注册/署名投影/价格声明非法拒/免费链路/
//      owner board/iterations/digest 注册与退订
//   B) 需要供方/买家子账户的链（onboarding 写入、付费 purchase+credit、发布跟新版
//      的订阅提亮）: 显式标 SKIPPED-unless-secret 并给出 ops 注入路径,
//      不在 CI 色假绿。
//
// 运行：FACET_BASE_URL=https://facet.finddatatech.cloud FACET_INTERNAL_TOKEN=… \
//       TEST_EMAIL=aloadtree@gmail.com node scripts/test-supply-owner-acceptance-live.mjs
// GHA: .github/workflows/live-supply-owner-acceptance.yml （workflow_dispatch 手动起）

import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = (process.env.FACET_BASE_URL ?? "https://facet.finddatatech.cloud").replace(/\/+$/, "");
const PBASE = (process.env.PLATFORM_BASE_URL ?? "https://platform.finddatatech.cloud").replace(/\/+$/, "");
const TOKEN = process.env.FACET_INTERNAL_TOKEN ?? "";
const PCOOKIE = process.env.PLATFORM_COOKIE ?? "";   // 壹座面会话 cookie（mint-paas-cookie 配方）
const EMAIL = process.env.TEST_EMAIL ?? "aloadtree@gmail.com";
const STRICT_TOKEN_LANE = process.env.ACCEPT_TOKEN_LANE === "1";

if (!TOKEN) {
  // This suite is the LIVE acceptance lane (workflow_dispatch, manual). It has
  // no place in the serialized unit gate: without the org secret it must skip
  // cleanly, not fail the run. An exit code of 2 would surface as a red test
  // file in `node --test scripts/test-*.mjs`; exit 0 with a clear notice keeps
  // the gate honest (CI green ≠ acceptance passed — see the lane's own job).
  console.log("SKIPPED: FACET_INTERNAL_TOKEN not set — live acceptance runs only via .github/workflows/live-supply-owner-acceptance.yml (workflow_dispatch)");
  process.exit(0);
}

const facetUser = Buffer.from(JSON.stringify({ email: EMAIL, groups: ["creators"], emailVerified: true })).toString("base64url");
const H = () => ({
  "x-facet-token": TOKEN,
  "x-facet-user": facetUser,          // facet 代理身份头=base64url(JSON)（facet/identity.js 合约）
  "content-type": "application/json",
});
const reqOn = async (base, headers, path, method = "GET", body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json };
};
// 壹座面（fleets 宿主）：cookie 会话；缺 cookie 时调用方给 SKIP 语义。
const preq = async (path, method = "GET", body) => {
  if (!PCOOKIE) return { status: 0, json: null, skipped: true };
  return reqOn(PBASE, { cookie: PCOOKIE, "content-type": "application/json" }, path, method, body);
};
const req = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: H(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json };
};
const uniq = process.env.ACCEPT_SLUG ?? "acpt-supply-live";  // 幂等：固定主体名，重复运行 409 复用
console.log(`target=${BASE} actor=${EMAIL} uniq=${uniq}`);

test("A1 vendor 注册即得 + 档案行", async () => {
  const r = await req("/api/vendors", "POST", { slug: uniq, displayName: "验收供应商·ACPT", contact: "acpt@test.dev" });
  assert.ok([201, 409].includes(r.status), JSON.stringify(r.json));
  const mine = await req("/api/vendors/mine");
  assert.equal(mine.status, 200);
  assert.ok(mine.json.vendors.find((v) => v.slug === uniq), "mine 应见该主体");
});

test("A2 缴纳上线: 署名与价格声明随版本锁定, manifest 自署被闸", async () => {
  const manifest = { name: "acpt-supply-live-pack", description: "acceptance", skills: [{ name: "s", description: "d", content: "ok" }] };
  // 署名闸用例必须用唯一包名：同名闸（409）先于署名闸（400）命中。
  const bad = await req("/api/packs", "POST", { manifest: { ...manifest, name: `${manifest.name}-attr-${Date.now().toString(36)}`, vendor: uniq } });
  assert.equal(bad.status, 400, JSON.stringify(bad.json), "manifest 自带署名键应被拒（发布门 400 口径）");
  assert.equal(bad.json.code, "manifest-attribution-forbidden");
  let ok = await req("/api/packs", "POST", { manifest, vendor: uniq, pricing: { priceUsd: 2.5, kind: "once" } });
  if (ok.status === 409) {
    // 同名重跑：读既有条目继续（幂等走查）
    const list = await req(`/api/packs?search=${encodeURIComponent(manifest.name)}`);
    const hit = (list.json?.packs ?? []).find((p) => p.name === manifest.name);
    assert.ok(hit, "重名 409 且列表可寻回既有条目");
    ok = { status: 200, json: { id: hit.id } };
  }
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const id = ok.json.id;
  const detail = await req(`/api/packs/${id}`);
  assert.equal(detail.json.vendor.slug, uniq);
  assert.deepEqual(detail.json.pricing, { priceUsd: 2.5, kind: "once" });
  const badPrice = await req("/api/packs", "POST", { manifest: { ...manifest, name: `${manifest.name}-bad-${Date.now().toString(36)}` }, vendor: uniq, pricing: { priceUsd: -1 } });
  assert.equal(badPrice.status, 400);
});

test("A3 vendor lane 未配 (accept-token-lane=0) 回容真实; 配了则走 fork 通道", async (t) => {
  if (!STRICT_TOKEN_LANE) {
    t.diagnostic("stepped: onboarding writes live behind REGISTRY_VENDOR_LANE=service-token 部署窗 — skip live-write (4.3 walkthrough window)");
    return;
  }
  const r = await req(`/api/vendors/${uniq}/onboarding`, "POST", {
    serverName: `acpt-${uniq}-${Date.now().toString(36)}`,
    kind: "vendor-hosted",
    material: {
      serverEndpoint: "https://no-such-host.invalid/mcp", license: "MIT", domain: { name: "acpt" },
      surface: { tools: [{ name: "t1" }], commercialTools: ["t1"], description: "probe" },
    },
  });
  assert.equal(r.status, 422, `期望 422 如实拒, got ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`);
  // 死地址必须被如实拒——轴要么 selfcheck_failed（探不通），要么 quota_exceeded
  // （走查主体此前留有未决单占额）。两者都属「不静默放行」，禁止 2xx。
  const axis = r.json?.submission?.axis;
  assert.ok(["selfcheck_failed", "quota_exceeded"].includes(axis), `如实拒轴异常: ${axis}`);
  if (axis === "quota_exceeded") t.diagnostic("走查主体额度已占满（历史未决单）——轴如实呈现, 非静默放行");
});

test("A4 owner 坞总览可跨机占位 + 花销投影有形状", async (t) => {
  const board = await preq("/api/fleets/owner/board");
  if (board.skipped) { t.diagnostic("SKIP: PLATFORM_COOKIE 未配 — 壹座面走查需 mkae cookie(mint-paas-cookie)"); }
  else {
    assert.equal(board.status, 200, JSON.stringify(board.json));
    assert.ok(Array.isArray(board.json.fleets), "owner/board 应返且数");
    const cells = await preq("/api/fleets/owner/cells");
    assert.ok([200, 404].includes(cells.status), "gateway 缺机位册时 404/honest degrade 可接受");
  }
  const snap = await req("/api/packs/billing/snapshot");
  assert.ok([200, 503].includes(snap.status), `snapshot 形态=200/503, got ${snap.status}`);
  if (snap.status === 200) {
    assert.ok("basis" in snap.json && (snap.json.basis ?? "").includes("账户级"), "金额口径必须如实标注");
  }
});

test("A5 迭代链与 digest 订阅", async (t) => {
  if (!PCOOKIE) { t.diagnostic("SKIP: PLATFORM_COOKIE 未配 — digest 路在壹座面"); return; }
  const sub = await preq("/api/fleets/no-such/digest-subscribe", "POST", { cadence: "daily" });
  assert.ok([400, 404].includes(sub.status), `无集群要 4xx, got ${sub.status}: ${JSON.stringify(sub.json)}`);
  const list = await preq("/api/fleets/owner/digest-subscriptions");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.subscriptions));
});

test.skip("B1 paid 付费+credit 抵扣全真循环 (need seeded sub2api buyer, ops 窗)", () => {});
test.skip("B2 onboarding 经过 fork lane 的 live-write (need VENDOR_LANE_TOKEN 部署窗)", () => {});
test.skip("B3 v2 发布与订阅跟新提示回放 (need 生产市场走查窗)", () => {});
