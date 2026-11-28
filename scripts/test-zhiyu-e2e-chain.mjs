// End-to-end chain suite — zhiyu room, one narrative across two users and two
// agent seats (add-zhiyu-room, task 10.2). Boots the REAL module stack
// (routes + store + router + bus + SSE) with only the live-runner HTTP lane
// stubbed — everything between the HTTP surface and the persisted stream is
// the production code path.
// Run: node --test scripts/test-zhiyu-e2e-chain.mjs
//
// Chain: create → invite user → invite facade (auto) → hatch → @mention →
// broadcast pass+cap → busy → 呼叫 → 接管/交还 → budget → idle close → minutes.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const waitFor = async (fn, { tries = 80, ms = 50 } = {}) => {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
};

test("zhiyu full chain (two users, two seats, one narrative)", async (t) => {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-chain-"));
  const calls = [];
  const settles = [];
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent: async (member, { text, contextId, scopeSeed }) => {
      calls.push({ ref: member.ref, text, contextId, scopeSeed });
      if (member.ref === "p:quiet:c") return { text: "「过」" };
      if (member.ref === "p:chatty:c") return { text: "@Quiet 我说的对吗" };
      return { text: "收到，我记下了" };
    },
    settleTurn: async (member, usage) => settles.push({ ref: member.ref, ...usage }),
    cellExport: async () => ({ sessionId: "s-src", title: "老会话", window: { kind: "last", n: 2 }, messages: [{ role: "user", content: "旧问题" }, { role: "assistant", content: "旧回答" }] }),
    ssePollMs: 40,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b), patch: (p, b) => call("PATCH", p, b) };
  };
  const li = cli("li@x"); // 主办
  const chen = cli("chen@x"); // 成员+其分身
  const rows0 = () => null;

  // 1) 开通空间（携带升房历史窗）
  const created = await li.post("/api/zhiyu/rooms", { title: "董事会", hatch: { sessionId: "s-src", window: "last:2" } });
  assert.equal(created.status, 200);
  const roomId = created.body.room.id;
  let rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.ok(rows.some((m) => m.provenance === "session:s-src"), "hatched history seeded");

  // 2) 邀请成员 + 分身（陈总预设 auto_accept）
  await chen.put("/api/zhiyu/policies/facade", { facadeInvite: "auto_accept" });
  const invUser = await li.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "chen@x" });
  await chen.post(`/api/zhiyu/invites/${invUser.body.invite.id}/accept`);
  const invF = await li.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "facade", ref: "p:quiet:c", onBehalfOf: "chen@x", display: "陈总分身" });
  assert.equal(invF.body.invite.state, "accepted");
  await li.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "agent", ref: "p:chatty:c", onBehalfOf: "chen@x", display: "Chatty" });
  // Agent 席的接受由部署者代答 — 陈总收下自己部署的入场
  const agentInvite = (await chen.get("/api/zhiyu/invites")).body.invites.find((v) => v.kind === "agent");
  assert.ok(agentInvite, "agent invite is actionable by its deployer");
  await chen.post(`/api/zhiyu/invites/${agentInvite.id}/accept`);
  const invK = await li.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "agent", ref: "p:keen:c", onBehalfOf: "chen@x", display: "Keen" });
  await chen.post(`/api/zhiyu/invites/${invK.body.invite.id}/accept`);
  const members = (await li.get(`/api/zhiyu/rooms/${roomId}`)).body.members;
  assert.ok(members.find((m) => m.kind === "facade"));

  // 3) 房间级上限 1：一次广播里 quiet 过、chatty 答、keen 被熔断（按条消息计数）
  await li.patch(`/api/zhiyu/rooms/${roomId}`, { replyCap: 1 });
  await li.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "都听听这个" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "reply_cap_hit"));
  rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.equal(rows.filter((m) => m.kind === "agent" && !m.provenance).length, 1, "one broadcast, one capped answer");
  assert.ok(rows.some((m) => m.meta?.event === "pass"), "quiet passed");
  assert.equal(calls.filter((c) => c.ref === "p:keen:c").length, 0, "keen was never even dispatched");
  // chatty 的发言虽 @ 了 quiet，quiet 不被连环唤醒
  assert.equal(calls.filter((c) => c.ref === "p:quiet:c").length, 1, "quiet saw only its own solicit, no chain wake");
  // 成员的 scope 按发问者记
  assert.ok(calls.every((c) => c.scopeSeed?.startsWith(`room:${roomId}:`)));

  // 4) 陈总被呼叫：needs_you 落流、指令派给值守分身；陈总接管；交还
  await li.post(`/api/zhiyu/rooms/${roomId}/call`, { target: "chen@x" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "needs_you"));
  await waitFor(() => calls.some((c) => /系统指令|指令/.test(c.text)), "directive dispatched");
  const tk = await chen.post(`/api/zhiyu/rooms/${roomId}/takeover`);
  assert.equal(tk.body.members.find((m) => m.kind === "facade").presence, "listening");
  const hb = await chen.post(`/api/zhiyu/rooms/${roomId}/handback`);
  assert.equal(hb.body.members.find((m) => m.kind === "facade").presence, "on_duty");

  // 5) 发言计费各记各的座（quiet 已过/keen 被熔绝无 settle；chatty 一条 settle）
  assert.equal(settles.length, 1);
  assert.equal(settles[0].ref, "p:chatty:c");

  // 6) 私窗：只有陈总看见
  const chenMember = (await chen.get(`/api/zhiyu/rooms/${roomId}`)).body.myMemberId;
  zhiyu.store.messageAppend({ roomId, kind: "agent", visibility: `private:${chenMember}`, content: "私窗备忘" });
  assert.ok((await chen.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages.some((m) => m.content === "私窗备忘"));
  assert.ok(!(await li.get(`/api/zhiyu/rooms/${roomId}/messages`)).body.messages.some((m) => m.content === "私窗备忘"));

  // 7) 预算闸：今日预算=当前已答数 → 下一次触发被闸
  const answered = zhiyu.store.roomDayTurnsPeek(roomId);
  await li.patch(`/api/zhiyu/rooms/${roomId}`, { dailyBudgetTurns: answered });
  await chen.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@Chatty 还醒着吗" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "budget_exhausted"));
  assert.equal(zhiyu.store.roomDayTurnsPeek(roomId), answered);

  // 8) 空闲自动结束 + 纪要推送给李、陈（含分身主人）
  zhiyu.store.roomTouch(roomId, Date.now() - 60 * 60 * 1000);
  zhiyu.sweep();
  assert.equal(zhiyu.store.roomGet(roomId).status, "ended");
  for (const who of ["li@x", "chen@x"]) {
    const inbox = (await cli(who).get("/api/zhiyu/notifications")).body;
    assert.ok(inbox.notifications.some((n) => n.type === "minutes"), `${who} got minutes`);
  }
  // 结束后只读
  assert.equal((await chen.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "尾" })).status, 409);

  srv.close();
  void rows0;
});
