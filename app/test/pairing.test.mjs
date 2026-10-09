// Pairing client unit tests (task 2.2): the fake transport stands in for an
// instance and asserts the client's contract shapes — capability probing's
// three states, pair's 401/503/ok, silent login's rebind semantics, revoke,
// and the QR payload parser.

import test from "node:test";
import assert from "node:assert/strict";
import { createPairingClient, parsePairingQr } from "../src/lib/pairing.ts";

function fakeServer({ config, pair, challenge, login, del } = {}) {
  const calls = [];
  const transport = async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
    const respond = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
    });
    if (path === "/api/config") return respond(200, config ?? { capabilities: { devicePairing: true } });
    if (path === "/api/app/pair") return pair(respond, calls.at(-1).body);
    if (path === "/api/app/challenge") return challenge(respond);
    if (path === "/api/app/login") return login(respond, calls.at(-1).body);
    if (path.startsWith("/api/app/bind/")) return (del ?? (() => respond(200, { ok: true })))(respond, path);
    return respond(404, { error: "no route" });
  };
  return { transport, calls };
}

const identity = { deviceId: "dev-1", sign: (m) => `sig(${m})` };

test("probe: supported / older-server / unknown(401) / unreachable", async () => {
  const supported = createPairingClient(fakeServer({ config: { capabilities: { devicePairing: true } } }).transport);
  assert.equal(await supported.probeConfig(), "supported");
  const older = createPairingClient(fakeServer({ config: {} }).transport);
  assert.equal(await older.probeConfig(), "older-server");
  // forward-auth shape: anonymous /api/config answers 401 — capabilities
  // unknown, pairing still proceeds (the app's degrade philosophy).
  const refused = createPairingClient(
    async () => ({ ok: false, status: 401, json: async () => ({ error: "Authentication required" }) }),
  );
  assert.equal(await refused.probeConfig(), "unknown");
  const dead = createPairingClient(async () => {
    throw new Error("fetch failed");
  });
  assert.equal(await dead.probeConfig(), "unknown");
});

test("pair: ok carries token+email; 401 is the bad-code signal; 503 = unconfigured", async () => {
  const ok = fakeServer({ pair: (r) => r(200, { token: "t1", email: "a@x.com" }) });
  const result = await createPairingClient(ok.transport).pair({
    code: "123456",
    deviceId: "dev-1",
    publicKey: "k".repeat(43),
    label: "test",
  });
  assert.deepEqual(result, { ok: true, token: "t1", email: "a@x.com" });
  // The wire body uses the server's field names.
  assert.deepEqual(ok.calls[0].body, { code: "123456", deviceId: "dev-1", pubkey: "k".repeat(43), label: "test" });

  const bad = fakeServer({ pair: (r) => r(401, { error: "绑定码无效或已过期" }) });
  assert.equal((await createPairingClient(bad.transport).pair({ code: "0", deviceId: "d", publicKey: "k", label: "" })).status, 401);

  const inert = fakeServer({ pair: (r) => r(503, { error: "not configured" }) });
  assert.equal((await createPairingClient(inert.transport).pair({ code: "1", deviceId: "d", publicKey: "k", label: "" })).status, 503);
});

test("silentLogin: happy path signs `deviceId:nonce`; rebind detected at both steps", async () => {
  const good = fakeServer({
    challenge: (r) => r(200, { nonce: "n0" }),
    login: (r, body) => {
      assert.equal(body.signature, "sig(dev-1:n0)"); // the pinned message format
      return r(200, { token: "t2", email: "a@x.com" });
    },
  });
  const result = await createPairingClient(good.transport).silentLogin(identity);
  assert.deepEqual(result, { ok: true, token: "t2", email: "a@x.com" });

  const revokedAtChallenge = fakeServer({ challenge: (r) => r(401, { error: "binding_required" }) });
  assert.equal((await createPairingClient(revokedAtChallenge.transport).silentLogin(identity)).rebind, true);

  const revokedAtLogin = fakeServer({ challenge: (r) => r(200, { nonce: "n1" }), login: (r) => r(401, { error: "binding_required" }) });
  assert.equal((await createPairingClient(revokedAtLogin.transport).silentLogin(identity)).rebind, true);

  const badSignature = fakeServer({ challenge: (r) => r(200, { nonce: "n2" }), login: (r) => r(401, { error: "签名验证失败" }) });
  const failed = await createPairingClient(badSignature.transport).silentLogin(identity);
  assert.equal(failed.ok, false);
  assert.equal(failed.rebind, false); // signature failure ≠ revoked — no re-pair loop
});

test("revokeSelf: DELETE with the device's own bearer", async () => {
  const srv = fakeServer({});
  assert.equal(await createPairingClient(srv.transport).revokeSelf("t1", "dev-1"), true);
  assert.equal(srv.calls[0].method, "DELETE");
  assert.equal(srv.calls[0].path, "/api/app/bind/dev-1");
});

test("parsePairingQr: URL carries base+code; bare digits; junk is empty", () => {
  assert.deepEqual(parsePairingQr("https://yizuo.example.com/settings/devices?bindcode=482913"), {
    baseUrl: "https://yizuo.example.com",
    code: "482913",
  });
  assert.deepEqual(parsePairingQr("482913"), { code: "482913" });
  assert.deepEqual(parsePairingQr("https://example.com/no-code"), {});
  assert.deepEqual(parsePairingQr("hello"), {});
});
