#!/usr/bin/env node
// ── 词元能力快照消费侧（add-ciyuan-capability-contract 3.2 的前置）
//
// 这组测试锁三件事：
//   1. 任何失败都必须返回 null（→ 调用方退回探测），不许抛、不许半截对象
//   2. 三态保留：车道 available 的 null 不许被折成 false（契约禁止推断 #2）
//   3. planProbeSet 只缩小探测集合，不替代判定；serving 为空时退回全量
//
//   node --test scripts/test-ciyuan-capabilities.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  CAPABILITIES_PATH,
  CAPABILITIES_SCHEMA,
  fetchCapabilities,
  planProbeSet,
  capabilitiesDiscoveryEnabled,
  offpeakAdvisory,
} = await import("../lib/ciyuan-capabilities.js");

const BASE = "https://token.example.test/v1";
const KEY = "sk-test";

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function snapshotBody(overrides = {}) {
  return {
    schema: CAPABILITIES_SCHEMA,
    generated_at: "2026-11-10T13:05:00Z",
    basis: "schedulable_account_config",
    probed: false,
    key: { name: "yizuo-ab-20261110", allowlist_enabled: true },
    models: {
      serving: [{ id: "deepseek-v4.1-flash", kind: "unknown" }],
      permitted_only: [{ id: "glm-5.3-flash", kind: "unknown", basis: "allowlist" }],
      counts: { serving: 1, permitted_only: 1 },
    },
    lanes: {
      rerank: { available: true, upstream_accounts: 2 },
      audio: { available: false, upstream_accounts: 0 },
      websearch: { available: null, upstream_accounts: null },
    },
    media: { image: { allowed: true } },
    ...overrides,
  };
}

// ── 1. 正常读取 ──────────────────────────────────────────────

test("reads serving and permitted_only from a valid snapshot", async () => {
  let seenUrl = null;
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async (url) => {
      seenUrl = url;
      return jsonRes(200, snapshotBody());
    },
  });

  assert.equal(seenUrl, `${BASE}${CAPABILITIES_PATH}`);
  assert.equal(snap.schema, CAPABILITIES_SCHEMA);
  assert.equal(snap.probed, false);
  assert.equal(snap.generatedAt, "2026-11-10T13:05:00Z");
  assert.deepEqual(snap.serving, ["deepseek-v4.1-flash"]);
  assert.deepEqual(snap.permittedOnly, ["glm-5.3-flash"]);
});

test("keeps lanes three-state — null must not collapse to false", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody()),
  });

  assert.equal(snap.lanes.rerank, true);
  assert.equal(snap.lanes.audio, false);
  assert.equal(snap.lanes.websearch, null, "unknown 必须是 null，不能变 false");
  assert.equal(Object.hasOwn(snap.lanes, "websearch"), true);
});

// ── 2. 一切失败都降级为 null ─────────────────────────────────

test("returns null on 404 (older ciyuan without the endpoint)", async () => {
  const snap = await fetchCapabilities(BASE, KEY, { fetchImpl: async () => jsonRes(404, {}) });
  assert.equal(snap, null);
});

test("returns null on 503 (gateway services not wired)", async () => {
  const snap = await fetchCapabilities(BASE, KEY, { fetchImpl: async () => jsonRes(503, {}) });
  assert.equal(snap, null);
});

test("returns null on schema mismatch", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({ schema: "something/v2" })),
  });
  assert.equal(snap, null, "schema 不符不许当成 v1 使用");
});

test("returns null on malformed models block", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({ models: { serving: "nope" } })),
  });
  assert.equal(snap, null);
});

test("returns null when both model sets are empty (no information)", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () =>
      jsonRes(200, snapshotBody({ models: { serving: [], permitted_only: [], counts: { serving: 0, permitted_only: 0 } } })),
  });
  assert.equal(snap, null, "空快照不许拿去裁探测集合");
});

test("returns null on network error instead of throwing", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(snap, null);
});

test("returns null for keyless provider (no key entitlement concept)", async () => {
  let called = false;
  const snap = await fetchCapabilities(BASE, "", {
    auth: "none",
    fetchImpl: async () => {
      called = true;
      return jsonRes(200, snapshotBody());
    },
  });
  assert.equal(snap, null);
  assert.equal(called, false, "auth=none 时不该发请求");
});

// ── 3. 探测集合规划 ─────────────────────────────────────────

test("planProbeSet narrows to serving and reports skipped", () => {
  const snap = { serving: ["a", "b"], permittedOnly: ["c", "d"] };
  const plan = planProbeSet(snap, ["a", "b", "c", "d", "e"]);

  assert.equal(plan.source, "capabilities");
  assert.deepEqual(plan.ids, ["a", "b"]);
  assert.deepEqual(plan.skipped, ["c", "d"]);
});

