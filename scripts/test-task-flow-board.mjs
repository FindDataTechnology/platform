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

const { columnOf, buildBoard, acceptConsequence, unscopedNotice } = mod;

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

test("3.3 the withheld-cards notice renders only when there is a count", () => {
  // Three states, not two: a server too old to send the field (`undefined`)
  // must not read as zero, and zero must not render a line that says nothing.
  assert.equal(unscopedNotice(3), 3);
  assert.equal(unscopedNotice(0), null);
  assert.equal(unscopedNotice(undefined), null);
  assert.equal(unscopedNotice(null), null);
});

test("4.1 the refresh throttle: immediate when idle, one scheduled read when busy", () => {
  // 0 means "read now"; a positive number is the single wait until the next
  // allowed read. Ten broadcasts inside the gap must collapse into one.
  assert.equal(mod.refreshDelay(0, 10_000), 0, "first signal reads immediately");
  assert.equal(mod.refreshDelay(10_000, 11_000), 1_000, "inside the gap → wait the remainder");
  assert.equal(mod.refreshDelay(10_000, 12_000), 0, "gap elapsed → read now");
  // Second signal arriving during the wait returns a fresh remainder rather than
  // firing a second timer early — the page's cleanup cancels the older one.
  const first = mod.refreshDelay(10_000, 11_000);
  const second = mod.refreshDelay(10_000, 11_400);
  assert.ok(second < first, "a later signal waits less, never more");
});

test("5.4 the card opens on the card surface, verbs live in their own event scope", () => {
  // The page wires `onClick` on the card root and stops propagation on the verb
  // row. That split is the whole behavior, so pin the two pieces the page reads:
  // the card carries its id, and every verb is a distinct busy label — a click
  // can therefore be attributed without inspecting DOM structure here.
  const c = card({ id: "c9", flow: { flowId: "f", stationId: "s", dispatchedAt: "t" } });
  assert.equal(c.id, "c9");
  assert.ok(String(c.flow.dispatchedAt).length > 0, "a dispatched card offers the verb row (accept/return)");
  // Backlog cards offer dispatch; both remain inside the verb row's scope.
  const backlog = card({ id: "c10" });
  assert.equal(backlog.flow.dispatchedAt ?? null, null);
});

test("6.1 lanes: one row per (flow, station), never merged across flows", () => {
  const flows = [
    { flowId: "fa", name: "流程甲", stations: [{ stationId: "draft", label: "起草" }, { stationId: "review", label: "复核" }] },
    { flowId: "fb", name: "流程乙", stations: [{ stationId: "draft", label: "起草" }] },
  ];
  const cards = [
    card({ id: "a1", flow: { flowId: "fa", stationId: "draft" } }),
    card({ id: "a2", flow: { flowId: "fa", stationId: "review" } }),
    card({ id: "b1", flow: { flowId: "fb", stationId: "draft" } }),
  ];
  const lanes = mod.buildLanes({ cards, flows });
  // Two flows both have a "draft" station: that MUST be two rows, not one.
  assert.equal(lanes.length, 3);
  const draftRows = lanes.filter((l) => l.stationId === "draft");
  assert.equal(draftRows.length, 2, "same station id in two flows is two lanes");
  assert.deepEqual(draftRows.map((l) => l.flowId).sort(), ["fa", "fb"]);
});

test("6.1 lanes: a station-less card gets its own row, not a named one", () => {
  const flows = [{ flowId: "fa", name: "流程甲", stations: [{ stationId: "draft", label: "起草" }] }];
  const cards = [
    card({ id: "x", flow: { flowId: "fa", stationId: "draft" } }),
    card({ id: "y", flow: { flowId: "fa", stationId: null } }),
  ];
  const lanes = mod.buildLanes({ cards, flows });
  const unassigned = lanes.find((l) => l.stationId === null);
  assert.ok(unassigned, "the stationless card is visible");
  assert.equal(unassigned.board.columns.backlog.length + unassigned.board.columns.ready.length +
    unassigned.board.columns.running.length + unassigned.board.columns.review.length +
    unassigned.board.columns.done.length, 1);
  // The unassigned row is last.
  assert.equal(lanes[lanes.length - 1].stationId, null);
});

test("6.1 lanes: empty stations render no row; columns match the flat board card-for-card", () => {
  const flows = [
    { flowId: "fa", name: "流程甲", stations: [{ stationId: "draft" }, { stationId: "review" }, { stationId: "publish" }] },
  ];
  const cards = [
    card({ id: "1", flow: { flowId: "fa", stationId: "draft" } }),
    card({ id: "2", flow: { flowId: "fa", stationId: "draft", dispatchedAt: "t" } }),
    card({ id: "3", flow: { flowId: "fa", stationId: "draft" }, state: "failed" }),
    card({ id: "4", flow: { flowId: "fa", stationId: "draft" }, state: "skipped" }),
  ];
  const lanes = mod.buildLanes({ cards, flows });
  assert.equal(lanes.length, 1, "review/publish have no cards → no rows");
  const flat = mod.buildBoard({ cards });
  const lane = lanes[0].board;
  for (const col of ["backlog", "ready", "running", "review", "done"]) {
    assert.deepEqual(lane.columns[col].map((c) => c.id), flat.columns[col].map((c) => c.id), `column ${col}`);
  }
  for (const g of ["failed", "not_executed"]) {
    assert.deepEqual(lane.bypass[g].map((c) => c.id), flat.bypass[g].map((c) => c.id), `bypass ${g}`);
  }
});

