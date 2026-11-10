// ciyuan-account-lane (tasks 1.x / 2.x / 4.1): the 词元 account binding —
// module semantics, the zero-paste connect/test/disconnect routes against a
// programmable fake 词元, the hosted-cell credential-store override, and the
// "password and login token never persist or log" invariant.
//
//   node --test scripts/test-ciyuan-account.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import yaml from "js-yaml";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ciyuan-account-"));
process.env.DB_PATH = path.join(root, "data.db");
process.env.DSH_HOME = path.join(root, "home");
process.env.LLM_API_KEY = "sk-env-llm-seed";
const SEED_KEY = ["sk-or", "deployment-seed-0000"].join("-");
const SEED_KEY_2 = ["sk-or", "deployment-seed-2222"].join("-");
process.env.LLM_PROVIDERS_STORE = path.join(root, "llm-providers.json");
fs.writeFileSync(
  process.env.LLM_PROVIDERS_STORE,
  JSON.stringify({ providers: [
    { id: "finddata", name: "finddata", baseUrl: "https://token.example/v1", apiKey: SEED_KEY, type: "openai-completions", models: [] },
    // Production names the deployment's 词元 route finddata-token (design D1):
    // the override must cover BOTH ids, whichever the deployment carries.
    { id: "finddata-token", name: "finddata-token", baseUrl: "https://token.example/v1", apiKey: SEED_KEY_2, type: "openai-completions", models: [] },
  ] }),
);

// ── programmable fake 词元 ───────────────────────────────────────────────────
const fake = { mode: { login: "ok", keys: "ok", models: 200 }, seen: [] };
const MINTED = `sk-minted-${"m".repeat(40)}`;
const fakeServer = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => { data += c; });
  req.on("end", () => {
    const body = data ? JSON.parse(data) : null;
    fake.seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body });
    const json = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/api/v1/auth/login") {
      if (fake.mode.login === "hang") return; // never answers → client timeout
      if (fake.mode.login === "401") return json(401, { message: "invalid credentials" });
      if (fake.mode.login === "500") return json(500, { message: "boom" });
      return json(200, { code: 0, data: { access_token: "jwt-login-token-ABC", user: { email: body?.email } } });
    }
    if (req.url === "/api/v1/keys") {
      if (fake.mode.keys === "500") return json(500, { message: "group not allowed sk-shouldnotleak" });
      return json(200, { code: 0, data: { id: 777, key: MINTED, name: body?.name, group_id: body?.group_id } });
    }
    if (req.url === "/v1/models") {
      return json(fake.mode.models, fake.mode.models === 200 ? { data: [] } : { error: "unauthorized" });
    }
    json(404, { error: "nope" });
  });
});
await new Promise((r) => fakeServer.listen(0, "127.0.0.1", r));
process.env.CIYUAN_API_BASE = `http://127.0.0.1:${fakeServer.address().port}`;
process.env.CIYUAN_MINT_GROUP_ID = "3";

const { registerAuth } = await import("../server/auth.js");
const db = await import("../db.js");
await db.initDb();
const ca = await import("../ciyuan-account-credentials.js");
const lc = await import("../line-credentials.js");
const refs = await import("../credential-refs.js");
const { registerCiyuanAccountRoutes, keyNameFor, extractMintedKey } = await import("../server/routes/ciyuan-account.js");
const dshProfile = await import("../dsh-profile.js");

const EMAIL = "owner@x.test";
const CIYUAN_EMAIL = "someone@findmail.com";
const PASSWORD = "S3cret-pass-word!";
const credentialsPath = dshProfile.targetPaths().credentials;
const readRefs = () => yaml.load(fs.readFileSync(credentialsPath, "utf8")).refs;

function request(app, method, p, { headers = {}, body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest({
        host: "127.0.0.1", port, path: p, method,
        headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...headers },
      }, (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { d += c; });
        res.on("end", () => server.close(() => resolve({ status: res.statusCode, raw: d, body: d ? JSON.parse(d) : null })));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
    server.on("error", reject);
  });
}

