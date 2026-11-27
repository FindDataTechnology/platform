#!/usr/bin/env node
// ── 按门的凭据分组（change converge-line-identity-and-keys 4.2）─────────────
//
// 这一层不做第二个读面：状态由 `/api/connections` 的统一投影独占，本层只归类。
// 所以断言针对的是**归类正确性**，而不是再去读一遍凭据：
//
//   1. 三扇门齐全且顺序固定（从最省事的一把钥到各家自己的）；
//   2. 词元那把钥只出现在门 K，不随吃它的线数量增加；
//   3. 门 A 默认关就必须报 declared/enabled=false（配置事实，不是推断）；
//   4. 分类表覆盖不到的新条目落进 unclassified 并被看见，不会被静默塞进第三方；
//   5. 分组只返回 id 引用，不夹带状态——状态只在一个地方算。
//
//   node --test --test-concurrency=1 scripts/test-credential-doors.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { DOOR_ORDER, DOOR_OF, doorOf, doorOfRef, groupDoors } = await import("../server/lib/credential-doors.js");
const { FEDERATED_LINES } = await import("../federated-ref.js");

//: `/api/connections` 实际会发出的条目 id（读自 misc.js 的构造顺序）。
const LIVE_IDS = [
  "registry",
  "facet-market",
  "connector",
  "line-wire-customer",
  "line-lex",
  "ciyuan-account",
  "paper-trading",
  "chatwoot",
  "search",
];

const asItems = (ids) => ids.map((id) => ({ id, name: id, state: "connected", reason: null }));

test("三扇门齐全且顺序固定", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  assert.deepEqual(g.order, ["customer-key", "member-assertion", "third-party"]);
  assert.deepEqual(g.doors.map((d) => d.id), DOOR_ORDER);
});

test("分类表覆盖 /api/connections 实际发出的每一条", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  assert.deepEqual(g.unclassified, [], `未归类的条目: ${g.unclassified.join(",")}`);
  for (const id of LIVE_IDS) assert.ok(doorOf(id), `${id} 必须在 DOOR_OF 里表态`);
});

test("门 K 只有一把钥，不随消费它的线数量增加", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  const k = g.doors.find((d) => d.id === "customer-key");
  assert.deepEqual(k.connections, ["ciyuan-account"], "多条线吃同一把钥 ≠ 多把钥");
});

test("门 A 默认关：declared/enabled 如实报，不画成可用", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  assert.equal(g.memberAssertion.declared, false, "此刻没有线声明代做");
  assert.equal(g.memberAssertion.enabled, false);
  assert.deepEqual(g.memberAssertion.lines, []);
  // 旧成形但开关没开的线也不能被当成"已声明"：
  const withLines = groupDoors(asItems(LIVE_IDS), {
    lex: { line: "lex", jitPolicy: "off", exchangeUrl: null, enabled: false, ownTrack: "lex-pat" },
  });
  assert.equal(withLines.memberAssertion.declared, false, "jit=off 且无兑换地址 = 没有门 A");
});

test("真声明了代做的线才会进成员门", () => {
  const g = groupDoors(asItems(LIVE_IDS), {
    lex: { line: "lex", jitPolicy: "consent", exchangeUrl: "https://lex.test/api/auth/exchange", enabled: true, ownTrack: "lex-pat" },
  });
  assert.equal(g.memberAssertion.declared, true);
  assert.equal(g.memberAssertion.enabled, true);
  assert.deepEqual(g.memberAssertion.lines, [
    { line: "lex", enabled: true, jitPolicy: "consent", exchangeUrl: "https://lex.test/api/auth/exchange", ownTrack: "lex-pat" },
  ]);
});

test("第三方门收其余自有凭据，词元不在其中", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  const t = g.doors.find((d) => d.id === "third-party");
  for (const id of ["registry", "connector", "chatwoot", "search", "paper-trading"]) {
    assert.ok(t.connections.includes(id), `${id} 属第三方`);
  }
  assert.equal(t.connections.includes("ciyuan-account"), false, "词元不属于第三方门");
});

test("未知条目进 unclassified 而不是被静默塞进第三方", () => {
  const g = groupDoors(asItems([...LIVE_IDS, "brand-new-thing"]), FEDERATED_LINES);
  assert.deepEqual(g.unclassified, ["brand-new-thing"]);
  const t = g.doors.find((d) => d.id === "third-party");
  assert.equal(t.connections.includes("brand-new-thing"), false, "没表态就不许归类");
});

test("分组只带 id 引用，不夹带状态（状态只在一处算）", () => {
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES);
  for (const d of g.doors) {
    for (const c of d.connections) assert.equal(typeof c, "string", "门里只能放 id");
  }
  const blob = JSON.stringify(g);
  assert.equal(/sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{8,}|fdt_[A-Za-z0-9]{8,}/.test(blob), false);
  assert.equal(blob.includes('"state"'), false, "分组不该复制状态");
});

test("分类表本身不含已废弃的面板别名（每条都要能对上真实条目）", () => {
  for (const id of Object.keys(DOOR_OF)) {
    assert.ok(!id.includes(":"), `${id} 看起来是槽位名而不是连接 id`);
  }
});

test("凭据 ref 名与连接条目 id 是两套命名，doorOfRef 负责对齐", () => {
  // 线自有轨在 ref 表里叫 `wire-customer` / `lex`，连接页条目是
  // `line-wire-customer` / `line-lex`。4.1 接舰队凭据包时正是拿 ref 名去查
  // DOOR_OF，结果三条线全被报成"未归类"——所以这条缝要有断言盯着。
  assert.equal(doorOf("wire-customer"), null, "ref 名直接查表本来就查不到");
  assert.equal(doorOfRef("wire-customer"), "third-party");
  assert.equal(doorOfRef("lex"), "third-party");
  // 已经在表里的 id 与共享钥不受影响。
  assert.equal(doorOfRef("registry"), "third-party");
  assert.equal(doorOfRef("ciyuan-account"), "customer-key");
  assert.equal(doorOfRef(""), null);
  assert.equal(doorOfRef(null), null);
});

