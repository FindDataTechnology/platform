#!/usr/bin/env node
// ── connector / chatwoot 的 vault 与注入时机一致性（change converge-line-identity-and-keys，任务 5.2）──
//
// 5.2 的决策是「**只**统一 vault 与注入时机，**保留**独立语义」，不是把两个模块合并。
// 决策本身没有代码要写（两者早已共用 db + ownerKey、共用 REFS 表），但它**也没有任何判据**：
// 今天没有人断言「这两个 ref 走的是同一层存储、同一处解析、且互不串味」。缺了这道网，
// 后来把 chatwoot 挪去另一条解析路径时，行为会静默分叉而所有既有测试照旧全绿
// （既有两套测试各自只验自己那一半：test-connector-credentials / test-crm-desk-pack-embed）。
//
// 本文件钉四件事：
//   1. vault 是同一层：两边的行都按 registry.ownerKey(email) 落库（同一把主键推导）；
//   2. 注入时机是同一处：两边都由 credential-refs 的 REFS 表解析（liveTokenForRef / invalidateRef）；
//   3. 401 归因不串味：作废 connector 不动 chatwoot，反之亦然；
//   4. 传输语义各自保留：connector 走 Authorization 头，chatwoot 走 stdio 的 credentialEnv ——
//      resolveCredentials 绝不给 chatwoot 挂 Authorization 头（那会既把 HTTP 头贴到 stdio 条目上，
//      又在机器属主档把条目删掉、杀掉部署 env 兜底；见 chatwoot-credentials.js 的 isChatwootRef 注）。
//
//   node --test --test-concurrency=1 scripts/test-credential-vault-parity.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "credential-vault-parity-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
delete process.env.FEDERATED_REF_ENABLED;

const db = await import("../db.js");
await db.initDb();

