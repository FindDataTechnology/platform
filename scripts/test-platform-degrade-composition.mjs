#!/usr/bin/env node
// ── 平台凭据失效 ⇒ 只降一类动作（converge-line-identity-and-keys 3.5 的离线半）──
//
// 3.5 的验收原话是四条：该线**工具面仍在** / **客户级调用成功** / **成员级动作显式失败** /
// **其他消费方不受影响**。前三条的一半、以及第四条，在别处各有断言：
//   · D5 三段判定（保留/省略/计降级）—— `test-federated-ref.mjs` 三条，但都停在
//     `resolveCredentials()` 的**返回对象**上；
//   · 门 A 未配置抛类型化错误 —— 同文件两条；
//   · 降级不串味（按 (人,线) 记账）—— 同文件 3.4 三条 + `test-credential-degradation-route.mjs`。
//
// **本文件补的是它们之间那一步：`resolveCredentials` 说「degraded」之后，
// `dsh-profile.js` 到底有没有把这个 server 留在写给 dsh 的 patch 里。**
// 这一环此前没有任何断言——把 `dsh-profile.js` 里那段降级分支改回旧的
// `delete servers[name]`（＝本 change 要消除的「平台挂=子线功能消失」），
// 上面那些用例**全部照绿**：它们量的是返回对象，不是落盘的 profile。
//
// 为什么量 patch 文件而不是量返回对象：patch 是 dsh 真正加载的那份，也是"工具面在不在"
// 的唯一可观测事实。返回对象里活着、patch 里没有，等于没有。
//
//   node --test --test-concurrency=1 scripts/test-platform-degrade-composition.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "degrade-composition-"));
process.env.DB_PATH = path.join(TMP, "platform.db");
process.env.PLATFORM_DATA_DIR = TMP;
process.env.DSH_HOME = path.join(TMP, "dsh");
process.env.MCP_CONFIG_PATH = path.join(TMP, "mcp.json");
process.env.MARKET_REGISTRY_URL = "https://registry.example.test";
process.env.MARKET_REGISTRY_TOKEN = "service-token";
delete process.env.REGISTRY_URL;
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });
process.chdir(TMP);

// 夹具刻意分四行，每行只承担一条断言：
//   file-server  无 ref ⇒ 「其他消费方不受影响」的对照组
//   lex-http     lex 行 + 配置自身带自有轨凭据（x-authorization）⇒ 平台挂时应保留
//   lex-bare     lex 行但**不带**任何自有凭据 ⇒ 平台挂时仍须省略（保留＝裸调用）
//   pt-srv       legacy ref（paper-trading，无 ownTrack）⇒ 行为必须与改动前一致
fs.writeFileSync(
  process.env.MCP_CONFIG_PATH,
  JSON.stringify({
    mcpServers: {
      "file-server": { url: "https://file.example.test/mcp" },
      "lex-http": {
        url: "https://lex.example.test/mcp",
        credentialRef: "lex",
        headers: { "x-authorization": "Bearer line-own-pat" },
      },
      "lex-bare": { url: "https://lex-bare.example.test/mcp", credentialRef: "lex" },
      "pt-srv": { url: "https://pt.example.test/mcp", credentialRef: "paper-trading" },
    },
  }),
);
fs.writeFileSync(path.join(TMP, "market-catalog.json"), JSON.stringify({ mcpServers: [] }));
fs.writeFileSync(path.join(TMP, "market-catalog-skills.json"), JSON.stringify({ skills: [] }));

// 顺序是判据的一部分：`credential-refs.js` 的 REFS 是**模块加载时的快照**
// （`...federatedRef.entries()`），所以全局开关与按线开关必须在它被首次 import
// **之前**就位。先 import 再翻开关只会得到一个不含 lex 的表 —— 那是「夹具没开」，
// 会被读成「降级分支没走到」。
process.env.FEDERATED_REF_ENABLED = "1";

