#!/usr/bin/env node
// ── 词元能力快照接入 syncProvider（add-ciyuan-capability-contract 消费侧）
//
// 这组测试锁的是「快照只缩小探测集合」这条纪律，以及三个必须成立的行为：
//   1. 快照说 serving 的 → 探；快照说 permitted_only 的 → **不探**（今天纯白探的那一撮）
//   2. 快照不可用（404）→ 退回 /models 全量探测，行为与接入前完全一致
//   3. 快照与探测分歧 → 以探测为准（实测胜过配置），且分歧可观测
//
//   node --test scripts/test-ciyuan-capability-discovery.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ciyuan-cap-discovery-"));
process.env.LLM_PROVIDERS_STORE = path.join(tmpRoot, "llm-providers.json");
process.env.LLM_DEFAULT_STORE = path.join(tmpRoot, "llm-default.json");
delete process.env.LLM_API_KEY;

const llm = await import("../llm-providers.js");

// ── Mock gateway ─────────────────────────────────────────────────────────────
// GET /v1/models              → 全部已知 id（"recognized"，与真网关同语义）
// GET /v1/ciyuan/capabilities → 由 capabilitiesDoc 决定；null 时返 404（模拟旧版词元）
// POST /v1/chat/completions   → 按 chatBehavior 应答，并记录 attempts
const chatBehavior = {};
const attempts = {};
let capabilitiesDoc = null;

const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { data: Object.keys(chatBehavior).map((id) => ({ id })) });
    }

    if (req.method === "GET" && req.url === "/v1/ciyuan/capabilities") {
      if (!capabilitiesDoc) {
        res.writeHead(404);
        return res.end();
      }
      return send(200, capabilitiesDoc);
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const model = JSON.parse(Buffer.concat(chunks).toString()).model;
      attempts[model] = (attempts[model] || 0) + 1;
      const b = chatBehavior[model];
      if (b === "ok") return send(200, { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      if (b === "unauthorized") {
        return send(404, {
          error: { message: `Model ${model} is not supported by any configured account in this group` },
        });
      }
      return send(500, { error: { message: `unexpected model ${model}` } });
    }

    res.writeHead(404);
    res.end();
  });
});

await new Promise((r) => mockServer.listen(0, "127.0.0.1", r));
const MOCK_BASE = `http://127.0.0.1:${mockServer.address().port}/v1`;
test.after(() => mockServer.close());

function setChatBehavior(map) {
  for (const k of Object.keys(chatBehavior)) delete chatBehavior[k];
  Object.assign(chatBehavior, map);
  for (const k of Object.keys(attempts)) delete attempts[k];
}

function snapshot({ serving, permittedOnly }) {
  return {
    schema: "ciyuan.capabilities/v1",
    generated_at: new Date().toISOString(),
    basis: "schedulable_account_config",
    probed: false,
    key: { name: "test-key", allowlist_enabled: true },
    models: {
      serving: serving.map((id) => ({ id, kind: "unknown" })),
      permitted_only: permittedOnly.map((id) => ({ id, kind: "unknown", basis: "allowlist" })),
      counts: { serving: serving.length, permitted_only: permittedOnly.length },
    },
    lanes: {},
    media: {},
    limits: {},
  };
}

function newProvider(name) {
  return llm.createProvider({ name, baseUrl: MOCK_BASE, apiKey: "sk-cap-key" });
}

// ── 1. 快照缩窄探测集合 ─────────────────────────────────────

test("sync probes only serving ids and skips permitted_only", async () => {
  capabilitiesDoc = snapshot({ serving: ["live-a"], permittedOnly: ["orphan-b", "orphan-c"] });
  setChatBehavior({ "live-a": "ok", "orphan-b": "unauthorized", "orphan-c": "unauthorized" });
  const p = newProvider("Cap Narrow");

  const result = await llm.syncProvider(p.id);

  assert.equal(attempts["live-a"], 1, "serving id 必须被探测一次");
  assert.equal(attempts["orphan-b"], undefined, "permitted_only 不许被探测（纯白探）");
  assert.equal(attempts["orphan-c"], undefined, "permitted_only 不许被探测（纯白探）");

  assert.deepEqual(result.added, ["live-a"]);
  // 结果形状不变（既有测试钉住这三个键），快照信息只进日志。
  assert.deepEqual(Object.keys(result).sort(), ["added", "rosterSize", "statuses"]);
});

// ── 2. 快照不可用时退回全量探测 ─────────────────────────────

test("falls back to probing every /models id when the snapshot is absent", async () => {
  capabilitiesDoc = null; // 404 = 旧版词元，未部署该端点
  setChatBehavior({ "only-a": "ok", "dead-b": "unauthorized" });
  const p = newProvider("Cap Fallback");

  await llm.syncProvider(p.id);

  assert.equal(attempts["only-a"], 1, "回落路径必须探 /models 列出的每个 id");
  assert.equal(attempts["dead-b"], 1, "回落路径必须探 /models 列出的每个 id");
});

// ── 3. 分歧以探测为准 ───────────────────────────────────────

test("probe wins when the snapshot claims serving but the probe says unauthorized", async () => {
  capabilitiesDoc = snapshot({ serving: ["ghost-model"], permittedOnly: [] });
  setChatBehavior({ "ghost-model": "unauthorized" });
  const p = newProvider("Cap Diverge");

  const result = await llm.syncProvider(p.id);

  // 探测是实测：快照说能服务、探测说不能 → 记账为 unauthorized，且不进名册。
  assert.equal(result.statuses["ghost-model"].status, "unauthorized");
  assert.deepEqual(result.added, [], "分歧时不得把 id 加进 roster");
});

// ── 4. 显式关闭开关 ─────────────────────────────────────────

test("CIYUAN_CAPABILITIES_DISCOVERY=off disables the snapshot path entirely", async () => {
  capabilitiesDoc = snapshot({ serving: ["live-a"], permittedOnly: ["orphan-b"] });
  setChatBehavior({ "live-a": "ok", "orphan-b": "unauthorized" });
  process.env.CIYUAN_CAPABILITIES_DISCOVERY = "off";
  const p = newProvider("Cap Disabled");

  try {
    await llm.syncProvider(p.id);
  } finally {
    delete process.env.CIYUAN_CAPABILITIES_DISCOVERY;
  }

  // 关闭后回到接入前行为：/models 全量都探。
  assert.equal(attempts["orphan-b"], 1, "关闭开关后应恢复全量探测");
});
