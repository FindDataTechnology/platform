#!/usr/bin/env node
// ── pack-manifest-source：身份头归一化（2026-10-31 真机实录）─────────────────
//
// 背景：试跑拉 manifest 时传的 viewer 是**裸邮箱字符串**（blueprint.ownerEmail），
// 而 facetForwardHeaders 读的是 user.email —— 对字符串取 .email 得 undefined，
// 身份头退化成 {"groups":[]}，facet 判匿名，private 包一律 404，再被包成误导性的
// "Pack version not found"。真机后果：结构样例包（private）永远拉不到 manifest，
// 看上去像「铸造指针失效」，连带把前面的自愈改动全带偏。
//
//   node --test scripts/test-pack-manifest-source.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchMarketManifest } from "../server/pack-manifest-source.js";

// 捕获真实发出的身份头，其余全部走真实现（facetRequest / 归一化）。
function captureFetch({ status = 200, body = { manifest: { name: "x" } } } = {}) {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, headers: init?.headers ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { seen, impl };
}

const ENV = { FACET_BASE_URL: "http://facet.test", FACET_INTERNAL_TOKEN: "t" };

test("viewer 传裸邮箱字符串时，身份头仍解出真实邮箱（private 包不再被误判匿名）", async () => {
  const { seen, impl } = captureFetch();
  await fetchMarketManifest({ packId: "pk_1", version: 3, viewer: "owner@example.com", env: ENV, fetchImpl: impl });
  assert.equal(seen.length, 1);
  const raw = seen[0].headers["x-facet-user"];
  assert.ok(raw, "必须带 x-facet-user 头");
  const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  assert.equal(decoded.email, "owner@example.com", "裸串 viewer 必须被归一成 {email,groups}，否则 facet 判匿名");
  assert.deepEqual(decoded.groups, []);
});

test("viewer 传对象时原样透传其 groups（不吞权限）", async () => {
  const { seen, impl } = captureFetch();
  await fetchMarketManifest({ packId: "pk_1", version: 1, viewer: { email: "a@b.c", groups: ["creators", "platform"] }, env: ENV, fetchImpl: impl });
  const decoded = JSON.parse(Buffer.from(seen[0].headers["x-facet-user"], "base64url").toString("utf8"));
  assert.equal(decoded.email, "a@b.c");
  assert.deepEqual(decoded.groups, ["creators", "platform"]);
});

test("market 回 404 时仍报 Pack version not found（不改既有契约）", async () => {
  const { impl } = captureFetch({ status: 404, body: { error: "nope" } });
  await assert.rejects(
    () => fetchMarketManifest({ packId: "pk_1", version: 9, viewer: "owner@example.com", env: ENV, fetchImpl: impl }),
    (err) => err.status === 404 && err.message === "Pack version not found",
  );
});

test("market 回 5xx 时报 502 且带上游状态（与 404 区分）", async () => {
  const { impl } = captureFetch({ status: 503, body: {} });
  await assert.rejects(
    () => fetchMarketManifest({ packId: "pk_1", version: 1, viewer: "owner@example.com", env: ENV, fetchImpl: impl }),
    (err) => err.status === 502 && /503/.test(err.message),
  );
});
