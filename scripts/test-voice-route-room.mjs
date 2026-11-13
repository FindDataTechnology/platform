// add-speaker-attribution (task 5.1 / 6.2's non-capture half): the seam inside
// the REAL room router.
//
// The unit tests prove `createVoiceRoute` computes the right decision; the source
// assertion proves gateway/index.js passes it. Neither proves the router ACCEPTS
// it: registerZhiyuRoutes could mount a different instance, or onHumanMessage
// could ignore the result. This file closes that gap by mounting the real kernel
// and driving `router.onHumanMessage` the way the capture lane will — a stored
// message row carrying `meta.capture`.
//
// The first case is the safety property: a message WITHOUT that meta must wake
// every seat, byte-for-byte as before. If that ever changes, every room in
// production changes with it.
//
//   node --test scripts/test-voice-route-room.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { createVoiceRoute } from "../gateway/zhiyu/voice-route.js";

const OWNER = "owner@corp.test";
const OTHER = "other@corp.test";

function boot() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voice-route-room-"));
  const app = express();
  const woken = [];
  const settles = [];
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot,
    resolveUser: () => null,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: process.env,
    secret: "test-secret",
    webDist: null,
    // The agent lane is a recorder: who was woken is the whole assertion.
    callAgent: async (member, { text }) => {
      woken.push({ memberId: member.id, ref: member.ref, text });
      return { text: `（答复）${text}` };
    },
    // Billing recorder (task 5.2): attribution must not reach the usage key.
    settleTurn: async (member, meta) => {
      settles.push({ memberId: member.id, usageId: meta?.usageId, minutes: meta?.minutes });
    },
    // No sweeper/SSE timers: the process must exit when the test ends.
    startTimers: false,
    voiceRoute: createVoiceRoute(),
  });

  const store = zhiyu.store;
  const room = store.roomCreate({ title: "归属验收房", ownerEmail: OWNER });
  const owner = store.memberAdd({ roomId: room.id, kind: "user", ref: OWNER, display: "本人" });
  // The two seats that can actually answer. Their on_behalf_of is what the
  // adapter translates into `ownerMemberId` (design D9).
  const mine = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:mine", display: "我的助手", onBehalfOf: OWNER });
  const theirs = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:theirs", display: "别人的助手", onBehalfOf: OTHER });

  /** Append a human row (optionally carrying capture evidence) and route it. */
  async function say(content, capture) {
    const { row } = store.messageAppend({
      roomId: room.id,
      kind: "human",
      senderMemberId: owner.id,
      content,
      meta: capture ? { source: "capture", capture } : null,
    });
    await zhiyu.router.onHumanMessage({ room: store.roomGet(room.id), member: owner, message: row });
    return row;
  }

  const decisions = () =>
    store
      .messagesAfter(room.id, 0, { limit: 1000 })
      .filter((m) => m?.meta?.event === "route_decision")
      .map((m) => ({ kind: m.meta.kind, reason: m.meta.reason }));

  return { zhiyu, store, room, owner, mine, theirs, woken, settles, say, decisions, close: () => zhiyu.close?.() };
}

test("没有 meta.capture 的消息照旧广播给所有席位（零行为变化）", async () => {
  const t = boot();
  try {
    await t.say("大家好，预算怎么样");
    const ids = t.woken.map((w) => w.memberId).sort();
    assert.deepEqual(ids, [t.mine.id, t.theirs.id].sort(), "两个 active 席位都被叫醒，与改造前一致");
    assert.deepEqual(t.decisions(), [], "没有采集证据时不写 route_decision 事件");
  } finally {
    t.close();
  }
});

test("带本场声明的采集消息只叫醒该成员自己的席位", async () => {
  const t = boot();
  try {
    await t.say("预算怎么样", { streamId: "dev-owner", mode: "per_stream", declaredMemberId: OWNER });
    assert.deepEqual(t.woken.map((w) => w.memberId), [t.mine.id], "只叫醒我的助手，不要别人的");
    const d = t.decisions();
    assert.equal(d.length, 1);
    assert.equal(d[0].kind, "attribution");
    assert.match(d[0].reason, /session/);
  } finally {
    t.close();
  }
});

test("带席位绑定的采集消息走同一条路（不因来源不同而区别对待）", async () => {
  const t = boot();
  try {
    await t.say("预算怎么样", { streamId: "seat-1", mode: "per_stream", seatOwnerMemberId: OTHER });
    assert.deepEqual(t.woken.map((w) => w.memberId), [t.theirs.id]);
    assert.equal(t.decisions()[0].kind, "attribution");
  } finally {
    t.close();
  }
});

test("混录（一支麦）：不叫醒任何人，落 needs_confirmation 并写进路由事件", async () => {
  const t = boot();
  try {
    await t.say("预算怎么样", { streamId: "room-mic", mode: "mixed", declaredMemberId: OWNER });
    assert.deepEqual(t.woken, [], "混录不得按声明派发");
    const d = t.decisions();
    assert.equal(d.length, 1);
    assert.equal(d[0].kind, "needs_confirmation");
  } finally {
    t.close();
  }
});

test("匿名（有证据无来源）：同样落 needs_confirmation，不退化成广播", async () => {
  const t = boot();
  try {
    await t.say("预算怎么样", { streamId: "dev-unknown", mode: "per_stream" });
    assert.deepEqual(t.woken, []);
    assert.equal(t.decisions()[0].kind, "needs_confirmation");
  } finally {
    t.close();
  }
});

