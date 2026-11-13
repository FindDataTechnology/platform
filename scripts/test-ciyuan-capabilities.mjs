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
