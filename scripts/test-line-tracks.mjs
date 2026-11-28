#!/usr/bin/env node
// ── 从 manifest 读"这条线走哪几扇门"（change converge-line-identity-and-keys 5.3）
//
// 5.3 的判据是一句话：**新增一条线只需改 manifest，平台侧 grep 不到新的硬编码
// ref 名**。所以本文件的断言不是"解析器能跑"，而是：
//
//   1. 形状照真实 manifest（`auth_tracks[].kind/accepts/enforced/migration_task`
//      + `identity.jit_policy`），不是照设计稿猜的；
//   2. `enforced:false` 的轨只算"已声明未生效"——声明 ≠ 生效；
//   3. 缺目录 = 空（还没人投放），坏文件 = unreadable（读失败），两者不同形；
//   4. 加一条线只新增一份 manifest，分组里就多一条线——不用改任何表；
//   5. 不能独立使用的线要点名（`notStandalone`），子线承诺靠它验收。
//
//   node --test --test-concurrency=1 scripts/test-line-tracks.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { doorsForManifest, groupLinesByDoor, loadManifests } = await import("../server/lib/line-tracks.js");
const { groupDoors } = await import("../server/lib/credential-doors.js");

const tmpRoot = mkdtempSync(path.join(tmpdir(), "line-tracks-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

//: 真实 lex manifest 的形状（照抄字段名与取值，不发明新字段）。
const LEX_MANIFEST = {
  schema: "line-manifest/v1",
  line: "lex",
  public_base_url: "https://lex.finddatatech.cloud",
  identity: { issuer: "https://auth.finddatatech.cloud/oidc", jwks_uri: "https://auth.finddatatech.cloud/oidc/jwks", jit_policy: "off" },
  auth_tracks: [
    { kind: "line-native", name: "lex-pat", accepts: "line-native-key", fallback: true },
    { kind: "customer-key", accepts: "ciyuan-sk", fallback: false, enforced: false, migration_task: "converge-line-identity-and-keys#8.2" },
  ],
  scopes: ["line:read", "line:write"],
  billing: { plane: "ciyuan" },
  surfaces: { mcp: true, account: true, admin: false },
};

function writeLine(root, line, doc, name = line) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "line-manifest.json"), JSON.stringify(doc));
  return dir;
}

test("真实形状解析：客户钥匙已声明但未生效，自有轨可回退且生效", () => {
  const info = doorsForManifest(LEX_MANIFEST);
  assert.equal(info.line, "lex");
  assert.equal(info.customerKey.length, 1);
  assert.equal(info.customerKey[0].accepts, "ciyuan-sk");
  assert.equal(info.customerKey[0].enforced, false, "enforced:false 必须如实传成未生效");
  assert.equal(info.customerKey[0].migrationTask, "converge-line-identity-and-keys#8.2");
  assert.equal(info.ownTracks.length, 1);
  assert.equal(info.ownTracks[0].name, "lex-pat");
  assert.equal(info.ownTracks[0].fallback, true);
  assert.equal(info.standalone, true, "有 fallback 且生效的自有轨 = 这条线能单独用");
  assert.equal(info.assertion, null, "jit_policy=off 时门 A 不该被声明");
});

test("jit_policy 非 off 才算声明门 A", () => {
  const on = doorsForManifest({ ...LEX_MANIFEST, identity: { ...LEX_MANIFEST.identity, jit_policy: "consent" } });
  assert.ok(on.assertion, "consent 档必须被识别为已声明");
  assert.equal(on.assertion.jitPolicy, "consent");
  assert.equal(on.assertion.enforced, false, "没有 member 轨时不算已生效");
});

