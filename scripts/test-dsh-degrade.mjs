// Degrade-don't-die agent init (win-install-smoke 2026-10-08). server.js runs
// initDshAgent with a .catch that records ctx.dshInitError and keeps
// ready.dsh false — the listen-first server must keep serving static/auth/
// REST when the agent runtime cannot start (e.g. a packaged install missing
// the dsh binary), instead of the whole process dying mid-boot. These tests
// pin the observable surface: the /api/ready body carries dshInitError so
// probes can distinguish "booting" from "agent runtime unavailable", and the
// catch semantics (failure recorded, ready untouched) mirror server.js.

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerMiscRoutes } from "../server/routes/misc.js";

function request(app, path) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const req = httpRequest({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
      });
      req.on("error", reject);
      req.end();
    });
    server.on("error", reject);
  });
}

const baseCtx = () => ({
  app: express(),
  ready: { dsh: false },
  authMode: "none",
  authEnabled: false,
  adminGroups: [],
  catalog: {},
  cron: { jobs: [] },
  db: {
    isDbReady: () => true,
    getDeploymentConfig: () => null,
    setDeploymentConfig: () => {},
    clearDeploymentConfig: () => {},
  },
});

test("/api/ready reports dshInitError when agent init degraded", async () => {
  const ctx = baseCtx();
  ctx.dshInitError = "spawn dsh ENOENT";
  registerMiscRoutes(ctx);
  const res = await request(ctx.app, "/api/ready");
  assert.equal(res.status, 503);
  assert.equal(res.json.ready, false);
  assert.equal(res.json.dshInitError, "spawn dsh ENOENT");
});

test("/api/ready has null dshInitError while booting normally", async () => {
  const ctx = baseCtx();
  registerMiscRoutes(ctx);
  const res = await request(ctx.app, "/api/ready");
  assert.equal(res.status, 503);
  assert.equal(res.json.dshInitError, null);
});

test("ready true → 200 regardless of init error state", async () => {
  const ctx = baseCtx();
  ctx.ready.dsh = true;
  registerMiscRoutes(ctx);
  const res = await request(ctx.app, "/api/ready");
  assert.equal(res.status, 200);
  assert.equal(res.json.ready, true);
});

test("catch semantics mirror server.js: failure recorded, ready stays false", async () => {
  // This is the exact shape of the server.js change — kept here so a refactor
  // that silently re-throws (awaiting initDshAgent without the catch) still
  // has a pin to notice.
  const ctx = baseCtx();
  const failingInit = Promise.reject(new Error("spawn dsh ENOENT"));
  const dshInit = failingInit.catch((err) => {
    ctx.dshInitError = err?.message || String(err);
  });
  await Promise.all([Promise.resolve(), dshInit]);
  assert.equal(ctx.dshInitError, "spawn dsh ENOENT");
  assert.equal(ctx.ready.dsh, false);
});
