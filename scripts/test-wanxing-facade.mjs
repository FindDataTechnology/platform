#!/usr/bin/env node
// ── Wanxing facade tests (add-wanxing-serving-api tasks 1.2–1.3, 2.1–2.5, 3.x) ─
//
// Module-level tests for the external front door: the store's tables and
// lifecycle, the kernel (auth fail-closed, admission states, rate/slot
// bounds, idempotent replay, boundary settlement with the probed
// "subtract" direction and debt suspension), and the A2A face end-to-end
// against an in-process express app with stubbed registry/upstream/sub2api.
//
//   node --test scripts/test-wanxing-facade.mjs

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import http from "node:http";
import { test } from "node:test";

const tmp = mkdtempSync(path.join(tmpdir(), "wanxing-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const { createWanxingStore } = await import("../gateway/wanxing/store.js");
const { createWanxingCore, slugFor, maskKey } = await import("../gateway/wanxing/core.js");
const { createA2aFace, contextIdFor } = await import("../gateway/wanxing/a2a.js");

// A stub sub2api client with call counters — every behavior is programmable
// per test by mutating these fields.
function stubSub2api({ userId = 7, email = "caller@finddata.tech" } = {}) {
  return {
    userId,
    email,
    probeCalls: 0,
    resolveCalls: 0,
    adjustCalls: [],
    probeOk: true,
    resolveOk: true,
    adjustOk: true,
    degraded: () => false,
    async probeKeyLiveness() {
      this.probeCalls += 1;
      return this.probeOk ? { ok: true } : { ok: false, code: "INSUFFICIENT_BALANCE", message: "insufficient balance" };
    },
    async findUserByKey() {
      this.resolveCalls += 1;
      return this.resolveOk ? { userId: this.userId, email: this.email } : null;
    },
    async findUserByEmail(mail) {
      return mail === this.email ? { userId: this.userId, email: this.email } : null;
    },
    async adjustBalance(args) {
      this.adjustCalls.push(args);
      if (!this.adjustOk) throw new Error("sub2api unreachable");
      return { ok: true };
    },
  };
}

const freshStore = () => createWanxingStore({ file: path.join(mkdtempSync(path.join(tmp, "s-")), "wanxing.db") });

// ── Task 1.3: tables migrate idempotently; store lifecycle ──────────────────

test("1.3 store opens twice on the same file (idempotent migrations)", () => {
  const file = path.join(mkdtempSync(path.join(tmp, "m-")), "wanxing.db");
  const a = createWanxingStore({ file });
  a.close();
  const b = createWanxingStore({ file });
  b.close();
});

test("1.3 allowlist add/has/list/remove roundtrip", () => {
  const s = freshStore();
  s.allowlistAdd("agent-x", 7, "caller@finddata.tech");
  assert.equal(s.allowlistHas("agent-x", 7), true);
  assert.equal(s.allowlistHas("agent-x", 8), false);
  assert.equal(s.allowlistList("agent-x").length, 1);
  s.allowlistRemove("agent-x", 7);
  assert.equal(s.allowlistHas("agent-x", 7), false);
});

// ── Task 1.2: caller-key authentication ──────────────────────────────────────

test("1.2 auth fails closed without a billing plane", async () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: null });
  const r = await core.authenticate("sk-livekey");
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test("1.2 auth fails closed on a degraded client", async () => {
  const sub = stubSub2api();
  sub.degraded = () => true;
  const core = createWanxingCore({ store: freshStore(), sub2api: sub });
  assert.equal((await core.authenticate("sk-livekey")).status, 503);
});

test("1.2 malformed keys never reach the probe", async () => {
  const sub = stubSub2api();
  const core = createWanxingCore({ store: freshStore(), sub2api: sub });
  const r = await core.authenticate("not-a-key");
  assert.equal(r.status, 401);
  assert.equal(sub.probeCalls, 0);
});

test("1.2 the billing gate refuses broke keys with 402", async () => {
  const sub = stubSub2api();
  sub.probeOk = false;
  const core = createWanxingCore({ store: freshStore(), sub2api: sub });
  const r = await core.authenticate("sk-broke");
  assert.equal(r.status, 402);
  assert.equal(r.code, "INSUFFICIENT_BALANCE");
});

test("1.2 a valid key resolves the caller and hits the verdict cache", async () => {
  const sub = stubSub2api();
  const core = createWanxingCore({ store: freshStore(), sub2api: sub });
  const r1 = await core.authenticate("sk-good");
  assert.deepEqual(r1.caller, { userId: 7, email: "caller@finddata.tech" });
  await core.authenticate("sk-good");
  assert.equal(sub.probeCalls, 1, "second call served from cache");
});

test("1.2 maskKey never exposes more than the last four", () => {
  assert.equal(maskKey("sk-abcdefgh1234"), "…1234");
  assert.equal(maskKey(""), "");
});

// ── Task 2.1: admission states ───────────────────────────────────────────────

const CALLER = { userId: 7, email: "caller@finddata.tech" };

test("2.1 admission: not-found / paused / private-not-listed / private-listed / public", () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api() });
  assert.equal(core.admit(CALLER, { exists: false, slug: "x" }).status, 404);
  assert.equal(core.admit(CALLER, { exists: true, slug: "x", paused: true, visibility: "public" }).status, 423);
  assert.equal(core.admit(CALLER, { exists: true, slug: "x", paused: false, visibility: "private" }).status, 403);
  const s = freshStore();
  s.allowlistAdd("x", 7, CALLER.email);
  const core2 = createWanxingCore({ store: s, sub2api: stubSub2api() });
  assert.equal(core2.admit(CALLER, { exists: true, slug: "x", paused: false, visibility: "private" }).ok, true);
  assert.equal(core.admit(CALLER, { exists: true, slug: "x", paused: false, visibility: "public" }).ok, true);
});

