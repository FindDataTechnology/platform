#!/usr/bin/env node
// ── federated-ref 测试（change converge-line-identity-and-keys，任务 3.1）─────
//
// 判据三条，全部围绕「开关关闭时行为与现状逐字节一致」：
//   1. 默认关：entries() 空，REFS 与改动前同一组键（不多不少）；
//   2. 开全局 + 开某线：该线以同形五件套出现，keyToken 走词元账户键；
//   3. 门 A（assertion）未配置时抛类型化错误，不返回 null 冒充「没凭据」。
//
//   node --test --test-concurrency=1 scripts/test-federated-ref.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "federated-ref-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
delete process.env.FEDERATED_REF_ENABLED;

// db 的建表发生在 initDb()（模块加载本身不建），必须先初始化再落 token。
const db = await import("../db.js");
await db.initDb();

const federated = await import("../federated-ref.js");
const credentialRefs = await import("../credential-refs.js");
const ciyuan = await import("../ciyuan-account-credentials.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// 基线键集：改动前 REFS 里的 8 条（手写模块）。联邦轨默认不参与。
const LEGACY_REFS = [
  "registry", "connector", "facet-market", "paper-trading",
  "wire-customer", "lex", "wanxing-caller", "chatwoot",
];

test("默认关闭：entries 为空", () => {
  assert.deepEqual(federated.entries(), []);
  assert.equal(federated.globalEnabled({}), false);
  assert.match(federated.degradedReason("lex", {}), /global switch off/);
});

test("默认关闭：REFS 键集与改动前一致（不多不少）", () => {
  for (const name of LEGACY_REFS) {
    assert.equal(credentialRefs.knownRef(name), true, `${name} 应仍在册`);
  }
  assert.equal(federated.entries().length, 0);
});

test("全局开但线未开：仍不参与，degradedReason 指明是哪一层关的", () => {
  const env = { FEDERATED_REF_ENABLED: "1" };
  assert.equal(federated.isEnabled("lex", env), false);
  assert.equal(federated.degradedReason("lex", env), "line switch off");
  assert.deepEqual(federated.entries(env), []);
});

test("未知线：degradedReason 如实报 not a federated line", () => {
  assert.equal(federated.degradedReason("nope", { FEDERATED_REF_ENABLED: "1" }), "not a federated line");
});

test("两层都开：该线以同形五件套出现，key 轨解析到词元账户键", () => {
  const cfg = federated.FEDERATED_LINES.lex;
  const before = cfg.enabled;
  cfg.enabled = true;
  try {
    const env = { FEDERATED_REF_ENABLED: "1" };
    const entries = federated.entries(env);
    assert.equal(entries.length, 1);
    const entry = entries[0];
    // 五件套同形
    assert.equal(entry.refName, "lex");
    assert.equal(typeof entry.isRef, "function");
    assert.equal(typeof entry.liveToken, "function");
    assert.equal(typeof entry.markInvalid, "function");
    assert.equal(typeof entry.staleEvent, "string");
    assert.equal(entry.isRef({ credentialRef: "lex" }), true);
    assert.equal(entry.isRef({ credentialRef: "other" }), false);
    // 未绑定词元账户时：无 token，且 connected=false（不是"已连接"）
    assert.equal(entry.liveToken("nobody@example.com"), null);
    assert.equal(entry.connected("nobody@example.com"), false);
    // 绑定后同一把 key 生效
    ciyuan.store({ email: "u@example.com", token: "sk-live-123", keyName: "k" });
    assert.equal(entry.liveToken("u@example.com"), "sk-live-123");
    assert.equal(entry.connected("u@example.com"), true);
  } finally {
    cfg.enabled = before;
  }
});

test("两层都开：REFS 会自动多出该行（表驱动，不新增模块）", async () => {
  const cfg = federated.FEDERATED_LINES.lex;
  const before = cfg.enabled;
  cfg.enabled = true;
  process.env.FEDERATED_REF_ENABLED = "1";
  try {
    // REFS 在模块加载时构建，故重新导入一次拿新表
    const fresh = await import(`../credential-refs.js?federated=1`);
    assert.equal(fresh.knownRef("lex"), true);
    assert.equal(fresh.credentialRefForEntry({ credentialRef: "lex" }), "lex");
  } finally {
    cfg.enabled = before;
    delete process.env.FEDERATED_REF_ENABLED;
  }
});

test("门 A 未配置：抛类型化错误，不返回 null", async () => {
  await assert.rejects(
    () => federated.exchangeAssertion({ refName: "lex", email: "u@example.com", scope: "line:write" }),
    (err) => {
      assert.equal(err.name, "FederatedAssertionNotConfigured");
      assert.equal(err.refName, "lex");
      return true;
    },
  );
});

test("门 A 对未知线同样报错，且 reason 可区分", async () => {
  await assert.rejects(
    () => federated.exchangeAssertion({ refName: "nope" }),
    (err) => err.name === "FederatedAssertionNotConfigured" && /not a federated line/.test(err.why),
  );
});

// ── D5：缺平台凭据时的降级语义（任务 3.3 / 3.4）──────────────────────────────

test("D5 未声明自有轨的 ref：缺凭据仍删除（与改动前一致）", () => {
  // 任一 legacy ref（这里用 paper-trading，绝不带 hasOwnTrack）在无 token 时
  // 必须照旧被省略——这是"开关关闭/未迁移的线行为不变"的守门断言。
  const servers = { "pt-srv": { credentialRef: "paper-trading", headers: { Authorization: "Bearer own" } } };
  const { servers: out, omitted, degraded } = credentialRefs.resolveCredentials(servers, "nobody@example.com");
  assert.equal(out["pt-srv"], undefined, "legacy ref 不得因配置自带 Authorization 而被保留");
  assert.equal(omitted.length, 1);
  assert.equal(degraded.length, 0);
});

test("D5 声明自有轨且配置自带凭据：保留并计入 degraded", async () => {
  const cfg = federated.FEDERATED_LINES.lex;
  const before = cfg.enabled;
  cfg.enabled = true;
  process.env.FEDERATED_REF_ENABLED = "1";
  try {
    // REFS 是模块加载时构建的快照：开关翻转要重新加载才生效（=按线灰度重启生效）
    const fresh = await import(`../credential-refs.js?d5-keep=1`);
    const servers = { "lex-ops": { credentialRef: "lex", headers: { "x-authorization": "Bearer line-own" } } };
    const { servers: out, omitted, degraded } = fresh.resolveCredentials(servers, "nobody@example.com");
    assert.ok(out["lex-ops"], "线自有轨在，server 应保留");
    assert.equal(omitted.length, 0);
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].ref, "lex");
  } finally {
    cfg.enabled = before;
    delete process.env.FEDERATED_REF_ENABLED;
  }
});

