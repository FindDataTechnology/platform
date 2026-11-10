// Integration tests — zhiyu billing & budget gate (add-zhiyu-room, group 7).
// Run: node --test scripts/test-zhiyu-billing.mjs
//
//   7.1  each answered turn settles on its SEAT'S own deployment key;
//        passes and failures settle nothing (zero cost).
//   7.2  room daily budget: touching the ceiling pauses agent speech with
//        an honest budget_exhausted event; budget is owner-configurable,
//        clearable, and only answers consume it.
//   7.3  the live settle lane posts usage_id+minutes to host-settle with the
//        service credential.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";
import { createZhiyuAgentLane } from "../gateway/zhiyu/agent-lane.js";

async function boot({ agentScript = {}, settlements = [] } = {}) {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-billing-"));
  const callAgent = async (member) => {
    const script = agentScript[member.ref] ?? { answer: `答（${member.ref}）` };
    if (script.throw) throw new Error(script.throw);
    return { text: script.answer };
  };
  const settleTurn = async (member, usage) => settlements.push({ ref: member.ref, ...usage });
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent,
    settleTurn,
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
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
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  return { srv, base, cli, zhiyu, settlements, close: () => srv.close() };
}

async function waitFor(fn, { tries = 60, ms = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, ms));
  }
  throw new Error("waitFor timed out");
}

test("7.1 answers settle per seat; passes and failures settle nothing", async () => {
  const settlements = [];
  const { cli, zhiyu, close } = await boot({
    settlements,
    agentScript: { lazy: { answer: "「过」" }, broke: { throw: "socket hangup" }, keen: { answer: "有见地" } },
  });
  const a = cli("a@x");
  const created = await a.post("/api/zhiyu/rooms", { title: "" });
  const roomId = created.body.room.id;
  for (const ref of ["lazy", "broke", "keen"]) {
    zhiyu.store.memberAdd({ roomId, kind: "agent", ref, display: ref });
  }
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "都来说说" });
  await waitFor(() => settlements.length >= 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(settlements.length, 1, "only the answering seat settles");
  assert.equal(settlements[0].ref, "keen");
  assert.match(settlements[0].usageId, /^zyr-/);
  assert.equal(settlements[0].minutes, 1);
  close();
});

test("7.2 budget: ceiling pauses speech honestly; owner-set/clearable; passes do not consume", async () => {
  const { cli, zhiyu, close } = await boot({ agentScript: { deep: { answer: "答" } } });
  const a = cli("a@x");
  const b = cli("b@x");
  const created = await a.post("/api/zhiyu/rooms", { title: "", dailyBudgetTurns: 1 });
  const roomId = created.body.room.id;
  assert.equal(created.body.room.dailyBudgetTurns, 1);
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "deep", display: "deep" });
  const inv = await a.post(`/api/zhiyu/rooms/${roomId}/invites`, { kind: "user", ref: "b@x" });
  await b.post(`/api/zhiyu/invites/${inv.body.invite.id}/accept`);

  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@deep 一" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.kind === "agent"));
  assert.equal(zhiyu.store.roomDayTurnsPeek(roomId), 1);

  // Budget touched: the next trigger pauses speech with an honest event.
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@deep 二" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).some((m) => m.meta?.event === "budget_exhausted"));
  assert.equal(zhiyu.store.roomDayTurnsPeek(roomId), 1, "no further answer was consumed");
  assert.equal(zhiyu.store.messagesAfter(roomId, 0, {}).filter((m) => m.kind === "agent").length, 1);

  // Non-owner cannot fiddle with the budget; owner can clear it.
  assert.equal((await b.patch(`/api/zhiyu/rooms/${roomId}`, { dailyBudgetTurns: 99 })).status, 403);
  await a.patch(`/api/zhiyu/rooms/${roomId}`, { dailyBudgetTurns: null });
  await a.post(`/api/zhiyu/rooms/${roomId}/messages`, { content: "@deep 三" });
  await waitFor(() => zhiyu.store.messagesAfter(roomId, 0, {}).filter((m) => m.kind === "agent").length >= 2);
  close();
});

test("7.3 live settle lane posts usage to host-settle with service credential", async () => {
  const lane = createZhiyuAgentLane({
    bookings: { rows: async () => [{ packId: "p", agentId: "a", deployedBy: "c@x", agentPath: "/pa" }] },
    registryUrl: () => "http://lane.local",
    registryToken: () => "gw",
    backendToken: () => "be",
    packsInternalBase: () => "http://packs.local",
  });
  const seen = {};
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.url = url;
    seen.body = JSON.parse(init.body);
    seen.headers = init.headers;
    return new Response(JSON.stringify({ settled: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await lane.settleTurn({ ref: "p:a", onBehalfOf: "c@x" }, { usageId: "zyr-r1-9-mem1", minutes: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seen.url, "http://packs.local/api/packs/internal/deployments/p/a/host-settle");
  assert.equal(seen.headers.Authorization, "Bearer gw");
  assert.equal(seen.body.usage_id, "zyr-r1-9-mem1");
  assert.equal(seen.body.minutes, 1);
  assert.equal(seen.body.rate_usd_per_min, undefined, "rate is inherited from the settle side");
});