// ── Task 2.2: rate and slot bounds ───────────────────────────────────────────

test("2.2 rpm bound trips over the limit within the window", () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api(), config: { rpmMax: 2 } });
  assert.equal(core.checkRpm(7), true);
  assert.equal(core.checkRpm(7), true);
  assert.equal(core.checkRpm(7), false, "third request in the window is throttled");
  assert.equal(core.checkRpm(8), true, "other callers unaffected");
});

test("2.2 one in-flight turn per (caller, agent)", () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api() });
  assert.equal(core.acquireSlot(7, "a"), true);
  assert.equal(core.acquireSlot(7, "a"), false);
  assert.equal(core.acquireSlot(7, "b"), true);
  core.releaseSlot(7, "a");
  assert.equal(core.acquireSlot(7, "a"), true);
});

// ── Task 2.3: idempotent replay and single-flight ────────────────────────────

test("2.3 a replayed key returns the recorded outcome without a second exec", async () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api() });
  let execs = 0;
  const exec = async () => ({ response: { jsonrpc: "2.0", id: 1, result: { n: execs } } });
  const r1 = await core.idempotentSend({ callerId: 7, slug: "a", idemKey: "k1", exec: async () => { execs += 1; return exec(); } });
  const r2 = await core.idempotentSend({ callerId: 7, slug: "a", idemKey: "k1", exec: async () => { execs += 1; return exec(); } });
  assert.equal(execs, 1);
  assert.deepEqual(r1.response, r2.response);
  assert.equal(r2.replayed, true);
});

test("2.3 concurrent duplicates join one flight", async () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api() });
  let execs = 0;
  const exec = () => new Promise((r) => setTimeout(() => { execs += 1; r({ response: { ok: true } }); }, 30));
  const [a, b] = await Promise.all([
    core.idempotentSend({ callerId: 7, slug: "a", idemKey: "k", exec }),
    core.idempotentSend({ callerId: 7, slug: "a", idemKey: "k", exec }),
  ]);
  assert.equal(execs, 1);
  assert.deepEqual(a.response, b.response);
});

test("2.3 a failed exec records the error and replays it", async () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api() });
  const boom = async () => {
    throw Object.assign(new Error("agent route refused"), { code: -32033 });
  };
  await assert.rejects(() => core.idempotentSend({ callerId: 7, slug: "a", idemKey: "k", exec: boom }));
  const r2 = await core.idempotentSend({ callerId: 7, slug: "a", idemKey: "k", exec: boom });
  assert.equal(r2.replayed, true);
  assert.equal(r2.response.error.code, -32033);
});

// ── Task 2.4: metering and boundary settlement ───────────────────────────────

