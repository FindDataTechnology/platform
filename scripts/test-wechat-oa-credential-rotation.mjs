// Regression mirroring test-wecom-credential-rotation.mjs: a wechat-oa bot's
// appSecret rotated via PATCH must be visible to the token fetch — tokenFor
// keyed its cache by appId and captured the cred object in the fetch closure
// at first use, so a rotation was invisible until restart.

import { test } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const originalFetch = globalThis.fetch;

test("wechat-oa token fetch after a credential rotation uses the NEW secret", async () => {
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (/cgi-bin\/token/.test(String(url))) {
      const secret = new URL(String(url)).searchParams.get("secret");
      if (secret !== "rotated-secret") {
        return Response.json({ errcode: 40001, errmsg: "invalid credential" });
      }
      return Response.json({ errcode: 0, access_token: "tok-new", expires_in: 7200 });
    }
    // qrcode/create: only reachable once the token call succeeds
    return Response.json({ errcode: 0, ticket: "t", url: "u" });
  };
  try {
    const { registry } = await import("../server/bots/wechat-oa.js");
    const credBefore = { appId: "wx1", appSecret: "old-secret", token: "t" };
    // first entry mint: old secret → token 40001 → qr.resolve throws
    await assert.rejects(
      () => registry.qr.resolve(credBefore),
      /token: 40001/,
    );
    assert.equal(calls.filter((u) => /cgi-bin\/token/.test(u)).length, 1);

    // rotation: the SAME appId, a NEW secret (what PATCH+reload produces)
    const credAfter = { ...credBefore, appSecret: "rotated-secret" };
    await registry.qr.resolve(credAfter);
    const tokenUrls = calls.filter((u) => /cgi-bin\/token/.test(u));
    assert.equal(tokenUrls.length, 2, "a fresh token call is attempted after rotation");
    assert.ok(tokenUrls[1].includes("secret=rotated-secret"), "the retry uses the rotated secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
