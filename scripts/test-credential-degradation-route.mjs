#!/usr/bin/env node
// ── 凭据降级读面路由测试（change converge-line-identity-and-keys 4.2）────────
//
// 这条路由是"降级提示"的数据源，判据三条：
//   1. 按人返回：A 的降级不出现在 B 的响应里；
//   2. 未登录 401（auth 开启时）；
//   3. DB 不可用 503 —— **不是空列表**："读不到"与"没有降级"不能同形。
//
//   node --test --test-concurrency=1 scripts/test-credential-degradation-route.mjs

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import express from "express";

const tmpRoot = mkdtempSync(path.join(tmpdir(), "credential-degradation-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
process.env.PLATFORM_DATA_DIR = path.join(tmpRoot, "data");
delete process.env.FEDERATED_REF_ENABLED;

const db = await import("../db.js");
await db.initDb();
const federated = await import("../federated-ref.js");
const { registerAuth } = await import("../server/auth.js");
const { registerCredentialDegradationRoutes } = await import(
  "../server/routes/credential-degradation.js"
);

test.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

function makeApp({ dbOverride = null } = {}) {
  const ctx = {
    app: express().use(express.json()),
    authMode: "forward_auth",
    authEnabled: true,
    ssoEnabled: false,
    headerTrust: null,
    CLOUD_MODE: false,
    logtoAuth: null,
    PAAS_BASE_URL: "https://platform.test",
    resolveSessionSecret: async () => "test-session-secret",
  };
  registerAuth(ctx);
  registerCredentialDegradationRoutes({ ...ctx, db: dbOverride ?? db });
  return ctx.app;
}

function httpRequest(app, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${p}`, { headers })
        .then(async (res) => resolve({ status: res.status, body: await res.json().catch(() => null) }))
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

const ALICE = { "x-forwarded-email": "alice@x.test", "x-forwarded-groups": "user" };
const BOB = { "x-forwarded-email": "bob@x.test", "x-forwarded-groups": "user" };

test("按人返回：A 的降级不出现在 B 的响应里", async () => {
  federated.recordFederatedDegraded("lex", { servers: 2, email: "alice@x.test" });
  federated.recordFederatedDegraded("wire-customer", { servers: 1, email: "bob@x.test" });
  const app = makeApp();

  const a = await httpRequest(app, "/api/credentials/degraded", ALICE);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.degraded.map((r) => r.ref), ["lex"]);
  assert.equal(a.body.degraded[0].count, 2);
  assert.ok(a.body.asOf, "响应应带时间戳，便于判断新鲜度");

  const b = await httpRequest(app, "/api/credentials/degraded", BOB);
  assert.deepEqual(b.body.degraded.map((r) => r.ref), ["wire-customer"]);
});

test("未登录 → 401（auth 开启时）", async () => {
  const app = makeApp();
  const r = await httpRequest(app, "/api/credentials/degraded");
  assert.equal(r.status, 401);
});

test("DB 不可用 → 503，不是空列表", async () => {
  const app = makeApp({ dbOverride: { isDbReady: () => false } });
  const r = await httpRequest(app, "/api/credentials/degraded", ALICE);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /database unavailable/);
});

test("没有降级的人拿到空数组（与 503 可区分）", async () => {
  const app = makeApp();
  const r = await httpRequest(app, "/api/credentials/degraded", {
    "x-forwarded-email": "clean@x.test",
    "x-forwarded-groups": "user",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.degraded, []);
});
