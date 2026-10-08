import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateKeyPairSync,
  sign as signJwt,
} from "node:crypto";
import { createLogtoAuth, mapGroups } from "../server/logto-auth.js";
import { signSession, verifySessionCookie, verifySignedCookie } from "../server/session.js";

const issuer = "https://logto.test/oidc";
const secret = "test-secret";
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/auth`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  end_session_endpoint: `${issuer}/logout`,
};
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
const jwks = { keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "ES256" }] };
// Logto's stock tenant key is EC P-384 and signs ES384.
const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
const p384Jwks = { keys: [{ ...p384.publicKey.export({ format: "jwk" }), kid: "p384-key", use: "sig", alg: "ES384" }] };

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

function config(overrides = {}) {
  return {
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: issuer,
    LOGTO_APP_ID: "client",
    LOGTO_APP_SECRET: secret,
    LOGTO_CLIENT_TYPE: "confidential",
    SESSION_TTL_HRS: "1",
    resolveSessionSecret: async () => secret,
    ...overrides,
  };
}

function idToken({ nonce, exp = Math.floor(Date.now() / 1000) + 60, claims = {}, key = privateKey, alg = "ES256", kid = "test-key" } = {}) {
  const header = JSON.stringify({ alg, kid, typ: "JWT" });
  const payload = JSON.stringify({
    iss: issuer,
    aud: "client",
    exp,
    nonce,
    email: "user@example.com",
    organizations: ["finddata"],
    organization_roles: ["finddata:admin"],
    ...claims,
  });
  const body = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  const hash = alg === "ES384" ? "sha384" : "sha256";
  // JWS signatures are raw r||s, not DER — sign the way a real OP does.
  const signature = signJwt(hash, Buffer.from(body), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${body}.${signature}`;
}

function responseStub({ tokenBody = {}, tokenOk = true, jwksBody = jwks } = {}) {
  return async (url) => {
    if (url === discovery.jwks_uri) return response(jwksBody);
    if (url === discovery.token_endpoint) return response(tokenBody, tokenOk);
    return response(discovery);
  };
}

function request(path = "/", headers = {}) {
  const url = new URL(path, "https://paas.test");
  return {
    headers: { host: "paas.test", cookie: "", ...headers },
    protocol: "http",
    query: Object.fromEntries(url.searchParams),
  };
}

function responseRecorder() {
  return {
    appendCalls: [],
    redirectUrl: null,
    append(name, value) {
      this.appendCalls.push({ name, value });
    },
    redirect(value) {
      this.redirectUrl = value;
    },
  };
}

function registerHandlers(auth) {
  const handlers = {};
  auth.register({
    get(path, handler) { handlers[path] = handler; },
    post(path, handler) { handlers[path] = handler; },
  });
  return handlers;
}

function sessionCookie(res) {
  return res.appendCalls.find((call) => call.name === "Set-Cookie" && call.value.startsWith("paas_session="))?.value;
}

