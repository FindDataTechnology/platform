#!/usr/bin/env node
// ── Cell-scoped bindings (add-multi-tenant-cloud, tasks 3.1 + 3.2) ───────────
//
// Proves the two halves of the bindings retirement against a real cell:
//
//   3.1 the surviving surface still works — WS `list_bindings` and the REST
//       binding endpoints answer, and the retired `apply_bindings` message has
//       no handler left to answer it.
//   3.2 bindings are cell-scoped startup state — a model saved through the REST
//       endpoint is what the runtime boots on after the cell restarts, rather
//       than something applied later by an inter-user coordinator.
//
// A dummy LLM key is set purely so the profile DECLARES models (the declared
// list is the model list); nothing here calls a model.
//
//   node scripts/test-cell-bindings.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket from "ws";
import { signSession } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "bindings-test-secret";
const SESSION_SECRET = "bindings-session-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = netServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const cookie = `paas_session=${signSession(
  { email: "dave@cell.test", groups: ["users"], exp: Math.floor(Date.now() / 1000) + 3600 },
  SESSION_SECRET,
)}`;

async function startStubOidc() {
  const port = await freePort();
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${port}`;
    res.setHeader("content-type", "application/json");
    if (req.url.includes("openid-configuration")) {
      return res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oidc/auth`,
        token_endpoint: `${base}/oidc/token`,
        jwks_uri: `${base}/oidc/jwks`,
      }));
    }
    if (req.url.includes("jwks")) return res.end(JSON.stringify({ keys: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

if (!(await import("./lib/dsh-available.mjs")).dshRuntimeAvailable()) {
  console.warn("[skip] shared dsh install unavailable — dsh runtime integration skipped (see scripts/lib/dsh-available.mjs)");
  process.exit(0);
}

test("cell-scoped bindings: surface intact, applied at cell start", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cell-bindings-"));
  const oidc = await startStubOidc();
  const port = await freePort();
  let proc;

  const logs = [];
  try {
    proc = spawn(process.execPath, [path.join(REPO, "gateway/index.js")], {
      cwd: REPO,
      env: {
        ...process.env,
        GATEWAY_PORT: String(port),
        GATEWAY_HOST: "127.0.0.1",
        CELL_DATA_ROOT: path.join(root, "cells"),
        CELL_GATEWAY_SECRET: SECRET,
        CELL_IDLE_REAP_SECS: "",
        CELL_START_TIMEOUT_MS: "90000",
        SESSION_SECRET,
        LOGTO_ENDPOINT: `http://127.0.0.1:${oidc.port}`,
        LOGTO_APP_ID: "test-app",
        LOGTO_APP_SECRET: "test-secret",
        PAAS_BASE_URL: "",
        AUTH_MODE: "none",
        CLOUD_MODE: "",
        // Declares the model list; never called.
        LLM_API_KEY: "dummy-key-for-model-declaration",
        LLM_BASE_URL: "http://127.0.0.1:1/v1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (b) => logs.push(`[out] ${b}`));
    proc.stderr.on("data", (b) => logs.push(`[err] ${b}`));

    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      if (proc.exitCode !== null) throw new Error(`gateway exited early:\n${logs.join("")}`);
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* booting */ }
      if (i === 79) throw new Error(`gateway never became healthy:\n${logs.join("")}`);
      await sleep(250);
    }

    const call = async (route, { method = "GET", body } = {}) => {
      const res = await fetch(base + route, {
        method,
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    // First traffic starts the cell and syncs the model roster to the socket.
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
    ws.on("message", (raw) => {
      try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });

    for (let i = 0; i < 120 && !frames.some((f) => f.type === "models"); i++) await sleep(500);
    const modelsFrame = frames.find((f) => f.type === "models");
    assert.ok(modelsFrame, `the cell must report its model roster:\n${logs.join("")}`);
    // The connect-time current_model carries a null id while the agent is still
    // booting; the ready sync sends the real one.
    const startingModel = frames.filter((f) => f.type === "current_model" && f.id).at(-1)?.id;
    assert.ok(startingModel, "the cell must report a starting model");

    const target = modelsFrame.models.find((m) => m.id !== startingModel);
    assert.ok(target, "the roster must declare more than one model for this test to be meaningful");

    // ── 3.1 The surviving surface ────────────────────────────────────────────
    const listed = await call("/api/users/me/bindings");
    assert.equal(listed.status, 200, "the REST bindings endpoint must still answer");
    assert.ok(Array.isArray(listed.json.mcp), "the snapshot must still carry the MCP availability list");

    const framesBefore = frames.length;
    ws.send(JSON.stringify({ type: "list_bindings" }));
    for (let i = 0; i < 20 && !frames.slice(framesBefore).some((f) => f.type === "user_bindings"); i++) await sleep(250);
    assert.ok(
      frames.slice(framesBefore).some((f) => f.type === "user_bindings"),
      "WS list_bindings must still answer with the user's snapshot",
    );

    // The retired message must have no handler left: sending it is inert.
    const beforeRetired = frames.length;
    ws.send(JSON.stringify({ type: "apply_bindings" }));
    await sleep(1200);
    assert.equal(frames.length, beforeRetired, "the retired apply_bindings message must have no handler");

    // ── 3.2 The binding is what the cell boots on ────────────────────────────
    const saved = await call("/api/users/me/model", {
      method: "PUT",
      body: { providerId: target.provider, modelId: target.id },
    });
    assert.equal(saved.status, 200, `saving a personal binding must succeed: ${JSON.stringify(saved.json)}`);
    assert.equal(saved.json.binding.id, target.id, "the binding must be persisted for the cell's user");

    // Restart the cell: the model must come from the binding at boot, not from
    // a coordinator applying it after the first request.
    const adminCookie = `paas_session=${signSession(
      { email: "root@cell.test", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 3600 },
      SESSION_SECRET,
    )}`;
    const cell = await (async () => {
      for (let i = 0; i < 60; i++) {
        const res = await fetch(`${base}/api/gateway/status`, { headers: { cookie: adminCookie } });
        const found = (await res.json()).cells.find((c) => c.user === "dave@cell.test");
        if (found?.state === "running") return found;
        await sleep(400);
      }
      throw new Error("cell never reached running");
    })();

    ws.close();
    process.kill(cell.pid, "SIGKILL");
    await sleep(1500);

    const resumedFrames = [];
    const resumedWs = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
    resumedWs.on("message", (raw) => {
      try { resumedFrames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    await new Promise((resolve, reject) => { resumedWs.on("open", resolve); resumedWs.on("error", reject); });

    for (let i = 0; i < 60 && !resumedFrames.some((f) => f.type === "current_model" && f.id); i++) await sleep(500);
    // The FIRST model the restarted cell reports is the assertion: it must come
    // from the binding at boot, not from a coordinator applying it afterwards.
    const resumedModel = resumedFrames.find((f) => f.type === "current_model" && f.id);
    assert.equal(
      resumedModel?.id,
      target.id,
      `the restarted cell must boot on the saved binding (got ${resumedModel?.id}, expected ${target.id})`,
    );
    resumedWs.close();
  } finally {
    proc?.kill("SIGTERM");
    await sleep(600);
    if (proc && proc.exitCode === null) proc.kill("SIGKILL");
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await oidc.close();
  }
});
