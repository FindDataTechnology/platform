import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearCookie, parseCookies, resolveSessionSecret, signSession, verifySessionCookie } from "../server/session.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-cookie-"));
const secret = "test-secret";

test("session cookie round-trip and cookie parsing", () => {
  const payload = { email: "a@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 60 };
  const cookie = signSession(payload, secret);
  assert.deepEqual(verifySessionCookie(cookie, secret), payload);
  assert.deepEqual(parseCookies(`other=1; paas_session=${cookie}`).paas_session, cookie);
});

test("tampered and expired cookies are rejected", () => {
  const valid = signSession({ email: "a@example.com", groups: [], exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  assert.equal(verifySessionCookie(`${valid}x`, secret), null);
  assert.equal(verifySessionCookie(signSession({ email: "a@example.com", groups: [], exp: 1 }, secret), secret, Date.now()), null);
});

test("clear cookie can match secure session cookies", () => {
  assert.match(clearCookie("paas_session", true), /; Secure$/);
});

test("generated secret persists across resolution", async () => {
  delete process.env.SESSION_SECRET;
  const first = await resolveSessionSecret({ env: { ...process.env, PLATFORM_DATA_DIR: tmp }, dataDir: tmp });
  const second = await resolveSessionSecret({ env: { ...process.env, PLATFORM_DATA_DIR: tmp }, dataDir: tmp });
  assert.equal(first, second);
  assert.equal(fs.statSync(path.join(tmp, "auth", "session-secret")).mode & 0o777, 0o600);
});