test("jit_policy=off 时，一条 member 轨**不等于**门 A 开启（2026-11-14 线上实历）", () => {
  // 这条补的是一个真实回归：`fd-find-data-business-mcp` 的清单写着
  // `jit_policy: "off"`（明确拒绝平台代做），同时声明了一条 `member-assertion /
  // logto-jwt` 轨（本线自己做 Logto JWT 鉴权）且**没写 `enforced`**。
  // 旧口径把「有没有 member 轨」当成了「这扇门开没开」，加上 `isEnforced` 是
  // `!== false`（缺省即生效），于是 `/api/connections` 报
  // `memberAssertion.enabled = true`、设置页把门 A 画成已开启。
  // 判据两边都要钉：**声明仍在**（轨是真的，别把它藏起来），**生效必须是假**。
  const info = doorsForManifest({
    ...LEX_MANIFEST,
    line: "finddata-business",
    identity: { ...LEX_MANIFEST.identity, jit_policy: "off" },
    auth_tracks: [
      { kind: "line-native", name: "fdbiz-internal-token", fallback: true },
      { kind: "member-assertion", name: "logto-jwt", fallback: true },
    ],
  });
  assert.ok(info.assertion, "有 member 轨就该被声明出来（不许静默丢掉）");
  assert.equal(info.assertion.jitPolicy, "off");
  assert.equal(info.assertion.tracks.length, 1);
  assert.equal(
    info.assertion.enforced,
    false,
    "jit_policy=off ⇒ 这扇门没开，哪怕轨自己没写 enforced",
  );
});

test("jit_policy 非 off 且 member 轨生效，门 A 才算开启", () => {
  const info = doorsForManifest({
    ...LEX_MANIFEST,
    identity: { ...LEX_MANIFEST.identity, jit_policy: "consent" },
    auth_tracks: [{ kind: "member-assertion", name: "assertion-jwt" }],
  });
  assert.equal(info.assertion.enforced, true, "两半都满足才生效");
  const off = doorsForManifest({
    ...LEX_MANIFEST,
    identity: { ...LEX_MANIFEST.identity, jit_policy: "consent" },
    auth_tracks: [{ kind: "member-assertion", name: "assertion-jwt", enforced: false }],
  });
  assert.equal(off.assertion.enforced, false, "轨显式写 enforced:false 也不能算生效");
});

test("内部上游地址：只认 http(s)、去尾斜杠、带凭据的一律 null（gateway-line-key-exchange 1.2）", () => {
  // 网关那条换票转发车道靠它取目标。三条边界都必须硬：缺/坏 ⇒ null（网关回
  // 503 upstream_unresolved，不猜地址）；尾斜杠去掉（否则拼路径会成 //mcp）；
  // 带 user:pass 的一律拒——这个字段会随 /.well-known 公开投影对外可见。
  const base = (value) =>
    doorsForManifest({ ...LEX_MANIFEST, internal_base_url: value })?.internalBaseUrl;

  assert.equal(base("http://10.43.255.8:8000"), "http://10.43.255.8:8000");
  assert.equal(base("http://10.43.255.8:8000/"), "http://10.43.255.8:8000", "尾斜杠要去");
  assert.equal(base("https://fd-wire-api.fd-prod.svc.cluster.local:8000"), "https://fd-wire-api.fd-prod.svc.cluster.local:8000");
  assert.equal(base(undefined), null, "没声明 = null，不是猜一个默认值");
  assert.equal(base(""), null);
  assert.equal(base("   "), null);
  assert.equal(base("ftp://10.0.0.1"), null, "非 http(s) 拒");
  assert.equal(base("not-a-url"), null);
  assert.equal(base("http://user:pw@10.0.0.1:8000"), null, "带凭据的 URL 拒（会公开可见）");
  assert.equal(base(123), null, "非字符串拒");
});

test("未知 kind 被看见而不是被悄悄丢掉", () => {
  const info = doorsForManifest({
    ...LEX_MANIFEST,
    auth_tracks: [{ kind: "brand-new-track", accepts: "x" }],
  });
  assert.deepEqual(info.unknownKinds, ["brand-new-track"]);
  assert.equal(info.customerKey.length, 0);
  assert.equal(info.ownTracks.length, 0);
});