// ── manifest 那半（5.3 的接线）：`lines` / `unreadableManifests` 的形状 ─────
//
// 为什么这组要单独钉：4.2 的前端（`web/src/components/settings/CredentialDoors.tsx`）
// 现在逐字段读 `doors.lines.customerKey[].{line, effective, tracks[].accepts}`
// 与 `doors.unreadableManifests`，而这两处**服务端是现算的**。形状一变，前端不会
// 报错——它会安静地少显示一行，看起来跟"这条线本来就没声明"完全同形。所以字段名
// 本身就是契约，必须有断言盯着。
//
// 夹具走真实管线（写文件 → loadManifests → groupLinesByDoor），不手搓中间形状：
// 手搓只能证明"我按自己想的形状能算"，证不到生产那条路。

const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const nodePath = await import("node:path");
const { loadManifests, groupLinesByDoor } = await import("../server/lib/line-tracks.js");

/** 两条真清单 + 一份坏清单（渲染成 ConfigMap 那种 `<line>/line-manifest.json` 形状）。 */
function manifestFixture() {
  const root = mkdtempSync(nodePath.join(tmpdir(), "lm-doors-"));
  const write = (dir, doc) => {
    mkdirSync(nodePath.join(root, dir), { recursive: true });
    writeFileSync(nodePath.join(root, dir, "line-manifest.json"), JSON.stringify(doc));
  };
  // alpha：自有轨生效（可独立用），客户钥匙轨**声明了但没生效**。
  write("alpha", {
    line: "alpha",
    auth_tracks: [
      { kind: "line-native", name: "alpha-pat", accepts: "line-native-key", fallback: true, enforced: true },
      { kind: "customer-key", name: "ciyuan-sk", accepts: "ciyuan-sk", fallback: false, enforced: false, migration_task: "chg#1" },
    ],
    identity: { jit_policy: "off" },
  });
  // beta：客户钥匙轨生效，但**没有回退轨** ⇒ 不能独立使用；且声明了代做。
  write("beta", {
    line: "beta",
    auth_tracks: [
      { kind: "customer-key", accepts: "ciyuan-sk", fallback: false, enforced: true },
      { kind: "member-assertion", accepts: "platform-assertion", fallback: false, enforced: true },
    ],
    identity: { jit_policy: "consent" },
  });
  // 坏 JSON：文件在、解析不了 ⇒ 必须进 unreadable，而不是静默当作"没这条线"。
  mkdirSync(nodePath.join(root, "broken"), { recursive: true });
  writeFileSync(nodePath.join(root, "broken", "line-manifest.json"), "{ not json");
  return root;
}

const fromDir = (root) => {
  const m = loadManifests(root);
  return { ...m, ...groupLinesByDoor(m.lines) };
};

test("有清单时 lines.source=manifest，且 customerKey 带齐界面读的字段", () => {
  const root = manifestFixture();
  try {
    const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES, fromDir(root));
    assert.equal(g.lines.source, "manifest");

    const alpha = g.lines.customerKey.find((l) => l.line === "alpha");
    const beta = g.lines.customerKey.find((l) => l.line === "beta");
    assert.ok(alpha && beta, "两条线都声明了客户钥匙轨");
    assert.equal(alpha.effective, false, "enforced:false = 已声明未生效，不许当可用");
    assert.equal(beta.effective, true);
    // 界面逐字段读这几个名字；改名会让它安静地少显示一行。
    assert.deepEqual(Object.keys(alpha.tracks[0]).sort(), [
      "accepts",
      "enforced",
      "fallback",
      "migrationTask",
      "name",
    ]);
    assert.equal(alpha.tracks[0].accepts, "ciyuan-sk");
    assert.equal(alpha.tracks[0].migrationTask, "chg#1");
    // 只有回退轨生效的线才算"能独立用"；beta 声明了客户钥匙却没有回退轨。
    assert.deepEqual(g.lines.notStandalone, ["beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("门 A 由清单表态：jit_policy 非 off 且轨生效才算开", () => {
  const root = manifestFixture();
  try {
    const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES, fromDir(root));
    assert.equal(g.memberAssertion.declared, true);
    assert.equal(g.memberAssertion.enabled, true, "beta 的 jit_policy=consent 且轨生效");
    const beta = g.memberAssertion.lines.find((l) => l.line === "beta");
    assert.equal(beta.enabled, true);
    assert.equal(beta.jitPolicy, "consent");
    assert.equal(
      g.memberAssertion.lines.some((l) => l.line === "alpha"),
      false,
      "jit_policy=off 且无代做轨的线不该出现在门 A 里",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("坏清单进 unreadableManifests 并被透出（不许静默当作没有这条线）", () => {
  const root = manifestFixture();
  try {
    const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES, fromDir(root));
    assert.deepEqual(g.unreadableManifests, [{ dir: "broken", reason: "unreadable" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没有清单目录 ⇒ federated-config，且三个数组为空（旧部署不炸）", () => {
  const empty = { lines: new Map(), ...groupLinesByDoor(new Map()), unreadable: [] };
  const g = groupDoors(asItems(LIVE_IDS), FEDERATED_LINES, empty);
  assert.equal(g.lines.source, "federated-config");
  assert.deepEqual(g.lines.customerKey, []);
  assert.deepEqual(g.lines.ownTracks, []);
  assert.deepEqual(g.lines.notStandalone, []);
  assert.deepEqual(g.unreadableManifests, []);
});