test("2.4 minutes round up, ok turns settle once via subtract, and the row id is the idempotency key", async () => {
  const sub = stubSub2api();
  const core = createWanxingCore({ store: freshStore(), sub2api: sub, config: { ratePerMin: 0.1 } });
  const row = core.recordUsage({ caller: CALLER, slug: "a", idemKey: "k", startedAt: 0, endedAt: 90_000, outcome: "ok" });
  assert.equal(row.minutesBilled, 2, "90s bills two started minutes");
  assert.equal(row.settlementStatus, "pending");
  assert.equal(await core.trySettle(row), true);
  assert.equal(sub.adjustCalls.length, 1);
  assert.deepEqual(
    { amountUsd: sub.adjustCalls[0].amountUsd, operation: sub.adjustCalls[0].operation, idempotencyKey: sub.adjustCalls[0].idempotencyKey },
    { amountUsd: 0.2, operation: "subtract", idempotencyKey: row.id },
  );
});

test("2.4 errored turns are recorded but waived", () => {
  const core = createWanxingCore({ store: freshStore(), sub2api: stubSub2api() });
  const row = core.recordUsage({ caller: CALLER, slug: "a", idemKey: "k", startedAt: 0, endedAt: 60_000, outcome: "error" });
  assert.equal(row.settlementStatus, "waived");
  assert.equal(row.minutesBilled, 0);
});

test("2.4 repeated settlement failures suspend the caller; the gate re-admits after recovery", async () => {
  const sub = stubSub2api();
  sub.adjustOk = false;
  const store = freshStore();
  const core = createWanxingCore({ store, sub2api: sub, config: { suspendAfterFailures: 3 } });
  for (let i = 0; i < 3; i++) {
    const row = core.recordUsage({ caller: CALLER, slug: "a", idemKey: `k${i}`, startedAt: 0, endedAt: 60_000, outcome: "ok" });
    assert.equal(await core.trySettle(row), false);
  }
  assert.match(store.callerState(7).suspended_reason, /settlement failed/);
  const refused = await core.authenticate("sk-good");
  assert.equal(refused.status, 402);
  assert.equal(refused.code, "CALLER_SUSPENDED");
  // Recovery: the balance gate passes again and a settle succeeds → cleared.
  sub.adjustOk = true;
  const okRow = core.recordUsage({ caller: CALLER, slug: "a", idemKey: "kx", startedAt: 0, endedAt: 60_000, outcome: "ok" });
  assert.equal(await core.trySettle(okRow), true);
  assert.equal(store.callerState(7).suspended_reason, null);
  assert.equal((await core.authenticate("sk-good")).ok, true);
});

test("2.4 settlePending retries what the turn path could not settle", async () => {
  const sub = stubSub2api();
  const store = freshStore();
  const core = createWanxingCore({ store, sub2api: sub });
  const row = core.recordUsage({ caller: CALLER, slug: "a", idemKey: "k", startedAt: 0, endedAt: 60_000, outcome: "ok" });
  sub.adjustOk = false;
  await core.trySettle(row);
  assert.equal(store.usagePending().length, 1);
  sub.adjustOk = true;
  await core.settlePending();
  assert.equal(store.usagePending().length, 0);
});

test("5.1 the usage board aggregates by caller and by agent", async () => {
  const sub = stubSub2api();
  const store = freshStore();
  const core = createWanxingCore({ store, sub2api: sub, config: { ratePerMin: 0.1 } });
  for (const [slug, idem] of [["a", "k1"], ["a", "k2"], ["b", "k3"]]) {
    const row = core.recordUsage({ caller: CALLER, slug, idemKey: idem, startedAt: 0, endedAt: 60_000, outcome: "ok" });
    await core.trySettle(row);
  }
  const board = store.usageBoard();
  assert.equal(board.byCaller.length, 1);
  assert.equal(board.byCaller[0].turns, 3);
  assert.equal(board.byCaller[0].minutes, 3);
  assert.equal(board.byAgent.find((a) => a.agent === "a").turns, 2);
});

// ── Task 3.x: the A2A face against a listening app ───────────────────────────

