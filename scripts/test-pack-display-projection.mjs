#!/usr/bin/env node
// ── Display v2 read-face passthrough (overhaul-market-catalog-presentation
// 4.5) ───────────────────────────────────────────────────────────────────────
//
// The compatibility invariant: a manifest WITHOUT v2 display fields projects
// byte-identically to the pre-change market faces — the ONLY sanctioned
// additions are the derived read-only fields pinned below. And a manifest WITH
// them rides the market summary VERBATIM (specs/pack-display-format 透传规则),
// locale-projected on the secondary track (4.3) through the same one seam.
//
//   node --test scripts/test-pack-display-projection.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");

const tmp = mkdtempSync(path.join(tmpdir(), "display-proj-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const LEGACY = {
  name: "存量包",
  description: "老包描述。",
  tags: ["法律"],
  skills: [{ name: "s", description: "技能描述", content: "# s" }],
  agents: [{ id: "a", name: "角色", persona: "p" }],
};

const V2 = {
  ...LEGACY,
  name: "v2 显示包",
  identity: { mark: { kind: "glyph", value: "律" }, accent: "lex" },
  promise: "三句话内讲清：合同风险一屏可见。",
  audience: ["legal", "knowledge"],
  outcomes: [
    { title: "风险清单", detail: "逐条定位到条款" },
    { title: "修订建议" },
  ],
  examples: [
    { title: "问风险", prompt: "这份合同的主要风险？" },
    { title: "要建议", prompt: "给出修订建议" },
  ],
  domain: ["legal"],
  i18n: {
    en: {
      name: "V2 Display Pack",
      description: "Legacy description, English.",
      promise: "Contract risks on one screen.",
      audience: ["legal", "knowledge"],
      outcomes: [{ title: "Risk list", detail: "clause by clause" }, { title: "Revision advice" }],
      examples: [{ title: "Ask risks", prompt: "Main risks of this contract?" }, { title: "Ask advice", prompt: "Give revision advice" }],
      skills: { s: { description: "Skill description" } },
      agents: { a: { name: "Role" } },
    },
  },
};

function mount() {
  const dir = mkdtempSync(path.join(tmp, "reg-"));
  const reg = createPackRegistry({ file: path.join(dir, "packs.db") });
  const app = express();
  registerPackRoutes(app, {
    registry: reg,
    resolveUser: () => ({ email: "author@e.test", groups: ["creators"] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "nope" }),
    creatorGroups: ["creators"],
    anonymousRead: true,
    officialAuthors: [],
  });
  const server = http.createServer(app);
  server.listen(0);
  return { server, reg, dir };
}

const get = (server, p) =>
  fetch(`http://127.0.0.1:${server.address().port}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));

test("存量 manifest 的列表投影逐字节钉死：键集无 display、值与变更前语义一致", async () => {
  const { server, reg, dir } = mount();
  try {
    const { id } = reg.publish({ email: "author@e.test", manifest: LEGACY });
    const list = await get(server, "/api/packs");
    const row = list.body.packs.find((p) => p.id === id);
    // 兼容不变量的最强可执行形式：整行等于手拼的预变更形状（id/时间戳除外）。
    assert.ok(!("display" in row), "存量行不得出现 display 键");
    assert.deepEqual(row, {
      id: row.id,
      authorEmail: "author@e.test",
      createdAt: row.createdAt,
      version: 1,
      name: "存量包",
      description: "老包描述。",
      tags: ["法律"],
      publishedAt: row.publishedAt,
      unlisted: false,
      visibility: "public",
      category: "",
      line: "",
      lineLabel: "",
      featured: false,
      agentCount: 1,
      skillCount: 1, // mcpServers 未声明 → json 长度 NULL → 键缺席（未知≠零）
      facade: false,
      badge: "assistant",
      official: false,
    });
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 声明逐字段原样进 summary.display（zh 轨），市场投影不改写其值", async () => {
  const { server, reg, dir } = mount();
  try {
    const { id } = reg.publish({ email: "author@e.test", manifest: V2 });
    const list = await get(server, "/api/packs");
    const row = list.body.packs.find((p) => p.id === id);
    assert.deepEqual(row.display.identity, V2.identity);
    assert.equal(row.display.promise, V2.promise);
    assert.deepEqual(row.display.audience, V2.audience);
    assert.deepEqual(row.display.outcomes, V2.outcomes);
    assert.deepEqual(row.display.examples, V2.examples);
    // domain 走存储真源列（P1 契约），不重复进 display。
    assert.deepEqual(row.domains, ["legal"]);
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("en 轨：display 随副轨投影本地化，与 name/description 同一 seam（4.3 消费面）", async () => {
  const { server, reg, dir } = mount();
  try {
    const { id } = reg.publish({ email: "author@e.test", manifest: V2 });
    const list = await get(server, "/api/packs?locale=en");
    const row = list.body.packs.find((p) => p.id === id);
    assert.equal(row.name, "V2 Display Pack");
    assert.equal(row.display.promise, "Contract risks on one screen.");
    assert.deepEqual(row.display.outcomes[0], { title: "Risk list", detail: "clause by clause" });
    assert.equal(row.display.examples[1].prompt, "Give revision advice");
    // 未声明覆盖的 locale（ja 回落 zh 主轨）——display 值同 zh。
    const ja = (await get(server, "/api/packs?locale=ja")).body.packs.find((p) => p.id === id);
    assert.equal(ja.display.promise, V2.promise);
    // 详情投影同样带副轨 display（manifest 原样 + 4.3 投影）。
    const detail = await get(server, `/api/packs/${id}?locale=en`);
    assert.equal(detail.body.manifest.promise, "Contract risks on one screen.");
  } finally {
    server.close();
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
