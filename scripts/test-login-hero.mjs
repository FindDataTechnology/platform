// loginHero branding (openspec: add-login-hero). Route-level tests over a
// fake db: GET resolution (stored → env → null with WARN degradation), PUT
// structural validation (whole-write-or-nothing), clear semantics, and the
// locale closed set kept in lockstep with the web's SUPPORTED_LOCALES. The
// web-side resolution chain (locale → en → none, links independence) is
// tested by importing web/src/lib/login-hero.ts directly (Node type
// stripping) so the chain has exactly one implementation and one test.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerMiscRoutes } from "../server/routes/misc.js";
import { SUPPORTED_LOCALES } from "../web/src/i18n/config.ts";
import { parseLoginHero, resolveLoginHero } from "../web/src/lib/login-hero.ts";

function request(app, path, { method = "GET", body } = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => { data += c; });
          res.on("end", () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    server.on("error", reject);
  });
}

function makeApp() {
  const store = new Map();
  const db = {
    isDbReady: () => true,
    getDeploymentConfig: (k) => (store.has(k) ? store.get(k) : null),
    setDeploymentConfig: (k, v) => store.set(k, v),
    clearDeploymentConfig: (k) => store.delete(k),
  };
  const app = express();
  app.use(express.json());
  registerMiscRoutes({ app, catalog: {}, db, cron: {}, authEnabled: false, isAdminUser: () => true });
  return { app, store };
}

const validHero = {
  "zh-CN": {
    title: "壹座 · 你的 AI 执行底座",
    subtitle: "开源、全平台、本地优先",
    points: ["网页 / 小程序 / 桌面同源", "数据留在本地"],
    links: [{ label: "官网", url: "https://www.finddatatech.cloud" }],
  },
};

test("GET /api/config reports loginHero null by default", async () => {
  const { app } = makeApp();
  const res = await request(app, "/api/config");
  assert.equal(res.status, 200);
  assert.equal(res.json.loginHero, null);
});

test("admin PUT stores a valid loginHero; GET reflects it without restart", async () => {
  const { app } = makeApp();
  const put = await request(app, "/api/config/branding", { method: "PUT", body: { loginHero: validHero } });
  assert.equal(put.status, 200);
  const cfg = await request(app, "/api/config");
  assert.deepEqual(cfg.json.loginHero, validHero);
});

test("malformed hero structures are rejected whole-write", async () => {
  const bad = [
    { loginHero: "nope" },
    { loginHero: [] },
    { loginHero: {} }, // empty map is a CLEAR (handled separately) — use an unknown-locale map instead
    { loginHero: { "zh-TW": { title: "x" } } }, // unsupported locale key
    { loginHero: { en: "not an object" } },
    { loginHero: { en: {} } }, // contentless entry
    { loginHero: { en: { title: 42 } } },
    { loginHero: { en: { points: ["a", "b", "c", "d", "e"] } } }, // >4 points
    { loginHero: { en: { points: ["x".repeat(121)] } } }, // point too long
    { loginHero: { en: { links: [{ label: "ok", url: "/relative" }] } } }, // relative url
    { loginHero: { en: { links: [{ label: "x".repeat(41), url: "https://a.example" }] } } }, // label bound
    { loginHero: { en: { imageUrl: "ftp://nope/icon.png" } } }, // non-http image
  ];
  for (const [i, body] of bad.entries()) {
    if (body.loginHero && typeof body.loginHero === "object" && !Array.isArray(body.loginHero) && Object.keys(body.loginHero).length === 0) continue;
    const { app, store } = makeApp();
    // A valid sibling field must NOT persist when loginHero is invalid.
    const res = await request(app, "/api/config/branding", { method: "PUT", body: { companyName: "X", ...body } });
    assert.equal(res.status, 400, `case ${i} should 400: ${JSON.stringify(body)}`);
    assert.match(res.json.error, /loginHero/);
    assert.equal(store.size, 0, `case ${i} must not persist anything`);
  }
});

test("PUT loginHero=null / '' / {} clears back to the env fallback", async () => {
  process.env.LOGIN_HERO = JSON.stringify({ en: { title: "env hero" } });
  try {
    for (const clear of [null, "", {}]) {
      const { app } = makeApp();
      const seed = await request(app, "/api/config/branding", { method: "PUT", body: { loginHero: validHero } });
      assert.equal(seed.status, 200);
      const res = await request(app, "/api/config/branding", { method: "PUT", body: { loginHero: clear } });
      assert.equal(res.status, 200);
      const cfg = await request(app, "/api/config");
      assert.deepEqual(cfg.json.loginHero, { en: { title: "env hero" } }, `clear form ${JSON.stringify(clear)}`);
    }
  } finally {
    delete process.env.LOGIN_HERO;
  }
});