function faceHarness({ entry, upstream, sub = stubSub2api(), store = freshStore() } = {}) {
  const core = createWanxingCore({ store, sub2api: sub, config: { ratePerMin: 0.1, rpmMax: 100 } });
  const upstreamCalls = [];
  const defaultEntry = {
    name: "SpiderHeal",
    description: "repairs spiders",
    version: "3",
    visibility: "public",
    capabilities: { streaming: true },
    skills: [],
    tags: ["ops"],
    metadata: {},
  };
  const face = createA2aFace({
    core,
    resolveDeployment: (slug) => (slug === "packs-p1-heal" ? { agentPath: "/packs/p1/heal" } : null),
    listDeployments: () => [{ slug: "packs-p1-heal", agentPath: "/packs/p1/heal" }],
    forwardHeaders: () => ({ "X-Authorization": "Bearer svc", Authorization: "Bearer backend" }),
    registryFetch: async () => new Response(JSON.stringify({ ...defaultEntry, ...(entry ?? {}) }), { headers: { "Content-Type": "application/json" } }),
    config: { agentUrlFor: (p) => `https://registry.internal/agent${p}/` },
    upstreamFetch: async (url, init) => {
      upstreamCalls.push({ url, init });
      return upstream(init);
    },
  });
  const app = express();
  face.register(app);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    core, store, upstreamCalls, base, sub,
    close: () => new Promise((r) => server.close(r)),
    call: (p, opts = {}) => fetch(base + p, opts).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) })),
    callText: (p, opts = {}) => fetch(base + p, opts).then(async (r) => ({ status: r.status, headers: r.headers, text: await r.text() })),
  };
}

const sendBody = (text, extra = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "message/send",
  params: { message: { role: "user", parts: [{ kind: "text", text }], ...extra } },
});

const jsonReply = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { message: { parts: [{ kind: "text", text: "queued" }] } } }), { headers: { "Content-Type": "application/json" } });

test("3.2 catalog and card are public; private agents are absent", async () => {
  const h = faceHarness({ entry: { visibility: "public" } });
  const cat = await h.call("/api/wanxing/v1/agents");
  assert.equal(cat.status, 200);
  assert.equal(cat.body.agents[0].slug, "packs-p1-heal");
  const card = await h.call("/api/wanxing/v1/a2a/packs-p1-heal/.well-known/agent-card.json");
  assert.equal(card.status, 200);
  assert.match(card.body.url, /\/api\/wanxing\/v1\/a2a\/packs-p1-heal$/);
  await h.close();
  const priv = faceHarness({ entry: { visibility: "private" } });
  assert.equal((await priv.call("/api/wanxing/v1/agents")).body.agents.length, 0);
  assert.equal((await priv.call("/api/wanxing/v1/a2a/packs-p1-heal/.well-known/agent-card.json")).status, 404);
  await priv.close();
});

test("3.1 send: auth → forward on dual internal credentials → wx context → settled ledger row", async () => {
  const upstreamCalls = [];
  const sub = stubSub2api();
  const store = freshStore();
  const core = createWanxingCore({ store, sub2api: sub, config: { ratePerMin: 0.1, rpmMax: 100 } });
  const face = createA2aFace({
    core,
    resolveDeployment: (slug) => (slug === "packs-p1-heal" ? { agentPath: "/packs/p1/heal" } : null),
    listDeployments: () => [{ slug: "packs-p1-heal", agentPath: "/packs/p1/heal" }],
    forwardHeaders: () => ({ "X-Authorization": "Bearer svc", Authorization: "Bearer backend" }),
    registryFetch: async () => new Response(JSON.stringify({ name: "S", visibility: "public", metadata: {} }), { headers: { "Content-Type": "application/json" } }),
    config: { agentUrlFor: (p) => `https://registry.internal/agent${p}/` },
    upstreamFetch: async (url, init) => {
      upstreamCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return jsonReply();
    },
  });
  const app = express();
  face.register(app);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const noKey = await fetch(base + "/api/wanxing/v1/a2a/packs-p1-heal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sendBody("hi")) });
  assert.equal(noKey.status, 401);

  const ok = await fetch(base + "/api/wanxing/v1/a2a/packs-p1-heal", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good", "Idempotency-Key": "fd-001" },
    body: JSON.stringify(sendBody("SUBMIT repo ticket.yaml")),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.message.parts[0].text, "queued");
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].headers["X-Authorization"], "Bearer svc");
  assert.equal(upstreamCalls[0].headers.Authorization, "Bearer backend");
  assert.match(upstreamCalls[0].body.params.message.context_id, /^wx:/);

  // Replay: no second upstream call, no second ledger row.
  const replay = await fetch(base + "/api/wanxing/v1/a2a/packs-p1-heal", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good", "Idempotency-Key": "fd-001" },
    body: JSON.stringify(sendBody("SUBMIT repo ticket.yaml")),
  });
  assert.equal(replay.status, 200);
  assert.equal(upstreamCalls.length, 1);
  const board = store.usageBoard();
  assert.equal(board.byCaller[0].turns, 1);
  assert.equal(board.byCaller[0].pending, 0, "settled inline");
  await new Promise((r) => server.close(r));
});

