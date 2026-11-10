#!/usr/bin/env node
// ── Installed-pack read face under a display locale (tasks 2.3) ─────────────
//
// GET /api/mypacks is 壹座's 设置→功能集 data source. It must render under the
// SAME locale rules as the market (lib/pack-locale owns them): a non-zh
// request overlays the stored manifest's i18n block on the response copy; the
// stored row is never rewritten; zh (or absent) returns the pre-change rows.
//
//   node --test scripts/test-pack-mypacks-locale.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test, after } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "mypacks-locale-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const db = await import("../db.js");
await db.initDb();
const { registerPackRoutes } = await import("../server/routes/packs.js");

const MANIFEST = {
  name: "政心盯梢集群",
  description: "盯住政策与舆情的长期变化。",
  skills: [{ name: "intel", description: "情报采集", content: "# 正文" }],
  mcpServers: [],
  agents: [],
  guide: {
    steps: [
      { title: "第一步", body: "准备材料" },
      { title: "第二步", body: "发起提问" },
      { title: "第三步", body: "拿到产出" },
    ],
  },
  i18n: {
    en: {
      name: "Policy Sentinel Cluster",
      description: "Watches long-run policy and sentiment shifts.",
      guide: { steps: [
        { title: "Step One", body: "Prepare materials" },
        { title: "Step Two", body: "Ask the agent" },
        { title: "Step Three", body: "Get the output" },
      ] },
    },
  },
};

db.upsertInstalledPack({ packId: "pk-locale-1", name: MANIFEST.name, version: 1, manifest: MANIFEST, report: {} });

async function boot() {
  const app = express();
  registerPackRoutes({ app, db, broadcast: () => {}, requireMcpManage: () => true });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (p, init = {}) =>
    fetch(`${base}${p}`, init).then(async (r) => ({ status: r.status, body: await r.json() }));
  return {
    call,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

test("installed packs render the requested locale, zh otherwise", async (t) => {
  const env = await boot();
  t.after(() => env.close());

  const zh = await env.call("/api/mypacks");
  assert.equal(zh.status, 200);
  assert.equal(zh.body.packs[0].name, "政心盯梢集群");
  assert.equal(zh.body.packs[0].manifest.guide.steps[0].title, "第一步");

  const en = await env.call("/api/mypacks?locale=en");
  assert.equal(en.body.packs[0].name, "Policy Sentinel Cluster");
  assert.equal(en.body.packs[0].manifest.name, "Policy Sentinel Cluster");
  assert.equal(en.body.packs[0].manifest.guide.steps[0].title, "Step One");
  assert.ok(en.body.packs[0].manifest.i18n?.en, "the i18n block rides along");

  const viaHeader = await env.call("/api/mypacks", { headers: { "accept-language": "en" } });
  assert.equal(viaHeader.body.packs[0].name, "Policy Sentinel Cluster");

  const ja = await env.call("/api/mypacks?locale=ja");
  assert.equal(ja.body.packs[0].name, "政心盯梢集群");

  // The stored row is never rewritten by a localized read.
  const stored = db.getInstalledPack("pk-locale-1");
  assert.equal(stored.name, "政心盯梢集群");
  assert.equal(stored.manifest.guide.steps[0].title, "第一步");
});