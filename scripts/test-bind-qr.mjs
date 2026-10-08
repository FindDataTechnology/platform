// Unit tests for the mini-program's scanned bind-payload parser (openspec:
// add-mp-scan-bind, task 1.1). The parser is what stands between a camera and a
// `login-bindcode` exchange, so the interesting cases are the ones a real scan
// can actually produce: a scheme-less host, an IP-literal origin whose digits
// must not be mistaken for the code, and junk that has to come back as an error
// rather than an empty string. Runs under `npm run test:unit`.

import test from "node:test";
import assert from "node:assert/strict";
import { parseBindPayload } from "../miniapp/src/lib/bind-qr.ts";

const code = (payload) => {
  const r = parseBindPayload(payload);
  assert.ok("code" in r, `expected a code from ${JSON.stringify(payload)}, got ${JSON.stringify(r)}`);
  return r.code;
};

const rejects = (payload) => {
  const r = parseBindPayload(payload);
  assert.ok("error" in r, `expected an error from ${JSON.stringify(payload)}, got ${JSON.stringify(r)}`);
  assert.ok(r.error.length > 0, "an error must carry a message the login page can show");
  return r.error;
};

test("accepts the QR the settings page actually renders", () => {
  assert.equal(code("https://craw.finddatatech.cloud/settings/wechat-app?bindcode=482913"), "482913");
});

test("accepts a scheme-less host with the bindcode query", () => {
  assert.equal(code("craw.finddatatech.cloud/settings/wechat-app?bindcode=482913"), "482913");
});

test("accepts the bindcode query alongside other parameters", () => {
  assert.equal(code("https://example.com/settings/wechat-app?utm=1&bindcode=004821&lang=zh"), "004821");
});

test("accepts a bare six-digit payload", () => {
  assert.equal(code("482913"), "482913");
});

test("accepts a six-digit last path segment", () => {
  assert.equal(code("https://example.com/bind/482913"), "482913");
});

test("accepts a six-digit fragment", () => {
  assert.equal(code("https://example.com/bind#482913"), "482913");
});

test("trims whitespace around the payload", () => {
  assert.equal(code("  482913\n"), "482913");
  assert.equal(code("  https://example.com/settings/wechat-app?bindcode=482913  "), "482913");
});

test("an IP-literal origin does not shadow the bindcode query", () => {
  // The digit-prefix URL: reading the host as the code would redeem 123456 and
  // burn a valid code's attempt on a device-specific origin.
  assert.equal(code("http://123.45.67.89:3000/settings/wechat-app?bindcode=482913"), "482913");
  assert.equal(code("https://127.0.0.1/settings/wechat-app?bindcode=482913"), "482913");
});

test("rejects a digit-prefix URL that carries no code", () => {
  rejects("http://123.45.67.89:3000/settings/wechat-app");
});

test("rejects a bindcode query that is not six digits", () => {
  rejects("https://example.com/settings/wechat-app?bindcode=12345");
  rejects("https://example.com/settings/wechat-app?bindcode=1234567");
  rejects("https://example.com/settings/wechat-app?bindcode=abcdef");
  rejects("https://example.com/settings/wechat-app?bindcode=");
});

test("rejects bare payloads that are not six digits", () => {
  rejects("48291");
  rejects("4829130");
  rejects("48291x");
});

test("rejects free text", () => {
  rejects("欢迎使用平台");
  rejects("bindcode is 482913");
  rejects("please visit https://example.com for help");
});

test("rejects empty and whitespace-only payloads with their own message", () => {
  const blank = rejects("   \n\t ");
  assert.equal(rejects(""), blank);
  assert.notEqual(blank, rejects("hello"), "a blank scan and unreadable content read differently");
});