function makeCtx(overrides = {}) {
  const cloud = overrides.CLOUD_MODE !== false;
  // registerAuth derives ctx.cellUserEmail from CELL_USER_EMAIL in cloud mode —
  // the same way a hosted cell learns its owner.
  if (cloud) process.env.CELL_USER_EMAIL = EMAIL;
  else delete process.env.CELL_USER_EMAIL;
  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: cloud,
    logtoAuth: null,
    runtimeMcpOverlay: {},
    dshUpdateMcpCalls: [],
    ...overrides,
  };
  ctx.dshUpdateMcp = (overlay, groups, ownerEmail) => { ctx.dshUpdateMcpCalls.push({ overlay, groups, ownerEmail }); return Promise.resolve(); };
  registerAuth(ctx);
  registerCiyuanAccountRoutes({ ...ctx, db });
  return ctx;
}
const AS_OWNER = { "x-forwarded-email": EMAIL, "x-forwarded-groups": "" };

// Capture everything the server logs during a request to prove secrets stay out.
function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { lines.push(a.map(String).join(" ")); orig[k](...a); };
  return Promise.resolve().then(fn).finally(() => { Object.assign(console, orig); }).then((r) => ({ r, lines }));
}

// ── module ──────────────────────────────────────────────────────────────────

test("module: unbound → store → live → stale → heal → disconnect; projection never carries the key", () => {
  assert.deepEqual(ca.status(EMAIL), { connected: false, stale: false, source: null, keyName: null, mintedAt: null, ciyuanEmailMasked: null });
  assert.equal(ca.store({ email: EMAIL, token: "nope" }), null, "non sk- refused");
  const s = ca.store({ email: EMAIL, token: MINTED, keyId: 1, keyName: "yizuo-x", groupId: 3, ciyuanEmail: CIYUAN_EMAIL });
  assert.equal(s.connected, true);
  assert.equal(s.source, "account");
  assert.equal(s.ciyuanEmailMasked, "so***@findmail.com");
  assert.ok(!JSON.stringify(s).includes("sk-"), "projection has no key material");
  assert.equal(ca.liveToken(EMAIL), MINTED);
  assert.equal(ca.markStale(EMAIL), true);
  assert.equal(ca.markStale(EMAIL), false, "second stale mark is a no-op");
  assert.equal(ca.liveToken(EMAIL), null);
  assert.equal(ca.status(EMAIL).stale, true);
  assert.equal(ca.storedKeyForProbe(EMAIL), MINTED, "probe still sees the stored key");
  assert.equal(ca.markHealthy(EMAIL), true);
  assert.equal(ca.liveToken(EMAIL), MINTED);
  assert.equal(ca.disconnect(EMAIL), true);
  assert.equal(ca.status(EMAIL).connected, false);
});

test("module: account key beats a legacy pasted caller key; legacy keeps working alone (D5)", () => {
  const PASTED = `sk-pasted-${"p".repeat(30)}`;
  lc.store({ email: EMAIL, line: "wanxing-caller", token: PASTED });
  assert.equal(ca.status(EMAIL).source, "pasted-key");
  assert.equal(ca.status(EMAIL).connected, true);
  assert.equal(ca.liveToken(EMAIL), PASTED, "legacy alone → pasted key");
  ca.store({ email: EMAIL, token: MINTED, ciyuanEmail: CIYUAN_EMAIL });
  assert.equal(ca.liveToken(EMAIL), MINTED, "account wins");
  // The credential-refs table routes the wanxing-caller ref through the account module.
  const entry = refs.refFor({ credentialRef: "wanxing-caller" });
  assert.equal(entry.liveToken(EMAIL), MINTED);
  assert.equal(refs.connectPathForRef("wanxing-caller"), "/settings/connections?panel=ciyuan-account");
  // Disconnect drops whichever source is serving — the card goes fully dark.
  assert.equal(ca.disconnect(EMAIL), true);
  assert.equal(ca.liveToken(EMAIL), null, "no fallback after disconnecting the card");
  // 401 with only the legacy key flips the legacy row through the account module.
  lc.store({ email: EMAIL, line: "wanxing-caller", token: PASTED });
  assert.equal(ca.markStale(EMAIL), true);
  assert.equal(ca.liveToken(EMAIL), null);
  lc.disconnect(EMAIL, "wanxing-caller");
});

