#!/usr/bin/env node
// ── Market read faces under a display locale (add-pack-locale-tracks, 2.2/2.4)
//
// Route-level contract over a real pack registry + registerPackRoutes mount:
//   - list rows render the en overlay when asked, zh otherwise
//   - detail renders overlay name/description AND the manifest display fields
//     (card and dialog agree), with the i18n block riding along
//   - no-locale requests keep the pre-change zh payload
//   - an uncovered locale (ja) falls back to zh everywhere
//   - Accept-Language is the fallback channel when ?locale= is absent
//   - stored-version reads stay the zh install truth (locale never tints them)
//   - search runs on the zh columns regardless of locale
//
//   node --test scripts/test-pack-locale-routes.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

delete process.env.MARKET_REGISTRY_URL;
process.env.PACK_ACCESS_MODE = "open";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "pack-locale-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const ZH_GUIDE = [
  { title: "第一步", body: "准备材料" },
  { title: "第二步", body: "发起提问" },
  { title: "第三步", body: "拿到产出" },
];

function manifest(overrides = {}) {
  return {
    name: "政心盯梢集群",
    description: "盯住政策与舆情的长期变化。",
    skills: [{ name: "intel", description: "情报采集", content: "# 正文" }],
    mcpServers: [],
    agents: [{ id: "watch", name: "监视岗", persona: "你是监视岗。" }],
    guide: { steps: ZH_GUIDE },
    i18n: {
      en: {
        name: "Policy Sentinel Cluster",
        description: "Watches long-run policy and sentiment shifts.",
        guide: { steps: [
          { title: "Step One", body: "Prepare materials" },
          { title: "Step Two", body: "Ask the agent" },
          { title: "Step Three", body: "Get the output" },
        ] },
        skills: { intel: { description: "Collects intelligence" } },
        agents: { watch: { name: "Watch Post" } },
      },
    },
    ...overrides,
  };
}

async function boot() {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: (req) => {
      const who = req.headers["x-test-user"];
      if (!who) return null;
      const [email, groups = ""] = String(who).split("|");
      return { email, groups: groups ? groups.split(",") : [] };
    },
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "Authentication required" }),
    creatorGroups: ["creators"],
    adminGroups: [],
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, init = {}) =>
    fetch(`${base}${p}`, init).then(async (r) => {
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      return { status: r.status, body, text };
    });
  const publish = (md, who = "author@x.test|creators") =>
    call("/api/packs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": who },
      body: JSON.stringify({ manifest: md }),
    });
  return {
    call,
    publish,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      registry.close();
    },
  };
}

test("locale read faces over a published bilingual pack", async (t) => {
  const env = await boot();
  t.after(() => env.close());

  const published = await env.publish(manifest());
  assert.equal(published.status, 200, published.text);
  const id = published.body.id ?? published.body.packId;
  assert.ok(id, published.text);

  // ── list: no locale keeps the zh payload ─────────────────────────────────
  const zhList = await env.call("/api/packs", { headers: { "x-test-user": "reader@x.test" } });
  assert.equal(zhList.status, 200);
  const zhRow = zhList.body.packs.find((p) => p.id === id);
  assert.equal(zhRow.name, "政心盯梢集群");
  assert.equal(zhRow.description, "盯住政策与舆情的长期变化。");

  // ── list: en renders the overlay ─────────────────────────────────────────
  const enList = await env.call("/api/packs?locale=en", { headers: { "x-test-user": "reader@x.test" } });
  const enRow = enList.body.packs.find((p) => p.id === id);
  assert.equal(enRow.name, "Policy Sentinel Cluster");
  assert.equal(enRow.description, "Watches long-run policy and sentiment shifts.");
  // Uncovered locales fall back to zh.
  const jaList = await env.call("/api/packs?locale=ja", { headers: { "x-test-user": "reader@x.test" } });
  assert.equal(jaList.body.packs.find((p) => p.id === id).name, "政心盯梢集群");

  // ── list: Accept-Language is the fallback channel ────────────────────────
  const alList = await env.call("/api/packs", {
    headers: { "x-test-user": "reader@x.test", "accept-language": "en-US,en;q=0.9" },
  });
  assert.equal(alList.body.packs.find((p) => p.id === id).name, "Policy Sentinel Cluster");

  // ── detail: columns and manifest display fields agree ────────────────────
  const enDetail = await env.call(`/api/packs/${id}?locale=en`, { headers: { "x-test-user": "reader@x.test" } });
  assert.equal(enDetail.status, 200);
  assert.equal(enDetail.body.name, "Policy Sentinel Cluster");
  assert.equal(enDetail.body.manifest.name, "Policy Sentinel Cluster");
  assert.equal(enDetail.body.manifest.guide.steps[0].title, "Step One");
  assert.equal(enDetail.body.manifest.skills[0].description, "Collects intelligence");
  assert.equal(enDetail.body.manifest.agents[0].name, "Watch Post");
  assert.ok(enDetail.body.manifest.i18n?.en, "the i18n block rides along");

  const zhDetail = await env.call(`/api/packs/${id}`, { headers: { "x-test-user": "reader@x.test" } });
  assert.equal(zhDetail.body.name, "政心盯梢集群");
  assert.equal(zhDetail.body.manifest.guide.steps[0].title, "第一步");

  // ── stored-version read stays the zh install truth ───────────────────────
  const stored = await env.call(`/api/packs/${id}/versions/1?locale=en`, { headers: { "x-test-user": "reader@x.test" } });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.manifest.name, "政心盯梢集群");
  assert.equal(stored.body.manifest.guide.steps[0].title, "第一步");

  // ── search runs on the zh columns regardless of locale ───────────────────
  const enSearch = await env.call(`/api/packs?locale=en&search=${encodeURIComponent("政心")}`, {
    headers: { "x-test-user": "reader@x.test" },
  });
  assert.ok(enSearch.body.packs.some((p) => p.id === id), "zh-keyword search still hits under locale=en");
  const enOnly = await env.call(`/api/packs?locale=en&search=${encodeURIComponent("Policy Sentinel")}`, {
    headers: { "x-test-user": "reader@x.test" },
  });
  // overhaul-market-catalog-presentation P0 (061298ea, committed): 搜索改为跨轨
  // 命中（zh 主轨 + 翻译轨并检），"v1 search is zh-only" 的旧合同已废——本断言
  // 随已提交行为翻转；pack-locale 能力的 spec 偿还归该班。
  assert.ok(enOnly.body.packs.some((p) => p.id === id), "cross-track search: en text hits too (P0 061298ea)");
});