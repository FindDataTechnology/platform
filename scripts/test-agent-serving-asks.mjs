// The serving ask lane (openspec: add-serving-ask-bridge).
//
// Four layers, one file:
//   1. the overlay writer (writeServingQuestionsPatch) — the row-swap overlay
//      that gives a served child the ask answerer;
//   2. the bridge class (platform-serving-questions-bridge.js) — parks each
//      ask, notifies upward, answers on request, first-wins (skips without a
//      dsh install; the staging probe covers the composed runtime);
//   3. the harness adapter's ask lane — onAsk forwarding, the no-answerer
//      decline, the budget-bounded deadline self-cancel;
//   4. the A2A surface — the opt-in `ask` SSE event, the /ask-answer side
//      route's receipts, and keepalive comments only while an ask pends.
//
//   node --test scripts/test-agent-serving-asks.mjs

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import yaml from "js-yaml";

import { DshHarnessAdapter } from "../agent-runner/harness/dsh.js";
import { createAgentApp } from "../agent-runner/a2a.js";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "dsh-profile-template");

// ── 1. the overlay writer ────────────────────────────────────────────────────

test("writeServingQuestionsPatch lands the bridge chain and the notify→questions row swap", async () => {
  const { writeServingQuestionsPatch } = await import("../dsh-profile.js");
  const home = mkdtempSync(path.join(tmpdir(), "questions-patch-"));
  try {
    const patchPath = writeServingQuestionsPatch({ dirs: { dshHome: home, profileName: "platform" } });
    assert.equal(patchPath, path.join(home, "profiles", "platform", "serving-questions.patch.yml"));
    const patch = yaml.load(readFileSync(patchPath, "utf8"));
    // The swap: disable the row the notify overlay inserted, insert the
    // questions subclass under a fresh id (a patch cannot rewrite a row's
    // plugin name — the chain grows one overlay per face).
    assert.deepEqual(patch[0], { id: "platform-notify-server", disabled: true });
    assert.deepEqual(patch[1], { insert: [{ id: "platform-serving-questions-server", name: "./platform-serving-questions-bridge.js" }] });
    for (const f of [
      "platform-serving-questions-bridge.js",
      "platform-notify-bridge.js",
      "bot-notify.js",
      "platform-preset-bridge.js",
      "platform-tool-scope.js",
      "platform-tool-description.js",
    ]) {
      assert.ok(existsSync(path.join(home, "profiles", "platform", f)), `${f} copied beside the profile`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── 2. the bridge class (skips without a dsh install) ────────────────────────

// The dsh install tree the machine actually boots children from — the same
// anchor walk as test-agent-notify-bridge.
function findDshAnchor() {
  const candidates = [
    path.join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai"),
    "/opt/dsh/node_modules/@deepseek-ai",
  ];
  try {
    const bin = execSync("command -v dsh", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (bin) {
      let dir = path.dirname(realpathSync(bin));
      while (dir !== path.dirname(dir)) {
        if (path.basename(dir) === "@deepseek-ai") { candidates.push(dir); break; }
        dir = path.dirname(dir);
      }
    }
  } catch { /* no dsh on PATH — the class test skips */ }
  for (const anchor of candidates) {
    if (existsSync(path.join(anchor, "dsh-sdk-jsonrpc-server", "package.json"))) return anchor;
  }
  return null;
}

test("bridge: parks the ask, answers first-wins, cancel reason surfaces in the tool error", async (t) => {
  const anchor = findDshAnchor();
  if (!anchor) {
    t.skip("no dsh install resolvable on this machine (the staging probe covers the composed runtime)");
    return;
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "questions-class-"));
  try {
    for (const f of [
      "platform-serving-questions-bridge.js",
      "platform-notify-bridge.js",
      "bot-notify.js",
      "platform-preset-bridge.js",
      "platform-tool-scope.js",
      "platform-tool-description.js",
    ]) {
      copyFileSync(path.join(TEMPLATE_DIR, f), path.join(tmp, f));
    }
    mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
    const pkgRoot = (name) => {
      try {
        return path.dirname(require.resolve(`${name}/package.json`));
      } catch {
        let dir = path.dirname(require.resolve(name));
        while (!existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
        return dir;
      }
    };
    const links = [
      [path.join(anchor, "dsh-sdk-jsonrpc-server"), "dsh-sdk-jsonrpc-server"],
      [pkgRoot("@deepseek-ai/dsh-tools"), "dsh-tools"],
      [pkgRoot("@deepseek-ai/schemastery"), "schemastery"],
      [pkgRoot("@deepseek-ai/dsh-session"), "dsh-session"],
    ];
    for (const [target, name] of links) symlinkSync(target, path.join(tmp, "node_modules", "@deepseek-ai", name));

    const mod = await import(pathToFileURL(path.join(tmp, "platform-serving-questions-bridge.js")).href);
    assert.equal(mod.name, "platform-serving-questions-server");
    assert.deepEqual(mod.inject, ["agents", "userQuestions"]);

    const sent = [];
    const listeners = {};
    const ctx = {
      on: (name, cb) => { listeners[name] = cb; return () => {}; },
      get: () => undefined,
      inject: () => ({ dispose: () => {} }),
    };
    const transportPeer = { notify: (method, params) => sent.push({ method, params }) };
    const server = new mod.ServingQuestionsSdkServer(ctx, transportPeer, {});

    // The waterfall ask: parked, notified upward with its session and batch.
    const questions = [{ id: "q1", question: "继续吗？", options: [{ label: "继续" }, { label: "跳过" }] }];
    const askPromise = listeners["user-questions/request"]({ agent: { session: { id: "wire-s1" } }, questions }, () => {});
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "userQuestion/ask");
    assert.equal(sent[0].params.sessionId, "wire-s1");
    assert.equal(sent[0].params.questions, questions);
    const askId = sent[0].params.askId;
    assert.ok(askId, "a fresh askId rides the notification");

    // First answer wins and resolves the tool with those answers.
    assert.deepEqual(await server.handleRequest("userQuestions/answer", { askId, answers: [{ id: "q1", selected: ["继续"] }] }), { accepted: true });
    assert.deepEqual(await askPromise, { answers: [{ id: "q1", selected: ["继续"] }] });
    // The late duplicate changes nothing.
    assert.equal((await server.handleRequest("userQuestions/answer", { askId, answers: [] })).accepted, false);

    // A cancel with a reason surfaces that reason as the tool error — the
    // serving layer's decline texts ride the cancel shape.
    const declinePromise = listeners["user-questions/request"]({ agent: { session: { id: "wire-s2" } }, questions }, () => {});
    await new Promise((r) => setTimeout(r, 5));
    const declineId = sent.at(-1).params.askId;
    assert.equal((await server.handleRequest("userQuestions/answer", { askId: declineId, cancelled: true, reason: "the caller cannot answer questions" })).accepted, true);
    await assert.rejects(() => declinePromise, /the caller cannot answer questions/);

    // A plain cancel keeps the cell bridge's wording.
    const plainPromise = listeners["user-questions/request"]({ agent: { session: { id: "wire-s3" } }, questions }, () => {});
    await new Promise((r) => setTimeout(r, 5));
    const plainId = sent.at(-1).params.askId;
    await server.handleRequest("userQuestions/answer", { askId: plainId, cancelled: true });
    await assert.rejects(() => plainPromise, /the user closed this question request/);

    // A request without a session-bound caller defers down the waterfall.
    let nextCalled = false;
    const deferred = listeners["user-questions/request"]({ questions }, () => { nextCalled = true; });
    assert.ok(nextCalled, "the waterfall next() ran for a sessionless ask");
    assert.equal(deferred, undefined);
    // The parent chain stays intact: unknown methods still reach the stock
    // SDK server's error.
    await assert.rejects(() => server.handleRequest("no/such-method", {}), /unknown DeepSeek Harness SDK runtime method/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 3. the harness adapter's ask lane ────────────────────────────────────────

// A fake stdio client whose prompt() emits an in-flight ask and whose
// userQuestions/answer request continues the turn to idle.
function fakeAskClient({ askId = "a-1" } = {}) {
  const calls = { requests: [], prompts: [] };
  const client = {
    calls,
    start() {},
    async initialize() { return { ok: true }; },
    async request(method, params) {
      calls.requests.push({ method, params });
      if (method === "userQuestions/answer" && client.__askSession) {
        const sessionId = client.__askSession;
        setTimeout(() => {
          client.__emit({ method: "session.event", params: { sessionId, event: { type: "assistant/message", data: { message: { content: [{ type: "text", text: "answered" }] } } } } });
          client.__emit({ method: "session.status", params: { sessionId, status: "idle" } });
        }, 0);
      }
      return { accepted: true };
    },
    subscribe() {
      const queue = [];
      let listeners = [];
      client.__emit = (notif) => {
        queue.push(notif);
        const waiting = listeners;
        listeners = [];
        for (const r of waiting) r();
      };
      return {
        next: async () => {
          for (;;) {
            const notif = queue.shift();
            if (notif) return notif;
            await new Promise((r) => listeners.push(r));
          }
        },
      };
    },
    async prompt(sessionId, blocks) {
      calls.prompts.push({ sessionId, blocks });
      setTimeout(() => {
        client.__askSession = sessionId;
        client.__emit({ method: "userQuestion/ask", params: { sessionId, askId, questions: [{ id: "q1", question: "Q?" }] } });
      }, 0);
      return "m1";
    },
    async stop() {},
  };
  return client;
}

function askAdapter({ client, turnTimeoutMs = 30_000, askGraceMs = 5_000 } = {}) {
  return new DshHarnessAdapter({
    key: "ask-test",
    spawnSpec: { profile: "platform", patchPaths: [], cwd: REPO_ROOT, env: {}, provider: "test-provider", model: "test-model", presetId: null },
    clientFactory: () => client,
    log: { log() {}, warn() {}, error() {} },
    turnTimeoutMs,
    askGraceMs,
  });
}

test("harness: capabilities claim asks", () => {
  const client = fakeAskClient();
  const adapter = askAdapter({ client });
  assert.equal(adapter.capabilities().asks, true);
});

test("harness: an in-flight ask reaches onAsk with a deadline, and the answer continues the turn", async () => {
  const client = fakeAskClient({ askId: "a-9" });
  const adapter = askAdapter({ client, turnTimeoutMs: 60_000, askGraceMs: 20_000 });
  await adapter.start();
  const startedAt = Date.now();
  const asks = [];
  const turn = adapter.turn("s1", "hi", { onAsk: (ask) => asks.push(ask) });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.length, 1);
  assert.equal(asks[0].askId, "a-9");
  assert.equal(asks[0].sessionId, "s1");
  assert.deepEqual(asks[0].questions, [{ id: "q1", question: "Q?" }]);
  // The deadline is the turn's budget end less the grace — not the bridge's
  // 15-minute fallback, and never past the budget itself.
  assert.ok(asks[0].deadlineAt <= startedAt + 60_000 && asks[0].deadlineAt >= startedAt + 30_000, "deadlineAt rides the budget window");
  const receipt = await adapter.request("userQuestions/answer", { askId: "a-9", answers: [{ id: "q1", selected: ["yes"] }] });
  assert.deepEqual(receipt, { accepted: true });
  const out = await turn;
  assert.equal(out.text, "answered");
  assert.equal(client.calls.requests.length, 1);
  assert.deepEqual(client.calls.requests[0].params.answers, [{ id: "q1", selected: ["yes"] }]);
});

test("harness: a turn without an answerer declines the ask itself, never waits", async () => {
  const client = fakeAskClient({ askId: "a-no" });
  const adapter = askAdapter({ client, turnTimeoutMs: 60_000, askGraceMs: 20_000 });
  await adapter.start();
  const out = await adapter.turn("s2", "hi", {});
  assert.equal(out.text, "answered");
  assert.equal(client.calls.requests.length, 1);
  assert.equal(client.calls.requests[0].method, "userQuestions/answer");
  assert.equal(client.calls.requests[0].params.askId, "a-no");
  assert.equal(client.calls.requests[0].params.cancelled, true);
  assert.match(client.calls.requests[0].params.reason, /caller cannot answer questions/);
});

test("harness: an unanswered ask is cancelled at the deadline and the turn still finishes", async () => {
  const client = fakeAskClient({ askId: "a-dl" });
  const adapter = askAdapter({ client, turnTimeoutMs: 900, askGraceMs: 200 });
  await adapter.start();
  const asks = [];
  const turn = adapter.turn("s3", "hi", { onAsk: (ask) => asks.push(ask) });
  const out = await turn;
  assert.equal(out.text, "answered");
  assert.equal(asks.length, 1);
  assert.ok(asks[0].deadlineAt - Date.now() <= 800, "the deadline sat inside the shortened budget");
  assert.equal(client.calls.requests.length, 1);
  assert.equal(client.calls.requests[0].params.cancelled, true);
  assert.match(client.calls.requests[0].params.reason, /ask window closed/);
});

// ── 4. the A2A surface ───────────────────────────────────────────────────────

// A manager double: turn() surfaces one ask when the caller opted in and
// holds the turn until the answer route resolves it.
function fakeAskManager() {
  const state = { turns: [], answers: [] };
  let release = null;
  const manager = {
    state,
    isPaused: () => false,
    async turn(_entry, sessionId, _text, opts = {}) {
      const hasOnAsk = typeof opts.onAsk === "function";
      state.turns.push({ sessionId, hasOnAsk });
      if (hasOnAsk) {
        opts.onAsk({
          askId: "ask-sse-1",
          sessionId,
          questions: [{ id: "q1", question: "打开用量页？", options: [{ label: "执行" }, { label: "跳过" }] }],
          deadlineAt: Date.now() + 5_000,
        });
        await new Promise((r) => (release = r));
      }
      opts.onDelta?.("答后输出");
      return { text: "最终回复", usage: null };
    },
    async answerAsk(_entry, askId, payload) {
      state.answers.push({ askId, ...payload });
      if (askId === "ask-sse-1") {
        release?.();
        release = null;
        return { accepted: true };
      }
      return { accepted: false, reason: "unknown or already-resolved ask" };
    },
  };
  return { manager, state };
}

async function askAppHarness({ keepaliveMs = 15_000 } = {}) {
  const { manager, state } = fakeAskManager();
  const app = createAgentApp({
    entry: { name: "n", description: "d", version: "1", path: "/agent/asks/x/" },
    manager,
    config: { backendToken: "tok", registryUrl: "https://mcp.example.test", askKeepaliveMs: keepaliveMs },
    log: { log() {}, warn() {}, error() {} },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = (extraHeaders = {}) =>
    fetch(base + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok", ...extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/stream", params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }], context_id: "ctx-1" } } }),
    });
  const answer = (body, token = "tok") =>
    fetch(base + "/ask-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
  return { base, rpc, answer, state, close: () => new Promise((r) => server.close(r)) };
}

function parseFrames(text) {
  const frames = [];
  let event = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      try { frames.push({ event, data: JSON.parse(line.slice(5).trim()) }); } catch { /* keepalive junk */ }
    }
  }
  return frames;
}

test("a2a: an opt-in stream carries the ask, the answer route resolves it, the turn completes", async () => {
  const h = await askAppHarness();
  try {
    const res = await h.rpc({ "X-Serving-Ask": "1" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // One pending read at a time, reused across windows: a plain race would
    // leave a dangling read() whose chunk is then lost to the next window.
    let pending = null;
    const readFor = async (ms) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return;
        pending ??= reader.read().then((c) => { pending = null; return c; });
        const chunk = await Promise.race([
          pending,
          new Promise((r) => setTimeout(() => r(null), left)),
        ]);
        if (!chunk) return;
        if (chunk.done) return;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.includes("event: done")) return;
      }
    };
    await readFor(500);
    const before = parseFrames(text);
    const askFrame = before.find((f) => f.event === "ask");
    assert.ok(askFrame, "the ask event rode the stream");
    assert.equal(askFrame.data.askId, "ask-sse-1");
    assert.deepEqual(askFrame.data.questions[0].options, [{ label: "执行" }, { label: "跳过" }]);
    assert.ok(askFrame.data.deadlineAt > Date.now(), "deadlineAt rides the ask event");
    assert.ok(!before.some((f) => f.event === "done"), "the stream stayed open while the ask pended");

    const receipt = await h.answer({ askId: "ask-sse-1", answers: [{ id: "q1", selected: ["执行"] }] });
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.body, { accepted: true });

    await readFor(2_000);
    const after = parseFrames(text);
    assert.ok(after.some((f) => f.event === "delta" && f.data.parts?.[0]?.text === "答后输出"), "deltas resumed after the answer");
    assert.ok(after.some((f) => f.event === "message"), "the final message arrived");
    assert.ok(after.some((f) => f.event === "done"), "the stream terminated after the turn");
    assert.equal(h.state.answers.length, 1);
  } finally {
    await h.close();
  }
});

