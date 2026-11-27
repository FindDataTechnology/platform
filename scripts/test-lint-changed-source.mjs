#!/usr/bin/env node
// ── lint-changed judges the pushed bytes (harden-release-line-hygiene) ──────
//
// 事故来源（2026-11-20，`6fe58dc5f`）：推送前闸用 git range 取**文件名**，再把
// 文件名交给 biome —— biome 读的是**工作树**。共用 checkout 上另一个会话已经把
// server.js 在盘上改好了，闸于是读到修好的字节，判绿放行；真正被推上去的是
// 缺 9 个 import 的那份，main 自该提交起起不来（三笔提交后才有人补）。
// 报错原文只有一句「Checked 8 files. No fixes applied.」——和「真的没问题」一模一样。
//
// 同一个文件头的 2026-11-12 agent-runner 事故是同一类：闸判的东西不是推送的东西。
// 本次把它钉死成断言，而不是再写一段注释。
//
//   node --test scripts/test-lint-changed-source.mjs
//
// 判据用真实 git 历史，不造夹具：本仓历史上就有一个「范围里是坏字节、工作树里是
// 好字节」的提交对，用它当红证，比构造一个人造 commit 更难被将来的人绕过。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runGate(range, env = {}) {
  try {
    const out = execFileSync("node", ["scripts/lint-changed.mjs", "--range", range], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// The regression commit and the commit before it. Guarded: a history rewrite
// that drops them must SKIP loudly, not silently pass.
const BAD = "6fe58dc5f"; // shipped server.js calling 9 undeclared identifiers
const BAD_RANGE = `${BAD}~1..${BAD}`;

function hasCommit(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HISTORICAL_CASE_AVAILABLE = hasCommit(BAD);

test("a range whose bytes are broken is red even when the worktree is clean", (t) => {
  if (!HISTORICAL_CASE_AVAILABLE) {
    t.skip(`${BAD} not in this history — the regression fixture is gone, re-anchor it`);
    return;
  }
  const r = runGate(BAD_RANGE);
  assert.notEqual(r.code, 0, "the gate passed a range whose committed bytes do not resolve identifiers");
  assert.match(r.out, /noUndeclaredVariables/, "the red must name the rule that actually broke");
});

test("the red is about the range's bytes, not about the worktree", (t) => {
  // The whole point: the same range judged from the worktree reads the FIXED
  // copy and exits 0. Pinning that difference is what makes the first test mean
  // something — otherwise a gate that is red for an unrelated reason passes it.
  if (!HISTORICAL_CASE_AVAILABLE) {
    t.skip(`${BAD} not in this history`);
    return;
  }
  const worktreeMode = runGate(BAD_RANGE, { LINT_CHANGED_SOURCE: "worktree" });
  assert.equal(worktreeMode.code, 0, "worktree mode is expected to be blind to this defect — that is the bug");
});

test("a clean range stays green", () => {
  // The negative control. Without it, "always red" would satisfy the first test.
  const clean = execFileSync("git", ["rev-list", "-1", "--skip=20", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const r = runGate(`${clean}~1..${clean}`);
  assert.equal(r.code, 0, `a clean range must not be red:\n${r.out.slice(-1500)}`);
});

test("the explicit --files path (CI) still judges the checked-out tree", () => {
  try {
    execFileSync("node", ["scripts/lint-changed.mjs", "--files", "scripts/lint-changed.mjs"], {
      cwd: ROOT,
      stdio: "pipe",
    });
  } catch (err) {
    assert.fail(`--files path must stay green on this file: ${err.stdout ?? ""}${err.stderr ?? ""}`);
  }
});