const db = await import("../db.js");
await db.initDb();
const federated = await import("../federated-ref.js");
federated.FEDERATED_LINES.lex.enabled = true; // 按线那一层（线上由 FEDERATED_REF_LINES 声明）
const credentialRefs = await import("../credential-refs.js");

const bridge = await import("../registry-bridge.js");
bridge.initRegistryBridge({
  broadcast: () => {},
  fetchImpl: async (url) =>
    url.includes("/api/skills")
      ? { ok: true, status: 200, json: async () => ({ skills: [] }) }
      : url.includes("/api/agents")
        ? { ok: true, status: 200, json: async () => ({ agents: [] }) }
        : { ok: true, status: 200, json: async () => ({ servers: [] }) },
});
await bridge.refreshRegistry();

const { writeMcpPatch } = await import("../dsh-profile.js");
const ciyuan = await import("../ciyuan-account-credentials.js");

const PATCH_FILE = path.join(
  process.env.DSH_HOME,
  "profiles",
  process.env.DSH_PROFILE || "platform",
  "mcp.patch.yml",
);

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function writePatch(ownerEmail) {
  fs.rmSync(PATCH_FILE, { force: true });
  await writeMcpPatch({ ownerEmail });
  assert.ok(fs.existsSync(PATCH_FILE), "前提：patch 真的落盘了（没落盘时下面所有断言都会'通过'）");
  const rows = yaml.load(fs.readFileSync(PATCH_FILE, "utf8"));
  const insert = Array.isArray(rows) ? (rows[0]?.insert ?? []) : [];
  return {
    names: insert.map((e) => e.config.serverName),
    entry: (name) => insert.find((e) => e.config.serverName === name),
  };
}

const EMAIL = "degrade@x.test";

// ── 前提断言：夹具真的让降级分支可达 ─────────────────────────────────────────
// 没有这一条，下面「server 还在」可以是「根本没进降级」的同形结果。
// 两个探针**必须成对**：保留的条件是「声明了 ownTrack **且** 配置自带凭据」，
// 只断言其中一半会把「凡 lex 就保留」这种更宽的实现也判绿。
test("前提：lex 行已启用，保留与否取决于配置自身带不带凭据", () => {
  assert.equal(federated.degradedReason("lex"), null, "lex 行应已启用");
  const withOwnAuth = credentialRefs.resolveCredentials(
    { probe: { url: "https://probe.example.test/mcp", credentialRef: "lex", headers: { "x-authorization": "Bearer own" } } },
    EMAIL,
  );
  assert.ok(withOwnAuth.servers.probe, "声明 ownTrack 且自带凭据 ⇒ 保留");
  assert.equal(withOwnAuth.degraded.length, 1, "并且必须计入 degraded（不是静默保留）");
  assert.equal(withOwnAuth.degraded[0].ref, "lex");

  const withoutOwnAuth = credentialRefs.resolveCredentials(
    { probe: { url: "https://probe.example.test/mcp", credentialRef: "lex" } },
    EMAIL,
  );
  assert.equal(withoutOwnAuth.servers.probe, undefined, "没有自身凭据 ⇒ 省略（保留＝裸调用）");
  assert.equal(withoutOwnAuth.degraded.length, 0);
});