test("a2a: receipts are first-wins and the route is credential-gated with a strict body shape", async () => {
  const h = await askAppHarness();
  try {
    assert.equal((await h.answer({ askId: "never-sent", answers: [] })).body.accepted, false);
    assert.equal((await h.answer({ answers: [] })).status, 400);
    assert.equal((await h.answer({ askId: "x" })).status, 400);
    assert.equal((await h.answer({ askId: "x", cancelled: true }, null)).status, 401);
  } finally {
    await h.close();
  }
});

test("a2a: a stream that did not opt in never receives the ask and never waits", async () => {
  const h = await askAppHarness();
  try {
    const res = await h.rpc({});
    const text = await res.text();
    const frames = parseFrames(text);
    assert.ok(!frames.some((f) => f.event === "ask"), "no ask event without the opt-in header");
    assert.ok(frames.some((f) => f.event === "done"), "the turn completed on its normal path");
    assert.equal(h.state.turns.length, 1);
    assert.equal(h.state.turns[0].hasOnAsk, false, "the manager saw no answerer for this turn");
  } finally {
    await h.close();
  }
});

test("a2a: keepalive comments flow only while an ask pends", async () => {
  const h = await askAppHarness({ keepaliveMs: 20 });
  try {
    const res = await h.rpc({ "X-Serving-Ask": "1" });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let done = false;
    const pump = (async () => {
      for (;;) {
        const { done: d, value } = await reader.read();
        if (d) { done = true; return; }
        chunks.push({ at: Date.now(), text: decoder.decode(value, { stream: true }) });
      }
    })();
    await new Promise((r) => setTimeout(r, 150)); // ~7 intervals of pending ask
    const answeredAt = Date.now();
    await h.answer({ askId: "ask-sse-1", answers: [{ id: "q1", selected: ["执行"] }] });
    await pump;
    assert.ok(done, "the stream ended after the answer");
    const before = chunks.filter((c) => c.text.includes(": keepalive") && c.at <= answeredAt);
    const after = chunks.filter((c) => c.text.includes(": keepalive") && c.at > answeredAt + 50);
    assert.ok(before.length >= 2, `keepalives rode the pending window (${before.length})`);
    assert.equal(after.length, 0, "no keepalive after the ask resolved");
  } finally {
    await h.close();
  }
});
