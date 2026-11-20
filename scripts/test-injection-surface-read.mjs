#!/usr/bin/env node
// ── 注入面读盘（mcp-injection-budget-residual 1.1/1.2）───────────────────────
//
// 三处消费者共用 `readInjectionSurface()`：profile 写完后的日志行、`/api/ready`
// 的读面、溢出回合的归因快照。它们必须给出**同一组数**——所以这里钉的是「从盘上
// 读出来的数是什么」，不是「日志格式长什么样」（那是 test-injection-surface 的事）。
//
// 钉四件事：
//   A. 数得对（servers / skillRoots / skillBytes，字节只数 SKILL.md 的 size）
//   B. 「patch 不在」与「patch 在但 0 个 server」是两件事（`patchPresent`）
//   C. 卸一个 server / 删一个技能目录 ⇒ 数**当场**下降，不需要重启（1.1 的验收）
//   D. 坏的 YAML 不抛（观测面不该让读面 500）
//
//   node --test scripts/test-injection-surface-read.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "inj-read-"));
const home = path.join(tmpRoot, "dsh");
const profileDir = path.join(home, "profiles", "platform");
const dirs = { dshHome: home, profileName: "platform" };

const { readInjectionSurface } = await import("../dsh-profile.js");

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

const patchPath = path.join(profileDir, "mcp.patch.yml");
const skillsPatchPath = path.join(profileDir, "skills.patch.yml");

/** 写入端真实形状：`- insert: [{ id, name, config: { serverName } }]`。 */
function writeMcpPatch(names) {
  mkdirSync(profileDir, { recursive: true });
  const insert = names.map((n) => ({ id: `mcp-${n}`, name: "@deepseek-ai/dsh-mcp-client", config: { serverName: n } }));
  writeFileSync(patchPath, `- insert:\n${insert.map((e) => `  - ${JSON.stringify(e)}`).join("\n")}\n`);
}

function writeSkillsPatch(roots) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(skillsPatchPath, `- config:\n    customSkillDirs:\n${roots.map((r) => `      - ${r}`).join("\n")}\n`);
}

function skill(root, rel, bytes) {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), "x".repeat(bytes));
}

test("A. reads servers, skill roots and skill bytes from the two patches on disk", () => {
  const skillsRoot = path.join(tmpRoot, "skills");
  skill(skillsRoot, "alpha", 10);
  skill(skillsRoot, "beta", 20);
  writeMcpPatch(["fleet-architect", "fd-open-data-mcp", "actions-mcp"]);
  writeSkillsPatch([skillsRoot]);

  const face = readInjectionSurface(dirs);
  // 形状钉住：三处消费者（日志 / 读面 / 溢出快照）读的就是这几个键，少一个下游就得
  // 自己拼；多一个没人认的键则是谎报能力。
  assert.deepEqual(Object.keys(face).sort(), [
    "patchPresent", "profileDir", "serverNames", "servers", "skillBytes", "skillBytesCapped", "skillRoots",
  ]);
  assert.equal(face.patchPresent, true);
  assert.equal(face.servers, 3);
  assert.deepEqual(face.serverNames, ["fleet-architect", "fd-open-data-mcp", "actions-mcp"]);
  assert.equal(face.skillRoots, 1);
  assert.equal(face.skillBytes, 30, "只数 SKILL.md 的 size：10 + 20");
  assert.equal(face.skillBytesCapped, false);
});

test("B. missing patch is NOT the same as a patch with zero servers", () => {
  const bare = path.join(tmpRoot, "bare-home");
  const face = readInjectionSurface({ dshHome: bare, profileName: "platform" });
  assert.equal(face.patchPresent, false, "文件不在 ⇒ patchPresent=false");
  assert.equal(face.servers, 0);

  // 盘上有一份空 patch ⇒ 合成过、但一个 server 都没有：patchPresent 必须为 true
  const emptyHome = path.join(tmpRoot, "empty-home");
  const emptyProfile = path.join(emptyHome, "profiles", "platform");
  mkdirSync(emptyProfile, { recursive: true });
  writeFileSync(path.join(emptyProfile, "mcp.patch.yml"), "[]\n");
  const empty = readInjectionSurface({ dshHome: emptyHome, profileName: "platform" });
  assert.equal(empty.servers, 0);
  assert.equal(empty.patchPresent, true, "「合成过且为空」与「还没合成过」要分得开");
});

test("C. uninstalling a server / removing a skill lowers the numbers immediately (no restart)", () => {
  const skillsRoot = path.join(tmpRoot, "skills2");
  skill(skillsRoot, "gamma", 7);
  skill(skillsRoot, "delta", 3);
  writeMcpPatch(["a", "b"]);
  writeSkillsPatch([skillsRoot]);

  const before = readInjectionSurface(dirs);
  assert.equal(before.servers, 2);
  assert.equal(before.skillBytes, 10);

  // 「卸载一个包」在盘上的形状：patch 少一行、技能目录少一个
  writeMcpPatch(["a"]);
  rmSync(path.join(skillsRoot, "delta"), { recursive: true, force: true });

  const after = readInjectionSurface(dirs);
  assert.equal(after.servers, 1, "server 数当场下降");
  assert.equal(after.skillBytes, 7, "技能字节当场下降（不重启、不清缓存）");
});

test("C2. SKILL.md deeper than the depth cap is not counted (the walk is bounded)", () => {
  const deepRoot = path.join(tmpRoot, "deep");
  skill(deepRoot, "ok", 5); // root/ok/SKILL.md —— depth 2，算
  skill(deepRoot, "a/b/c/d", 100); // depth 6，不算
  writeSkillsPatch([deepRoot]);
  const face = readInjectionSurface(dirs);
  assert.equal(face.skillBytes, 5, "深度上限之外的不数：读面不能被一棵大树拖死");
});

test("D. a garbled patch never throws — it reports what it could read", () => {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(patchPath, "this: [is: not: a patch\n");
  const face = readInjectionSurface(dirs);
  assert.equal(face.servers, 0);
  assert.equal(face.patchPresent, false, "解析不了就不算「读到过 patch」");
});
