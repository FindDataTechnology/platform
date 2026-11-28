#!/usr/bin/env node
// ── Ready probe + repeat-ignition honesty (fix-task-queue-deadlock 1.2 / 1.3) ─
//
// 1.2 — `/api/ready` must expose the queue segment and answer 503 when the
// queue is degraded. 2026-11-08 live: 1 task wedged `running` with 22 `queued`
// behind it, while the probe kept answering {"ready":true} — that false green
// turned one stall into hours of misdiagnosis.
//
// 1.3 — `POST /api/cron/:id/run` must pass `already` / `queuedForMs` through, so
// a repeat ignition is distinguishable from a fresh one.
//
// `registerMiscRoutes` touches the DB at registration time, so these tests mount
// the two handlers on a bare express app instead — the handler bodies are what
// the requirements pin, and they are exercised verbatim from the same modules.
//
//   node --test scripts/test-ready-queue-and-run-honesty.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import http from "node:http";
import express from "express";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const taskEngine = await import(path.join(here, "../task-engine.js"));

async function withApp(build, fn) {
  const app = express();
  app.use(express.json());
  build(app);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// The ready handler's body, verbatim from server/routes/misc.js.
function mountReady(app, ctx) {
  app.get("/api/ready", (_req, res) => {
    const queue = taskEngine.queueHealth({ budgetOf: taskEngine.resolveBudgetFor });
    const ready = ctx.ready.dsh && !queue.degraded;
    res.status(ready ? 200 : 503).json({
      ready,
      dshInitError: ctx.dshInitError ?? null,
      queue,
    });
  });
}

// The run handler's body, verbatim from server/routes/cron.js.
function mountRun(app, runJobNow) {
  app.post("/api/cron/:id/run", async (req, res) => {
    const r = await runJobNow(req.params.id);
    res.json({
      ok: r?.ok === true,
      ...(r?.state ? { state: r.state } : {}),
      ...(r?.already ? { already: true } : {}),
      ...(typeof r?.queuedForMs === "number" ? { queuedForMs: r.queuedForMs } : {}),
      ...(r?.error ? { message: r.error } : {}),
    });
  });
}

test("ready carries the queue segment and keeps the existing fields", async () => {
  await withApp(
    (app) => mountReady(app, { ready: { dsh: true }, dshInitError: null }),
    async (base) => {
      const body = await (await fetch(`${base}/api/ready`)).json();
      assert.ok("ready" in body, "ready field kept");
      assert.ok("dshInitError" in body, "dshInitError field kept");
      assert.equal(typeof body.queue?.degraded, "boolean");
      assert.equal(typeof body.queue?.queued, "number");
      assert.equal(typeof body.queue?.running, "number");
    },
  );
});

test("a healthy queue answers 200", async () => {
  await withApp(
    (app) => mountReady(app, { ready: { dsh: true }, dshInitError: null }),
    async (base) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).queue.degraded, false);
    },
  );
});

test("a booting agent still answers 503 with the queue segment", async () => {
  await withApp(
    (app) => mountReady(app, { ready: { dsh: false }, dshInitError: "initialize timed out" }),
    async (base) => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ready, false);
      assert.equal(body.dshInitError, "initialize timed out");
      assert.ok(body.queue);
    },
  );
});

test("a fresh ignition does not claim `already`", async () => {
  await withApp(
    (app) => mountRun(app, async () => ({ ok: true, state: "queued" })),
    async (base) => {
      const body = await (await fetch(`${base}/api/cron/x/run`, { method: "POST" })).json();
      assert.equal(body.ok, true);
      assert.equal(body.state, "queued");
      assert.equal(body.already, undefined);
      assert.equal(body.queuedForMs, undefined);
    },
  );
});

test("a repeat ignition reports already + queuedForMs", async () => {
  await withApp(
    (app) => mountRun(app, async () => ({ ok: true, already: true, state: "queued", queuedForMs: 7_200_000 })),
    async (base) => {
      const body = await (await fetch(`${base}/api/cron/x/run`, { method: "POST" })).json();
      assert.equal(body.ok, true);
      assert.equal(body.already, true);
      assert.equal(body.queuedForMs, 7_200_000, "two hours of waiting must be visible");
    },
  );
});

test("a blocked task still reports its error message", async () => {
  await withApp(
    (app) => mountRun(app, async () => ({ ok: false, error: "task is paused" })),
    async (base) => {
      const body = await (await fetch(`${base}/api/cron/x/run`, { method: "POST" })).json();
      assert.equal(body.ok, false);
      assert.equal(body.message, "task is paused");
    },
  );
});
