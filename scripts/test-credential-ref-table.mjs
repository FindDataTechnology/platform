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
  "ciyuan-account": ["ciyuan-account", "connect your Ciyuan account first — no live Ciyuan account key"],
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
  // wanxing-deployer 现在是一行，但**刻意不声明 panel**（没有那张卡），
  // 所以它仍落 registry——这是保留现状，不是遗漏，与 "nope" 那种真未知同名不同因。
  assert.equal(refs.connectPanelForRef("wanxing-deployer"), "registry");
  assert.equal(refs.connectPanelForRef("nope"), "registry");
  assert.equal(refs.credentialMissingReason("nope"), REGISTRY_REASON);
  // 未知名字不参与连接判定时也不该抛
  assert.equal(refs.credentialConnected("nope", "nobody@example.com"), false);
});

// converge 5.1 的验收原话：「每条 ref 在配置表中可读」。五条里三条第一刀已在表，
// ciyuan-account / wanxing-deployer 是本次补的两行——一条断言钉住全部五条。
test("5.1 点名的五条 ref 全部在表里可读", () => {
  for (const refName of ["facet-market", "paper-trading", "ciyuan-account", "wanxing-caller", "wanxing-deployer"]) {
    assert.equal(refs.knownRef(refName), true, `${refName} 应是表里的一行`);
  }
});

test("ciyuan-account 行与模块同源：取到的钥匙就是绑定账户那把", async () => {
  const ciyuan = await import("../ciyuan-account-credentials.js");
  const email = "ciyuan@example.com";
  assert.equal(refs.liveTokenForRef("ciyuan-account", email), null);
  ciyuan.store({ email, token: "sk-bound-account-key", keyId: 11, keyName: "yizuo-test" });
  assert.equal(refs.liveTokenForRef("ciyuan-account", email), ciyuan.liveToken(email));
  assert.equal(refs.credentialConnected("ciyuan-account", email), true);
  // 401 归因走同一处：markStale 一次翻真，再一次为假（状态没再变）
  assert.equal(refs.invalidateRef("ciyuan-account", email), true);
  assert.equal(refs.liveTokenForRef("ciyuan-account", email), null);
});

test("wanxing-deployer 行与旧兜底逐字等价（这条行替换的是 liveTokenForRef 的名字回退）", async () => {
  const lineCredentials = await import("../line-credentials.js");
  const email = "deployer@example.com";

  // 表里读得到（本轮之前它只能靠名字兜底）
  assert.equal(refs.knownRef("wanxing-deployer"), true);
  assert.equal(refs.liveTokenForRef("wanxing-deployer", email), null);

  lineCredentials.store({ email, line: "wanxing-deployer", token: "sk-deployer-paste" });
  const viaTable = refs.liveTokenForRef("wanxing-deployer", email);
  const viaModule = lineCredentials.liveToken(email, "wanxing-deployer");
  assert.equal(viaTable, viaModule, "两条路必须取到同一把钥匙");
  assert.equal(viaTable, "sk-deployer-paste");
  assert.equal(refs.credentialConnected("wanxing-deployer", email), true);

  // 只认自己的 ref 名：普通配置与相邻的 caller 行都不被它认领
  const entry = refs.refFor({ credentialRef: "wanxing-deployer" });
  assert.ok(entry, "refFor 应解出这一行");
  assert.equal(entry.refName, "wanxing-deployer");
  assert.equal(entry.isRef({ credentialRef: "wanxing-caller" }), false);
  assert.equal(entry.isRef({ credentialRef: "registry" }), false);

  // 401 归因落在这一行自己的 store 上
  assert.equal(refs.invalidateRef("wanxing-deployer", email), true);
  assert.equal(refs.liveTokenForRef("wanxing-deployer", email), null);
  assert.equal(lineCredentials.liveToken(email, "wanxing-caller"), null, "不许串到相邻行");
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
