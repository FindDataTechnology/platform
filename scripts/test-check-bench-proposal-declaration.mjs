// ── `check-bench-proposal-declaration.mjs` 的守门测试 ────────────────────────
//
// 这道闸守的是 change `bind-bench-proposal-identity-to-credential` 的 D2/③：
// 「同一时刻至多一份 pack 声明 bench 提案面」。它必须能被 CI 跑到，因为
// 违反这条的后果是**静默的**：第二支舰队以第一支的名义落提案，服务端还会把 source
// 强制成那支——比自述身份更隐蔽，没有任何错误行。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  declaringPacks,
  judge,
  packIdOf,
  serverNames,
} from "./check-bench-proposal-declaration.mjs";

const SERVERS = ["bench-proposal"];

test("声明面识别认两种形状：裸字符串与 {registryName}", () => {
  const bare = { P: { mcpServers: ["bench-proposal"] } };
  const obj = { P: { mcpServers: [{ registryName: "bench-proposal", allowTools: [] }] } };
  assert.deepEqual(serverNames(obj.P), ["bench-proposal"]);
  assert.deepEqual(declaringPacks(bare, SERVERS), declaringPacks(obj, SERVERS));
  assert.deepEqual(Object.keys(declaringPacks(bare, SERVERS)), ["P"]);
});

test("没挂该面的 pack 不算声明方（0 份＝空集合，不是「唯一」）", () => {
  const snap = { A: { mcpServers: ["wire-ops"] }, B: { mcpServers: [] } };
  assert.deepEqual(declaringPacks(snap, SERVERS), {});
});

test("packIdOf 认 source_template 文本、对象与 packId 直给，解析不出返回 null", () => {
  assert.equal(packIdOf({ source_template: '{"packId":"P1","version":2}' }), "P1");
  assert.equal(packIdOf({ source_template: { packId: "P2" } }), "P2");
  assert.equal(packIdOf({ packId: "P3" }), "P3");
  assert.equal(packIdOf({ source_template: "not-json" }), null);
  assert.equal(packIdOf({ source_template: null }), null);
});

test("绿：唯一声明方，且令牌就是它的那支舰队", () => {
  const { findings, undecided } = judge({
    snapshot: { P1: { mcpServers: ["bench-proposal"] } },
    fleets: [{ id: "f1", source_template: '{"packId":"P1"}' }],
    servers: SERVERS,
    authenticatedFleetRef: "f1",
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(undecided, []);
});

test("红 J1：两份 pack 声明同一个面", () => {
  const { findings } = judge({
    snapshot: {
      P1: { mcpServers: ["bench-proposal"] },
      P2: { mcpServers: ["bench-proposal"] },
    },
    fleets: [{ id: "f1", source_template: '{"packId":"P1"}' }],
    servers: SERVERS,
    authenticatedFleetRef: "f1",
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /J1/);
  assert.match(findings[0], /P1/);
  assert.match(findings[0], /P2/);
});

test("红 J2：令牌属于另一支舰队", () => {
  const { findings } = judge({
    snapshot: { P1: { mcpServers: ["bench-proposal"] } },
    fleets: [
      { id: "f1", source_template: '{"packId":"P1"}' },
      { id: "f2", source_template: '{"packId":"OTHER"}' },
    ],
    servers: SERVERS,
    authenticatedFleetRef: "f2",
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0], /J2/);
  assert.match(findings[0], /f2/);
});

test("判不出：快照为空 / 没有舰队表 / 声明方无舰队 / 没有令牌", () => {
  const okSnap = { P1: { mcpServers: ["bench-proposal"] } };
  const fleet = [{ id: "f1", source_template: '{"packId":"P1"}' }];
  const cases = [
    { snapshot: {}, fleets: fleet, servers: SERVERS, authenticatedFleetRef: "f1" },
    { snapshot: okSnap, fleets: null, servers: SERVERS, authenticatedFleetRef: "f1" },
    {
      snapshot: { P9: { mcpServers: ["bench-proposal"] } },
      fleets: fleet,
      servers: SERVERS,
      authenticatedFleetRef: "f1",
    },
    { snapshot: okSnap, fleets: fleet, servers: SERVERS, authenticatedFleetRef: null },
  ];
  for (const c of cases) {
    const r = judge(c);
    assert.deepEqual(r.findings, [], "这几档都不该报命中，否则会把「判不出」伪装成结论");
    assert.equal(r.undecided.length, 1);
  }
});
