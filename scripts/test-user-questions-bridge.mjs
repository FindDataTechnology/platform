// The user-questions dsh bridge (dsh-profile-template/platform-user-questions-
// bridge.js) against a FAKE transport and FAKE ctx (add-user-questions, task
// 1.1 + 1.3). Asserted directly: ask → `userQuestion/ask` notification →
// `userQuestions/answer` resolves the parked promise; cancellation rejects;
// first-wins (a second answer for a resolved ask is refused); shutdown
// rejects everything still pending; the fallback timer cancels an unanswered
// ask; a session-less caller is refused.
//
// The bridge imports @deepseek-ai/dsh-sdk-jsonrpc-server, which is only
// installed inside the dsh contracts scratch tree (or a materialized
// dsh-matrix). The test loads the plugin the generated profile does — file
// beside its parent bridges, package symlinked in — and skips cleanly when no
// install exists to link against.

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const TEMPLATE_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../dsh-profile-template");
const REPO_ROOT = path.resolve(TEMPLATE_DIR, "..");

// Where a real @deepseek-ai/dsh-sdk-jsonrpc-server install can be found: the
// dsh-matrix checkout first, then the contracts scratch tree cache.
function locateSdkServerPackage() {
  const candidates = [
    path.join(REPO_ROOT, "dsh-matrix", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server"),
  ];
  const cacheRoot = path.join(REPO_ROOT, "node_modules", ".cache", "dsh-contracts-tree");
  if (existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot)) {
      candidates.push(path.join(cacheRoot, entry, "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server"));
    }
  }
  return candidates.find((p) => existsSync(path.join(p, "package.json"))) ?? null;
}

// Load the bridge the way the generated profile does: this bridge + the
// permission bridge + the preset bridge side by side, with the SDK server
// package symlinked into a local node_modules. `fallbackMs` seeds
// DSH_ASK_FALLBACK_MS before the module import (it is read at load time).
async function loadBridge({ fallbackMs } = {}) {
  const sdkServerDir = locateSdkServerPackage();
  if (sdkServerDir === null) return { mod: null };
  if (fallbackMs !== undefined) process.env.DSH_ASK_FALLBACK_MS = String(fallbackMs);
  const tmp = mkdtempSync(path.join(tmpdir(), "user-questions-bridge-"));
  for (const file of [
    "platform-preset-bridge.js",
    "platform-tool-scope.js",
    "platform-permission-bridge.js",
    "platform-user-questions-bridge.js",
  ]) {
    copyFileSync(path.join(TEMPLATE_DIR, file), path.join(tmp, file));
  }
  mkdirSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true });
  // The tmp profile sits outside the repo, so every @deepseek-ai import the
  // bridges make needs a symlink here: the SDK server package (only installed
  // inside the dsh trees) plus the repo-root-resolvable two.
  for (const [pkg, source] of [
    ["dsh-sdk-jsonrpc-server", sdkServerDir],
    ["schemastery", path.dirname(require.resolve("@deepseek-ai/schemastery/package.json"))],
    ["dsh-session", path.dirname(require.resolve("@deepseek-ai/dsh-session/package.json"))],
  ]) {
    symlinkSync(source, path.join(tmp, "node_modules", "@deepseek-ai", pkg));
  }
  const mod = await import(pathToFileURL(path.join(tmp, "platform-user-questions-bridge.js")).href);
  return { mod, tmp };
}

// The base server only touches ctx.on(...). The user-questions layer registers
// its answerer as a scoped-listener on the "user-questions/request" waterfall
// (0.2.0 D7.5 — the seam that REPLACED ctx.userQuestions.registerProvider).
//
// This fake models the REAL seam: it captures the listener the bridge installs
// and exposes ask() to drive it, exactly as the dsh scope would. Faking
// registerProvider (the retired 0.1.x shape) is what let the 2026-10-13 image
// regression ship: the unit suite passed against a bridge that could not boot.
function fakeCtx() {
  let listener = null;
  const ctx = {
    on(event, fn) {
      if (event === "user-questions/request") listener = fn;
      return () => {};
    },
  };
  return {
    ctx,
    // The captured answerer (null when the bridge registered nothing — the
    // failure mode this suite exists to catch).
    listener() {
      return listener;
    },
    // Drive the installed answerer. A caller that never gets a listener means
    // the bridge registered on a seam this dsh does not emit → hard failure,
    // not a silent pass.
    ask(request) {
      if (listener === null) {
        throw new Error('bridge installed no "user-questions/request" listener (seam mismatch)');
      }
      return listener(request, () => undefined);
    },
  };
}

function fakeTransport() {
  const notifications = [];
  return {
    notifications,
    transport: { notify: (method, payload) => notifications.push({ method, payload }) },
  };
}