// ── 断言一 / 二 / 四：平台凭据不可用时的组合结果 ──────────────────────────────
test("3.5 平台凭据不可用：该线工具面仍在、自有轨凭据原样保留、其余消费方不受影响", async () => {
  assert.equal(ciyuan.liveToken(EMAIL), null, "前提：这个人没有词元账户键（＝平台通道不可用）");

  const { names, entry } = await writePatch(EMAIL);

  // ① 工具面仍在：lex-http 进了 patch 本身就是「平台挂但线还能被调」。
  const lex = entry("lex-http");
  assert.ok(lex, "平台凭据不可用时，声明了自有轨且配置自带凭据的线必须留在 profile 里");

  // ② 客户级调用成功的前提：自有轨那把凭据原样到了 patch。
  //    注意这里断言的是**具体值**——只断言「headers 存在」会让「被换成平台票」
  //    或「被清空成空对象」两种坏形态都通过。
  assert.equal(lex.config.headers["x-authorization"], "Bearer line-own-pat");
  // 并且**不许伪造平台票**：没有任何平台凭据被解出来时，Authorization 不得凭空出现
  // （那会让线侧收到一张无效票，症状从「降级」变成「401」）。
  assert.equal(lex.config.headers.Authorization, undefined, "无平台凭据时不得注入 Authorization");

  // ③ lex-bare（同一 ref、但配置自身不带凭据）仍须省略：保留一个没有凭据的条目
  //    等于让调用方发裸请求，比省略更糟。这条与 ① 成对——只有两条同时成立，
  //    「保留」才是**有条件**的，而不是「凡声明 ownTrack 就留」。
  assert.equal(names.includes("lex-bare"), false, "没有自有凭据的 lex 行不得被保留");

  // ④ 其他消费方不受影响：legacy ref 行为与改动前一致，无关行一个不丢。
  assert.equal(names.includes("pt-srv"), false, "legacy ref 缺凭据时仍省略（行为不变）");
  assert.equal(names.includes("file-server"), true, "不带 ref 的行不受凭据解析影响");
});

// ── 断言一（反方向）：平台凭据可用时不得降级 ─────────────────────────────────
test("3.5 平台凭据可用：注入平台票，两条 lex 行都在，自有轨那半不被抹掉", async () => {
  const stored = ciyuan.store({ email: EMAIL, token: "sk-degrade-composition-0001" });
  assert.ok(stored, "前提：词元凭据真的存进去了");

  const { names, entry } = await writePatch(EMAIL);

  const lex = entry("lex-http");
  assert.ok(lex);
  // 平台票按 ref 解析出来并注入；这是「平台在时走平台」的那一侧。
  assert.equal(lex.config.headers.Authorization, "Bearer sk-degrade-composition-0001");
  // 自有轨那半不被抹掉——降级只是「没平台时顶上」，不是「有平台就交出去」。
  assert.equal(lex.config.headers["x-authorization"], "Bearer line-own-pat");

  // 同一 ref 下没有自有凭据的那行现在也该在（它有了平台票，不再需要回退）。
  assert.equal(names.includes("lex-bare"), true, "有平台凭据时 lex-bare 应正常注入");
  assert.equal(names.includes("file-server"), true);

  ciyuan.disconnect(EMAIL);
  assert.equal(ciyuan.liveToken(EMAIL), null);
});

// ── 断言三：成员级动作显式失败 ───────────────────────────────────────────────
test("3.5 成员级动作显式失败：key 轨的线被要求成员断言时报类型化错误，不静默无操作", async () => {
  await assert.rejects(
    () => federated.exchangeAssertion({ refName: "lex", email: EMAIL }),
    (err) => {
      assert.equal(err.name, "FederatedAssertionNotConfigured");
      // 原因必须可判：笼统的「失败」会把「这条线根本没有成员轨」读成「兑换坏了」。
      assert.match(err.why, /customer-key track/);
      return true;
    },
  );
});

// 说明一条**没在这里断言**的东西：降级计数（`recordFederatedDegraded`）。
// `dsh-profile.js` 是在 `void import(...).then(...)` 里记账的（fire-and-forget），
// 落库发生在 microtask 之后 ⇒ 在这里 `await writeMcpPatch()` 后立刻读，读到的
// 是「还没写」还是「写了」取决于调度。计数本身已由 `test-federated-ref.mjs`
// 的 3.4 三条直接钉住（按人落库、累加、未知≠0），不值得为了凑齐四条再引入一处
// 时序敏感的断言——**不稳定的闸等于没有闸**。
