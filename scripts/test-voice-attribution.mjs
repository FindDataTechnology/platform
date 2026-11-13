// add-speaker-attribution (tasks 4.1–4.5): the attribution function and its
// negative guards.
//
// The subject is small on purpose — a stream record in, one attribution out —
// because that is what makes the "no guessing" rule checkable. The tests that
// matter are the two that can only pass if the module stays honest:
//
//   • MIXED MIC: one microphone, declarations present, still `anonymous`. A
//     single mic cannot separate speakers, so attributing every line to the
//     person who confirmed "I'm here" would look like evidence and be a guess.
//   • CROSS-SESSION: the same streamId attributed in a second session with no
//     evidence must come back `anonymous`. Deliberately reusing the same
//     ids/process, so a module-level memo of last session's answer would fail.
//
//   node --test scripts/test-voice-attribution.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTRIBUTION_CERTAINTY,
  ATTRIBUTION_SOURCE,
  CAPTURE_MODE,
  attributeStreams,
  toRouterAttribution,
} from "../gateway/zhiyu/voice-attribution.js";
import { decideAddressee, ATTRIBUTION_CERTAIN } from "../gateway/zhiyu/voice-router.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "../gateway/zhiyu/voice-attribution.js"), "utf8");

const one = (stream, mode = "per_stream") => attributeStreams({ mode, streams: [stream] })[0];

// ── 4.1 truth table: two legal sources, and the no-evidence branch ──────────

test("真值表：本场声明→session，席位绑定→bound，两者都有→session（本次事实更新），都没有→anonymous", async () => {
  const declared = one({ streamId: "s1", declaredMemberId: "m-li" });
  assert.deepEqual(
    { memberId: declared.memberId, certainty: declared.certainty, source: declared.source },
    { memberId: "m-li", certainty: "session", source: "self_declaration" },
  );

  const bound = one({ streamId: "s1", seatOwnerMemberId: "m-wang" });
  assert.deepEqual(
    { memberId: bound.memberId, certainty: bound.certainty, source: bound.source },
    { memberId: "m-wang", certainty: "bound", source: "seat_binding" },
  );

  const both = one({ streamId: "s1", declaredMemberId: "m-li", seatOwnerMemberId: "m-wang" });
  assert.equal(both.memberId, "m-li", "会议室座位会被借用，本次确认比席位主人更新");
  assert.equal(both.certainty, "session");

  const none = one({ streamId: "s1" });
  assert.equal(none.memberId, null);
  assert.equal(none.certainty, "anonymous");
  assert.equal(none.source, "none");
  assert.ok(none.reason.length > 0, "unknown 也要给得出可读原因");
});

test("空串/非字符串的成员标识不算一个人：降级为 anonymous 而不是路由到无名的成员", async () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
    const r = one({ streamId: "s1", declaredMemberId: bad, seatOwnerMemberId: bad });
    assert.equal(r.memberId, null, `declaredMemberId=${JSON.stringify(bad)}`);
    assert.equal(r.certainty, "anonymous");
  }
});

test("枚举常量就是那份词汇表，归属只能落在这三个等级上", async () => {
  assert.deepEqual([...ATTRIBUTION_CERTAINTY], ["session", "bound", "anonymous"]);
  assert.deepEqual([...ATTRIBUTION_SOURCE], ["self_declaration", "seat_binding", "none"]);
  assert.deepEqual([...CAPTURE_MODE], ["per_stream", "mixed"]);
  // 只有前两个能走默认接收方，这条与 router 的 ATTRIBUTION_CERTAIN 必须一致。
  assert.deepEqual([...ATTRIBUTION_CERTAIN], ["session", "bound"]);
  for (const s of [{ streamId: "a", declaredMemberId: "m" }, { streamId: "b" }, { streamId: "c", seatOwnerMemberId: "n" }]) {
    assert.ok(ATTRIBUTION_CERTAINTY.includes(one(s).certainty));
  }
});

test("批量：顺序与条数保持，形状不合法（无 streamId）的条目也占位而不被吞掉", async () => {
  const out = attributeStreams({
    streams: [
      { streamId: "s1", declaredMemberId: "m1" },
      { streamId: "s2" },
      null,
      { declaredMemberId: "m3" },
      { streamId: "s4", seatOwnerMemberId: "m4" },
    ],
  });
  assert.equal(out.length, 5, "一路流一条归属，不跳过未知的流");
  assert.deepEqual(out.map((r) => r.streamId), ["s1", "s2", null, null, "s4"]);
  // 第 4 条有证据却没有流标识：归属无处可挂，因此仍是 anonymous——不能因为
  // 「刚好排在第 4 位」就把它安到某一路音频上。
  assert.deepEqual(out.map((r) => r.certainty), ["session", "anonymous", "anonymous", "anonymous", "bound"]);
  assert.equal(out[3].memberId, null);
  assert.match(out[3].reason, /缺少标识/);
});

test("入参不是数组时退化为空结果，不抛错（路由侧不应因坏数据炸掉整场会议）", async () => {
  assert.deepEqual(attributeStreams({ streams: null }), []);
  assert.deepEqual(attributeStreams({ streams: "nope" }), []);
  assert.deepEqual(attributeStreams(), []);
});

// ── 4.2 per-stream attribution: the stream IS the person ───────────────────

