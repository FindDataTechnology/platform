#!/usr/bin/env node
// ── 装包闸接线（mcp-injection-budget-residual 2.2）────────────────────────────
//
// `lib/cell-mcp-budget.js` 的算术已有单测（`test-cell-mcp-budget.mjs`），但「判据
// 存在」不等于「判据有调用方」——本仓最贵的一类缺陷就是闸写好了、没人调，或调在
// `installPack` 之后（此时包已落盘，回滚还会留下 skills 根与 catalog 行）。
//
// 所以这里只钉**接线与顺序**，用源码结构而不是跑整个 express app：
//   ① 两个装包入口都必须先过 `mcpBudgetRefusal(manifest)`；
//   ② 它必须在 `packStore.installPack(` **之前**出现；
//   ③ 拒绝必须是 409 + `refusal`，且拒绝报文带上 `details`（数量/上限/新增），
//      否则客户端只能看到一个 500 形状的错误。
//
//   node --test scripts/test-pack-install-budget-gate.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// `PACKS_SRC` 只为红证存在：把门挪到 `installPack` 之后（或整段删掉）的副本指进来，
// 这一组用例必须当场转红。不设它就永远读真正的路由文件。
const srcPath = process.env.PACKS_SRC || path.join(here, "../server/routes/packs.js");
const src = readFileSync(srcPath, "utf8");

const INSTALL_CALL = "packStore.installPack(";
const GATE_CALL = "mcpBudgetRefusal(manifest)";

test("both install paths ask the budget gate before materialising", () => {
  const installAt = [];
  for (let i = src.indexOf(INSTALL_CALL); i !== -1; i = src.indexOf(INSTALL_CALL, i + 1)) installAt.push(i);
  assert.equal(installAt.length, 2, "expected exactly two installPack call sites (/api/mypacks/install + import-bundle)");

  for (const at of installAt) {
    const before = src.slice(Math.max(0, at - 800), at);
    assert.ok(
      before.includes(GATE_CALL),
      `installPack at offset ${at} has no ${GATE_CALL} in the 800 chars before it`,
    );
    assert.ok(
      before.includes("if (refusal) return res.status(409).json(refusal)"),
      `installPack at offset ${at} does not refuse on a gate verdict before writing`,
    );
    // 顺序本身也要断言：门必须在 installPack 之前，不能只是在附近。
    assert.ok(before.lastIndexOf(GATE_CALL) < before.length, "gate call must precede installPack");
  }
});

test("the gate reads the shared budget implementation, not a local constant", () => {
  assert.match(src, /import \{ installBudgetVerdict \} from "\.\.\/\.\.\/lib\/cell-mcp-budget\.js";/);
  assert.match(src, /installBudgetVerdict\(\{/);
  // 上限不许在路由里另抄一份：读面与拒绝报文各说一个数，运维会按错的那个卸包。
  assert.doesNotMatch(src, /CELL_MCP_HARD_LIMIT/, "limits must come from lib/cell-mcp-budget.js, not env re-reads here");
});

test("a gate failure degrades open but never silently", () => {
  assert.match(src, /mcp budget gate degraded/);
});

test("the refusal body names the facts the owner needs", () => {
  const start = src.indexOf("const mcpBudgetRefusal =");
  assert.ok(start !== -1, "mcpBudgetRefusal must exist");
  const body = src.slice(start, src.indexOf("};", start) + 2);
  for (const field of ["count:", "added:", "softLimit:", "hardLimit:"]) {
    assert.ok(body.includes(field), `refusal details must carry ${field}`);
  }
  assert.ok(body.includes('code: "mcp-budget-exceeded"'), "a stable code lets the client render the fix");
});
