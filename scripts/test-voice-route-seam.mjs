// add-speaker-attribution (task 5.1, the seam itself): capture evidence →
// voiceRoute → decideAddressee, driven against the room shapes the store
// actually produces (design D9).
//
// The first test is the one that makes the rest safe to ship: a message with no
// capture evidence answers `null`, which room-router reads as "not my policy"
// and therefore leaves the legacy broadcast untouched. Everything after that is
// about doing the translation right — a person is `kind:'user'` with `ref` =
// email, and the seats that answer for them are the `agent`/`facade` rows whose
// `onBehalfOf` is that email.
//
//   node --test scripts/test-voice-route-seam.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureEvidence, seatsAsRoomTeams, createVoiceRoute } from "../gateway/zhiyu/voice-route.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── realistic room members (zy_room_members rows) ───────────────────────────
const ROOM_MEMBERS = [
  { id: "m-li", kind: "user", ref: "li@x.test", display: "李四", alias: "", state: "active" },
  { id: "seat-li", kind: "agent", ref: "pack:li-assistant", display: "李四的助手", onBehalfOf: "li@x.test", state: "active" },
  { id: "seat-wang", kind: "agent", ref: "pack:wang-assistant", display: "王五的助手", onBehalfOf: "wang@x.test", state: "active" },
  { id: "seat-orphan", kind: "agent", ref: "pack:shared", display: "公共助手", onBehalfOf: null, state: "active" },
  { id: "seat-away", kind: "agent", ref: "pack:away", display: "离席助手", onBehalfOf: "li@x.test", state: "left" },
  { id: "seat-listening", kind: "facade", ref: "pack:facade-li", display: "李四本人", onBehalfOf: "li@x.test", state: "active", presence: "listening" },
];

const AGENTS = ROOM_MEMBERS.filter((m) => m.kind !== "user");
const captureMessage = (content, capture) => ({ content, meta: { source: "capture", capture } });

const route = createVoiceRoute();

// ── 5.1a the zero-change guarantee ─────────────────────────────────────────

test("没有采集证据的消息一律返回 null：打字消息、agent 事件、契约之前写入的行都不受影响", async () => {
  for (const message of [
    { content: "手打的一句话", meta: {} },
    { content: "没有 meta" },
    { content: "采集但没证据", meta: { source: "capture" } },
    { content: "证据形状不对", meta: { capture: { mode: "per_stream" } } }, // 缺 streamId
    { content: "证据是数组", meta: { capture: [] } },
    null,
  ]) {
    assert.equal(route({ message, agents: AGENTS }), null, JSON.stringify(message));
  }
  // 未知 mode 不得被当成 per_stream：那会给一个我们不理解的形状悄悄开启归属。
  assert.equal(captureEvidence({ meta: { capture: { streamId: "s1", mode: "telepathy" } } }).mode, "mixed");
});

// ── 5.1b the translation ───────────────────────────────────────────────────

test("席位翻译：on_behalf_of 即 ownerMemberId；离席与已接管的 facade 不可调，与旧广播同口径", async () => {
  const teams = seatsAsRoomTeams(AGENTS);
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  assert.equal(byId["seat-li"].ownerMemberId, "li@x.test");
  assert.equal(byId["seat-li"].callable, true);
  assert.equal(byId["seat-away"].callable, false, "离席的席位不能被叫醒");
  assert.equal(byId["seat-listening"].callable, false, "facade 已被主人接管时不可调——旧广播也排除它");
  assert.equal(byId["seat-orphan"].ownerMemberId, null, "无主的席位可点名，但永不因归属被选中");
});

// ── 5.1c the decision ─────────────────────────────────────────────────────

test("本场声明属于李四 → 只派给李四自己的席位（离席与接管的都不在内）", async () => {
  const d = route({
    message: captureMessage("预算怎么样", { streamId: "dev-li", mode: "per_stream", declaredMemberId: "li@x.test" }),
    agents: AGENTS,
  });
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.recipients.map((r) => r.id), ["seat-li"]);
});