test("两路采集同场录音：各自归到各自的人，且不读取任何声音特征", async () => {
  const out = attributeStreams({
    streams: [
      { streamId: "dev-li", declaredMemberId: "m-li" },
      { streamId: "dev-wang", declaredMemberId: "m-wang" },
    ],
  });
  assert.deepEqual(out.map((r) => r.memberId), ["m-li", "m-wang"]);
  // 反向证明：把「声音特征」塞进流记录也不会改变结果——模块根本不看这些字段。
  const withAudio = attributeStreams({
    streams: [
      { streamId: "dev-li", declaredMemberId: "m-li", speaker: "speaker_0", embedding: [0.1, 0.2], voiceprint: "vp-1" },
      { streamId: "dev-wang", declaredMemberId: "m-wang", speaker: "speaker_0", embedding: [0.1, 0.2], voiceprint: "vp-1" },
    ],
  });
  assert.deepEqual(withAudio, out, "同一 speaker 标签、同一 embedding 不影响任何归属");
});

// ── 4.3 / 4.4 the guards: only this session, and nothing acoustic ──────────

test("跨会话不继承：同一个流标识在下一场没有证据时必须是 anonymous", async () => {
  const sessionOne = attributeStreams({ streams: [{ streamId: "seat-3", declaredMemberId: "m-li" }] });
  assert.equal(sessionOne[0].memberId, "m-li");

  // Same process, same streamId, new session, no evidence. A module-level memo
  // of the previous answer — or any "remember who used this device" cache —
  // turns this red.
  const sessionTwo = attributeStreams({ streams: [{ streamId: "seat-3" }] });
  assert.equal(sessionTwo[0].memberId, null);
  assert.equal(sessionTwo[0].certainty, "anonymous");
});

test("源码守卫：归属模块不引用任何声纹/音色/相似度能力", async () => {
  // Comments are stripped before scanning: the file's own header explains WHY
  // these capabilities are absent, and a guard that cannot tell an explanation
  // from a call is a guard nobody can keep green.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const forbidden = [
    /whisperx/i, /pyannote/i, /resemblyzer/i, /voiceprint/i,
    /mfcc/i, /spectrogram/i, /embedding/i, /cosine/i, /similarity/i,
  ];
  for (const re of forbidden) assert.ok(!re.test(code), `归属模块不得出现 ${re}`);
  // 也只允许读这三个字段作为证据来源。
  const readFields = [...code.matchAll(/stream\?\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(readFields)].sort(), ["declaredMemberId", "seatOwnerMemberId", "streamId"]);
});

// ── 4.5 mixed recording fails honestly ────────────────────────────────────

test("单路混录：即使有人声明身份，也不得把任何一段标成具体某人", async () => {
  const out = attributeStreams({
    mode: "mixed",
    streams: [
      { streamId: "room-mic", declaredMemberId: "m-li" },
      { streamId: "room-mic-2", seatOwnerMemberId: "m-wang" },
    ],
  });
  for (const r of out) {
    assert.equal(r.memberId, null, "混录不能按人归属");
    assert.equal(r.certainty, "anonymous");
    assert.match(r.reason, /无法区分|一路采集/);
  }
});

// ── 消费侧：喂给既有 router，不确定即确认 ─────────────────────────────────

const TEAMS = [
  { id: "t-li", ref: "li", display: "李四的团队", ownerMemberId: "m-li", tags: ["finance"], visible: true, callable: true },
  { id: "t-wang", ref: "wang", display: "王五的团队", ownerMemberId: "m-wang", tags: ["legal"], visible: true, callable: true },
];

test("喂进 voice-router：session/bound 走该人的团队，anonymous 落 needs_confirmation", async () => {
  const li = decideAddressee({
    utterance: "预算怎么样",
    attribution: toRouterAttribution(one({ streamId: "s1", declaredMemberId: "m-li" })),
    roomTeams: TEAMS,
  });
  assert.equal(li.basis, "attribution");
  assert.deepEqual(li.recipients.map((t) => t.id), ["t-li"]);

  const wang = decideAddressee({
    utterance: "预算怎么样",
    attribution: toRouterAttribution(one({ streamId: "s2", seatOwnerMemberId: "m-wang" })),
    roomTeams: TEAMS,
  });
  assert.equal(wang.basis, "attribution");
  assert.deepEqual(wang.recipients.map((t) => t.id), ["t-wang"]);

  // 混录里这句话其实命中了李四团队的标签，但归属不确定时**不允许**用意图补足。
  const unknown = decideAddressee({
    utterance: "预算怎么样",
    attribution: toRouterAttribution(one({ streamId: "room-mic", declaredMemberId: "m-li" }, "mixed")),
    roomTeams: TEAMS,
  });
  assert.equal(unknown.basis, "needs_confirmation", "不确定的归属绝不能被意图匹配顶掉");
  assert.deepEqual(unknown.recipients, []);
});

test("toRouterAttribution 只放行三个等级；畸形输入一律降为 anonymous", async () => {
  assert.deepEqual(toRouterAttribution(null), { certainty: "anonymous", memberId: null });
  assert.deepEqual(toRouterAttribution({ certainty: "inferred", memberId: "m1" }), { certainty: "anonymous", memberId: "m1" },
    "inferred 不在本模块词汇表里，降级后 router 仍会要求确认");
  assert.deepEqual(toRouterAttribution({ certainty: "session" }), { certainty: "session", memberId: null });
});
