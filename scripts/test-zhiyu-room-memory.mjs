// Room-lane memory injection (unified-memory-and-outputs D7: "facade/智语走
// chat-memory 同一条缝，不分不帕；登入=本 owner，游客=不注入").
//
// The room turn's prompt is assembled by the router, so the memory block is
// appended there from the SAME ladder the 壹座 chat lane uses. What this file
// pins:
//   · a signed-in member's turn carries their own digest, query = the message
//   · a guest's turn carries nothing and issues zero fd-memory requests
//   · CELL_MEMORY_CHAT_DIGEST=0 is the lane's total kill switch (chat's lever,
//     not a new one) — byte-identical prompt, zero requests
//   · any fd-memory failure degrades open: the turn still answers
//   · the appended bytes equal the chat lane's block (same seam, no drift)
//
//   node --test scripts/test-zhiyu-room-memory.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { chatMemoryInjectionFor, chatMemoryBlockFor, clusterMemoryFor } from "@finddatatechnology/yongyi-client";

const realFetch = globalThis.fetch;

// The fd-memory stand-in: mints a person token, answers /digest with a
// recognizable block, and records every memory request so the guest and
// kill-switch cases can assert ZERO traffic (not merely "no visible block").
function stubMemory({ digest = "【工作记忆】此前会话的沉淀，供参考：\n〔L2〕组合周报口径已定：每周五 17:00。", fail = false } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes("memory.stub")) return realFetch(url, init);
    seen.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (fail) throw new Error("stub memory down");
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/admin/mint")) return json(200, { token: "person-token" });
    if (u.includes("/digest")) return json(200, { digest });
    if (u.includes("/pages")) return json(200, { pages: [] });
    return json(404, { error: "unexpected" });
  };
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}

async function boot({ env = {}, agentScript = {} } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-mem-"));
  const calls = [];
  const callAgent = async (member, { text, contextId, onDelta: _onDelta }) => {
    calls.push({ ref: member.ref, text, contextId });
    const script = agentScript[member.ref] ?? { answer: `（${member.display}的回答）` };
    if (script.throw) throw new Error(script.throw);
    return { text: script.answer };
  };
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {
      CELL_MEMORY_ENABLED: "1",
      CELL_MEMORY_URL: "http://memory.stub",
      CELL_MEMORY_PLATFORM_TOKEN: "platform-token",
      CELL_MEMORY_DATA: path.join(tmp, "cell-memory"),
      ...env,
    },
    callAgent,
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body) => {
      const r = await realFetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  const close = () => new Promise((r) => srv.close(r));
  return { cli, zhiyu, calls, close };
}

async function waitFor(fn, { tries = 80, ms = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
}

async function seedRoom(cli, zhiyu, owner, seats) {
  const created = await cli(owner).post("/api/zhiyu/rooms", { title: "记忆缝" });
  const roomId = created.body.room.id;
  for (const s of seats) {
    zhiyu.store.memberAdd({ roomId, kind: s.kind ?? "agent", ref: s.ref, display: s.display ?? s.ref, onBehalfOf: s.onBehalfOf ?? null });
  }
  return roomId;
}

const DIGEST = "【工作记忆】此前会话的沉淀，供参考：\n〔L2〕组合周报口径已定：每周五 17:00。";

test("a signed-in member's room turn carries their own digest", async () => {
  const mem = stubMemory({ digest: DIGEST });
  const { cli, zhiyu, calls, close } = await boot();
  try {
    const roomId = await seedRoom(cli, zhiyu, "alice@x", [{ ref: "deep", display: "DeepResearch" }]);
    await cli("alice@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@DeepResearch 本周报怎么出" });
    await waitFor(() => calls.length === 1);
    assert.ok(calls[0].text.endsWith(DIGEST), "digest block appended at the tail");
    assert.ok(calls[0].text.includes("@DeepResearch 本周报怎么出"), "room context intact above the block");
    // identity: the mint is the ASKING owner's namespace, and the digest query
    // is the human's message (not the whole transcript).
    const mint = mem.seen.find((s) => s.url.endsWith("/admin/mint"));
    assert.equal(mint.body.namespace, "u/alice@x");
    const digest = mem.seen.find((s) => s.url.includes("/digest"));
    assert.ok(digest.url.includes("project=default"));
    assert.equal(new URL(digest.url).searchParams.get("q"), "@DeepResearch 本周报怎么出");
  } finally {
    await close();
    mem.restore();
  }
});

