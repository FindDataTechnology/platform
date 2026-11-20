// Voice routing priority (openspec: add-voice-routing, group 1 + 2).
//
// The matrix is the deliverable: three signals, and a cell for each combination
// saying which one wins and why. Written as a table so a reader can check the
// product decision without reading an implementation.
//
// The two properties that matter beyond "it picks something":
//   • short-circuit — a higher path never lets a lower one add a recipient, so
//     one utterance cannot wake four teams and bill them all;
//   • no guessing — `anonymous` attribution ends in `needs_confirmation`, never
//     in a broadcast to the room.
//
//   node --test scripts/test-voice-routing-priority.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const {
  summarizeRouteDecisions,
  decideAddressee,
  matchMentions,
  namesFor,
  teamCallable,
  allowsMultipleAnswers,
  ROUTE_BASIS,
  ROUTE_PRIORITY,
} = await import("../gateway/zhiyu/voice-router.js");

// The room used across the matrix: three members, one team each, plus a fourth
// team that is listed but at its daily ceiling.
const teams = [
  { id: "t-zhang", ref: "zhang/finance", display: "财务团队", names: ["财务团队", "finance"], ownerMemberId: "m-zhang", tags: ["预算", "报销"], visible: true, callable: true },
  { id: "t-li", ref: "li/plan", display: "排期团队", names: ["排期团队", "plan"], ownerMemberId: "m-li", tags: ["排期", "进度"], visible: true, callable: true },
  { id: "t-wang", ref: "wang/data", display: "数据团队", names: ["数据团队", "data"], ownerMemberId: "m-wang", tags: ["数据"], visible: true, callable: true },
  { id: "t-full", ref: "full/team", display: "满额团队", names: ["满额团队"], ownerMemberId: "m-full", tags: ["预算"], visible: true, callable: false, reason: "quota_exceeded" },
  { id: "t-hidden", ref: "hidden/team", display: "未上架团队", names: ["未上架团队"], ownerMemberId: "m-hidden", tags: ["排期"], visible: false, callable: true },
];
const seats = [
  { id: "s-zhang", kind: "agent", display: "张三", names: ["张三"], teamId: "t-zhang" },
  { id: "s-li", kind: "agent", display: "李四", names: ["李四"], teamId: "t-li" },
  { id: "s-wang", kind: "agent", display: "王五", names: ["王五"], teamId: "t-wang" },
  { id: "s-front", kind: "agent", display: "前台", names: ["前台"] },
];

const decide = (over = {}) =>
  decideAddressee({ utterance: "", attribution: null, roomTeams: teams, roomSeats: seats, roomPolicy: {}, ...over });

// ── 1.1 the priority matrix ────────────────────────────────────────────────

test("1.1 mention beats attribution and intent", () => {
  const d = decide({
    utterance: "@李四 预算怎么样",
    attribution: { certainty: "bound", memberId: "m-zhang" },
  });
  assert.equal(d.basis, "mention");
  // The named seat stands for its team; the attribution's team is NOT added.
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-li"]);
});

test("1.1 attribution beats intent when nothing is named", () => {
  const d = decide({
    utterance: "预算怎么样",
    attribution: { certainty: "bound", memberId: "m-zhang" },
  });
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-zhang"]);
  // 「预算」also matches 满额团队's tag, but that team cannot be called anyway.
  assert.equal(d.recipients.some((r) => r.id === "t-full"), false);
});

test("1.1 intent is the last resort and only sees callable teams", () => {
  const d = decide({ utterance: "预算和排期都想听一下", attribution: null });
  assert.equal(d.basis, "intent");
  assert.deepEqual(d.recipients.map((r) => r.id).sort(), ["t-li", "t-zhang"]);
});

