// Unit checks for GET /api/mp/command-summary (openspec: add-mp-command-center 1.2).
// Exercises the real route handler against a stubbed ctx — pending map,
// chat-history join, and a cron list seam (ctx.cronList) that tests inject.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerMpRoutes } from "../server/routes/mp.js";

function makeCtx({ pending = new Map(), sessions = [], jobs = [] } = {}) {
  return {
    mpAuth: {},
    mpBindings: { issueBindCode: () => ({ code: "000000", ttlMs: 1 }) },
    pendingQuestionBySession: pending,
    chatHistory: { listSessions: async () => sessions },
    cronList: () => jobs,
  };
}

async function handlerFor(ctx) {
  let handler = null;
  const app = {
    post: () => {},
    delete: () => {},
    get: (path, hd) => { if (path === "/api/mp/command-summary") handler = hd; },
  };
  registerMpRoutes({ ...ctx, app });
  assert.ok(handler, "route registered");
  return handler;
}

const res = () => ({
  status(code) { this.code = code; return this; },
  json(v) { this.body = v; return this; },
});

test("empty state is honest, not an error", async () => {
  const handler = await handlerFor(makeCtx());
  const r = res();
  await handler({}, r);
  assert.equal(r.code ?? 200, 200);
  assert.deepEqual(r.body.pendingQuestions, []);
  assert.equal(r.body.jobs.counts.total, 0);
  assert.deepEqual(r.body.jobs.attention, []);
  assert.deepEqual(r.body.jobs.recentDone, []);
});

test("pending questions snapshot joins session titles", async () => {
  const handler = await handlerFor(makeCtx({
    pending: new Map([["s1", { askId: "a1", toolCallId: "t1", questions: [{ id: "q1", question: "继续吗？" }] }]]),
    sessions: [{ id: "s1", title: "爬虫修复" }],
  }));
  const r = res();
  await handler({}, r);
  assert.equal(r.body.pendingQuestions.length, 1);
  assert.equal(r.body.pendingQuestions[0].sessionTitle, "爬虫修复");
  assert.equal(r.body.pendingQuestions[0].askId, "a1");
});

test("degraded title join degrades to null, never fails the summary", async () => {
  const ctx = makeCtx({ pending: new Map([["s1", { askId: "a1", questions: [] }]]) });
  ctx.chatHistory = { listSessions: async () => { throw new Error("db down"); } };
  const handler = await handlerFor(ctx);
  const r = res();
  await handler({}, r);
  assert.equal(r.body.pendingQuestions[0].sessionTitle, null);
});

test("job buckets match the cron page chip logic", async () => {
  const handler = await handlerFor(makeCtx({
    jobs: [
      { id: "j1", sessionTitle: "晨报", paused: false, state: "idle", history: [{ success: true, time: "2026-10-13T01:00:00Z", duration: 60 }] },
      { id: "j2", sessionTitle: "坏任务", paused: false, state: "failed", history: [{ success: false, time: "2026-10-13T02:00:00Z", error: "provider 500" }] },
      { id: "j3", sessionTitle: "暂停的", paused: true, state: "idle", history: [] },
      { id: "j4", sessionTitle: "跑着的", paused: false, state: "running", history: [] },
    ],
  }));
  const r = res();
  await handler({}, r);
  const c = r.body.jobs.counts;
  assert.equal(c.total, 4);
  assert.equal(c.active, 2); // j1 idle-with-success-history + j4 running
  assert.equal(c.paused, 1);
  assert.equal(c.failed, 1);
  assert.equal(r.body.jobs.attention.length, 1);
  assert.equal(r.body.jobs.attention[0].id, "j2");
  assert.match(r.body.jobs.attention[0].error, /provider 500/);
  assert.equal(r.body.jobs.recentDone.length, 1);
  assert.equal(r.body.jobs.recentDone[0].jobId, "j1");
});
