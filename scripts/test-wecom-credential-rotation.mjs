// Regression for the prod 40001: a wecom bot's corpSecret was rotated via
// PATCH, but the running adapter kept fetching tokens with the OLD secret —
// tokenFor keyed its cache by corpId:agentId and captured the cred object in
// the fetch closure at first use, so a rotation was invisible until restart.
// The cache must track the LATEST credentials per key.

import { test } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const originalFetch = globalThis.fetch;

test("wecom sendText after a credential rotation fetches tokens with the NEW secret", async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (/gettoken/.test(String(url))) {
      const secret = new URL(String(url)).searchParams.get("corpsecret");
      if (secret !== "rotated-secret") {
        return Response.json({ errcode: 40001, errmsg: "invalid credential" });
      }
      return Response.json({ errcode: 0, access_token: "tok-new", expires_in: 7200 });
    }
    // message/send: only reachable once gettoken succeeds
    return Response.json({ errcode: 0 });
  };
  try {
    const { registry } = await import("../server/bots/wecom.js");
    const credBefore = { corpId: "corp1", agentId: "1000002", corpSecret: "old-secret", token: "t", encodingAesKey: "k" };
    // first send: old secret → gettoken 40001 → sendText throws
    await assert.rejects(
      () => registry.sendText(credBefore, "userid1", "hello"),
      /gettoken: 40001/,
    );
    assert.equal(calls.filter((u) => /gettoken/.test(u)).length, 1);

    // rotation: the SAME corpId:agentId, a NEW secret (what PATCH+reload produces)
    const credAfter = { ...credBefore, corpSecret: "rotated-secret" };
    await registry.sendText(credAfter, "userid1", "hello");
    const tokenUrls = calls.filter((u) => /gettoken/.test(u));
    assert.equal(tokenUrls.length, 2, "a fresh gettoken is attempted after rotation");
    assert.ok(tokenUrls[1].includes("corpsecret=rotated-secret"), "the retry uses the rotated secret");
    assert.ok(!calls.some((u) => /message\/send/.test(u) === false && /rotated-secret/.test(u) === false && /gettoken/.test(u) && u.includes("old-secret") && u === tokenUrls[1]), "no stale secret on the post-rotation fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