test("1.1 with nothing to go on, the legacy broadcast is preserved", () => {
  // `attribution: null` = the attribution lane is not in play (a typed message).
  // That is deliberately different from `certainty: "anonymous"` (we looked and
  // could not tell), which asks instead of broadcasting.
  const d = decide({ utterance: "大家看一下", attribution: null });
  assert.equal(d.basis, "broadcast");
  assert.deepEqual(
    d.recipients.map((r) => r.id),
    seats.map((s) => s.id),
  );
});

test("1.1 a known speaker with no team here still broadcasts — and says why", () => {
  // The message has a home in the room even though it has no owner: routing it
  // to nobody would drop it, which is the one thing 2.2 forbids.
  const d = decide({ utterance: "大家看一下", attribution: { certainty: "session", memberId: "m-nobody" } });
  assert.equal(d.basis, "broadcast");
  assert.match(d.reason, /没有自己的团队/);
});

test("1.1 every basis the decider can return is a declared value", () => {
  const cases = [
    decide({ utterance: "@李四 预算" }),
    decide({ utterance: "预算", attribution: { certainty: "bound", memberId: "m-zhang" } }),
    decide({ utterance: "预算" }),
    decide({ utterance: "大家看看", attribution: { certainty: "session", memberId: "m-nobody" } }),
    decide({ utterance: "嗯", attribution: { certainty: "anonymous" } }),
  ].map((d) => d.basis);
  for (const basis of cases) assert.ok(ROUTE_BASIS.includes(basis), `undeclared basis ${basis}`);
  assert.deepEqual([...new Set(cases)].sort(), [...ROUTE_BASIS].filter((b) => cases.includes(b)).sort());
});

// ── 1.2 short-circuit ──────────────────────────────────────────────────────

test("1.2 all three signals available: candidates hold ONLY the named branch", () => {
  const d = decide({
    utterance: "@李四 预算和排期",
    attribution: { certainty: "bound", memberId: "m-zhang" },
  });
  assert.equal(d.basis, "mention");
  assert.deepEqual(
    d.candidates.map((c) => c.id),
    ["t-li"],
    "a lower path must not widen a resolved higher one",
  );
  // The intent words are in the utterance, and they change nothing.
  assert.equal(d.recipients.length, 1);
});

test("1.2 an attribution hit keeps intent matches out of candidates", () => {
  const d = decide({ utterance: "预算和排期", attribution: { certainty: "session", memberId: "m-zhang" } });
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.candidates.map((c) => c.id), ["t-zhang"]);
});

// ── 1.3 purity ─────────────────────────────────────────────────────────────

test("1.3 the decider reads no DB and writes nothing", () => {
  // No store, no db, no clock is passed in — and it still decides. If this file
  // ever reaches for the store, this test is where the reach shows up.
  const d = decide({ utterance: "预算" });
  assert.equal(d.basis, "intent");
  // Same input, same output, three times: no hidden state.
  const thrice = [0, 1, 2].map(() => JSON.stringify(decide({ utterance: "预算" }).recipients.map((r) => r.id)));
  assert.equal(new Set(thrice).size, 1);
});

// ── 2.1 the @ lexer is the room's lexer ────────────────────────────────────

test("2.1 the lexer matches the existing samples verbatim", () => {
  // These strings are lifted from scripts/test-zhiyu-router.mjs, so 「同一份用例」
  // is literal: the same utterances the room already handles.
  const roster = [
    { id: "s-deep", kind: "agent", display: "DeepResearch", names: ["DeepResearch"] },
    { id: "s-slow", kind: "agent", display: "Slow", names: ["Slow"] },
    { id: "s-c", kind: "facade", display: "C 的分身", names: ["C 的分身"] },
  ];
  const samples = [
    ["@DeepResearch 这个数据怎么看", ["s-deep"]],
    ["@Slow 第一个问题", ["s-slow"]],
    ["@DeepResearch 在吗", ["s-deep"]],
    ["@C 的分身 你也说", ["s-c"]],
    // Case-insensitive, as the room router has always been.
    ["@deepresearch 怎么看", ["s-deep"]],
    // Full-width punctuation after the name still matches (substring rule).
    ["@DeepResearch，你看下", ["s-deep"]],
    ["没有点名的消息", []],
    ["邮件 @ 符号但不是点名", []],
  ];
  for (const [text, expected] of samples) {
    assert.deepEqual(
      matchMentions(text, roster).map((m) => m.id),
      expected,
      `mismatch for ${JSON.stringify(text)}`,
    );
  }
});

