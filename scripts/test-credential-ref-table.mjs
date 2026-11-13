#!/usr/bin/env node
// ── 凭据表查询测试（change converge-line-identity-and-keys，任务 5.1）─────────
//
// 这一刀把三条并行的 if 链（connected / missingReason / panel）收进每行字段。
// 判据是**行为逐字节不变**：
//   - 每条在册 ref 的三个查询返回原值；
//   - 未在表里的名字仍落 registry 默认；
//   - connector 的 panel 仍是 "registry"（现状缺陷的记录，不是设计意图——
//     修它会改行为，需单独一条）。
//
//   node --test --test-concurrency=1 scripts/test-credential-ref-table.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "credential-ref-table-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
delete process.env.FEDERATED_REF_ENABLED;

const db = await import("../db.js");
await db.initDb();

const refs = await import("../credential-refs.js");
const paperTrading = await import("../paper-trading-credentials.js");
const registry = await import("../registry-credentials.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const REGISTRY_REASON = "connect the MCP market first — no live registry credential";

// ref 名 → [panel, missingReason]
const EXPECTED = {
  registry: ["registry", REGISTRY_REASON],
  connector: ["connector", "connect a connector account first — no live connector credential"],
  "facet-market": ["facet-market", "pair the facet market first — no live market credential"],
  "paper-trading": [
    "paper-trading",
    "connect the paper-trading service first — no live paper-trading credential",
  ],
  "wire-customer": ["line-wire-customer", "connect your wire line first — no live wire credential"],
  lex: ["line-lex", "connect your lex line first — no live lex credential"],
  "wanxing-caller": ["ciyuan-account", "connect your Wanxing caller key first — no live caller credential"],
  chatwoot: ["chatwoot", "connect your Chatwoot account first — no live Chatwoot credential"],
};

test("每条在册 ref 都在表里，且三个查询返回原值", () => {
  for (const [refName, [panel, reason]] of Object.entries(EXPECTED)) {
    assert.equal(refs.knownRef(refName), true, `${refName} 应在册`);
    assert.equal(refs.connectPanelForRef(refName), panel, `${refName} 的 panel`);
    assert.equal(refs.credentialMissingReason(refName), reason, `${refName} 的缺凭据话术`);
    assert.equal(
      refs.connectPathForRef(refName),
      `/settings/connections?panel=${panel}`,
      `${refName} 的深链`,
    );
  }
});

test("未在表里的名字仍落 registry 默认（与 KNOWN_CONNECT_PANELS 时代一致）", () => {
  assert.equal(refs.connectPanelForRef("wanxing-deployer"), "registry");
  assert.equal(refs.connectPanelForRef("nope"), "registry");
  assert.equal(refs.credentialMissingReason("nope"), REGISTRY_REASON);
  // 未知名字不参与连接判定时也不该抛
  assert.equal(refs.credentialConnected("nope", "nobody@example.com"), false);
});

test("connected 走各自 resolver：paper-trading 粘贴后即为真", () => {
  const email = "paper@example.com";
  assert.equal(refs.credentialConnected("paper-trading", email), false);
  paperTrading.store({ email, token: "fdt_paste_1" });
  assert.equal(refs.credentialConnected("paper-trading", email), true);
});

test("connector 的连接判定与 registry 互不牵连（两个方向都验）", async () => {
  const connector = await import("../connector-credentials.js");

  // 方向一：只有 connector PAT、没有 registry token → 必须判为已连接
  // （去重前会误拒，理由写的是「市场凭据」）。
  const onlyConnector = "conn-only@example.com";
  assert.equal(registry.status(onlyConnector).connected, false);
  connector.store({ email: onlyConnector, token: "oct_pat_1" });
  assert.equal(refs.credentialConnected("connector", onlyConnector), true);

  // 方向二：只有 registry token、没有 connector PAT → 必须判为未连接
  // （去重前会因为 registry 已连接而放行，随后 connector 调用 401）。
  const onlyRegistry = "reg-only@example.com";
  registry.store({ email: onlyRegistry, token: "eyJ.reg.token", expiresAt: null });
  assert.equal(registry.status(onlyRegistry).connected, true);
  assert.equal(refs.credentialConnected("connector", onlyRegistry), false);
});