test("3.1 paused answers 423; private-not-listed answers 403; unknown slug answers 404", async () => {
  const paused = faceHarness({ entry: { visibility: "public", metadata: { paused: true } } });
  const r1 = await paused.call("/api/wanxing/v1/a2a/packs-p1-heal", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" }, body: JSON.stringify(sendBody("hi")) });
  assert.equal(r1.status, 423);
  await paused.close();

  const priv = faceHarness({ entry: { visibility: "private" } });
  const r2 = await priv.call("/api/wanxing/v1/a2a/packs-p1-heal", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" }, body: JSON.stringify(sendBody("hi")) });
  assert.equal(r2.status, 403);
  await priv.close();

  const none = faceHarness({});
  const r3 = await none.call("/api/wanxing/v1/a2a/no-such-agent", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" }, body: JSON.stringify(sendBody("hi")) });
  assert.equal(r3.status, 404);
  await none.close();
});

test("3.1 a concurrent second turn for the same (caller, agent) is refused with Retry-After", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const h = faceHarness({ upstream: async () => { await gate; return jsonReply(); } });
  const opts = { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" }, body: JSON.stringify(sendBody("slow")) };
  const first = fetch(h.base + "/api/wanxing/v1/a2a/packs-p1-heal", { ...opts, headers: { ...opts.headers, "Idempotency-Key": "s1" } });
  await new Promise((r) => setTimeout(r, 50)); // let the first acquire the slot
  const second = await fetch(h.base + "/api/wanxing/v1/a2a/packs-p1-heal", { ...opts, headers: { ...opts.headers, "Idempotency-Key": "s2" } });
  assert.equal(second.status, 409);
  assert.equal(second.headers.get("retry-after"), "5");
  release();
  assert.equal((await first).status, 200);
  await h.close();
});

test("3.3 unsupported methods answer JSON-RPC method-not-found; malformed bodies -32600", async () => {
  const h = faceHarness({});
  const r = await h.call("/api/wanxing/v1/a2a/packs-p1-heal", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: {} }),
  });
  assert.equal(r.body.error.code, -32601);
  const bad = await h.call("/api/wanxing/v1/a2a/packs-p1-heal", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" },
    body: JSON.stringify({ hello: 1 }),
  });
  assert.equal(bad.body.error.code, -32600);
  await h.close();
});

test("3.1 stream: SSE frames pass through and the ledger closes on stream end", async () => {
  const frames = [
    `event: delta\ndata: {"parts":[{"text":"que"}]}\n\n`,
    `event: message\ndata: {"parts":[{"text":"queued"}]}\n\n`,
    `event: done\ndata: {}\n\n`,
  ];
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
  const h = faceHarness({
    upstream: async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
  });
  const r = await fetch(h.base + "/api/wanxing/v1/a2a/packs-p1-heal", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "message/stream", params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } } }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /event: done/);
  const board = h.store.usageBoard();
  assert.equal(board.byCaller[0].turns, 1);
  await h.close();
});

test("2.5/D2 slug derivation is stable and collision-shaped like the runner key", () => {
  assert.equal(slugFor("/packs/AbC.x/Heal.y"), "packs-abc.x-heal.y");
});

test("D5 context derivation: supplied passes through; keyed send is replay-stable; keyless stream is one-shot", () => {
  assert.equal(contextIdFor({ context_id: "ctx-9" }, null), "ctx-9");
  const a = contextIdFor({}, "fd-001");
  const b = contextIdFor({}, "fd-001");
  assert.equal(a, b);
  assert.match(a, /^wx:[0-9a-f]{16}$/);
  assert.match(contextIdFor({}, null), /^wx:[0-9a-f]{16}$/);
  assert.notEqual(contextIdFor({}, null), contextIdFor({}, null));
});