test("D5 声明自有轨但配置无任何凭据：仍删除（绝不发裸调用）", async () => {
  const cfg = federated.FEDERATED_LINES.lex;
  const before = cfg.enabled;
  cfg.enabled = true;
  process.env.FEDERATED_REF_ENABLED = "1";
  try {
    const fresh = await import(`../credential-refs.js?d5-drop=1`);
    const servers = { "lex-ops": { credentialRef: "lex" } };
    const { servers: out, omitted, degraded } = fresh.resolveCredentials(servers, "nobody@example.com");
    assert.equal(out["lex-ops"], undefined, "没有自身凭据时保留等于裸调用");
    assert.equal(omitted.length, 1);
    assert.equal(degraded.length, 0);
  } finally {
    cfg.enabled = before;
    delete process.env.FEDERATED_REF_ENABLED;
  }
});

test("3.4 降级计数按人落库且累加（滚版不清零）", () => {
  const email = "deg@example.com";
  const a = federated.recordFederatedDegraded("lex", { servers: 2, email, now: new Date("2026-11-11T00:00:00Z") });
  assert.equal(a.count, 2);
  const b = federated.recordFederatedDegraded("lex", { servers: 3, email, now: new Date("2026-11-11T01:00:00Z") });
  assert.equal(b.count, 5, "第二次应在既有计数上累加，而不是覆盖");
  const row = federated.federatedDegradedStats({ email }).find((r) => r.ref === "lex");
  assert.equal(row.count, 5);
  assert.equal(row.lastAt, "2026-11-11T01:00:00.000Z");
});

