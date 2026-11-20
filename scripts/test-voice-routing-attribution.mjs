// add-speaker-attribution (tasks 5.1–5.3, consumer side): the routing matrix.
//
// The producer (`voice-attribution.js`) hands one `attribution` value to
// `decideAddressee`; this file pins the four combinations the task names plus
// the two safety properties around them. It deliberately drives the REAL
// router rather than a stand-in: the claim being tested is that the consumer
// needed no rewrite, so anything that fails here is the consumer disagreeing
// with the producer, which is exactly the drift worth catching.
//
// Scope note: this is the CONTRACT between attribution and the router. The
// production call site (a `voiceRoute` implementation in gateway/index.js) is
// blocked on two facts this worktree cannot establish — see tasks.md 3.x/5.1.
//
//   node --test scripts/test-voice-routing-attribution.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { attributeStreams, toRouterAttribution } from "../gateway/zhiyu/voice-attribution.js";
import { decideAddressee, ATTRIBUTION_CERTAIN } from "../gateway/zhiyu/voice-router.js";

const TEAMS = [
  { id: "t-li", display: "李四的团队", ownerMemberId: "m-li", tags: ["finance"], visible: true, callable: true },
  { id: "t-wang", display: "王五的团队", ownerMemberId: "m-wang", tags: ["legal"], visible: true, callable: true },
];
const SEATS = [{ id: "seat-li", display: "李四", names: ["李四"] }];

const attributionOf = (stream, mode = "per_stream") =>
  toRouterAttribution(attributeStreams({ mode, streams: [stream] })[0]);

const route = (utterance, attribution, extra = {}) =>
  decideAddressee({ utterance, attribution, roomTeams: TEAMS, roomSeats: SEATS, ...extra });

// ── 5.1 the four combinations ───────────────────────────────────────────────

test("① mention + 归属：点名赢，即使归属指向另一个人", async () => {
  const d = route("预算怎么样 @李四", attributionOf({ streamId: "s1", declaredMemberId: "m-wang" }));
  assert.equal(d.basis, "mention");
  assert.deepEqual(d.recipients.map((r) => r.id), ["seat-li"]);
});

test("② 无 mention + 可信归属（session）：派给该人的团队", async () => {
  const d = route("预算怎么样", attributionOf({ streamId: "s1", declaredMemberId: "m-li" }));
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-li"]);
  assert.match(d.reason, /session/);
});

test("②b 无 mention + 可信归属（bound）：同样派给该人的团队", async () => {
  const d = route("预算怎么样", attributionOf({ streamId: "s1", seatOwnerMemberId: "m-wang" }));
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-wang"]);
});

test("③ 无 mention + 匿名：落 needs_confirmation，即使意图能匹配到团队", async () => {
  // 「预算」命中李四团队的 finance 标签——这正是「用意图补足归属」的诱惑。
  const d = route("预算怎么样", attributionOf({ streamId: "s2" }));
  assert.equal(d.basis, "needs_confirmation", "不确定的归属不允许被意图路径顶掉");
  assert.deepEqual(d.recipients, []);
  assert.ok(d.reason.length > 0);
});

test("③b 混录（单路麦）走同一条路：needs_confirmation，不是按开口的人派发", async () => {
  const d = route("预算怎么样", attributionOf({ streamId: "room-mic", declaredMemberId: "m-li" }, "mixed"));
  assert.equal(d.basis, "needs_confirmation");
  assert.deepEqual(d.recipients, []);
});

test("④ 归属与意图冲突：归属赢，意图不扩大候选集", async () => {
  // 说话人是李四（归属 m-li），但话里带 legal 关键词（王五团队的标签）。
  const d = route("legal 条款怎么样", attributionOf({ streamId: "s1", declaredMemberId: "m-li" }));
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.recipients.map((r) => r.id), ["t-li"], "四个 agent 被叫醒是会议里最贵的一种错");
  assert.deepEqual(d.candidates.map((r) => r.id), ["t-li"], "候选集不得事后扩大");
});

test("归属可信但该成员的团队当前不可调：仍然问人，不退化成广播", async () => {
  const gated = [
    { id: "t-li", display: "李四的团队", ownerMemberId: "m-li", tags: [], visible: true, callable: false, reason: "quota_exceeded" },
    { id: "t-wang", display: "王五的团队", ownerMemberId: "m-wang", tags: ["finance"], visible: true, callable: true },
  ];
  const d = decideAddressee({
    utterance: "预算怎么样",
    attribution: attributionOf({ streamId: "s1", declaredMemberId: "m-li" }),
    roomTeams: gated,
    roomSeats: [],
  });
  assert.equal(d.basis, "needs_confirmation");
  assert.deepEqual(d.recipients, [], "不能把李四的话拿去花王五的额度");
});

// ── 5.2 attribution is a routing signal only ───────────────────────────────

test("归属不进权限/计费/可见性：决定对象只有四个字段，且不可见团队不会因归属变成可调", async () => {
  const hidden = [
    { id: "t-li", display: "李四的团队", ownerMemberId: "m-li", tags: [], visible: false, callable: true },
  ];
  const withAttr = decideAddressee({
    utterance: "预算怎么样",
    attribution: attributionOf({ streamId: "s1", declaredMemberId: "m-li" }),
    roomTeams: hidden,
    roomSeats: [],
  });
  const withoutAttr = decideAddressee({ utterance: "预算怎么样", roomTeams: hidden, roomSeats: [] });

  assert.deepEqual(Object.keys(withAttr).sort(), ["basis", "candidates", "reason", "recipients"]);
  assert.deepEqual(withAttr.recipients, [], "归属不能把不可见的团队解锁");
  assert.deepEqual(withoutAttr.recipients, []);
  // 两次的候选集都是空：可见性判定与归属无关。
  assert.deepEqual(withAttr.candidates, withoutAttr.candidates);
});

test("归属缺席（null）与匿名是两件事：缺席保留旧的广播路径，匿名要求确认", async () => {
  const absent = decideAddressee({ utterance: "随便说说", roomTeams: TEAMS, roomSeats: SEATS });
  assert.notEqual(absent.basis, "needs_confirmation", "打字消息没有归属这回事，不该被要求确认");
  const anonymous = decideAddressee({
    utterance: "随便说说",
    attribution: { certainty: "anonymous", memberId: null },
    roomTeams: TEAMS,
    roomSeats: SEATS,
  });
  assert.equal(anonymous.basis, "needs_confirmation");
});

// ── 5.3 confirmation is per-message, never remembered ─────────────────────

test("连续两条匿名消息各自需要确认：第二次不套用第一次的选择", async () => {
  const attribution = attributionOf({ streamId: "s9" });
  const first = route("第一句", attribution);
  const second = route("第二句", attribution);
  assert.equal(first.basis, "needs_confirmation");
  assert.equal(second.basis, "needs_confirmation", "人工确认一次不等于给未来所有消息背书");
  assert.deepEqual(first, second, "同一输入同一结果：路由器里没有跨消息记忆");
});

test("三个等级与 router 的可信集一致：只有 session/bound 免确认", async () => {
  for (const certainty of ["session", "bound", "anonymous"]) {
    const d = decideAddressee({
      utterance: "zzz",
      attribution: { certainty, memberId: certainty === "anonymous" ? null : "m-li" },
      roomTeams: TEAMS,
      roomSeats: [],
    });
    const certain = ATTRIBUTION_CERTAIN.includes(certainty);
    assert.equal(d.basis === "attribution", certain, `${certainty} → ${d.basis}`);
  }
});
