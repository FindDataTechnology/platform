#!/usr/bin/env node
// ── Flow board read model (add-task-flow, task 6.1/6.4)
//
// Pure logic, so it runs without a browser. What it pins is the whole point of
// the change in one line: `state === "done"` lands in REVIEW, not DONE. A card
// reaches `done` only through a passing verdict.
//
// Run: node --test web/src/lib/flow-board.test.mjs
// (kept as .mjs with a TS strip so it can ride the repo's node --test habit;
// the module under test is plain logic + type imports, which node strips.)

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "flow-board-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

// The lib is TypeScript. Strip types once with tsc's transpile-only path via
// node's built-in type stripping (node >= 22.6 with --experimental-strip-types)
// — if unavailable, the suite reports that instead of silently passing.
let mod;
try {
  mod = await import(new URL("../web/src/lib/flow-board.ts", import.meta.url));
} catch (err) {
  console.error("cannot load the TS read model:", err.message);
  throw err;
}

const { columnOf, buildBoard, acceptConsequence } = mod;

const card = (over = {}) => ({ id: "c1", prompt: "p", state: null, flow: { flowId: "f", stationId: "s" }, ...over });

test("6.4 the load-bearing mapping: executed-but-unaccepted is REVIEW, not DONE", () => {
  // This is the defect the whole change exists to remove.
  assert.equal(columnOf(card({ state: "done" })), "review");
  assert.equal(columnOf(card({ state: "done", flow: { flowId: "f", stationId: "s", verdict: { outcome: "pass" } } })), "done");
});

test("6.4 created-but-not-dispatched is BACKLOG; dispatched-and-waiting is READY", () => {
  assert.equal(columnOf(card()), "backlog");
  assert.equal(columnOf(card({ flow: { flowId: "f", stationId: "s", dispatchedAt: "2026-01-01T00:00:00Z" } })), "ready");
  assert.equal(columnOf(card({ state: "queued", flow: { flowId: "f", stationId: "s", dispatchedAt: "2026-01-01T00:00:00Z" } })), "ready");
});

test("6.4 running is its own column", () => {
  assert.equal(columnOf(card({ state: "running" })), "running");
});

test("6.4 not_executed is a bypass group, never folded into a column", () => {
  assert.equal(columnOf(card({ state: "skipped" })), "not_executed");
  assert.equal(columnOf(card({ state: "failed" })), "failed");
  assert.equal(columnOf(card({ state: "interrupted" })), "failed");
});

test("6.1 build: blockers are named by title, and an unknown blocker counts as unmet", () => {
  const a = { id: "a", prompt: "写初稿", title: "初稿" };
  const b = { id: "b", prompt: "复核", blockedBy: ["a"] };
  let board = buildBoard({ cards: [a, b] });
  let blockedCard = board.columns.backlog.find((c) => c.id === "b");
  assert.deepEqual(blockedCard.blockedByTitles, ["初稿"], "the blocker is named, not just counted");
  assert.equal(blockedCard.blocked, true);

  // A is finished → B unblocks.
  const aDone = { ...a, flow: { flowId: "f", stationId: "s", verdict: { outcome: "pass" } } };
  board = buildBoard({ cards: [aDone, b] });
  blockedCard = board.columns.done.concat(board.columns.backlog).find((c) => c.id === "b");
  assert.equal(blockedCard.blocked, false);

  // A blocker that vanished does NOT silently unblock: the alternative is a
  // card running ahead of work nobody can see.
  const orphan = { id: "b2", prompt: "x", blockedBy: ["gone"] };
  const board2 = buildBoard({ cards: [orphan] });
  assert.equal(board2.columns.backlog[0].blocked, true);
});

test("6.1 build: queue depth arrives from the engine and unknown stays null", () => {
  // 0 and null are DIFFERENT: "the queue is empty" vs "we could not read it".
  assert.equal(buildBoard({ cards: [], queueDepth: 0 }).queueDepth, 0);
  assert.equal(buildBoard({ cards: [], queueDepth: null }).queueDepth, null);
});

test("6.1 build: every card lands in exactly one place", () => {
  const cards = [
    card({ id: "1" }),
    card({ id: "2", flow: { flowId: "f", stationId: "s", dispatchedAt: "t" } }),
    card({ id: "3", state: "running" }),
    card({ id: "4", state: "done" }),
    card({ id: "5", flow: { flowId: "f", stationId: "s", verdict: { outcome: "pass" } } }),
    card({ id: "6", state: "failed" }),
    card({ id: "7", state: "skipped" }),
  ];
  const b = buildBoard({ cards });
  const all = [...Object.values(b.columns).flat(), ...Object.values(b.bypass).flat()];
  assert.equal(all.length, cards.length, "no card is dropped and none is duplicated");
  assert.deepEqual(b.columns.done.map((c) => c.id), ["5"], "only the ruled card is done");
  assert.deepEqual(b.bypass.not_executed.map((c) => c.id), ["7"]);
});

test("consequence text is derived from the station's own criteria", () => {
  const station = { stationId: "s", acceptance: [
    { id: "m", kind: "artifact-exists", target: "a.md" },
    { id: "j", kind: "llm-judged", rubric: "r" },
  ] };
  const text = acceptConsequence(card(), station);
  assert.ok(text.includes("1 条机器判据"), text);
  assert.ok(text.includes("1 条判据型断言"), text);

  const none = acceptConsequence(card(), { stationId: "s", acceptance: [] });
  // No criteria → the copy must say a human signature is what happens, not
  // imply an automatic pass.
  assert.ok(none.includes("未声明验收判据"), none);
});

test("6.2 an accepted card stops asking to be accepted", () => {
  // Caught on the real board (2026-11-20): accepted cards in Done still showed
  // an Accept button. The page reads this off the verdict, so the mapping must
  // be pinned here — otherwise the button returns the next time the column
  // logic is touched.
  const accepted = card({ state: "done", flow: { flowId: "f", stationId: "s", verdict: { outcome: "pass" } } });
  const unaccepted = card({ state: "done", flow: { flowId: "f", stationId: "s" } });
  assert.equal(columnOf(accepted), "done");
  assert.equal(columnOf(unaccepted), "review");
  // The two are distinguishable by exactly the field the Accept button reads.
  assert.equal(accepted.flow.verdict?.outcome, "pass");
  assert.equal(unaccepted.flow?.verdict ?? null, null);
});