test("点名仍然赢：@别人的助手 + 归属本人 → 叫被点名的那一个", async () => {
  const t = boot();
  try {
    await t.say("@别人的助手 这个呢", { streamId: "dev-owner", mode: "per_stream", declaredMemberId: OWNER });
    assert.deepEqual(t.woken.map((w) => w.memberId), [t.theirs.id]);
    assert.equal(t.decisions()[0].kind, "mention");
  } finally {
    t.close();
  }
});

test("归属不改可见性、也不改计费键的形状（只改叫醒几个席位）", async () => {
  const a = boot();
  const b = boot();
  try {
    await a.say("预算怎么样");
    await b.say("预算怎么样", { streamId: "dev-owner", mode: "per_stream", declaredMemberId: OWNER });

    // 1) Visibility: every stored row in both rooms is "shared" — attribution
    //    is a routing signal, never a visibility lever.
    const vis = (t) => [...new Set(t.store.messagesAfter(t.room.id, 0, { limit: 1000 }).map((m) => m.visibility))];
    assert.deepEqual(vis(a), ["shared"]);
    assert.deepEqual(vis(b), ["shared"]);
    assert.deepEqual(vis(a), vis(b), "归属不得改变任何一行的可见性");

    // 2) Billing key shape: `zyr-<room>-<seq>-<seat>`, with the guest/private
    //    suffix chosen by sender kind and visibility — not by attribution.
    const shape = /^zyr-[^-]+-\d+-[^-]+$/;
    for (const t of [a, b]) {
      assert.ok(t.settles.length > 0, "应当有结算调用");
      for (const s of t.settles) {
        assert.match(s.usageId, shape, "计费键不得出现归属标记（guest/private 后缀只由发送者与可见性决定）");
        assert.equal(typeof s.minutes, "number");
        assert.ok(s.minutes >= 1);
      }
    }
    // 3) The only difference is HOW MANY seats were billed — that IS routing.
    assert.equal(a.settles.length, 2, "无归属：两个席位各结算一次");
    assert.equal(b.settles.length, 1, "有归属：只有本人席位结算一次");
  } finally {
    a.close();
    b.close();
  }
});

test("待确认后人工确认：发出去的是那句原文，不是改派理由", async () => {
  // The spec's acceptance path is 「落「需要确认」，等一次人工选择后才发送」— so
  // confirming a needs_confirmation row must deliver the ORIGINAL utterance to
  // the chosen seat. Sending the operator's reason string instead would make the
  // agent answer a note about the reassignment rather than the question asked.
  const t = boot();
  try {
    const row = await t.say("预算怎么样", { streamId: "room-mic", mode: "mixed" });
    assert.equal(t.decisions()[0].kind, "needs_confirmation");
    assert.deepEqual(t.woken, [], "确认之前谁都不叫");

    const out = await t.zhiyu.router.reassignDispatch({
      room: t.store.roomGet(t.room.id),
      triggerSeq: row.seq,
      targets: [t.mine.id],
      reason: "由房间所有者手动改派",
      by: OWNER,
    });
    assert.equal(out.ok, true, "待确认的行必须可以被人工确认");
    assert.equal(t.woken.length, 1, "确认后只叫被选中的席位");
    const prompt = t.woken[0].text;
    assert.match(prompt, /预算怎么样/, "发出去的必须包含那句原文");
    assert.doesNotMatch(
      prompt.split("最新一条来自")[1] ?? "",
      /由房间所有者手动改派/,
      "「最新一条」不能是改派理由——那会让席位去回答一条关于改派的说明",
    );
  } finally {
    t.close();
  }
});

test("反证：把 voiceRoute 去掉，同一段带证据的消息退回广播", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voice-route-off-"));
  const woken = [];
  const zhiyu = registerZhiyuRoutes(express(), {
    dataRoot,
    resolveUser: () => null,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: process.env,
    secret: "test-secret",
    webDist: null,
    callAgent: async (member, { text }) => {
      woken.push(member.id);
      return { text: `（答复）${text}` };
    },
    settleTurn: null,
    startTimers: false,
    // voiceRoute deliberately omitted: this is the pre-change wiring.
  });
  try {
    const store = zhiyu.store;
    const room = store.roomCreate({ title: "无接缝房", ownerEmail: OWNER });
    const owner = store.memberAdd({ roomId: room.id, kind: "user", ref: OWNER, display: "本人" });
    const live = store.memberAdd({ roomId: room.id, kind: "agent", ref: "pack:only", display: "唯一助手", onBehalfOf: OWNER });
    const { row } = store.messageAppend({
      roomId: room.id,
      kind: "human",
      senderMemberId: owner.id,
      content: "预算怎么样",
      meta: { source: "capture", capture: { streamId: "dev-owner", mode: "per_stream", declaredMemberId: OWNER } },
    });
    await zhiyu.router.onHumanMessage({ room: store.roomGet(room.id), member: owner, message: row });
    assert.deepEqual(woken, [live.id], "没有接缝时走既有广播（这里只有一个席位，所以仍是它）");
    const decisions = store.messagesAfter(room.id, 0, { limit: 100 })
      .filter((m) => m?.meta?.event === "route_decision");
    assert.deepEqual(decisions, [], "没有接缝时不写路由事件");
  } finally {
    zhiyu.close?.();
  }
});
