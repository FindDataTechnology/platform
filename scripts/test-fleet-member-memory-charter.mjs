// 逐岗记忆章程的读面（enrich-fleet-template-member-config 3.2）。
//
// 要钉的是三件容易各自「看起来对」的事：
//   1. 读面读的是**真正生效的那一份**（`entry.memory.guidance`，与
//      `catalogEntryPersona` 注入 persona 的同一来源），不是包根的 `memory` 段。
//   2. 没声明就是 null，不是空串、不是包根策略——「未声明」必须能被前端区分出来。
//   3. 非 persona 岗（a2a/cluster/tool/bot）没有章程这个概念，读 null 而不是报错。
//
// Run: node --test scripts/test-fleet-member-memory-charter.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const { memoryCharterForTest } = await import("../server/routes/fleets.js");

test("persona 岗：读出生效章程（与注入 persona 同源）", () => {
  const entry = { id: "p1", name: "岗一", memory: { guidance: "  本岗只记报数摘要  " } };
  const g = memoryCharterForTest({ targetKind: "persona", targetId: "p1" }, { chatAgentEntries: [entry] });
  assert.equal(g, "本岗只记报数摘要"); // trimmed
});

test("未声明章程 ⇒ null（不是空串，也不是包根策略）", () => {
  const entry = { id: "p2", name: "岗二", packId: "P" }; // 无 memory
  assert.equal(memoryCharterForTest({ targetKind: "persona", targetId: "p2" }, { chatAgentEntries: [entry] }), null);
  const blank = { id: "p3", memory: { guidance: "   " } };
  assert.equal(memoryCharterForTest({ targetKind: "persona", targetId: "p3" }, { chatAgentEntries: [blank] }), null);
});

test("目标不在 catalog ⇒ null（不编造）", () => {
  assert.equal(memoryCharterForTest({ targetKind: "persona", targetId: "missing" }, { chatAgentEntries: [] }), null);
});

test("非 persona 岗没有章程这个概念 ⇒ null", () => {
  for (const kind of ["a2a", "cluster", "tool", "bot"]) {
    assert.equal(memoryCharterForTest({ targetKind: kind, targetId: "x" }, { chatAgentEntries: [] }), null, kind);
  }
});

test("审计官是受约束的 persona，章程照样读得出", () => {
  const entry = { id: "aud", memory: { guidance: "只判证据自足、gold 独立、反例集" } };
  const g = memoryCharterForTest({ targetKind: "auditor", targetId: "aud" }, { chatAgentEntries: [entry] });
  assert.equal(g, "只判证据自足、gold 独立、反例集");
});