test("2.1 namesFor splits display and alias on , and / like the router", () => {
  assert.deepEqual(namesFor({ display: "张三,小张", alias: "zhang/ZS" }), ["张三", "小张", "zhang", "ZS"]);
  assert.deepEqual(namesFor({ display: "前台" }), ["前台"]);
  assert.deepEqual(namesFor({}), []);
});

test("2.1 a mention may name a team directly", () => {
  const d = decide({ utterance: "@财务团队 看一下这个", attribution: null });
  assert.equal(d.basis, "mention");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-zhang"]);
});

// ── 2.2 default recipient ──────────────────────────────────────────────────

test("2.2 a member with no team of their own falls through to intent, not to silence", () => {
  const d = decide({ utterance: "排期要往后挪", attribution: { certainty: "bound", memberId: "m-front" } });
  assert.equal(d.basis, "intent", "the message must still find a home");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-li"]);
});

test("2.2 a member whose only team is at its ceiling also falls through, and says why", () => {
  const d = decide({ utterance: "随便说点什么", attribution: { certainty: "bound", memberId: "m-full" } });
  assert.equal(d.basis, "needs_confirmation");
  assert.match(d.reason, /不可调/);
  assert.deepEqual(d.recipients, []);
});

test("2.2 session and bound both take the default path; anonymous never does", () => {
  for (const certainty of ["session", "bound"]) {
    assert.equal(decide({ utterance: "预算", attribution: { certainty, memberId: "m-zhang" } }).basis, "attribution");
  }
  assert.equal(decide({ utterance: "预算", attribution: { certainty: "anonymous", memberId: "m-zhang" } }).basis, "intent");
});

// ── 2.3 intent narrowing ───────────────────────────────────────────────────

test("2.3 a team outside the room's visible set is never chosen", () => {
  // 「排期」matches both 排期团队 (visible) and 未上架团队 (hidden).
  const d = decide({ utterance: "排期怎么安排", attribution: null });
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-li"]);
  assert.equal(d.recipients.some((r) => r.id === "t-hidden"), false);
});

test("2.3 a team at its daily ceiling is never chosen", () => {
  const d = decide({ utterance: "预算", attribution: null });
  assert.equal(d.basis, "intent");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-zhang"], "满额团队 matches the tag but is at its ceiling");
});

test("2.3 teamCallable keeps visibility and callability as separate reasons", () => {
  assert.deepEqual(teamCallable({ visible: false, callable: true }), { ok: false, because: "not_visible" });
  assert.deepEqual(teamCallable({ visible: true, callable: false, reason: "quota_exceeded" }), { ok: false, because: "quota_exceeded" });
  assert.deepEqual(teamCallable({ visible: true, callable: true, quotaExceeded: true }), { ok: false, because: "quota_exceeded" });
  assert.deepEqual(teamCallable({ visible: true, callable: true }), { ok: true, because: null });
  assert.deepEqual(teamCallable(null), { ok: false, because: "not_found" });
});

test("2.3 naming a team that cannot be called is a refusal with a reason, not a broadcast", () => {
  const d = decide({ utterance: "@满额团队 预算" });
  assert.equal(d.basis, "needs_confirmation");
  assert.deepEqual(d.recipients, []);
  assert.match(d.reason, /不可调/);
  assert.deepEqual(d.blocked, [{ id: "t-full", because: "quota_exceeded" }]);
});

// ── 2.4 uncertain attribution ──────────────────────────────────────────────