test("3.4 降级是 (人, 线) 的属性：A 的降级不出现在 B 的视图里", () => {
  federated.recordFederatedDegraded("lex", { servers: 1, email: "a@example.com" });
  federated.recordFederatedDegraded("wire-customer", { servers: 1, email: "b@example.com" });
  const a = federated.federatedDegradedStats({ email: "a@example.com" }).map((r) => r.ref);
  const b = federated.federatedDegradedStats({ email: "b@example.com" }).map((r) => r.ref);
  assert.deepEqual(a, ["lex"]);
  assert.deepEqual(b, ["wire-customer"]);
});

test("3.4 未记账的 (人, 线) 不出现在 stats 里（未知 ≠ 0）", () => {
  const stats = federated.federatedDegradedStats({ email: "nobody-recorded@example.com" });
  assert.deepEqual(stats, []);
});

test("3.2 两条线各一行：开两行→两条同形条目，各自的自有轨与 ref 名不串", () => {
  const lex = federated.FEDERATED_LINES.lex;
  const wire = federated.FEDERATED_LINES["wire-customer"];
  const before = [lex.enabled, wire.enabled];
  lex.enabled = true;
  wire.enabled = true;
  try {
    const env = { FEDERATED_REF_ENABLED: "1" };
    const entries = federated.entries(env);
    assert.equal(entries.length, 2);

    const byName = Object.fromEntries(entries.map((e) => [e.refName, e]));
    assert.deepEqual(Object.keys(byName).sort(), ["lex", "wire-customer"]);

    // 两行由同一个工厂生成：形状逐项一致（除配置差异）
    for (const name of ["lex", "wire-customer"]) {
      const e = byName[name];
      assert.equal(typeof e.isRef, "function");
      assert.equal(typeof e.liveToken, "function");
      assert.equal(typeof e.markInvalid, "function");
      assert.equal(e.staleEvent, "line_credential_stale");
      assert.equal(e.federated, true);
      assert.equal(e.hasOwnTrack, true);
    }

    // 自有轨按线不同：lex PAT vs wdk- 数据面 key
    assert.equal(lex.ownTrack, "lex-pat");
    assert.equal(wire.ownTrack, "wdk");
    assert.equal(wire.line, "wire");

    // isRef 只认自己的 ref 名（不许一条线认领另一条的配置）
    assert.equal(byName.lex.isRef({ credentialRef: "lex" }), true);
    assert.equal(byName.lex.isRef({ credentialRef: "wire-customer" }), false);
    assert.equal(byName["wire-customer"].isRef({ credentialRef: "wire-customer" }), true);
    assert.equal(byName["wire-customer"].isRef({ credentialRef: "lex" }), false);

    // 同一把词元钥匙同时喂两条线（这就是「一把钥匙跨线」的最小证据）
    ciyuan.store({ email: "both@example.com", token: "sk-both-xyz", keyName: "k2" });
    assert.equal(byName.lex.liveToken("both@example.com"), "sk-both-xyz");
    assert.equal(byName["wire-customer"].liveToken("both@example.com"), "sk-both-xyz");
  } finally {
    lex.enabled = before[0];
    wire.enabled = before[1];
  }
});

test("3.2 只开 wire-customer：lex 不跟着参与（按线开关互不牵连）", () => {
  const wire = federated.FEDERATED_LINES["wire-customer"];
  const before = wire.enabled;
  wire.enabled = true;
  try {
    const entries = federated.entries({ FEDERATED_REF_ENABLED: "1" });
    assert.deepEqual(entries.map((e) => e.refName), ["wire-customer"]);
    assert.equal(federated.isEnabled("lex", { FEDERATED_REF_ENABLED: "1" }), false);
  } finally {
    wire.enabled = before;
  }
});