test("helpers: key name shape and mint-response envelopes", () => {
  assert.match(keyNameFor(EMAIL, new Date("2026-10-18T12:00:00Z")), /^yizuo-[0-9a-f]{8}-20261018$/);
  assert.deepEqual(extractMintedKey({ data: { id: 5, key: "sk-a" } }), { key: "sk-a", id: 5 });
  assert.deepEqual(extractMintedKey({ api_key: "sk-b" }), { key: "sk-b", id: null });
  assert.equal(extractMintedKey({ data: { key: "not-a-key" } }), null);
});

// ── routes ──────────────────────────────────────────────────────────────────

test("connect: login → mint(group 3, yizuo-* name) → stored → cell override written; secrets never logged (1.2 / 2.1)", async () => {
  fake.mode = { login: "ok", keys: "ok", models: 200 };
  fake.seen.length = 0;
  const ctx = makeCtx();
  const { r, lines } = await captureConsole(() =>
    request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL, password: PASSWORD } }),
  );
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.connected, true);
  assert.equal(r.body.source, "account");
  assert.equal(r.body.modelLaneForm, "cell");
  assert.match(r.body.keyName, /^yizuo-[0-9a-f]{8}-\d{8}$/);
  assert.ok(!r.raw.includes("sk-") && !r.raw.includes(PASSWORD) && !r.raw.includes("jwt-login-token"), "response carries no secret");

  const login = fake.seen.find((s) => s.url === "/api/v1/auth/login");
  const mint = fake.seen.find((s) => s.url === "/api/v1/keys");
  assert.deepEqual(login.body, { email: CIYUAN_EMAIL, password: PASSWORD });
  assert.equal(mint.auth, "Bearer jwt-login-token-ABC");
  assert.equal(mint.body.group_id, 3);
  assert.equal(mint.body.name, r.body.keyName);

  assert.equal(ca.liveToken(EMAIL), MINTED, "the minted key is what got stored");
  assert.equal(ctx.dshUpdateMcpCalls.length, 1, "MCP profile re-applied once");
  // Hosted cell: the credential store now carries the user's key under the 词元 ref.
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, MINTED);
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA_TOKEN, MINTED, "both provider ids overridden");
  assert.equal(readRefs().LLM_API_KEY, MINTED, "reserved env route overridden too (production serves models through it)");
  const text = fs.readFileSync(credentialsPath, "utf8");
  assert.ok(!/:\s*[>|][-+]?\s*$/m.test(text), "credential-file-format invariant holds");

  const joined = lines.join("\n");
  assert.ok(!joined.includes(PASSWORD), "password never logged");
  assert.ok(!joined.includes("jwt-login-token"), "login token never logged");
  assert.ok(!joined.includes(MINTED), "minted key never logged");
  // Nothing but the key landed in the DB either.
  const row = db.getCiyuanAccount(EMAIL);
  assert.ok(!JSON.stringify(row).includes(PASSWORD) && !JSON.stringify(row).includes("jwt-login-token"));
});

test("disconnect: local drop, override removed, seed restored (2.1 fallback)", async () => {
  const ctx = makeCtx();
  const r = await request(ctx.app, "DELETE", "/api/ciyuan-account", { headers: AS_OWNER });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, false);
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, SEED_KEY, "seed is back");
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA_TOKEN, SEED_KEY_2, "second seed is back too");
  assert.equal(readRefs().LLM_API_KEY, "sk-env-llm-seed", "env seed restored on unbind");
});

test("connect: wrong password → 401 readable, state untouched", async () => {
  fake.mode = { login: "401", keys: "ok", models: 200 };
  const ctx = makeCtx();
  const r = await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL, password: "wrong" } });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /login failed/);
  assert.equal(ca.status(EMAIL).connected, false);
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, SEED_KEY);
});

test("connect: mint failure → 502 with sanitized reason, no half state", async () => {
  fake.mode = { login: "ok", keys: "500", models: 200 };
  const ctx = makeCtx();
  const r = await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL, password: PASSWORD } });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /refused to mint/);
  assert.ok(!r.body.error.includes("sk-shouldnotleak"), "upstream sk- fragments are scrubbed");
  assert.equal(ca.status(EMAIL).connected, false);
});