test("2.4 anonymous attribution with no other signal never broadcasts", () => {
  const d = decide({ utterance: "嗯……那个……", attribution: { certainty: "anonymous" } });
  assert.equal(d.basis, "needs_confirmation");
  assert.deepEqual(d.recipients, []);
  assert.match(d.reason, /归属不确定/);
});

test("2.4 anonymous + a named target is still honoured (the human spoke)", () => {
  // Uncertainty about WHO spoke says nothing about who was asked for.
  const d = decide({ utterance: "@王五 你来说", attribution: { certainty: "anonymous" } });
  assert.equal(d.basis, "mention");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-wang"]);
});

test("2.4 anonymous + intent still narrows: an anonymous speaker may still have a topic", () => {
  const d = decide({ utterance: "数据这块谁看", attribution: { certainty: "anonymous" } });
  assert.equal(d.basis, "intent");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-wang"]);
});

// ── 3.4 meeting mode ───────────────────────────────────────────────────────

test("3.4 meeting mode asks exactly one team for an inferred match", () => {
  const d = decide({ utterance: "预算和排期", roomPolicy: { meetingMode: true } });
  assert.equal(d.basis, "intent");
  assert.equal(d.recipients.length, 1, "one meeting question, one answer");
  assert.deepEqual(d.candidates.length, 2, "the others are recorded as considered, not called");
  assert.equal(allowsMultipleAnswers({ basis: "intent", recipients: d.recipients, roomPolicy: { meetingMode: true } }), true);
});

test("3.4 meeting mode still allows several answers when several were named", () => {
  const d = decide({ utterance: "@张三 @李四 都说说", roomPolicy: { meetingMode: true } });
  assert.equal(d.basis, "mention");
  assert.deepEqual(d.recipients.map((r) => r.id).sort(), ["t-li", "t-zhang"]);
  assert.equal(allowsMultipleAnswers({ basis: d.basis, recipients: d.recipients, roomPolicy: { meetingMode: true } }), true);
});

test("3.4 outside meeting mode nothing changes: an intent match may reach several", () => {
  const d = decide({ utterance: "预算和排期" });
  assert.equal(d.recipients.length, 2);
  assert.equal(allowsMultipleAnswers({ basis: d.basis, recipients: d.recipients, roomPolicy: {} }), true);
});

test("3.4 an inferred multi-match without meeting mode is the pre-existing behaviour", () => {
  // Baseline for the flag: the same input, flag off, must match what the room
  // did before this change (broadcast-equivalent reach), not silently narrow.
  const off = decide({ utterance: "预算和排期", roomPolicy: { meetingMode: false } });
  const absent = decide({ utterance: "预算和排期" });
  assert.deepEqual(off.recipients.map((r) => r.id), absent.recipients.map((r) => r.id));
});

// ── ordering discipline ────────────────────────────────────────────────────

test("the declared priority order matches what the function actually does", () => {
  assert.deepEqual([...ROUTE_PRIORITY], ["mention", "attribution", "intent"]);
  // A quick ladder: strip signals from the top and watch the basis descend.
  const full = decide({ utterance: "@李四 预算", attribution: { certainty: "bound", memberId: "m-zhang" } });
  const noMention = decide({ utterance: "预算", attribution: { certainty: "bound", memberId: "m-zhang" } });
  const noAttribution = decide({ utterance: "预算" });
  assert.deepEqual([full.basis, noMention.basis, noAttribution.basis], ["mention", "attribution", "intent"]);
});

test("an empty utterance with no attribution asks rather than spamming the room", () => {
  const d = decide({ utterance: "", attribution: { certainty: "anonymous" } });
  assert.equal(d.recipients.length, 0);
  assert.equal(d.basis, "needs_confirmation");
});

// ── 6.2 the readings off the trail ─────────────────────────────────────────

