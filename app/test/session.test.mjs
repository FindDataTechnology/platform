// Session runtime unit tests (task 3.1): the token refresher's contract —
// one silent exchange on auth failure (deduped across concurrent callers),
// rebind routes to the pairing screen, a network-blip refresh neither blocks
// nor routes.

import test from "node:test";
import assert from "node:assert/strict";
import { createTokenRefresher } from "../src/lib/token-refresh.ts";

function harness(behavior) {
  const calls = [];
  const setTokens = [];
  const rebinds = [];
  const refresher = createTokenRefresher({
    silentLogin: async () => {
      calls.push(calls.length);
      const r = await behavior(calls.length);
      return r;
    },
    setToken: (t) => setTokens.push(t),
    onRebind: () => rebinds.push(true),
  });
  return { refresher, calls, setTokens, rebinds };
}

test("refresh: success stores the new token exactly once for concurrent callers", async () => {
  const { refresher, calls, setTokens } = harness(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, token: "t-new" };
  });
  const [a, b] = await Promise.all([refresher.refreshOnce(), refresher.refreshOnce()]);
  assert.deepEqual([a, b], [{ ok: true, rebind: false }, { ok: true, rebind: false }]);
  assert.equal(calls.length, 1, "concurrent callers share ONE exchange");
  assert.deepEqual(setTokens, ["t-new"]);
});

test("refresh: rebind routes to pairing exactly once; ok stays false", async () => {
  const { refresher, rebinds } = harness(async () => ({ ok: false, rebind: true }));
  const r = await refresher.refreshOnce();
  assert.deepEqual(r, { ok: false, rebind: true });
  assert.equal(rebinds.length, 1);
});

test("refresh: a non-rebind failure is a blip — no token write, no routing", async () => {
  const { refresher, setTokens, rebinds } = harness(async () => {
    throw new Error("network down");
  });
  const r = await refresher.refreshOnce();
  assert.deepEqual(r, { ok: false, rebind: false });
  assert.equal(setTokens.length, 0);
  assert.equal(rebinds.length, 0);
});

test("refresh: after settling, a NEW refresh runs again (not latched)", async () => {
  const { refresher, calls } = harness(async () => ({ ok: true, token: `t-${calls.length}` }));
  await refresher.refreshOnce();
  await refresher.refreshOnce();
  assert.equal(calls.length, 2, "the single-flight slot is released after settle");
});