test("connect: bad input and anonymous caller are rejected before any upstream call", async () => {
  fake.seen.length = 0;
  const ctx = makeCtx();
  assert.equal((await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: "nope", password: "x" } })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL } })).status, 400);
  assert.equal((await request(ctx.app, "POST", "/api/ciyuan-account/connect", { body: { email: CIYUAN_EMAIL, password: "x" } })).status, 401);
  assert.equal(fake.seen.length, 0, "no upstream traffic");
});

test("connect: 词元 unreachable → 502, state untouched", async () => {
  const saved = process.env.CIYUAN_API_BASE;
  process.env.CIYUAN_API_BASE = "http://127.0.0.1:9"; // closed port
  try {
    const ctx = makeCtx();
    const r = await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL, password: PASSWORD } });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /unreachable/);
    assert.equal(ca.status(EMAIL).connected, false);
  } finally {
    process.env.CIYUAN_API_BASE = saved;
  }
});

test("test probe: 200 keeps connected; 401 flips stale and falls back; network leaves state alone (D8)", async () => {
  fake.mode = { login: "ok", keys: "ok", models: 200 };
  const ctx = makeCtx();
  assert.equal((await request(ctx.app, "POST", "/api/ciyuan-account/test", { headers: AS_OWNER })).status, 400, "nothing bound yet");
  await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL, password: PASSWORD } });
  let r = await request(ctx.app, "POST", "/api/ciyuan-account/test", { headers: AS_OWNER });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, true);
  assert.equal(r.body.probe.detail, "HTTP 200");

  fake.mode.models = 401;
  r = await request(ctx.app, "POST", "/api/ciyuan-account/test", { headers: AS_OWNER });
  assert.equal(r.body.stale, true);
  assert.equal(r.body.connected, false);
  assert.equal(ca.liveToken(EMAIL), null);
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, SEED_KEY, "model lane fell back to the seed");

  fake.mode.models = 500;
  const before = ca.status(EMAIL);
  r = await request(ctx.app, "POST", "/api/ciyuan-account/test", { headers: AS_OWNER });
  assert.deepEqual({ connected: r.body.connected, stale: r.body.stale }, { connected: before.connected, stale: before.stale }, "5xx leaves state alone");

  fake.mode.models = 200; // upstream healed → probe heals the row and re-applies the override
  r = await request(ctx.app, "POST", "/api/ciyuan-account/test", { headers: AS_OWNER });
  assert.equal(r.body.connected, true);
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, MINTED);
  await request(ctx.app, "DELETE", "/api/ciyuan-account", { headers: AS_OWNER });
});

test("single-process form: bound account never overrides the shared store (D6)", async () => {
  fake.mode = { login: "ok", keys: "ok", models: 200 };
  const ctx = makeCtx({ CLOUD_MODE: false, cellUserEmail: "" });
  const r = await request(ctx.app, "POST", "/api/ciyuan-account/connect", { headers: AS_OWNER, body: { email: CIYUAN_EMAIL, password: PASSWORD } });
  assert.equal(r.status, 200);
  assert.equal(r.body.modelLaneForm, "shared");
  assert.equal(ca.liveToken(EMAIL), MINTED, "binding itself works (serves the MCP ref)");
  await dshProfile.ensureCredentialsStore({ cellOwnerEmail: null });
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, SEED_KEY, "shared store keeps the seed");
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA_TOKEN, SEED_KEY_2);
  await request(ctx.app, "DELETE", "/api/ciyuan-account", { headers: AS_OWNER });
});

test("ensureCredentialsStore: override only for the owning identity; unbound owner keeps the seed", async () => {
  ca.store({ email: "other@x.test", token: `sk-other-${"o".repeat(20)}`, ciyuanEmail: "o@x.test" });
  await dshProfile.ensureCredentialsStore({ cellOwnerEmail: EMAIL });
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA, SEED_KEY, "another identity's key never leaks into this cell");
  assert.equal(readRefs().LLM_PROVIDER_KEY_FINDDATA_TOKEN, SEED_KEY_2);
  ca.disconnect("other@x.test");
});

test.after(() => {
  fakeServer.close();
  fs.rmSync(root, { recursive: true, force: true });
});
