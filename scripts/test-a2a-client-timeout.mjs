#!/usr/bin/env node
// ── A2A call deadline tests (fix-a2a-call-timeout)
//
// The defect this pins down: runA2aTurn's only bound was
//   setTimeout(() => signal?.abort(), timeoutMs)
// — a silent no-op when the caller passed no signal (the delegated lane hung
// forever) and an uncaught TypeError when one WAS passed (AbortSignal has no
// abort(); no uncaughtException handler in this repo → process exit).
//
// Three shapes, matching the three real callers:
//   • no signal              → cron-runner/runA2aRemoteTurn (delegated turn)
//   • signal, bound first    → gateway/zhiyu/agent-lane (never aborted by caller)
//   • signal, caller first   → agent-session/streamA2aChat (user stop)
//
//   node --test scripts/test-a2a-client-timeout.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "a2a-timeout-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");

const { runA2aTurn, DEFAULT_A2A_TIMEOUT_MS } = await import("../server/a2a-client.js");

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const TOKENS = { gatewayToken: "gw-token", agentToken: "agent-token" };

// A remote that accepts the POST, reads it, and never answers — the half-dead
// peer the bound exists for.
function blackHoleServer() {
  const seen = [];
  const server = createServer((req, _res) => {
    seen.push(req.url);
    req.resume();
    // never write, never end: the socket stays open
  });
  return { server, seen };
}

// A well-behaved SSE remote: one delta frame carrying the whole text, then the
// final `message` frame.
function sseServer(text) {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: delta\ndata: ${JSON.stringify({ parts: [{ kind: "text", text }] })}\n\n`);
    res.write(`event: message\ndata: ${JSON.stringify({ parts: [{ kind: "text", text }] })}\n\n`);
    res.end();
  });
  return server;
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}/agent/probe/`;
}

async function close(server) {
  server.closeAllConnections?.();
  server.close();
}

// The crash we are guarding against happens INSIDE a timer callback, so it
// surfaces as a process-level uncaught exception, not as a rejected promise.
// Listen for it instead of letting the runner die on it.
function watchUncaught() {
  const hits = [];
  const onUncaught = (e) => hits.push(`${e?.name}: ${e?.message}`);
  process.on("uncaughtException", onUncaught);
  return {
    hits,
    stop: () => {
      process.off("uncaughtException", onUncaught);
      assert.deepEqual(hits, [], "no uncaught exception may escape the deadline path");
    },
  };
}

// A hanging call must FAIL within seconds, not wedge the run: `assert.rejects`
// has no timeout of its own, and a hang would mask exactly the regression this
// file exists for (the bound silently doing nothing).
function noHang(promise, ms = 2000) {
  let t;
  const watchdog = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("HUNG: the call never settled")), ms);
    t.unref?.();
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(t));
}

test("defaults stay at 300s — the bound is a named constant, not a literal", () => {
  assert.equal(DEFAULT_A2A_TIMEOUT_MS, 300_000);
});

test("no signal: the bound ends the call instead of hanging (delegated shape)", async () => {
  const watcher = watchUncaught();
  const { server } = blackHoleServer();
  const url = await listen(server);
  const started = Date.now();
  try {
    // Also the discriminator for "budget is honored, not replaced by the 300s
    // default": a fixed-default regression ends at 300s, a no-op ends never.
    await assert.rejects(
      () => noHang(runA2aTurn(url, "ping", { ...TOKENS, timeoutMs: 120 })),
      (err) => {
        assert.equal(err.code, "a2a_timeout");
        assert.equal(err.timeoutMs, 120);
        assert.match(err.message, /timeout/i);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `bound of 120ms must fire well under a second, took ${elapsed}ms`);
  } finally {
    await close(server);
    watcher.stop();
  }
});

test("signal given, bound fires first: structured failure, no uncaught TypeError", async () => {
  const watcher = watchUncaught();
  const { server } = blackHoleServer();
  const url = await listen(server);
  const ac = new AbortController(); // never aborted by the caller — the zhiyu shape
  try {
    await assert.rejects(
      () => noHang(runA2aTurn(url, "ping", { ...TOKENS, signal: ac.signal, timeoutMs: 120 })),
      (err) => {
        assert.equal(err.code, "a2a_timeout");
        // The old shape threw `signal?.abort is not a function` out of the
        // timer; the caller signal must be left untouched.
        assert.equal(ac.signal.aborted, false);
        return true;
      },
    );
  } finally {
    await close(server);
    watcher.stop();
  }
});

test("caller aborts first: raw AbortError, and the bound stays quiet afterwards", async () => {
  const watcher = watchUncaught();
  const { server } = blackHoleServer();
  const url = await listen(server);
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 20);
  try {
    await assert.rejects(
      () => noHang(runA2aTurn(url, "ping", { ...TOKENS, signal: ac.signal, timeoutMs: 300 })),
      (err) => {
        // Human chat treats "user stopped" as silence: it must NOT read as a
        // timeout, or every manual stop would land a timeout error in the UI.
        assert.notEqual(err.code, "a2a_timeout");
        assert.equal(err.name, "AbortError");
        return true;
      },
    );
    // Sit past the would-be bound: a second abort action here used to be the
    // crash (and would be a double-settle if it ever resolved).
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(Date.now() - started < 1000);
  } finally {
    await close(server);
    watcher.stop();
  }
});

test("already-aborted signal: fails fast without touching the wire", async () => {
  const { server, seen } = blackHoleServer();
  const url = await listen(server);
  const ac = new AbortController();
  ac.abort();
  try {
    await assert.rejects(
      () => runA2aTurn(url, "ping", { ...TOKENS, signal: ac.signal, timeoutMs: 5_000 }),
      (err) => {
        assert.notEqual(err.code, "a2a_timeout");
        return true;
      },
    );
    assert.deepEqual(seen, [], "an already-cancelled call must not reach the remote");
  } finally {
    await close(server);
  }
});

test("happy path unchanged: delta + message aggregate to { text }, onDelta fires", async () => {
  const server = sseServer("hello world");
  const url = await listen(server);
  const deltas = [];
  try {
    const out = await runA2aTurn(url, "hi", {
      ...TOKENS,
      contextId: "c1",
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      onDelta: (d) => deltas.push(d),
    });
    assert.deepEqual(out, { text: "hello world" });
    assert.deepEqual(deltas, ["hello world"]);
  } finally {
    await close(server);
  }
});

test("depth header contract untouched: delegated carries 1, human sends none", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers["x-delegation-depth"] ?? null);
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: message\ndata: ${JSON.stringify({ parts: [{ kind: "text", text: "ok" }] })}\n\n`);
    res.end();
  });
  const url = await listen(server);
  try {
    await runA2aTurn(url, "a", { ...TOKENS, timeoutMs: 5_000 });
    await runA2aTurn(url, "b", { ...TOKENS, depth: 1, timeoutMs: 5_000 });
    assert.deepEqual(seen, [null, "1"]);
  } finally {
    await close(server);
  }
});