test("ask parks, notifies, and resolves on answer; late answers are refused", async (t) => {
  const { mod } = await loadBridge();
  if (mod === null) return t.skip("no dsh install to link the SDK server package against");
  const fake = fakeCtx();
  const { transport, notifications } = fakeTransport();
  const server = new mod.UserQuestionsSdkServer(fake.ctx, transport, {});

  const questions = [{ id: "q1", question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }];
  const pending = fake.ask({ questions, agent: { session: { id: "sess-1" } } });
  await new Promise((r) => setImmediate(r));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "userQuestion/ask");
  const { sessionId, askId, questions: sent } = notifications[0].payload;
  assert.equal(sessionId, "sess-1");
  assert.equal(askId, notifications[0].payload.askId);
  assert.deepEqual(sent, questions);

  const out = await server.handleRequest("userQuestions/answer", {
    askId,
    answers: [{ id: "q1", selected: ["Yes"] }],
  });
  assert.deepEqual(out, { accepted: true });
  assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["Yes"] }] });

  // First-wins: the resolved ask is gone; a second submission changes nothing.
  const late = await server.handleRequest("userQuestions/answer", {
    askId,
    answers: [{ id: "q1", selected: ["No"] }],
  });
  assert.equal(late.accepted, false);
  assert.deepEqual(await pending, { answers: [{ id: "q1", selected: ["Yes"] }] });
});

test("cancellation rejects the parked ask with a model-readable error", async (t) => {
  const { mod } = await loadBridge();
  if (mod === null) return t.skip("no dsh install to link the SDK server package against");
  const fake = fakeCtx();
  const { transport, notifications } = fakeTransport();
  const server = new mod.UserQuestionsSdkServer(fake.ctx, transport, {});
  const pending = fake.ask({ questions: [{ id: "q", question: "?" }], agent: { session: { id: "s" } } });
  await new Promise((r) => setImmediate(r));
  const { askId } = notifications[0].payload;
  const out = await server.handleRequest("userQuestions/answer", { askId, cancelled: true });
  assert.equal(out.accepted, true);
  await assert.rejects(pending, /closed this question/);
});

test("shutdown rejects everything still pending", async (t) => {
  const { mod } = await loadBridge();
  if (mod === null) return t.skip("no dsh install to link the SDK server package against");
  const fake = fakeCtx();
  const { transport } = fakeTransport();
  const server = new mod.UserQuestionsSdkServer(fake.ctx, transport, {});
  const pending = fake.ask({ questions: [{ id: "q", question: "?" }], agent: { session: { id: "s" } } });
  await new Promise((r) => setImmediate(r));
  await server.shutdown();
  await assert.rejects(pending, /shutting down/);
});

test("the fallback timer cancels an unanswered ask", async (t) => {
  const { mod } = await loadBridge({ fallbackMs: 60 });
  if (mod === null) return t.skip("no dsh install to link the SDK server package against");
  const fake = fakeCtx();
  const { transport } = fakeTransport();
  new mod.UserQuestionsSdkServer(fake.ctx, transport, {});
  const pending = fake.ask({ questions: [{ id: "q", question: "?" }], agent: { session: { id: "s" } } });
  await assert.rejects(pending, /ask window closed/);
});

test("a session-less caller is delegated down the waterfall (not answered)", async (t) => {
  const { mod } = await loadBridge();
  if (mod === null) return t.skip("no dsh install to link the SDK server package against");
  const fake = fakeCtx();
  const { transport, notifications } = fakeTransport();
  new mod.UserQuestionsSdkServer(fake.ctx, transport, {});
  // 0.2.0: a request with no session-bound caller returns next() so the seam's
  // own NO_PROVIDER error names the real condition — the bridge must not invent
  // a bridge-shaped rejection, and must not park the ask.
  let delegated = false;
  const listener = fake.listener();
  assert.notEqual(listener, null, "bridge must install the 0.2.0 seam listener");
  const out = await listener({ questions: [{ id: "q", question: "?" }] }, () => { delegated = true; });
  assert.equal(delegated, true, "session-less ask must delegate via next()");
  assert.equal(out, undefined);
  assert.equal(notifications.length, 0, "a delegated ask must not notify the host");
});

test("the bridge registers on the 0.2.0 seam, not the retired provider API", async (t) => {
  const { mod } = await loadBridge();
  if (mod === null) return t.skip("no dsh install to link the SDK server package against");
  const fake = fakeCtx();
  const { transport } = fakeTransport();
  new mod.UserQuestionsSdkServer(fake.ctx, transport, {});
  // The exact regression that blocked the 2026-10-13 image: the bridge called
  // ctx.userQuestions.registerProvider, which 0.2.0-rc.2 does not expose → the
  // plugin failed to activate → /api/ready never went green. A fake that accepts
  // EITHER shape cannot catch that, so this asserts the seam directly.
  assert.notEqual(fake.listener(), null,
    'bridge must install a "user-questions/request" listener (0.2.0 seam)');
});