test("planProbeSet falls back to all ids when serving is empty", () => {
  // 账号可能刚上线，快照还没刷新：这时不能只探空集，否则会误判「无模型」。
  const snap = { serving: [], permittedOnly: ["c"] };
  const plan = planProbeSet(snap, ["a", "c"]);

  assert.equal(plan.source, "capabilities");
  assert.deepEqual(plan.ids, ["c"]);
});

test("planProbeSet uses /models list when snapshot is null", () => {
  const plan = planProbeSet(null, ["a", "b"]);
  assert.equal(plan.source, "models");
  assert.deepEqual(plan.ids, ["a", "b"]);
});

// ── 4. 开关 ─────────────────────────────────────────────────

test("discovery switch defaults on and can be turned off", () => {
  assert.equal(capabilitiesDiscoveryEnabled({}), true);
  assert.equal(capabilitiesDiscoveryEnabled({ CIYUAN_CAPABILITIES_DISCOVERY: "off" }), true === false);
  assert.equal(capabilitiesDiscoveryEnabled({ CIYUAN_CAPABILITIES_DISCOVERY: "OFF" }), false);
  assert.equal(capabilitiesDiscoveryEnabled({ CIYUAN_CAPABILITIES_DISCOVERY: "on" }), true);
});

// ── 5. 额度段（ciyuan-consumer-surface 2.1）────────────────────
//
// 锁两件事：
//   1. 有额度就如实透出（面板才看得见余额/车道额度）
//   2. 额度不可信时整块作废 → null；绝不许把「读不到」变成「余额 0 元」

test("exposes a trustworthy limits block", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () =>
      jsonRes(200, snapshotBody({
        limits: {
          balance_usd: 12.5,
          key_quota_usd: 3,
          key_quota_used_usd: 0.75,
          quota_unlimited: false,
          window_usage: 0,
        },
      })),
  });

  assert.deepEqual(snap.limits, {
    balanceUsd: 12.5,
    quotaUnlimited: false,
    keyQuotaUsd: 3,
    keyQuotaUsedUsd: 0.75,
    windowUsage: 0,
  });
});

test("quota_unlimited=true reports no numeric quota instead of 0", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () =>
      jsonRes(200, snapshotBody({
        limits: { balance_usd: 5, key_quota_usd: 0, quota_unlimited: true, window_usage: null },
      })),
  });

  assert.equal(snap.limits.quotaUnlimited, true);
  assert.equal(snap.limits.keyQuotaUsd, null, "不限额度不许报成 0（0 会被读成『额度为零』）");
  assert.equal(snap.limits.windowUsage, null);
});

test("omitted limits block is null, not zero", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody()),
  });

  assert.equal(snap.limits, null, "旧版词元没有额度段 ⇒ 无数据，不是 0 元");
});

test("untrustworthy limits collapse to null rather than a half-trusted object", async () => {
  const cases = [
    { why: "余额是字符串", limits: { balance_usd: "12.5", quota_unlimited: true } },
    { why: "余额 NaN", limits: { balance_usd: Number.NaN, quota_unlimited: true } },
    { why: "余额负数", limits: { balance_usd: -1, quota_unlimited: true } },
    { why: "缺 balance", limits: { quota_unlimited: true } },
    { why: "缺 quota_unlimited", limits: { balance_usd: 1, key_quota_usd: 2 } },
    { why: "说不限却给了正额度", limits: { balance_usd: 1, key_quota_usd: 2, quota_unlimited: true } },
    { why: "说有限却额度为 0", limits: { balance_usd: 1, key_quota_usd: 0, quota_unlimited: false } },
    { why: "limits 不是对象", limits: "nope" },
  ];

  for (const c of cases) {
    const snap = await fetchCapabilities(BASE, KEY, {
      fetchImpl: async () => jsonRes(200, snapshotBody({ limits: c.limits })),
    });
    assert.equal(snap.limits, null, `${c.why} ⇒ 整块作废`);
    assert.deepEqual(snap.serving, ["deepseek-v4.1-flash"], `${c.why} 不许拖垮模型集合`);
  }
});

// ── 6. 峰谷价与观测吞吐（ciyuan-pricing-capacity-surface）─────────────

const LIVE_PRICING = {
  peak: false,
  multiplier: 1,
  peak_ends_at: null,
  next_offpeak_start: "2026-11-14T12:05:00Z",
  next_offpeak_end: "2026-11-16T01:00:00Z",
  timezone: "UTC",
  source: "deepseek_peak_multiplier + group_peak_rate",
  advisory: true,
};
const LIVE_CAPACITY = {
  model: "deepseek-v4.1-flash",
  sustainable_rps: 0.3474999999999985,
  error_ratio: 0.04173283187073409,
  sample_active_minutes: 3964,
  confidence: "high",
  source: "observed_usage_logs_3d",
  advisory: true,
};