const refs = await import("../credential-refs.js");
const connector = await import("../connector-credentials.js");
const chatwoot = await import("../chatwoot-credentials.js");
const registry = await import("../registry-credentials.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// 这条臂**故意落在 auth-off / 匿名的分支上**：ownerKey(email) = normalizeIdentityEmail(email)
// || MACHINE_OWNER_KEY。用真邮箱去断言「两边键相同」是空的——db.js 的每个访问器自己也会
// normalizeIdentityEmail，所以传原样邮箱照样落到同一行（我改过一遍 chatwoot 让它绕开
// ownerKey，五条臂全绿 ⇒ 那条断言不承重）。空邮箱才是分叉点：模块若不走 ownerKey，
// db 拿到空键直接拒绝写行，而机器属主那条路是模块层给的。
const ANON = "";
const OWNER = "parity@example.com";
// Fixture, not a credential: the token-shaped prefixes (oct_/cw_) tripped
// the public-snapshot gitleaks gate, so it is named as one.
const CONNECTOR_TOKEN = "parity-connector-fixture-token";
const CHATWOOT_TOKEN = "parity-chatwoot-fixture-token";

test("1 共用同一把主键推导：匿名档两边都落到机器属主，不是各写各的", () => {
  assert.equal(registry.ownerKey(ANON), registry.MACHINE_OWNER_KEY, "前提：空身份落到机器属主");

  connector.store({ email: ANON, token: CONNECTOR_TOKEN });
  chatwoot.store({ email: ANON, token: CHATWOOT_TOKEN });

  // 用机器属主键直接读 db 两张表：都读得到，才说明两边共用同一把推导。
  assert.equal(
    db.getConnectorCredential(registry.MACHINE_OWNER_KEY)?.token,
    CONNECTOR_TOKEN,
    "connector 行落在机器属主键上",
  );
  assert.equal(
    db.getChatwootCredential(registry.MACHINE_OWNER_KEY)?.token,
    CHATWOOT_TOKEN,
    "chatwoot 行落在机器属主键上",
  );

  // 再走模块自己的读口确认一遍（投影层也是同一把键）。
  assert.equal(connector.status(ANON).connected, true);
  assert.equal(chatwoot.status(ANON).connected, true);
});

test("2 注入时机是同一处：两边都由 REFS 表解析出 token", () => {
  // 夹具自备（不依赖上面那条臂的库存）：同一身份、两张表各一行。
  connector.store({ email: OWNER, token: CONNECTOR_TOKEN });
  chatwoot.store({ email: OWNER, token: CHATWOOT_TOKEN });

  assert.equal(refs.knownRef("connector"), true);
  assert.equal(refs.knownRef("chatwoot"), true);

  assert.equal(refs.liveTokenForRef("connector", OWNER), CONNECTOR_TOKEN);
  assert.equal(refs.liveTokenForRef("chatwoot", OWNER), CHATWOOT_TOKEN);

  // 面板指到各自该去的地方（去重前两边都落 registry 卡片）。
  assert.equal(refs.connectPanelForRef("connector"), "connector");
  assert.equal(refs.connectPanelForRef("chatwoot"), "chatwoot");
});

test("3 401 归因不串味：作废一边，另一边仍是 live", () => {
  const email = "isolation@example.com";
  connector.store({ email, token: "oct_iso" });
  chatwoot.store({ email, token: "cw_iso" });

  assert.equal(refs.invalidateRef("connector", email), true, "作废应报告状态变化");
  assert.equal(refs.liveTokenForRef("connector", email), null, "connector 已作废");
  assert.equal(refs.liveTokenForRef("chatwoot", email), "cw_iso", "chatwoot 不受牵连");

  // 反方向：重新粘贴恢复 connector，再作废 chatwoot。
  connector.store({ email, token: "oct_iso2" });
  assert.equal(refs.invalidateRef("chatwoot", email), true);
  assert.equal(refs.liveTokenForRef("chatwoot", email), null, "chatwoot 已作废");
  assert.equal(refs.liveTokenForRef("connector", email), "oct_iso2", "connector 不受牵连");
});

test("4 传输语义保留：connector 挂 Authorization 头，chatwoot 一个头都不挂", () => {
  const email = "transport@example.com";
  connector.store({ email, token: CONNECTOR_TOKEN });
  chatwoot.store({ email, token: CHATWOOT_TOKEN });

  // 同一份 mcp.json 里两行共存，形状照真实产物：connector 是 HTTP 行，chatwoot 是 stdio 行
  // （它的 token 由 credentialEnv 在 toMcpClientEntry 里解析，不经 Authorization）。
  const servers = {
    "connector-row": { url: "https://example.invalid/mcp", credentialRef: "connector" },
    "chatwoot-row": {
      command: "node",
      args: ["chatwoot-mcp.js"],
      credentialRef: "chatwoot",
      credentialEnv: { CHATWOOT_API_TOKEN: "chatwoot" },
    },
  };

  const { servers: out, injected, omitted } = refs.resolveCredentials(servers, email);

  assert.equal(
    out["connector-row"].headers?.Authorization,
    `Bearer ${CONNECTOR_TOKEN}`,
    "connector 行拿到 Authorization 头",
  );
  assert.equal(
    out["chatwoot-row"].headers,
    undefined,
    "chatwoot 行不许被贴 Authorization 头（stdio 条目上贴 HTTP 头是双错）",
  );
  assert.deepEqual(
    out["chatwoot-row"].credentialEnv,
    { CHATWOOT_API_TOKEN: "chatwoot" },
    "chatwoot 行的 credentialEnv 原样保留",
  );

  assert.deepEqual(
    injected.map((entry) => entry.ref),
    ["connector"],
    "一次解析里只有 connector 被算作注入",
  );
  assert.deepEqual(omitted, [], "两边都 live，不该有省略");
});

test("5 token 不出服务端：客户端投影里没有 token（connector 还多一个 patId 也要剥）", () => {
  const email = "projection@example.com";
  connector.store({ email, token: CONNECTOR_TOKEN, patId: "pat_123" });
  chatwoot.store({ email, token: CHATWOOT_TOKEN });

  const connectorRows = connector.listForClient(email);
  assert.equal(connectorRows.length, 1);
  assert.equal("token" in connectorRows[0], false, "connector 客户端投影不带 token");
  assert.equal("patId" in connectorRows[0], false, "connector 的 patId 是服务端吊销句柄，不进浏览器");

  const chatwootStatus = chatwoot.status(email);
  assert.equal("token" in chatwootStatus, false, "chatwoot 状态投影不带 token");
  assert.equal(chatwootStatus.connected, true);
});