// ── Task 4.1: runner external-context reap ──────────────────────────────────

test("4.1 reap removes idle wx sessions, keeps fresh ones and non-wx namespaces", async () => {
  const { ChildManager } = await import("../agent-runner/manager.js");
  const homeRoot = mkdtempSync(path.join(tmp, "runner-"));
  const mk = (agentKey, dir, name, ageSec) => {
    const dirPath = path.join(homeRoot, agentKey, dir, name);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(path.join(dirPath, "transcript.jsonl"), "{}");
    const t = new Date(Date.now() - ageSec * 1000);
    utimesSync(dirPath, t, t);
    utimesSync(path.join(dirPath, "transcript.jsonl"), t, t);
  };
  mk("packs-p1-heal", "sessions", "srv-wx-abc123", 90_000); // idle past TTL
  mk("packs-p1-heal", "sessions", "srv-wx-fresh1", 10);     // fresh: kept
  mk("packs-p1-heal", "sessions", "srv-day-20261003", 90_000); // rhythm: kept
  mk("packs-p1-heal", "projects", "srv-wx-oldproj", 90_000);   // other store: reaped
  const manager = new ChildManager({
    config: { homeRoot, externalContextTtlSecs: 86_400 },
    registryClient: {},
    clientFactory: () => null,
    log: { log() {}, warn() {}, error() {} },
  });
  const n = manager.reapExternalContexts();
  assert.equal(n, 2);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(path.join(homeRoot, "packs-p1-heal", "sessions", "srv-day-20261003")), true);
  assert.equal(existsSync(path.join(homeRoot, "packs-p1-heal", "sessions", "srv-wx-fresh1")), true);
  assert.equal(existsSync(path.join(homeRoot, "packs-p1-heal", "sessions", "srv-wx-abc123")), false);
  assert.equal(existsSync(path.join(homeRoot, "packs-p1-heal", "projects", "srv-wx-oldproj")), false);
});

// ── Task 2.5 + 5.1: the wiring module's own routes (allowlist mgmt, ops view) ─
//
// Since add-facet-platform S0 the facade reads deployment bookkeeping over
// the packs internal HTTP API (no process-local registry injection), so this
// test mounts BOTH surfaces on one app: the real registerPackRoutes with a
// seeded SQLite registry, and registerWanxingRoutes pointed at it by env —
// the loopback roundtrip is itself under test (auth gate included).