test("carries pricing and capacity from a real-shaped snapshot", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({ pricing: LIVE_PRICING, capacity: LIVE_CAPACITY })),
  });
  assert.equal(snap.pricing.peak, false);
  assert.equal(snap.pricing.multiplier, 1);
  assert.equal(snap.pricing.nextOffpeakEnd, "2026-11-16T01:00:00Z");
  assert.equal(snap.pricing.advisory, true);
  assert.equal(snap.capacity.model, "deepseek-v4.1-flash");
  assert.ok(Math.abs(snap.capacity.sustainableRps - 0.3475) < 1e-9);
  assert.equal(snap.capacity.confidence, "high");
});

test("missing pricing/capacity is null, never zero", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody()),
  });
  assert.equal(snap.pricing, null, "旧版词元没有峰谷段 ⇒ 无数据");
  assert.equal(snap.capacity, null, "旧版词元没有吞吐段 ⇒ 无数据，不是 0 rps");
});

test("untrustworthy pricing collapses to null rather than a half-trusted object", async () => {
  const cases = [
    { why: "peak 不是布尔", v: { ...LIVE_PRICING, peak: "false" } },
    { why: "multiplier 是字符串", v: { ...LIVE_PRICING, multiplier: "1" } },
    { why: "multiplier 小于 1", v: { ...LIVE_PRICING, multiplier: 0.5 } },
    { why: "缺 multiplier", v: { peak: false } },
    { why: "pricing 不是对象", v: 42 },
  ];
  for (const c of cases) {
    const snap = await fetchCapabilities(BASE, KEY, {
      fetchImpl: async () => jsonRes(200, snapshotBody({ pricing: c.v })),
    });
    assert.equal(snap.pricing, null, `${c.why} ⇒ 整块作废`);
  }
});

test("capacity keeps null numbers (sample shortage) but voids malformed ones", async () => {
  const shortSample = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({
      capacity: { ...LIVE_CAPACITY, sustainable_rps: null, error_ratio: null, sample_active_minutes: 0, confidence: "low" },
    })),
  });
  assert.equal(shortSample.capacity.sustainableRps, null, "样本不足是 null，不是 0");
  assert.equal(shortSample.capacity.model, "deepseek-v4.1-flash", "观测对象不许被藏掉");

  const bad = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({
      capacity: { ...LIVE_CAPACITY, sustainable_rps: -1 },
    })),
  });
  assert.equal(bad.capacity, null, "给了值却不可能 ⇒ 整块作废");

  const noModel = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({ capacity: { ...LIVE_CAPACITY, model: "  " } })),
  });
  assert.equal(noModel.capacity, null, "没有观测对象就没有吞吐可言");
});

test("unknown confidence is null, not a fabricated 'low'", async () => {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({ capacity: { ...LIVE_CAPACITY, confidence: "certain" } })),
  });
  assert.equal(snap.capacity.confidence, null);
});

// ── 7. 低谷叙述：低谷态给的是「当前窗口」，不是「下次开始」──────────

async function normalizedPricing(pricing) {
  const snap = await fetchCapabilities(BASE, KEY, {
    fetchImpl: async () => jsonRes(200, snapshotBody({ pricing })),
  });
  assert.ok(snap.pricing, "归一化后应当有 pricing");
  return snap.pricing;
}

test("offpeak state uses the CURRENT window end, never the start", async () => {
  const now = new Date("2026-11-14T13:00:00Z");
  const adv = offpeakAdvisory(await normalizedPricing(LIVE_PRICING), now);
  assert.equal(adv.state, "offpeak");
  assert.equal(adv.until, "2026-11-16T01:00:00Z", "低谷中要说「直到当前窗口结束」");
  assert.notEqual(adv.until, "2026-11-14T12:05:00Z", "起点就是现在，不许当成下次低谷");
});

test("peak state reports the peak window end", async () => {
  const now = new Date("2026-11-14T13:00:00Z");
  const adv = offpeakAdvisory(
    await normalizedPricing({ ...LIVE_PRICING, peak: true, multiplier: 1.5, peak_ends_at: "2026-11-14T14:00:00Z" }),
    now,
  );
  assert.equal(adv.state, "peak");
  assert.equal(adv.until, "2026-11-14T14:00:00Z");
  assert.equal(adv.multiplier, 1.5);
});

test("an expired off-peak window is reported unknown, not still-cheap", async () => {
  const now = new Date("2026-11-17T00:00:00Z"); // 已过 next_offpeak_end
  const adv = offpeakAdvisory(await normalizedPricing(LIVE_PRICING), now);
  assert.equal(adv.state, "unknown", "窗口已过就不许再声称便宜");
});

test("offpeakAdvisory tolerates a null pricing block", () => {
  assert.deepEqual(offpeakAdvisory(null), { state: "unknown", until: null, multiplier: null });
});