test("缺目录 = 空；坏文件 = unreadable；两者不同形", () => {
  const empty = loadManifests(path.join(tmpRoot, "does-not-exist"));
  assert.deepEqual([...empty.lines.keys()], []);
  assert.deepEqual(empty.unreadable, [], "没投放 manifest 不是读失败");

  const badRoot = path.join(tmpRoot, "bad");
  const dir = path.join(badRoot, "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "line-manifest.json"), "{ not json");
  const broken = loadManifests(badRoot);
  assert.deepEqual(broken.unreadable.map((r) => r.dir), ["broken"], "坏文件必须点名");
  assert.deepEqual([...broken.lines.keys()], []);
});

test("新增一条线只需多加一份 manifest——分组里多一条，不改任何表", () => {
  const root = path.join(tmpRoot, "two-lines");
  writeLine(root, "lex", LEX_MANIFEST);
  writeLine(root, "paper-trading", {
    schema: "line-manifest/v1",
    line: "paper-trading",
    identity: { issuer: "https://auth.finddatatech.cloud/oidc", jit_policy: "off" },
    auth_tracks: [{ kind: "line-native", name: "fdt-token", accepts: "fdt-token", fallback: true }],
    billing: { plane: "none" },
    surfaces: { mcp: true },
  });

  const loaded = loadManifests(root);
  assert.deepEqual([...loaded.lines.keys()].sort(), ["lex", "paper-trading"]);
  const grouped = groupLinesByDoor(loaded.lines);

  // 两条线都在，且都不需要平台改表：
  assert.deepEqual(grouped.customerKey.map((l) => l.line), ["lex"]);
  assert.deepEqual(grouped.ownTracks.map((l) => l.line).sort(), ["lex", "paper-trading"]);
  // lex 的客户钥匙尚未生效 → effective:false（声明 ≠ 生效）。
  assert.equal(grouped.customerKey[0].effective, false);
  assert.deepEqual(grouped.notStandalone, [], "两条线都有可用的自有轨");

  // 接进 4.2 的分组：manifest 在场时 source 必须是 manifest，不是配置表。
  const doors = groupDoors([{ id: "ciyuan-account" }], {}, { ...loaded, ...grouped });
  assert.equal(doors.lines.source, "manifest");
  assert.deepEqual(doors.lines.customerKey.map((l) => l.line), ["lex"]);
  assert.equal(doors.memberAssertion.declared, false, "两条线都没声明代做");
});

test("没有 manifest 时退回联邦配置，行为与旧版一致", () => {
  const doors = groupDoors([{ id: "ciyuan-account" }], {
    lex: { line: "lex", jitPolicy: "consent", exchangeUrl: "https://lex.test/x", enabled: true, ownTrack: "lex-pat" },
  });
  assert.equal(doors.lines.source, "federated-config");
  assert.equal(doors.memberAssertion.declared, true, "旧路径照旧从联邦配置读");
  assert.equal(doors.memberAssertion.enabled, true);
});

test("只有自有轨、没有 fallback 的线进 notStandalone", () => {
  const root = path.join(tmpRoot, "no-fallback");
  writeLine(root, "orphan", {
    schema: "line-manifest/v1",
    line: "orphan",
    identity: { jit_policy: "off" },
    auth_tracks: [{ kind: "line-native", name: "odk", accepts: "odk", fallback: false }],
  });
  const grouped = groupLinesByDoor(loadManifests(root).lines);
  assert.deepEqual(grouped.notStandalone, ["orphan"], "没有可回退的轨 = 子线还不能独立用");
});

test("符号链接目录也认（ConfigMap 挂载是 ..data 链接，别把已部署读成没部署）", () => {
  const root = path.join(tmpRoot, "symlinked");
  const real = path.join(tmpRoot, "real-line");
  mkdirSync(root, { recursive: true });
  mkdirSync(real, { recursive: true });
  writeFileSync(path.join(real, "line-manifest.json"), JSON.stringify(LEX_MANIFEST));
  symlinkSync(real, path.join(root, "lex-via-link"));

  const loaded = loadManifests(root);
  assert.deepEqual([...loaded.lines.keys()], ["lex"], "链过去的目录必须被读到");
  assert.deepEqual(loaded.unreadable, []);
});