test("2.5/5.1 registerWanxingRoutes: allowlist add makes a private agent callable; ops usage answers on the service credential", async () => {
  const { registerWanxingRoutes } = await import("../gateway/wanxing/index.js");
  const { createPackRegistry, registerPackRoutes } = await import("../gateway/packs.js");
  const sub = stubSub2api();
  const store = freshStore();
  const upstreamCalls = [];

  const packsReg = createPackRegistry({ file: path.join(mkdtempSync(path.join(tmp, "pk-")), "packs.db") });
  const pub = packsReg.publish({
    email: "author@x",
    manifest: {
      name: "P1",
      description: "seed",
      visibility: "private",
      tags: [],
      skills: [],
      mcpServers: [],
      agents: [{ id: "heal", name: "Heal", persona: "heals" }],
    },
  });
  packsReg.recordDeployment({
    packId: pub.id,
    agentId: "heal",
    version: 1,
    agentPath: `/packs/${pub.id}/heal`,
    skillPaths: [],
    email: "author@x",
  });
  // slugFor lowercases and dash-normalizes — the minted id's case must pass
  // through it, not through string interpolation.
  const slug = slugFor(`/packs/${pub.id}/heal`);

  const env = {
    AGENT_SERVING_REGISTRY_URL: "https://reg.internal",
    AGENT_SERVING_REGISTRY_TOKEN: "svc-tok",
    AGENT_SERVING_BACKEND_TOKEN: "back-tok",
    SUB2API_PANEL_URL: "https://panel.example",
  };
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith("http://127.0.0.1:")) return fetch(url, init);
    if (url.startsWith("https://reg.internal/api/agents")) {
      return new Response(JSON.stringify({ name: "S", visibility: "private", metadata: {} }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("https://reg.internal/agent/")) {
      upstreamCalls.push({ headers: init.headers });
      return jsonReply();
    }
    return new Response("{}", { status: 404 });
  };
  const app = express();
  registerPackRoutes(app, {
    registry: packsReg,
    resolveUser: () => ({ email: "author@x", groups: ["creators"] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: ["creators"],
    deployConfig: { token: "svc-tok" },
  });
  const wired = registerWanxingRoutes(app, {
    dataRoot: tmp,
    resolveUser: () => ({ email: "author@x", groups: ["creators"] }),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: ["creators"],
    adminGroups: ["admin"],
    env,
    fetchImpl,
    store,
    sub2api: sub,
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  env.PACKS_INTERNAL_BASE_URL = base;
  try {
    // Internal deployments API: token-gated (S0 task 1.1).
    assert.equal((await fetch(`${base}/api/packs/internal/deployments`)).status, 401);
    assert.equal((await fetch(`${base}/api/packs/internal/author/${pub.id}`)).status, 401);
    const authed = { Authorization: "Bearer svc-tok" };
    const all = await (await fetch(`${base}/api/packs/internal/deployments`, { headers: authed })).json();
    assert.equal(all.deployments.length, 1);
    assert.equal(all.deployments[0].agentPath, `/packs/${pub.id}/heal`);
    const one = await (await fetch(`${base}/api/packs/internal/deployments/${pub.id}`, { headers: authed })).json();
    assert.equal(one.deployments[0].agentId, "heal");
    const author = await (await fetch(`${base}/api/packs/internal/author/${pub.id}`, { headers: authed })).json();
    assert.equal(author.authorEmail, "author@x");

    // Private agent: refused before allowlisting.
    const send = () =>
      fetch(`${base}/api/wanxing/v1/a2a/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" },
        body: JSON.stringify(sendBody("hi")),
      });
    assert.equal((await send()).status, 403);

    // Add the caller to the allowlist (pack author auth via the internal
    // author/deployments lookups + email → sub2api user).
    const add = await fetch(`${base}/api/packs/${pub.id}/deployments/heal/callers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "caller@finddata.tech" }),
    });
    assert.equal(add.status, 200);
    const listed = await (await fetch(`${base}/api/packs/${pub.id}/deployments/heal/callers`)).json();
    assert.equal(listed.callers.length, 1);

    // Now the same key is admitted and forwarded on the internal credentials.
    const okTurn = await send();
    assert.equal(okTurn.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].headers["X-Authorization"], "Bearer svc-tok");

    // Ops view: the runner service credential reads the board.
    const ops = await fetch(`${base}/api/wanxing/v1/ops/usage`, { headers: { Authorization: "Bearer svc-tok" } });
    assert.equal(ops.status, 200);
    const board = await ops.json();
    assert.equal(board.byCaller.length, 1);
    assert.equal(board.byCaller[0].turns, 1);
  } finally {
    wired.close();
    packsReg.close();
    await new Promise((r) => server.close(r));
  }
});

// ── S0: the deployment source being unreachable is a 503, never a hang and
// never a silent "no agents" — the catalog, the card, and the turn surface
// all say DEPLOYMENT_SOURCE_UNAVAILABLE.

test("S0 deployment source unreachable ⇒ 503 DEPLOYMENT_SOURCE_UNAVAILABLE on catalog, card, and turn", async () => {
  const { registerWanxingRoutes } = await import("../gateway/wanxing/index.js");
  const store = freshStore();
  const env = {
    // Point at a port nothing listens on.
    PACKS_INTERNAL_BASE_URL: "http://127.0.0.1:9",
  };
  const app = express();
  const wired = registerWanxingRoutes(app, {
    dataRoot: tmp,
    resolveUser: () => null,
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth required" }),
    creatorGroups: [],
    adminGroups: [],
    env,
    store,
    // The turn surface authenticates the caller BEFORE agent resolution, so
    // the 503 only surfaces with a key that passes the billing gate.
    sub2api: stubSub2api(),
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cat = await fetch(`${base}/api/wanxing/v1/agents`);
    assert.equal(cat.status, 503);
    assert.equal((await cat.json()).error.code, "DEPLOYMENT_SOURCE_UNAVAILABLE");

    const card = await fetch(`${base}/api/wanxing/v1/a2a/whatever/.well-known/agent-card.json`);
    assert.equal(card.status, 503);

    const turn = await fetch(`${base}/api/wanxing/v1/a2a/whatever`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good" },
      body: JSON.stringify(sendBody("hi")),
    });
    assert.equal(turn.status, 503);
    assert.equal((await turn.json()).error.code, "DEPLOYMENT_SOURCE_UNAVAILABLE");
  } finally {
    wired.close();
    await new Promise((r) => server.close(r));
  }
});