test("席位绑定（seatOwnerMemberId）走同一条路，不因来源不同而区别对待", async () => {
  const d = route({
    message: captureMessage("预算怎么样", { streamId: "dev-w", mode: "per_stream", seatOwnerMemberId: "wang@x.test" }),
    agents: AGENTS,
  });
  assert.equal(d.basis, "attribution");
  assert.deepEqual(d.recipients.map((r) => r.id), ["seat-wang"]);
});

test("归属确定但此人在本房间没有席位 → 按既有口径广播征询，且 reason 写明归属为何没生效", async () => {
  const d = route({
    message: captureMessage("预算怎么样", { streamId: "dev-x", mode: "per_stream", declaredMemberId: "nobody@x.test" }),
    agents: AGENTS,
  });
  // This branch is the router's pre-existing decision, not this change's: a
  // person nobody has a seat for still gets heard by the room. What matters
  // here is that the trail says WHY attribution did not route, so a broadcast
  // caused by "no seat here" is never mistaken for "nobody knew who spoke".
  assert.equal(d.basis, "broadcast");
  assert.match(d.reason, /没有自己的团队|归属/);
  assert.ok(!d.recipients.some((r) => r.id === "seat-away"), "离开房间的席位不在广播集内");
  assert.ok(!d.recipients.some((r) => r.id === "seat-listening"), "已被主人接管的 facade 不在广播集内");
});

test("混录：即使带了声明，也不按人派发", async () => {
  const d = route({
    message: captureMessage("预算怎么样", { streamId: "room-mic", mode: "mixed", declaredMemberId: "li@x.test" }),
    agents: AGENTS,
  });
  assert.equal(d.basis, "needs_confirmation");
  assert.deepEqual(d.recipients, []);
});

test("匿名（有证据但无来源）→ needs_confirmation，不退化成广播", async () => {
  const d = route({
    message: captureMessage("预算怎么样", { streamId: "dev-unknown", mode: "per_stream" }),
    agents: AGENTS,
  });
  assert.equal(d.basis, "needs_confirmation");
  assert.deepEqual(d.recipients, []);
});

test("点名仍然赢：@公共助手 + 归属李四 → 点名对象", async () => {
  const d = route({
    message: captureMessage("@公共助手 这个呢", { streamId: "dev-li", mode: "per_stream", declaredMemberId: "li@x.test" }),
    agents: AGENTS,
  });
  assert.equal(d.basis, "mention");
  assert.deepEqual(d.recipients.map((r) => r.id), ["seat-orphan"]);
});

test("直接喂给 room-router 的 onHumanMessage 路径也能落地：产出会被 resolveSeat 认回同一席位", async () => {
  // room-router maps each recipient through resolveSeat(recipient, agents) by id.
  const d = route({
    message: captureMessage("预算怎么样", { streamId: "dev-li", mode: "per_stream", declaredMemberId: "li@x.test" }),
    agents: AGENTS,
  });
  for (const recipient of d.recipients) {
    assert.ok(AGENTS.some((m) => m.id === recipient.id), "转成席位必须能在 agents 里按 id 找到");
  }
});

// ── declared ≠ mounted ────────────────────────────────────────────────────
// A factory nobody passes is dead code, and this repo has been bitten by that
// shape before (页面/路由齐全但零引用). Assert the mount, not just the module.
test("真的挂上了：gateway 把 createVoiceRoute() 传给 registerZhiyuRoutes", async () => {
  const bootstrap = fs.readFileSync(path.join(here, "../gateway/index.js"), "utf8");
  assert.match(bootstrap, /import \{ createVoiceRoute \} from "\.\/zhiyu\/voice-route\.js"/);
  assert.match(bootstrap, /voiceRoute: createVoiceRoute\(\)/);
  // 且声明的入口与导出名一致，避免「导出了但名字不匹配」的静默死链。
  assert.match(fs.readFileSync(path.join(here, "../gateway/zhiyu/voice-route.js"), "utf8"), /export function createVoiceRoute/);
});