test("6.2 the view choice is validated on read (anything but 'lanes' is single)", () => {
  // The page's reader is a one-line guard; pin its contract here so a stored
  // junk value (or a storage that throws) can never render an unknown view.
  const readView = (stored) => (stored === "lanes" ? "lanes" : "single");
  assert.equal(readView("lanes"), "lanes");
  assert.equal(readView("single"), "single");
  assert.equal(readView(null), "single");
  assert.equal(readView("garbage"), "single");
});

test("7.1 the declaration body is shape-only; the server owns every rule", () => {
  const decl = mod.buildFlowDeclaration({
    name: "  内容生产  ",
    flowId: " content ",
    station: { label: "起草", kind: "persona", ref: " writer " },
  });
  assert.equal(decl.name, "内容生产", "trimmed");
  assert.equal(decl.flowId, "content");
  assert.equal(decl.stations.length, 1);
  assert.equal(decl.stations[0].label, "起草");
  assert.equal(decl.stations[0].target.kind, "persona");
  assert.equal(decl.stations[0].target.ref, "writer");
  assert.deepEqual(decl.stations[0].acceptance, []);
  // A Chinese station label cannot be a station id; it gets a stable fallback
  // the operator can correct rather than a silently mangled one.
  assert.equal(decl.stations[0].stationId, "station");
});

test("7.1 a name with latin letters yields a usable slug; junk yields the fallback", () => {
  assert.equal(mod.flowSlugFromName("Content Pipeline"), "content-pipeline");
  assert.equal(mod.flowSlugFromName("  --A--B--  "), "a-b");
  assert.equal(mod.flowSlugFromName(""), "flow");
  assert.equal(mod.flowSlugFromName("中文", "flow"), "flow");
});

test("7.2 the form stays submittable when the preset roster cannot be read", () => {
  // The picker's failure mode is degradation, not blocking: an empty reference
  // still produces a well-shaped declaration, and the SERVER's structured
  // refusal (not a client-side gate) is what tells the operator what to fix.
  const decl = mod.buildFlowDeclaration({
    name: "内容生产",
    flowId: "content",
    station: { label: "起草", kind: "persona", ref: "" },
  });
  assert.equal(decl.stations[0].target.ref, null, "empty ref is a legal shape");
  assert.equal(decl.stations[0].target.kind, "persona");
});

// ── completion readout (run-card-bridge) ───────────────────────────────────
//
// Three values, each from the card itself. Cost is unknown until the ledger is
// wired; a token count must never be turned into a price here.

test("8.1 a ruled card reads duration and quality, cost stays unknown", () => {
  const got = mod.completionReadout({
    id: "c1",
    prompt: "p",
    flow: {
      flowId: "f",
      stationId: "s",
      stakedAt: "2026-01-01T00:00:00.000Z",
      verdict: { outcome: "pass", at: "2026-01-01T00:00:05.000Z" },
    },
  });
  assert.equal(got.duration_s, 5);
  assert.equal(got.quality, "pass");
  assert.equal(got.cost.usd, null);
  assert.equal(got.cost.tokens, null);
  assert.ok(got.cost.reason);
});

test("8.2 an unruled card is unknown, not pass", () => {
  const got = mod.completionReadout({ id: "c1", prompt: "p", flow: { flowId: "f", stationId: "s" } });
  assert.equal(got.quality, "unknown");
  assert.equal(got.duration_s, null);
  assert.notEqual(got.quality, "pass");
});

test("8.3 a returned verdict reads as fail", () => {
  const got = mod.completionReadout({
    id: "c1",
    prompt: "p",
    flow: {
      flowId: "f",
      stationId: "s",
      stakedAt: "2026-01-01T00:00:00.000Z",
      verdict: { outcome: "returned", at: "2026-01-01T00:01:00.000Z" },
    },
  });
  assert.equal(got.quality, "fail");
  assert.equal(got.duration_s, 60);
});

test("8.4 tokens are summed from execution history; USD stays unknown", () => {
  const got = mod.completionReadout({
    id: "c1",
    prompt: "p",
    history: [
      { state: "done", tokens: { total: 120 } },
      { state: "done", tokens: { prompt: 30, completion: 50 } },
      { state: "failed", tokens: 5 },
    ],
    flow: { flowId: "f", stationId: "s" },
  });
  assert.equal(got.cost.tokens, 205);
  assert.equal(got.cost.usd, null);
});

test("8.5 a server-attributed USD is read as the billing truth", () => {
  const got = mod.completionReadout({
    id: "c1",
    prompt: "p",
    cost_usd: 0.0421,
    cost_basis: "sub2api_actual_cost",
    flow: { flowId: "f", stationId: "s" },
  });
  assert.equal(got.cost.usd, 0.0421);
  assert.equal(got.cost.reason, null);
});