// ── Live-probe regression (2026-10-03 fd-prod): replay must not leak the
// (caller, agent) slot; concurrent same-key duplicates join the flight at the
// ROUTE level, not just in the kernel.

test("regression: replay frees the slot — a fresh-key turn afterwards is not 409", async () => {
  const upstreamCalls = [];
  const store = freshStore();
  const sub = stubSub2api();
  const core = createWanxingCore({ store, sub2api: sub, config: { ratePerMin: 0.1, rpmMax: 100 } });
  const face = createA2aFace({
    core,
    resolveDeployment: (slug) => (slug === "packs-p1-heal" ? { agentPath: "/packs/p1/heal" } : null),
    listDeployments: () => [{ slug: "packs-p1-heal", agentPath: "/packs/p1/heal" }],
    forwardHeaders: () => ({ "X-Authorization": "Bearer svc", Authorization: "Bearer backend" }),
    registryFetch: async () => new Response(JSON.stringify({ name: "S", visibility: "public", metadata: {} }), { headers: { "Content-Type": "application/json" } }),
    config: { agentUrlFor: (p) => `https://registry.internal/agent${p}/` },
    upstreamFetch: async () => {
      upstreamCalls.push(1);
      return jsonReply();
    },
  });
  const app = express();
  face.register(app);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (key) =>
    fetch(`${base}/api/wanxing/v1/a2a/packs-p1-heal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good", ...(key ? { "Idempotency-Key": key } : {}) },
      body: JSON.stringify(sendBody("hi")),
    });
  try {
    assert.equal((await post("k1")).status, 200);
    assert.equal((await post("k1")).status, 200, "replay");
    // Before the fix this was 409 forever: the replay had leaked the slot.
    assert.equal((await post("k2")).status, 200, "fresh key after a replay must run, not 409");
    assert.equal(upstreamCalls.length, 2, "k1 once + k2 once");
    assert.equal(store.usageBoard().byCaller[0].turns, 2, "two billable turns, replay records none");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("regression: concurrent same-key duplicates join the flight through the route", async () => {
  const upstreamCalls = [];
  const store = freshStore();
  const sub = stubSub2api();
  const core = createWanxingCore({ store, sub2api: sub, config: { ratePerMin: 0.1, rpmMax: 100 } });
  const face = createA2aFace({
    core,
    resolveDeployment: (slug) => (slug === "packs-p1-heal" ? { agentPath: "/packs/p1/heal" } : null),
    listDeployments: () => [{ slug: "packs-p1-heal", agentPath: "/packs/p1/heal" }],
    forwardHeaders: () => ({ "X-Authorization": "Bearer svc", Authorization: "Bearer backend" }),
    registryFetch: async () => new Response(JSON.stringify({ name: "S", visibility: "public", metadata: {} }), { headers: { "Content-Type": "application/json" } }),
    config: { agentUrlFor: (p) => `https://registry.internal/agent${p}/` },
    upstreamFetch: async () => {
      upstreamCalls.push(1);
      await new Promise((r) => setTimeout(r, 40));
      return jsonReply();
    },
  });
  const app = express();
  face.register(app);
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () =>
    fetch(`${base}/api/wanxing/v1/a2a/packs-p1-heal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sk-good", "Idempotency-Key": "race" },
      body: JSON.stringify(sendBody("hi")),
    });
  try {
    const first = post();
    await new Promise((r) => setTimeout(r, 15)); // flight registered, still running
    const second = await post();
    const a = await first;
    assert.equal(second.status, 200, "duplicate joins the flight instead of 409");
    assert.equal(a.status, 200);
    const d1 = await second.json();
    const d2 = await a.json();
    assert.deepEqual(d1, d2, "both callers receive the same outcome");
    assert.equal(upstreamCalls.length, 1, "exactly one turn ran");
    assert.equal(store.usageBoard().byCaller[0].turns, 1, "one billable turn");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
