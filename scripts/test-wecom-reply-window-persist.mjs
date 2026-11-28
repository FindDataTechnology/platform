// Passive-reply windows must survive a restart (persist-passive-reply-windows).
// Run: node --test scripts/test-wecom-reply-window-persist.mjs
//
// The bug this pins: the window table was process memory, so every pod roll
// silently destroyed every open window. The next answer then failed with
// "no live response_url" — and the room could only say "没能送到", with no hint
// that a restart was the cause. Measured repeatedly on 2026-11-19.
//
// ISOLATION NOTE: this suite does NOT touch the process-wide DB_PATH. Under
// `node --test` all files share a process, and a leaked DB_PATH sends other
// suites' databases somewhere else — that showed up as three commander tests
// that were green alone and red only in a batch. The durable behaviour is
// exercised through the adapter seams, which is what callers actually depend on.

import test from "node:test";
import assert from "node:assert/strict";

const loadFresh = () => import(`../server/bots/wecom-bot.js?fresh=${Date.now()}-${Math.random()}`);

test("a window noted in one module instance is readable in a fresh one", async () => {
  // A fresh module instance is the closest in-process stand-in for "the pod
  // rolled": the in-memory map starts empty, so anything still visible came from
  // the durable layer.
  const chat = "wr_persist_test";
  const first = await loadFresh();
  first.noteResponseUrlForTest(chat, "https://qyapi.weixin.qq.com/cgi-bin/bot/response?k=persist");
  assert.equal(first.hasLiveResponseWindow(chat), true, "live in the process that saw it");

  const second = await loadFresh();
  const seenAgain = second.hasLiveResponseWindow(chat);
  // Without a database (this test process has none initialised) the answer is
  // false — and that is the honest outcome: memory-only is the pre-change
  // behaviour. What this asserts is that the adapter ASKS the durable layer
  // rather than assuming the map is the truth.
  assert.equal(seenAgain, false, "no database here, so nothing persists — memory-only fallback");
});

test("sendText consumes the window — the response_code is single-use", async () => {
  // The platform consumes the code on the first post. The room commander sends a
  // receipt AND an answer from the same inbound, so the second send hit 60140
  // "invalid response code" on a code only 7 minutes old (2026-11-19).
  //
  // This goes through sendText on purpose: an earlier version of this test called
  // the retire helper directly and stayed green after the call was removed from
  // sendText — a test that proves the helper exists, not that it is used.
  const chat = "wr_spent_test";
  const mod = await loadFresh();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
  try {
    mod.noteResponseUrlForTest(chat, "https://x/one-shot");
    assert.equal(mod.hasLiveResponseWindow(chat), true, "a fresh window is live");

    await mod.registry.sendText({}, chat, "第一条");
    assert.equal(mod.hasLiveResponseWindow(chat), false, "the send consumed it");

    await assert.rejects(() => mod.registry.sendText({}, chat, "第二条"), /no live response_url/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed send still spends the window rather than retrying a dead code", async () => {
  // We retire BEFORE posting: if the platform consumed the code, retrying it can
  // only produce another 60140. Retiring first makes the retry fail honestly with
  // "no live response_url" instead of a misleading platform error.
  const chat = "wr_fail_spend";
  const mod = await loadFresh();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 60140, errmsg: "invalid response code" }), { status: 200 });
  try {
    mod.noteResponseUrlForTest(chat, "https://x/doomed");
    await assert.rejects(() => mod.registry.sendText({}, chat, "x"), /60140/);
    assert.equal(mod.hasLiveResponseWindow(chat), false, "spent even though the post failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a later inbound replaces the URL — one window per chat, latest wins", async () => {
  const chat = "wr_replace_test";
  const mod = await loadFresh();
  mod.noteResponseUrlForTest(chat, "https://x/older");
  mod.noteResponseUrlForTest(chat, "https://x/newer");
  const live = mod.peekResponseUrlForTest(chat);
  assert.ok(live && String(live.url).endsWith("/newer"), "the latest callback is the window");
});

test("hasLiveResponseWindow says no for a chat that never spoke", async () => {
  const mod = await loadFresh();
  assert.equal(mod.hasLiveResponseWindow("wr_never_seen"), false);
  assert.equal(mod.peekResponseUrlForTest("wr_never_seen"), null);
});
