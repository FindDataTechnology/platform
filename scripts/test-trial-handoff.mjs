// ── Trial handoff rules (complete-creator-loop D2) ──────────────────────────
//
//   node --test scripts/test-trial-handoff.mjs
//
// 钉住的契约：
//   · 未发布的草稿不可试——不是「先禁用按钮」，是结构上装不了
//     （install 只收 {packId, version}，清单由服务端回市场取）；
//   · 跨域深链带 pack 引用与 trial 意图标记，形状与 deploy 交接同一条；
//   · 交接 URL 不夹带任何质量结论（不是「已验证」）。

import assert from "node:assert/strict";
import { test } from "node:test";

const { trialTarget, trialHandoffHref } = await import("../web/src/lib/trialHandoff.ts");

test("a published draft can be tried, by id", () => {
  assert.deepEqual(trialTarget({ publishedPackId: "packs-abc123" }), { ok: true, packId: "packs-abc123" });
  assert.deepEqual(trialTarget({ publishedPackId: "  packs-abc123  " }), { ok: true, packId: "packs-abc123" });
});

test("a never-published draft cannot be tried — there is nothing to install", () => {
  assert.deepEqual(trialTarget({ publishedPackId: null }), { ok: false, reason: "unpublished" });
  assert.deepEqual(trialTarget({}), { ok: false, reason: "unpublished" });
  assert.deepEqual(trialTarget({ publishedPackId: "   " }), { ok: false, reason: "unpublished" });
  assert.deepEqual(trialTarget(null), { ok: false, reason: "unpublished" });
});

test("the cross-domain handoff carries the pack reference and the trial marker", () => {
  const href = trialHandoffHref("https://platform.finddatatech.cloud", "packs-abc123");
  const url = new URL(href);
  assert.equal(url.origin, "https://platform.finddatatech.cloud");
  assert.equal(url.pathname, "/packs", "same doorway the deploy handoff uses");
  assert.equal(url.searchParams.get("deployCastPack"), "packs-abc123");
  assert.equal(url.searchParams.get("trial"), "1");
});

test("a trailing slash on the run origin does not double up", () => {
  const href = trialHandoffHref("https://platform.finddatatech.cloud///", "p1");
  assert.ok(href.startsWith("https://platform.finddatatech.cloud/packs?"), href);
});

test("the handoff makes no quality claim", () => {
  const href = trialHandoffHref("https://x.test", "p1");
  for (const word of ["verified", "validated", "approved", "已通过", "已验证"]) {
    assert.equal(href.includes(word), false, `${word} must not appear in a trial link`);
  }
});