test("6.2 the trail summary counts decisions by basis and both correction rates", () => {
  const rows = [
    { seq: 4, meta: { event: "route_decision", kind: "mention" } },
    { seq: 6, meta: { event: "route_decision", kind: "attribution" } },
    { seq: 9, meta: { event: "route_decision", kind: "intent" } },
    { seq: 12, meta: { event: "route_decision", kind: "needs_confirmation" } },
    { seq: 14, meta: { event: "route_reassigned", to: ["x"] } },
    { seq: 16, meta: { event: "route_cancelled", skipped: 2 } },
    { seq: 18, meta: { event: "pass" } },
    { seq: 20, kind: "human" },
  ];
  const out = summarizeRouteDecisions(rows);
  assert.equal(out.decisions, 4);
  assert.equal(out.byBasis.mention, 1);
  assert.equal(out.byBasis.attribution, 1);
  assert.equal(out.byBasis.intent, 1);
  assert.equal(out.byBasis.needs_confirmation, 1);
  assert.equal(out.reassigned, 1);
  assert.equal(out.cancelled, 1);
  assert.equal(out.reassignRate, 0.25);
  assert.equal(out.cancelRate, 0.25);
  assert.equal(out.needsConfirmationRate, 0.25);
  // The summary must not present a proxy as a measurement.
  assert.match(out.note, /代理/);
});

test("6.2 an empty trail reads as zeros, not NaN", () => {
  const out = summarizeRouteDecisions([]);
  assert.equal(out.decisions, 0);
  assert.equal(out.reassignRate, 0);
  assert.equal(out.cancelRate, 0);
  assert.equal(out.needsConfirmationRate, 0);
  assert.deepEqual(out.byBasis, { mention: 0, attribution: 0, intent: 0, broadcast: 0, needs_confirmation: 0 });
});

// ── 6.1 the surface actually renders what the router writes ───────────────

test("6.1 the room page registers the routing events — otherwise the trail is write-only", () => {
  const page = fs.readFileSync(path.resolve(import.meta.dirname, "..", "web/src/pages/ZhiyuRoomPage.tsx"), "utf8");
  // The page filters event rows through EVENT_LABEL_KEYS; a key missing from it
  // means the row is written and then silently dropped. Assert against the SET
  // BODY only: the same words appear in the render branch and in testids, so a
  // whole-file match would pass even with the whitelist entry deleted (that is
  // exactly the假绿 this assertion was written to avoid).
  const setBody = /const EVENT_LABEL_KEYS = new Set\(\[([\s\S]*?)\]\);/.exec(page)?.[1] ?? "";
  assert.notEqual(setBody, "", "EVENT_LABEL_KEYS literal not found");
  for (const key of ["route_decision", "route_cancelled", "route_reassigned"]) {
    assert.match(setBody, new RegExp(`"${key}"`), `${key} must be in EVENT_LABEL_KEYS`);
  }
  assert.match(page, /zy-route-cancel-/, "an undo entry exists");
  assert.match(page, /zy-route-reassign-/, "a reassign entry exists");
  assert.match(page, /zy-event-route_decision-/, "the decision row is rendered, not filtered away");
});

test("6.1 all four bases have their own sentence in every locale", () => {
  for (const lang of ["zh-CN", "en", "ja", "fr", "es"]) {
    const json = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "..", `web/src/locales/${lang}/common.json`), "utf8"),
    );
    const block = json.zhiyu?.event?.route_decision;
    assert.ok(block, `${lang}: zhiyu.event.route_decision missing`);
    for (const basis of ["mention", "attribution", "intent", "needs_confirmation"]) {
      assert.equal(typeof block[basis], "string", `${lang}: ${basis} missing`);
      assert.notEqual(block[basis].trim(), "", `${lang}: ${basis} is blank`);
    }
    assert.equal(typeof json.zhiyu.event.route_cancelled, "string", `${lang}: route_cancelled missing`);
    assert.equal(typeof json.zhiyu.event.route_reassigned, "string", `${lang}: route_reassigned missing`);
    assert.equal(typeof json.zhiyu.event.route_action?.cancel, "string", `${lang}: route_action.cancel missing`);
  }
});
