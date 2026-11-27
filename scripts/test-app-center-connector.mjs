#!/usr/bin/env node
// ── Connector credential card context (add-connector-context) ───────────────
//
// Shape assertions only (render coverage stays in the e2e sentinels), mirroring
// test-app-center.mjs:
//
//   1.1 — connectorLearnMoreUrl picks the official product page by console
//         language (zh family → the Chinese page, everything else → English).
//   1.2 — the card's copy keys exist in all five locales and the en/zh-CN
//         values are non-empty, distinct strings.
//   3.1 — agents.json's wanxing-connector description states the real product
//         (SaaS connection gateway / credential vault / tokens for agents) and
//         no longer carries the old database-connector wording.
//
//   node scripts/test-app-center-connector.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectorLearnMoreUrl } from "../web/src/lib/connector-mint.ts";

const LOCALES = ["en", "es", "fr", "ja", "zh-CN"];
const ZH_PAGE = "https://www.finddatatech.cloud/zh/products/wanxing-connector/";
const EN_PAGE = "https://www.finddatatech.cloud/products/wanxing-connector/";

function localeDict(lang) {
  return JSON.parse(readFileSync(new URL(`../web/src/locales/${lang}/common.json`, import.meta.url)));
}

test("learn-more URL follows the console language (zh family → zh page)", () => {
  assert.equal(connectorLearnMoreUrl("zh-CN"), ZH_PAGE);
  assert.equal(connectorLearnMoreUrl("zh"), ZH_PAGE);
  assert.equal(connectorLearnMoreUrl("ZH-cn"), ZH_PAGE);
  for (const lang of ["en", "es", "fr", "ja"]) {
    assert.equal(connectorLearnMoreUrl(lang), EN_PAGE, `${lang} must read the en page`);
  }
});

test("context copy keys exist and are non-empty in all five locales", () => {
  for (const lang of LOCALES) {
    const block = localeDict(lang).extensions?.connector;
    assert.ok(block, `${lang}: extensions.connector missing`);
    for (const key of ["contextLine", "learnMore"]) {
      assert.equal(typeof block[key], "string", `${lang}: ${key} missing`);
      assert.ok(block[key].trim().length > 0, `${lang}: ${key} empty`);
    }
  }
});

test("en and zh-CN context lines are distinct translations", () => {
  const en = localeDict("en").extensions.connector.contextLine;
  const zh = localeDict("zh-CN").extensions.connector.contextLine;
  assert.notEqual(en.trim(), zh.trim());
});

test("agents.json connector card states the real product, not the old wording", () => {
  const doc = JSON.parse(readFileSync(new URL("../agents.json", import.meta.url)));
  const card = (doc.apps ?? []).find((a) => a.id === "wanxing-connector");
  assert.ok(card, "wanxing-connector card missing from agents.json");
  assert.match(card.description, /连接网关|凭据/, "description must name the gateway/vault product");
  assert.doesNotMatch(card.description, /连接企业数据库与外部数据源/, "old wording must be gone");
  assert.equal(card.url, "https://connector.finddatatech.cloud", "url unchanged (root path redirects)");
});
