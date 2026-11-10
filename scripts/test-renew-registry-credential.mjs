// 续期脚本单测（openspec renew-registry-credential-automation 1.4）
//
// 不联网：所有 HTTP 用假 fetch 注入。锁四类分支——
//   1) cookie jar + 手动跟随重定向（跨域 cookie 必须自己带，否则 Experience API 必挂）
//   2) CSRF 来源（/api/auth/csrf-token），拿不到必须显式失败，不许硬着头皮 POST
//   3) 口令被拒（session.invalid_credentials）要如实冒泡，不能被吞成泛化错误
//   4) 握手判据：任一源非 200 即失败；写凭证非 2xx 即失败
import assert from "node:assert/strict";
import { test } from "node:test";

const mod = await import("../scripts/renew-registry-credential.mjs?t=" + Date.now());
const { makeJar, request, parseCsrf, mintToken, registryLogin, writeCredential, verifyServers } = mod;

function res({ status = 200, headers = {}, json, text } = {}) {
  return {
    status,
    headers: {
      get: (k) => headers[String(k).toLowerCase()] ?? null,
      getSetCookie: () => headers["set-cookie-list"] ?? [],
    },
    json: async () => json ?? {},
    text: async () => text ?? JSON.stringify(json ?? {}),
  };
}

test("cookie jar 跨跳转携带 cookie", async () => {
  const jar = makeJar();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, cookie: init.headers.cookie ?? "" });
    if (seen.length === 1) {
      return res({ status: 302, headers: { location: "https://start.test/next", "set-cookie-list": ["sid=abc; Path=/"] } });
    }
    return res({ status: 200, json: { ok: true } });
  };
  const out = await request("https://start.test/a", { jar, fetchImpl });
  assert.equal(out.res.status, 200);
  assert.equal(seen[0].cookie, "");
  assert.match(seen[1].cookie, /sid=abc/, "同一 host 的重定向必须带上第一跳拿到的 cookie");
});

test("parseCsrf 认 name/value 与 JSON 风格，垃圾返回 null", () => {
  assert.equal(parseCsrf('<input type="hidden" name="csrf_token" value="tok_123456789012345678901234" />'),
    "tok_123456789012345678901234");
  assert.equal(parseCsrf("nothing here"), null);
});

test("mintToken 走 /api/auth/csrf-token 再打 generate", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.endsWith("/api/auth/csrf-token")) return res({ status: 200, json: { csrf_token: "c" } });
    if (url.endsWith("/api/tokens/generate")) {
      return res({ status: 200, json: { success: true, tokens: { access_token: "tok-1", expires_in: 604800 } } });
    }
    return res({ status: 404, json: {} });
  };
  const token = await mintToken(makeJar(), { fetchImpl });
  assert.equal(token, "tok-1");
  assert.ok(urls[0].includes("/api/auth/csrf-token"), "必须先取 CSRF");
  assert.ok(urls[1].includes("/api/tokens/generate"));
});

test("mintToken 拿不到 CSRF 时显式失败（不裸奔 POST）", async () => {
  const fetchImpl = async () => res({ status: 403, json: { detail: "nope" } });
  await assert.rejects(mintToken(makeJar(), { fetchImpl }), /csrf-token unavailable \(403\)/);
});

test("口令被拒如实冒泡 invalid_credentials", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/sign-in") || url.endsWith("/api/auth/auth/logto")) return res({ status: 200, text: "<html>" });
    if (url.endsWith("/api/experience")) return res({ status: 204 });
    if (url.endsWith("/verification/password")) {
      return res({ status: 422, json: { code: "session.invalid_credentials" } });
    }
    return res({ status: 200 });
  };
  await assert.rejects(
    registryLogin(makeJar(), { email: "x@y.z", password: "bad", fetchImpl }),
    /session\.invalid_credentials/,
  );
});

test("写凭证非 2xx 即失败", async () => {
  const fetchImpl = async () => res({ status: 503, json: { error: "db unavailable" } });
  await assert.rejects(writeCredential(makeJar(), "tok", { fetchImpl }), /credential write failed \(503\)/);
});

test("握手判据：任一源非 200 即计入失败", async () => {
  const fetchImpl = async (url) => res({ status: url.includes("bad") ? 500 : 200, text: "ok" });
  const out = await verifyServers("tok", ["good-a", "bad-b", "good-c"], { fetchImpl });
  assert.equal(out.total, 3);
  assert.deepEqual(out.failed, ["bad-b:500"]);
});
