#!/usr/bin/env node
// ── Studio AI drafting bridge behavior (add-studio-ai-drafting 1.1/1.2) ──────
//
// The bridge's behavior, pinned against the MODULE rather than against one
// host's booted gateway:
//   - auth: an anonymous caller gets the family-standard 401
//   - whitelist: an off-whitelist kind is rejected by name (400)
//   - shape: a missing prompt is a 400 before any lane work
//   - honesty: with no LLM lane configured the bridge answers 503 — never a
//     fabricated draft
//
// Why not spawn the gateway: add-supply-studio-migration 4.6 (W2) unmounted the
// blueprint studio trio — `studio-draft` included — from 壹座's server.js; the
// creation surface moved to the facet host, which mounts this same module
// (facet/studio.js). A test that boots 壹座 and probes /api/studio/draft is now
// asserting a route the deployment deliberately no longer has, so it can only
// fail honestly. Mounting the module directly keeps the behavioral contract
// (status codes, never a fabricated draft) and stops depending on which host
// happens to mount it.
//
//   node --test scripts/test-studio-draft-gateway.mjs

import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const USER = { email: "drafter@example.com", groups: [] };

let dataRoot;
let server;
let base;

test.before(async () => {
  // Hermetic before the route module is loaded, because llm-providers.js
  // resolves its roster file at import time (`storeDir("llm-providers.json",
  // process.env.LLM_PROVIDERS_STORE)`). The checkout's own store carries a real
  // dev route, and a test must never resolve it — let alone call it. An empty
  // temp store plus no deployment env makes resolveJudgeLane answer
  // "unavailable", which is exactly what the 503 case pins.
  dataRoot = await mkdtemp(path.join(tmpdir(), "studio-draft-"));
  process.env.PLATFORM_DATA_DIR = dataRoot;
  process.env.LLM_PROVIDERS_STORE = path.join(dataRoot, "llm-providers.json");
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.BLUEPRINT_JUDGE_MODEL;

  const { createStudioDraftRoutes } = await import("../server/routes/studio-draft.js");

  const app = express();
  app.use(express.json());
  // The routes family's session middleware, stubbed: identity arrives as a
  // header so one server can serve the anonymous and the signed-in case.
  app.use((req, _res, next) => {
    if (req.headers["x-test-user"]) req.user = USER;
    next();
  });
  createStudioDraftRoutes(app, { authEnabled: true });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
});

function api(body, { signedIn = false } = {}) {
  const headers = {};
  if (signedIn) headers["x-test-user"] = USER.email;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}/api/studio/draft`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

test("auth: anonymous caller gets the family-standard 401", async () => {
  const r = await api({ kind: "agent-doc", prompt: "一个巡检助手" });
  assert.equal(r.status, 401);
  assert.match(r.body?.error ?? "", /Authentication required/);
});

test("whitelist: an off-whitelist kind is rejected by name (400)", async () => {
  const r = await api({ kind: "arbitrary-tool", prompt: "x" }, { signedIn: true });
  assert.equal(r.status, 400);
  assert.match(r.body?.error ?? "", /agent-doc, blueprint/);
});

test("shape: a missing prompt is a 400 before any lane work", async () => {
  const r = await api({ kind: "agent-doc" }, { signedIn: true });
  assert.equal(r.status, 400);
  assert.match(r.body?.error ?? "", /prompt is required/);
});

test("honesty: no lane configured → 503, never a fabricated draft", async () => {
  const r = await api({ kind: "agent-doc", prompt: "一个巡检助手，每小时报数" }, { signedIn: true });
  assert.equal(r.status, 503);
  assert.match(r.body?.error ?? "", /no LLM lane/);
  assert.equal(r.body?.draft, undefined, "no draft is ever fabricated");
});