test("a guest's turn injects nothing and issues zero fd-memory requests", async () => {
  const mem = stubMemory();
  const { cli, zhiyu, calls, close } = await boot();
  try {
    const roomId = await seedRoom(cli, zhiyu, "alice@x", [{ ref: "deep", display: "DeepResearch" }]);
    const room = zhiyu.store.roomGet(roomId);
    // A guest seat is kind=guest (identify upgrades it to kind=user, ref=email).
    const guest = zhiyu.store.memberAdd({ roomId, kind: "guest", ref: "zy_guest-1", display: "访客" });
    const target = zhiyu.store.memberFor(roomId, "agent", "deep");
    const prompt = await zhiyu.router.promptWithMemory({
      room,
      target,
      sender: guest,
      message: { content: "你好" },
      mode: "direct",
    });
    assert.ok(!prompt.includes("【工作记忆】"), "guests never receive memory");
    assert.equal(prompt, zhiyu.router.buildPrompt({ room, agentMember: target, sender: guest, message: { content: "你好" }, mode: "direct" }), "byte-identical to the memory-off prompt");
    assert.equal(mem.seen.length, 0, "no fd-memory traffic for a guest");
    assert.equal(calls.length, 0);
  } finally {
    await close();
    mem.restore();
  }
});

test("CELL_MEMORY_CHAT_DIGEST=0 turns the room lane off too (one switch, not two)", async () => {
  const mem = stubMemory();
  const { cli, zhiyu, calls, close } = await boot({ env: { CELL_MEMORY_CHAT_DIGEST: "0" } });
  try {
    const roomId = await seedRoom(cli, zhiyu, "carol@x", [{ ref: "deep", display: "DeepResearch" }]);
    await cli("carol@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@DeepResearch 你好" });
    await waitFor(() => calls.length === 1);
    assert.ok(!calls[0].text.includes("【工作记忆】"), "kill switch silences the room lane");
    assert.equal(mem.seen.length, 0, "kill switch means zero requests");
  } finally {
    await close();
    mem.restore();
  }
});

test("an fd-memory failure degrades open: the turn still answers", async () => {
  const mem = stubMemory({ fail: true });
  const { cli, zhiyu, calls, close } = await boot();
  try {
    const roomId = await seedRoom(cli, zhiyu, "dave@x", [{ ref: "deep", display: "DeepResearch" }]);
    await cli("dave@x").post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@DeepResearch 你好" });
    await waitFor(() => calls.length === 1);
    assert.ok(!calls[0].text.includes("【工作记忆】"), "no block when memory is down");
    await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.kind === "agent" && m.content.includes("回答")));
  } finally {
    await close();
    mem.restore();
  }
});

test("the appended block is the chat lane's block, byte for byte", async () => {
  const mem = stubMemory({ digest: DIGEST });
  try {
    const env = { CELL_MEMORY_ENABLED: "1", CELL_MEMORY_URL: "http://memory.stub", CELL_MEMORY_PLATFORM_TOKEN: "platform-token", CELL_MEMORY_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "cm-")) };
    const query = "本周报怎么出";
    const { block } = await chatMemoryBlockFor("bob@x", query, env);
    const cm = await clusterMemoryFor(env, "bob@x");
    const { prompt } = await chatMemoryInjectionFor(cm, query, env);
    assert.equal(prompt, `${query}\n\n${block}`, "the chat lane's prompt is query + the same block");
    assert.equal(block, DIGEST);
  } finally {
    mem.restore();
  }
});
