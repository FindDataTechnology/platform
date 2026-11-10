// Digest read timeout (fix-digest-adaptive-embed-deadline, task 2.3).
//
// The caller's budget used to be a flat 5s, sitting BELOW fd-memory's own
// embed budget (8000ms). When the embedding upstream was slow, fd-memory was
// still working while we had already hung up — the block was lost outright
// instead of arriving in its degraded (keyword) form. These tests pin:
//   · the default is 9s (above the 8s callee budget) and configurable
//   · nonsense values fall back to the default rather than to 0/NaN
//   · the value is clamped to a sane band
//   · a slow-but-under-budget call actually returns the block (the behaviour
//     the old flat 5s destroyed)
//   · the same timeout serves the chat lane and the cluster lane (one seam)
//
//   node --test scripts/test-digest-timeout-config.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clusterMemoryFor, digestTimeoutMs, chatMemoryBlockFor } from "@finddatatechnology/yongyi-client";

const realFetch = globalThis.fetch;

// fd-memory stand-in that answers /digest after `delayMs`. Used to prove the
// caller waits long enough; a 5s-capped caller would have aborted already.
function stubMemory({ delayMs = 0, digest = "【工作记忆】慢车道也能拿到块" } = {}) {
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes("memory.stub")) return realFetch(url, init);
    seen.push({ url: u, method: init.method ?? "GET" });
    const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/admin/mint")) return json(200, { token: "person-token" });
    if (u.includes("/digest")) {
      // Honour the abort signal like a real fetch: without this the stub would
      // resolve after the caller already gave up, hiding exactly the case the
      // misconfiguration test needs to observe.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal?.addEventListener?.("abort", () => {
          clearTimeout(t);
          reject(new Error("The operation was aborted"));
        });
      });
      return json(200, { digest });
    }
    if (u.includes("/pages")) return json(200, { pages: [] });
    return json(404, { error: "unexpected" });
  };
  return { seen, restore: () => { globalThis.fetch = realFetch; } };
}

const baseEnv = () => ({
  CELL_MEMORY_ENABLED: "1",
  CELL_MEMORY_URL: "http://memory.stub",
  CELL_MEMORY_PLATFORM_TOKEN: "platform-token",
  CELL_MEMORY_DATA: fs.mkdtempSync(path.join(os.tmpdir(), "cm-timeout-")),
});

test("default timeout sits above fd-memory's 8000ms embed budget", () => {
  assert.equal(digestTimeoutMs({}), 9000, "an empty env must still be patient enough");
  assert.ok(digestTimeoutMs({}) > 8000, "must exceed the callee's internal budget, or we hang up first");
});

test("explicit configuration is honoured", () => {
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "12000" }), 12000);
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "6500" }), 6500);
});

test("nonsense values fall back to the default instead of 0/NaN", () => {
  for (const bad of ["", "abc", "0", "-5", "NaN"]) {
    assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: bad }), 9000, `value ${JSON.stringify(bad)} must not disable the timeout`);
  }
});

test("the timeout is clamped to a sane band", () => {
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "10" }), 500, "floor keeps it meaningful");
  assert.equal(digestTimeoutMs({ CELL_MEMORY_DIGEST_TIMEOUT_MS: "999999" }), 60_000, "ceiling keeps a hung callee from pinning a turn");
});

test("a slow digest under the budget still returns the block", async () => {
  // 6s: past the old flat 5s cap, inside the 9s default. This is exactly the
  // case the old code lost.
  const mem = stubMemory({ delayMs: 6000 });
  try {
    const env = baseEnv();
    const cm = await clusterMemoryFor(env, "bob@x");
    assert.ok(cm, "memory lane must come up against the stub");
    const t0 = Date.now();
    const d = await cm.readDigest("c1", "本周报怎么出");
    const ms = Date.now() - t0;
    assert.ok(d?.digest, "block arrived instead of being dropped");
    assert.ok(ms >= 5800 && ms < 9000, `waited ${ms}ms — long enough for a 6s callee, under the 9s budget`);
  } finally {
    mem.restore();
  }
});

test("chat lane shares the same timeout seam", async () => {
  // Same stub latency through the chat entry point: if the chat lane had its
  // own 5s constant, this would come back empty.
  const mem = stubMemory({ delayMs: 6000, digest: "【工作记忆】chat 面同一条缝" });
  try {
    const env = baseEnv();
    const { block } = await chatMemoryBlockFor("bob@x", "本周报怎么出", env);
    assert.match(block, /chat 面同一条缝/, "chat lane must not cut at 5s either");
  } finally {
    mem.restore();
  }
});

test("configuring below the callee budget is observable as a timeout, not silence", async () => {
  // Deliberate misconfiguration: 800ms caller vs a 6s callee. readDigest's
  // contract is to THROW on abort — the ladder above it is what degrades to
  // the title list. What matters here is that we stop early (loudly) rather
  // than hanging on a callee that is still working.
  const mem = stubMemory({ delayMs: 6000 });
  try {
    const env = { ...baseEnv(), CELL_MEMORY_DIGEST_TIMEOUT_MS: "800" };
    const cm = await clusterMemoryFor(env, "bob@x");
    const t0 = Date.now();
    await assert.rejects(() => cm.readDigest("c1", "x"), /abort/i, "the caller gives up with a timeout");
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `gave up in ${ms}ms, did not wait for the callee`);
  } finally {
    mem.restore();
  }
});