test("omitted loginHero leaves stored value untouched", async () => {
  const { app } = makeApp();
  await request(app, "/api/config/branding", { method: "PUT", body: { loginHero: validHero } });
  await request(app, "/api/config/branding", { method: "PUT", body: { companyName: "Fork Co" } });
  const cfg = await request(app, "/api/config");
  assert.deepEqual(cfg.json.loginHero, validHero);
});

test("env fallback: valid JSON serves, invalid JSON degrades to null without touching anything else", async () => {
  const { app } = makeApp();
  process.env.LOGIN_HERO = JSON.stringify({ en: { title: "env hero", links: [{ label: "Docs", url: "https://docs.example" }] } });
  let cfg = await request(app, "/api/config");
  assert.deepEqual(cfg.json.loginHero, { en: { title: "env hero", links: [{ label: "Docs", url: "https://docs.example" }] } });

  process.env.LOGIN_HERO = "{not json";
  cfg = await request(app, "/api/config");
  assert.equal(cfg.json.loginHero, null);
  assert.equal(cfg.json.companyName, null);

  process.env.LOGIN_HERO = JSON.stringify({ en: { links: [{ label: "x", url: "nope" }] } }); // structurally invalid
  cfg = await request(app, "/api/config");
  assert.equal(cfg.json.loginHero, null);
  delete process.env.LOGIN_HERO;
});

test("stored loginHero wins over env", async () => {
  const { app } = makeApp();
  process.env.LOGIN_HERO = JSON.stringify({ en: { title: "env hero" } });
  try {
    await request(app, "/api/config/branding", { method: "PUT", body: { loginHero: validHero } });
    const cfg = await request(app, "/api/config");
    assert.deepEqual(cfg.json.loginHero, validHero);
  } finally {
    delete process.env.LOGIN_HERO;
  }
});

test("server locale closed set matches the web's SUPPORTED_LOCALES (lockstep guard)", async () => {
  // The server hardcodes LOGIN_HERO_LOCALES in misc.js; the web owns
  // SUPPORTED_LOCALES. A PUT with the web's newest locale must be accepted,
  // and one with a locale neither side knows must be rejected — so if the two
  // sets drift, this fails on the next added locale.
  const { app } = makeApp();
  for (const locale of SUPPORTED_LOCALES) {
    const res = await request(app, "/api/config/branding", {
      method: "PUT",
      body: { loginHero: { [locale]: { title: "t" } } },
    });
    assert.equal(res.status, 200, `locale ${locale} must be accepted`);
  }
  const rejected = await request(app, "/api/config/branding", {
    method: "PUT",
    body: { loginHero: { "klingon": { title: "t" } } },
  });
  assert.equal(rejected.status, 400);
});

test("resolveLoginHero chain: current locale → en → none; links independent of hero", () => {
  const config = parseLoginHero({
    "zh-CN": { title: "壹座", points: ["开源"] },
    en: { title: "Platform", links: [{ label: "Site", url: "https://example.com" }] },
    "zh-TW": { title: "dropped: unknown locale" },
  });
  // zh-CN direct
  assert.deepEqual(resolveLoginHero(config, "zh-CN"), {
    hero: { title: "壹座", subtitle: "", points: ["开源"], imageUrl: null },
    links: null,
  });
  // ja → en fallback (whole-entry: en's links ride along, zh-CN's fields do not mix in)
  assert.deepEqual(resolveLoginHero(config, "ja"), {
    hero: { title: "Platform", subtitle: "", points: [], imageUrl: null },
    links: [{ label: "Site", url: "https://example.com" }],
  });
  // es has no entry and en carries only links → no hero panel, links row stands alone
  const linksOnly = parseLoginHero({ en: { links: [{ label: "Docs", url: "https://docs.example" }] } });
  assert.deepEqual(resolveLoginHero(linksOnly, "es"), { hero: null, links: [{ label: "Docs", url: "https://docs.example" }] });
  // nothing configured
  assert.deepEqual(resolveLoginHero(null, "en"), { hero: null, links: null });
  assert.deepEqual(resolveLoginHero(parseLoginHero({ en: {} }), "en"), { hero: null, links: null });
});

test("parseLoginHero is reader-lenient: unknown fields dropped, malformed pieces vanish, junk → null", () => {
  const parsed = parseLoginHero({
    en: { title: "Keep",_evolution: "dropped", points: ["ok", 42, null, "  ", "fine"], links: [{ label: "L", url: "https://a.example" }, "junk", { label: "no-url" }] },
  });
  assert.deepEqual(parsed, {
    en: { title: "Keep", points: ["ok", "fine"], links: [{ label: "L", url: "https://a.example" }] },
  });
  assert.equal(parseLoginHero("junk"), null);
  assert.equal(parseLoginHero({ en: { points: [] } }), null); // nothing usable remains
});
