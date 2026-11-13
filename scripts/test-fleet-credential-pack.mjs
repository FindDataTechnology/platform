#!/usr/bin/env node
// ── 舰队级凭据包（change converge-line-identity-and-keys 4.1）
//
// 4.1 的判据是一句话：**跨三线舰队，属主需要独立填写的次数 ≤3（每门一次）**。
// 所以这里的断言不是"函数能跑"，而是那三个数字必须能对上：
//
//   1. 三条线落在三扇不同的门上 → 3 次；
//   2. 三条线共用门 K 的一把词元钥 → **1 次**（这是"简化"的全部意义）；
//   3. 第三方不能并成一次——chatwoot 的 token 喂不通 registry，把它算一次就是
//      给属主一个假承诺。
//
// 另外两条纪律：
//   - 注册表查不到（`null`）与"本来就不需要凭据"（refName 为空）必须分开列：
//     并成一类，真正的配置错误会看起来像正常情况；
//   - 一处说没连就当没连（宁可多要一次），别让属主填完才发现装不上。
//
//   node --test --test-concurrency=1 scripts/test-fleet-credential-pack.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { planFleetCredentials, DOOR_LABEL } = await import("../server/lib/fleet-credential-pack.js");

//: 一个"注册表"形状：server 名 → 解析结果。照真实装包路径的返回字段命名。
function resolver(table) {
  return (name) => (name in table ? table[name] : null);
}

test("三条线落在三扇不同的门 → 3 次填写，且逐条指明入口", () => {
  const plan = planFleetCredentials({
    packs: [
      { packId: "lex-pack", servers: ["lex-ops-mcp"] },
      { packId: "wire-pack", servers: ["wire-ops-mcp"] },
      { packId: "crm-pack", servers: ["chatwoot"] },
    ],
    resolveServer: resolver({
      "lex-ops-mcp": { refName: "line-lex", door: "third-party", connected: false, missingReason: "连一下识律", connectPath: "/settings/connections?panel=line-lex" },
      "wire-ops-mcp": { refName: "line-wire-customer", door: "third-party", connected: false, missingReason: "连一下柏讯", connectPath: "/settings/connections?panel=line-wire-customer" },
      chatwoot: { refName: "chatwoot", door: "third-party", connected: false, missingReason: "粘贴 Chatwoot token", connectPath: "/settings/connections?panel=chatwoot" },
    }),
  });
  assert.equal(plan.fillsRequired, 3, "跨三线各要自己的第三方凭据 = 3 次");
  assert.equal(plan.satisfied, false);
  assert.deepEqual(plan.fills.map((f) => f.refName).sort(), ["chatwoot", "line-lex", "line-wire-customer"]);
  assert.ok(plan.fills.every((f) => typeof f.connectPath === "string" && f.connectPath.startsWith("/settings/connections")));
  assert.equal(plan.doors.length, 1, "三条线都归第三方，门分组只有一门");
  assert.equal(plan.doors[0].label, DOOR_LABEL["third-party"]);
});

test("三条线共用门 K 的一把词元钥 → 只算 1 次（简化的全部意义）", () => {
  const table = {};
  for (const s of ["lex-ops-mcp", "wire-ops-mcp", "paper-trading-mcp"]) {
    table[s] = { refName: "ciyuan-account", door: "customer-key", connected: false, missingReason: "还没有词元钥", connectPath: "/settings/connections?panel=ciyuan-account" };
  }
  const plan = planFleetCredentials({
    packs: [
      { packId: "lex-pack", servers: ["lex-ops-mcp"] },
      { packId: "wire-pack", servers: ["wire-ops-mcp"] },
      { packId: "pt-pack", servers: ["paper-trading-mcp"] },
    ],
    resolveServer: resolver(table),
  });
  assert.equal(plan.fillsRequired, 1, "一把钥喂三条线，只能要一次");
  assert.equal(plan.fills[0].door, "customer-key");
  assert.deepEqual(plan.fills[0].servers, ["lex-ops-mcp", "paper-trading-mcp", "wire-ops-mcp"]);
  assert.deepEqual(plan.fills[0].packs, ["lex-pack", "pt-pack", "wire-pack"]);
  assert.deepEqual(plan.unclassified, []);
});

test("已连上的凭据不计数；同一 ref 被多个 pack 引用也只算一次", () => {
  const plan = planFleetCredentials({
    packs: [
      { packId: "a", servers: ["shared-search"] },
      { packId: "b", servers: ["shared-search"] },
    ],
    resolveServer: resolver({
      "shared-search": { refName: "search", door: "third-party", connected: true },
    }),
  });
  assert.equal(plan.fillsRequired, 0);
  assert.equal(plan.satisfied, true);
  assert.equal(plan.doors[0].units.length, 1);
  assert.deepEqual(plan.doors[0].units[0].packs, ["a", "b"]);
});

test("一处说没连就当没连（宁可多要一次，不要假承诺）", () => {
  const plan = planFleetCredentials({
    packs: [{ packId: "a", servers: ["s1", "s2"] }],
    resolveServer: (name) =>
      name === "s1"
        ? { refName: "registry", door: "third-party", connected: true }
        : { refName: "registry", door: "third-party", connected: false, missingReason: "缺 token" },
  });
  assert.equal(plan.fillsRequired, 1);
  assert.equal(plan.fills[0].missingReason, "缺 token", "理由取自说没连的那一处");
  assert.equal(plan.doors[0].units[0].connected, false);
});

test("查不到 与 本来不需要凭据 必须分开列", () => {
  const plan = planFleetCredentials({
    packs: [{ packId: "a", servers: ["ghost", "public-fetch"] }],
    resolveServer: (name) => (name === "public-fetch" ? { refName: null, door: null, connected: true } : null),
  });
  assert.deepEqual(plan.unknown, [{ server: "ghost", packId: "a" }]);
  assert.deepEqual(plan.noCredential, [{ server: "public-fetch", packId: "a" }]);
  assert.equal(plan.fillsRequired, 0, "两类都不算填写次数");
});

test("归类表里没有的 ref 被点名，且自成一次填写", () => {
  const plan = planFleetCredentials({
    packs: [{ packId: "a", servers: ["mystery-mcp"] }],
    resolveServer: resolver({
      "mystery-mcp": { refName: "some-new-ref", door: null, connected: false, missingReason: "缺凭据" },
    }),
  });
  assert.deepEqual(plan.unclassified, ["some-new-ref"]);
  assert.equal(plan.fillsRequired, 1, "不知道它和谁共享，就不能替属主假设共享");
  assert.equal(plan.doors.at(-1).label, "未归类");
});

test("空输入不炸，且报成已满足而不是缺一堆", () => {
  const plan = planFleetCredentials({ packs: [], resolveServer: () => null });
  assert.equal(plan.fillsRequired, 0);
  assert.equal(plan.satisfied, true);
  assert.deepEqual(plan.doors, []);
});