test("confidential login and callback issue a verifiable session", async () => {
  const nonce = "nonce";
  const token = idToken({ nonce });
  const calls = [];
  const auth = await createLogtoAuth(config({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return responseStub({ tokenBody: { id_token: token } })(url, options);
  } }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responseStub({ tokenBody: { id_token: token } })(url, options);
    },
  });
  const req = request("/auth/callback?code=code&state=state");
  const stateCookie = signSession({ state: "state", nonce, exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  req.headers.cookie = `paas_oauth_state=${stateCookie}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);

  assert.equal(res.redirectUrl, "/");
  const cookie = sessionCookie(res);
  assert.ok(cookie);
  const payload = verifySessionCookie(cookie.split(";")[0].split("=").slice(1).join("="), secret);
  assert.deepEqual(payload, {
    email: "user@example.com",
    groups: ["finddata", "admin"],
    exp: payload.exp,
  });
  assert.equal(calls.some((call) => call.url === discovery.jwks_uri), true);
  const exchange = calls.find((call) => call.url === discovery.token_endpoint);
  assert.equal(exchange.options.body.get("client_secret"), secret);
  assert.equal(exchange.options.body.get("code_verifier"), null);
});

test("state mismatch redirects to auth error without a session", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const req = request("/auth/callback?code=code&state=wrong");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "right", nonce: "nonce", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);
  assert.equal(res.redirectUrl, "/?auth_error=state");
  assert.equal(sessionCookie(res), undefined);
});

test("token failure redirects to auth error without a session", async () => {
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { error: "bad code" }, tokenOk: false }),
  });
  const req = request("/auth/callback?code=code&state=state");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce: "nonce", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);
  assert.equal(res.redirectUrl, "/?auth_error=token");
  assert.equal(sessionCookie(res), undefined);
});

test("public client adds PKCE and omits client secret", async () => {
  const auth = await createLogtoAuth(config({ LOGTO_CLIENT_TYPE: "public", LOGTO_APP_SECRET: "" }), {
    fetchImpl: responseStub(),
  });
  const req = request("/auth/login");
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/login"](req, res);
  const url = new URL(res.redirectUrl);
  const state = url.searchParams.get("state");
  const stateCookie = res.appendCalls.find((call) => call.name === "Set-Cookie" && call.value.startsWith("paas_oauth_state="))?.value;
  assert.ok(stateCookie);
  const statePayload = verifySignedCookie(stateCookie.split(";")[0].split("=").slice(1).join("="), secret);
  assert.equal(statePayload.state, state);
  assert.equal(typeof statePayload.codeVerifier, "string");
});

test("public callback exchanges code without a secret", async () => {
  const nonce = "nonce";
  const verifier = "verifier";
  const calls = [];
  const auth = await createLogtoAuth(config({ LOGTO_CLIENT_TYPE: "public", LOGTO_APP_SECRET: "" }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responseStub({ tokenBody: { id_token: idToken({ nonce }) } })(url, options);
    },
  });
  const req = request("/auth/callback?code=code&state=state");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce, codeVerifier: verifier, exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);
  const exchange = calls.find((call) => call.url === discovery.token_endpoint);
  assert.equal(exchange.options.body.get("code_verifier"), verifier);
  assert.equal(exchange.options.body.get("client_secret"), null);
  assert.ok(sessionCookie(res));
});

test("sliding renewal refreshes near-expiry cookies only", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const nearExpiry = signSession({ email: "user@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 30 * 60 }, secret);
  const fresh = signSession({ email: "user@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 60 * 60 }, secret);
  const nearRes = responseRecorder();
  const freshRes = responseRecorder();
  auth.authenticate(request("/", { cookie: `paas_session=${nearExpiry}` }), nearRes);
  auth.authenticate(request("/", { cookie: `paas_session=${fresh}` }), freshRes);
  assert.ok(sessionCookie(nearRes));
  assert.equal(sessionCookie(freshRes), undefined);
});

test("organization claims map to groups", () => {
  assert.deepEqual(mapGroups({ organizations: ["finddata"], organization_roles: ["finddata:admin"] }), ["finddata", "admin"]);
});

function callbackRequest(nonce) {
  const req = request("/auth/callback?code=code&state=state");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce, exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  return req;
}

test("ES384 ID tokens verify (Logto's stock algorithm)", async () => {
  const nonce = "nonce";
  const token = idToken({ nonce, key: p384.privateKey, alg: "ES384", kid: "p384-key" });
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { id_token: token }, jwksBody: p384Jwks }),
  });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/callback"](callbackRequest(nonce), res);
  assert.equal(res.redirectUrl, "/");
  assert.ok(sessionCookie(res));
});

test("a tampered ES384 signature is rejected", async () => {
  const nonce = "nonce";
  const [header, payload, encodedSignature] = idToken({ nonce, key: p384.privateKey, alg: "ES384", kid: "p384-key" }).split(".");
  const signature = Buffer.from(encodedSignature, "base64url");
  signature[0] ^= 0x01;
  const tampered = `${header}.${payload}.${signature.toString("base64url")}`;
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { id_token: tampered }, jwksBody: p384Jwks }),
  });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/callback"](callbackRequest(nonce), res);
  assert.equal(res.redirectUrl, "/?auth_error=token");
  assert.equal(sessionCookie(res), undefined);
});

test("an unknown ID-token algorithm is rejected", async () => {
  const nonce = "nonce";
  const token = idToken({ nonce, key: p384.privateKey, alg: "HS256", kid: "p384-key" });
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { id_token: token }, jwksBody: p384Jwks }),
  });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/callback"](callbackRequest(nonce), res);
  assert.equal(res.redirectUrl, "/?auth_error=token");
  assert.equal(sessionCookie(res), undefined);
});

test("RS256 ID tokens still verify", async () => {
  const nonce = "nonce";
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaJwks = { keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-key", use: "sig", alg: "RS256" }] };
  const token = idToken({ nonce, key: rsa.privateKey, alg: "RS256", kid: "rsa-key" });
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { id_token: token }, jwksBody: rsaJwks }),
  });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/callback"](callbackRequest(nonce), res);
  assert.equal(res.redirectUrl, "/");
  assert.ok(sessionCookie(res));
});

// ── rd carry-through + ui_locales (deployment branding change) ──────────────

function loginRequest(query = {}) {
  const req = request("/auth/login");
  req.query = query;
  return req;
}

test("login carries rd and ui_locales into the state cookie and the redirect", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/login"](loginRequest({ rd: "/chat/abc123", ui_locales: "zh-CN" }), res);
  const url = new URL(res.redirectUrl);
  assert.equal(url.searchParams.get("ui_locales"), "zh-CN");
  const stateCookie = res.appendCalls.find((call) => call.name === "Set-Cookie" && call.value.startsWith("paas_oauth_state="))?.value;
  assert.ok(stateCookie);
  const statePayload = verifySignedCookie(stateCookie.split(";")[0].split("=").slice(1).join("="), secret);
  assert.equal(statePayload.rd, "/chat/abc123");
});

// Regression: the roles scope is what makes a role NAME reach mapGroups().
// Without it the ID token carries organization IDs only, and no ADMIN_GROUPS
// entry can ever match.
test("login requests both the organizations and the organization_roles scope", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/login"](loginRequest({}), res);
  const scope = new URL(res.redirectUrl).searchParams.get("scope").split(" ");
  assert.ok(scope.includes("urn:logto:scope:organizations"), res.redirectUrl);
  assert.ok(scope.includes("urn:logto:scope:organization_roles"), res.redirectUrl);
});

test("invalid rd and ui_locales values are dropped, not rejected", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/login"](loginRequest({ rd: "https://evil.example", ui_locales: "xx-TOOLONGVALUE" }), res);
  const url = new URL(res.redirectUrl);
  assert.equal(url.searchParams.get("ui_locales"), null);
  const stateCookie = res.appendCalls.find((call) => call.name === "Set-Cookie" && call.value.startsWith("paas_oauth_state="))?.value;
  const statePayload = verifySignedCookie(stateCookie.split(";")[0].split("=").slice(1).join("="), secret);
  assert.equal(statePayload.rd, "/");
});

// The web client passes window.location.href, so rd arrives absolute. It must
// survive as a path (regression: every post-login redirect landed on "/").
test("same-origin absolute rd is reduced to its path, cross-origin is dropped", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub({ tokenBody: { id_token: idToken({ nonce: "nonce" }) } }) });
  const handlers = registerHandlers(auth);
  const cases = [
    ["http://paas.test/settings/account?tab=1#x", "/settings/account?tab=1#x"],
    ["https://paas.test/settings/account", "/"], // origin is scheme+host+port: proxy misconfig → safe fallback
    ["https://evil.example/settings/account", "/"],
    ["//evil.example/x", "/"],
  ];
  for (const [rd, expected] of cases) {
    const req = request("/auth/callback?code=code&state=state");
    req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce: "nonce", rd, exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
    const res = responseRecorder();
    await handlers["/auth/callback"](req, res);
    assert.equal(res.redirectUrl, expected, `rd=${rd}`);
  }
});

test("callback redirects to the carried rd after a successful exchange", async () => {
  const nonce = "nonce";
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { id_token: idToken({ nonce }) } }),
  });
  const req = request("/auth/callback?code=code&state=state");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce, rd: "/chat/abc123", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  await registerHandlers(auth)["/auth/callback"](req, res);
  assert.equal(res.redirectUrl, "/chat/abc123");
  assert.ok(sessionCookie(res));
});

test("callback falls back to / for invalid, protocol-relative, or missing rd", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub({ tokenBody: { id_token: idToken({ nonce: "nonce" }) } }) });
  const handlers = registerHandlers(auth);
  for (const rd of ["https://evil.example", "//evil.example", undefined, "relative/path"]) {
    const req = request("/auth/callback?code=code&state=state");
    const payload = { state: "state", nonce: "nonce", exp: Math.floor(Date.now() / 1000) + 60 };
    if (rd !== undefined) payload.rd = rd;
    req.headers.cookie = `paas_oauth_state=${signSession(payload, secret)}`;
    const res = responseRecorder();
    await handlers["/auth/callback"](req, res);
    assert.equal(res.redirectUrl, "/", `rd=${rd}`);
  }
});

test("logout clears the cookie and returns through Logto with client_id (post-logout redirect honored)", async () => {
  const auth = await createLogtoAuth(config({ LOGTO_END_SESSION: "true" }), { fetchImpl: responseStub() });
  const res = responseRecorder();
  await registerHandlers(auth)["/api/auth/logout"](request("/api/auth/logout"), res);
  assert.ok(res.appendCalls.some((c) => c.name === "Set-Cookie" && c.value.startsWith("paas_session=;")), "session cookie cleared");
  const url = new URL(res.redirectUrl);
  assert.equal(`${url.origin}${url.pathname}`, `${issuer}/logout`);
  // Without client_id Logto dead-ends on its sign-out success page (probed
  // live 2026-10-03) — the parameter is the difference between "back to the
  // app, signed out" and "stuck on auth.example".
  assert.equal(url.searchParams.get("client_id"), "client");
  assert.equal(url.searchParams.get("post_logout_redirect_uri"), "http://paas.test/");
});

test("logout without end-session support just goes home", async () => {
  const auth = await createLogtoAuth(config({ LOGTO_END_SESSION: "false" }), { fetchImpl: responseStub() });
  const res = responseRecorder();
  await registerHandlers(auth)["/api/auth/logout"](request("/api/auth/logout"), res);
  assert.equal(res.redirectUrl, "/");
});
