#!/usr/bin/env node
// ── Facade matters tests (add-matter-threads 1) ──────────────────────────────
//
// Module-level tests against the matters surface: the internal trio's auth
// and validation (the runner's channel), the owner trio's visibility law
// (deployer sees, stranger gets a same-shape nothing), and the state machine
// (open → responded → closed, closed is terminal).
//
//   node --test scripts/test-facade-matters.mjs

import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "facade-matters-"));
test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

import { createPackRegistry, registerPackRoutes } from "../gateway/packs.js";

const MANIFEST = {
  name: "分身测试包",
  description: "matters 面测试用分身",
  visibility: "public",
  category: "company",
  tags: ["分身"],
  skills: [{ name: "corpus-one", description: "语料", content: "# 语料\n正文。" }],
  agents: [
    {
      id: "reception",
      name: "接待",
      persona: "测试接待。",
      serving: { protocol: "a2a" },
    },
  ],
  facade: { reception: "reception", corpus: ["corpus-one"], delegation: [], stance: "hosted" },
};

async function harness({ user = { email: "author@x", groups: ["creators"] } } = {}) {
  const file = path.join(tmpRoot, `packs-${Math.random().toString(36).slice(2)}.db`);
  const registry = createPackRegistry({ file });
  const { id } = registry.publish({ email: "author@x", manifest: MANIFEST });
  // A live deployment row (the deploy handler's own write — done directly so
  // these tests exercise the matters surface, not the deploy pipeline).
  registry.recordDeployment({
    packId: id, agentId: "reception", version: 1,
    agentPath: `/packs/${id}/reception`, skillPaths: ["packs/x/corpus-one"],
    email: "author@x",
  });
  const app = express();
  registerPackRoutes(app, {
    registry,
    resolveUser: () => user,
    rejectUnauthenticated: (_q, r) => r.status(401).json({ error: "auth" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    deployConfig: {
      registryUrl: "https://mcp.example.test", token: "runner-svc-token",
      runnerBaseUrl: "http://runner:8790", packsPublicBase: "https://packs.example.test",
      fetchImpl: null, sub2api: null,
    },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, { headers = {}, body } = {}) =>
    fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  const svc = { Authorization: "Bearer runner-svc-token" };
  return {
    registry, packId: id, call, svc,
    close: () => new Promise((r) => server.close(r)),
    open: (body, headers = svc) => call("POST", `/api/packs/internal/matters/${id}/reception/open`, { headers, body }),
  };
}

test("internal open/list/read: service-credential gate, mt_ id, timeline round-trip", async () => {
  const h = await harness();
  try {
    // No credential → 401 (the runner's channel is not public).
    assert.equal((await h.open({ summary: "问价格" }, {})).status, 401);

    // Unknown deployment → 404; empty summary → 400.
    const badDep = await h.call("POST", `/api/packs/internal/matters/${h.packId}/nobody/open`, { headers: h.svc, body: { summary: "x" } });
    assert.equal(badDep.status, 404);
    assert.equal((await h.open({ summary: "  " })).status, 400);

    // A legal open lands with an mt_ id and the open timeline entry.
    const res = await h.open({ summary: "请问企业版怎么收费？", visitor_hint: "访客自述：张三（微信 zhang）" });
    assert.equal(res.status, 200);
    assert.match(res.body.id, /^mt_[0-9a-f]{24}$/);
    assert.equal(res.body.status, "open");

    const list = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception`, { headers: h.svc });
    assert.equal(list.status, 200);
    assert.equal(list.body.matters.length, 1);
    assert.equal(list.body.matters[0].summary, "请问企业版怎么收费？");
    assert.equal(list.body.matters[0].visitorHint, "访客自述：张三（微信 zhang）");

    const read = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception/${res.body.id}`, { headers: h.svc });
    assert.equal(read.status, 200);
    assert.equal(read.body.matter.timeline.length, 1);
    assert.equal(read.body.matter.timeline[0].kind, "open");
    assert.equal(read.body.matter.timeline[0].by, "reception");

    // A read scoped to another deployment → same-shape 404.
    const wrong = await h.call("GET", `/api/packs/internal/matters/${h.packId}/nobody/${res.body.id}`, { headers: h.svc });
    assert.equal(wrong.status, 404);
  } finally {
    await h.close();
  }
});

test("owner queue: deployer sees and works the state machine; stranger sees nothing", async () => {
  const h = await harness();
  try {
    const { body: opened } = await h.open({ summary: "想约一次产品演示" });
    const mid = opened.id;

    // The deployer's queue carries the matter, open first.
    const mine = await h.call("GET", `/api/packs/${h.packId}/matters`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.matters.length, 1);
    assert.equal(mine.body.matters[0].status, "open");

    // Reply: status → responded, timeline appends the owner's text verbatim.
    const reply = await h.call("POST", `/api/packs/${h.packId}/matters/${mid}/reply`, { body: { text: "本周四下午三点可以，会议链接稍后发出。" } });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.matter.status, "responded");
    const replyEntry = reply.body.matter.timeline.at(-1);
    assert.equal(replyEntry.kind, "reply");
    assert.equal(replyEntry.by, "owner");
    assert.equal(replyEntry.text, "本周四下午三点可以，会议链接稍后发出。");

    // Close with a note; further replies are refused (terminal).
    const close = await h.call("POST", `/api/packs/${h.packId}/matters/${mid}/close`, { body: { note: "已约成，串关闭。" } });
    assert.equal(close.status, 200);
    assert.equal(close.body.matter.status, "closed");
    assert.equal((await h.call("POST", `/api/packs/${h.packId}/matters/${mid}/reply`, { body: { text: "再补一句" } })).status, 409);

    // Open-first ordering: a fresh open matter outranks the closed one.
    await h.open({ summary: "还有第二个问题" });
    const again = await h.call("GET", `/api/packs/${h.packId}/matters`);
    assert.equal(again.body.matters[0].status, "open");
    assert.equal(again.body.matters[1].status, "closed");
  } finally {
    await h.close();
  }
});

test("stranger: empty list and same-shape 404s — existence never disclosed", async () => {
  const h = await harness({ user: { email: "stranger@x", groups: ["creators"] } });
  try {
    // The matter exists (opened over the runner channel)…
    await h.call("POST", `/api/packs/${h.packId}/internal-noop`).catch(() => {});
    const svcOpen = await h.open({ summary: "内部开串" });
    assert.equal(svcOpen.status, 200);

    // …but the stranger's queue is empty and both actions 404 identically.
    const list = await h.call("GET", `/api/packs/${h.packId}/matters`);
    assert.equal(list.status, 200);
    assert.equal(list.body.matters.length, 0);
    const reply = await h.call("POST", `/api/packs/${h.packId}/matters/${svcOpen.body.id}/reply`, { body: { text: "偷答" } });
    const close = await h.call("POST", `/api/packs/${h.packId}/matters/${svcOpen.body.id}/close`, { body: {} });
    assert.equal(reply.status, 404);
    assert.equal(close.status, 404);
    assert.equal(reply.body.error, close.body.error);
  } finally {
    await h.close();
  }
});

// ── Visitor scope boundary (add-matter-visitor-scope) ────────────────────────
//
// The disclosure boundary: an opened matter binds to the calling session's
// opaque scope; another session's tool-face reader cannot see or read it
// (same-shape 404 — existence never leaks), the same session can, and the
// owner queue stays unfiltered. Unscoped v1 rows stay visible to everyone.

test("visitor scope: cross-session invisible, same-session visible, owner unfiltered", async () => {
  const h = await harness();
  try {
    // Visitor A (scope a) opens a matter.
    const a = await h.call("POST", `/api/packs/internal/matters/${h.packId}/reception/open`, {
      headers: h.svc, body: { summary: "A 的私事", visitor_scope: "scope-a" },
    });
    assert.equal(a.status, 200);
    // A v1-style unscoped matter stays around too.
    await h.open({ summary: "存量无界事项" });

    // Visitor B (scope b): list shows only the unscoped row — A's matter and
    // its existence are gone.
    const listB = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception?visitor_scope=scope-b`, { headers: h.svc });
    assert.equal(listB.status, 200);
    assert.deepEqual(listB.body.matters.map((m) => m.summary), ["存量无界事项"], "B sees ONLY the unscoped legacy row");
    assert.ok(listB.body.matters.every((m) => m.scopeKey == null), "B sees no scoped matters");
    const readB = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception/${a.body.id}?visitor_scope=scope-b`, { headers: h.svc });
    assert.equal(readB.status, 404, "another session's matter reads as nonexistent");

    // Visitor A (scope a): sees own + legacy, reads own fine.
    const listA = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception?visitor_scope=scope-a`, { headers: h.svc });
    assert.equal(listA.body.matters.length, 2);
    const readA = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception/${a.body.id}?visitor_scope=scope-a`, { headers: h.svc });
    assert.equal(readA.status, 200);
    assert.equal(readA.body.matter.summary, "A 的私事");

    // Sessionless reader: least-privilege — only the unscoped rows.
    const listNone = await h.call("GET", `/api/packs/internal/matters/${h.packId}/reception`, { headers: h.svc });
    assert.ok(listNone.body.matters.every((m) => m.scopeKey == null));

    // Owner queue: everything, scoped included.
    const owner = await h.call("GET", `/api/packs/${h.packId}/matters`);
    assert.equal(owner.body.matters.length, 2);
    assert.ok(owner.body.matters.some((m) => m.summary === "A 的私事"));
  } finally {
    await h.close();
  }
});
