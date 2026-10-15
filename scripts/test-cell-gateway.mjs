#!/usr/bin/env node
// ── Gateway integration test (add-multi-tenant-cloud, tasks 2.1–2.5) ─────────
//
// Boots the real gateway against a stub OIDC discovery document and real cells,
// then drives it over HTTP and WebSocket the way a browser would.
//
// Authentication is exercised for real, not stubbed: the gateway verifies the
// same signed session cookie Logto's callback issues, so this test mints that
// cookie directly with the deployment's SESSION_SECRET. Only the OIDC discovery
// fetch is stubbed (it needs the network and happens once, at boot).
//
//   node scripts/test-cell-gateway.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket from "ws";
import { signSession } from "../server/session.js";
import { spawnTestServer } from "./lib/test-server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "gateway-test-secret";
const SESSION_SECRET = "session-test-secret";
// Long enough that the active scenarios never race it, short enough that the
// reaper is observable inside a test.
const IDLE_REAP_SECS = 6;

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

function cookieFor(email, groups = []) {
  const payload = { email, groups, exp: Math.floor(Date.now() / 1000) + 3600 };
  return `paas_session=${signSession(payload, SESSION_SECRET)}`;
}

// Minimal OIDC discovery + JWKS. createLogtoAuth fetches both once at boot and
// never again — session cookies are verified locally — so this is all it needs.
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
        end_session_endpoint: `${base}/oidc/session/end`,
      }));
    }
    if (req.url.includes("jwks")) return res.end(JSON.stringify({ keys: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

async function startGateway(oidcPort, dataRoot, extraEnv = {}, storeRoot = null) {
  const port = await freePort();
  const server = spawnTestServer({
    cwd: REPO,
    args: [path.join(REPO, "gateway/index.js")],
    storeRoot,
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_HOST: "127.0.0.1",
      CELL_DATA_ROOT: dataRoot,
      CELL_GATEWAY_SECRET: SECRET,
      CELL_IDLE_REAP_SECS: String(IDLE_REAP_SECS),
      CELL_START_TIMEOUT_MS: "90000",
      SESSION_SECRET,
      LOGTO_ENDPOINT: `http://127.0.0.1:${oidcPort}`,
      LOGTO_APP_ID: "test-app",
      LOGTO_APP_SECRET: "test-secret",
      LOGTO_CLIENT_TYPE: "confidential",
      PAAS_BASE_URL: "",
      AUTH_MODE: "none",
      CLOUD_MODE: "",
      // No provider: cells boot and serve REST/WS without paying for an LLM.
      LLM_API_KEY: "",
      ...extraEnv,
    },
  });
  const proc = server.child;
  const logs = [];
  proc.stdout.on("data", (b) => logs.push(`[out] ${b}`));
  proc.stderr.on("data", (b) => logs.push(`[err] ${b}`));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`gateway exited early:\n${logs.join("")}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    if (i === 79) throw new Error(`gateway never became healthy:\n${logs.join("")}`);
    await sleep(250);
  }

  return {
    port,
    base,
    logs,
    proc,
    async call(route, { method = "GET", cookie, headers = {}, body } = {}) {
      const res = await fetch(base + route, {
        method,
        redirect: "manual",
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* html or empty */ }
      return { status: res.status, location: res.headers.get("location"), json, text };
    },
    async cellFor(email) {
      const { json } = await this.call("/api/gateway/status", { cookie: cookieFor("root@cell.test", ["admin"]) });
      return (json?.cells || []).find((c) => c.user === email) ?? null;
    },
    async waitForCell(email, states, timeoutMs = 120_000) {
      const want = Array.isArray(states) ? states : [states];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const cell = await this.cellFor(email);
        if (cell && want.includes(cell.state)) return cell;
        await sleep(400);
      }
      throw new Error(`cell for ${email} never reached ${want.join("/")}`);
    },
    async stop() {
      await server.stop();
    },
  };
}

async function openWs(port, cookie, frames) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie } });
  ws.on("message", (raw) => {
    try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// Cells are listen-first: they answer before the dsh agent finishes booting, so
// anything that needs the agent has to wait for it rather than assume a fixed
// delay is enough (it is not when the suite runs files in parallel).
async function waitForFrame(frames, match, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(match);
    if (found) return found;
    await sleep(250);
  }
  return null;
}

async function waitForCellReady(gw, cookie, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await gw.call("/api/ready", { cookie })).status === 200) return true;
    await sleep(500);
  }
  return false;
}

if (!(await import("./lib/dsh-available.mjs")).dshRuntimeAvailable()) {
  console.warn("[skip] shared dsh install unavailable — dsh runtime integration skipped (see scripts/lib/dsh-available.mjs)");
  process.exit(0);
}

test("gateway: auth, routing, sticky WebSocket, restart resume, idle reap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-test-"));
  const oidc = await startStubOidc();
  const admin = cookieFor("root@cell.test", ["admin"]);
  const alice = cookieFor("alice@cell.test", ["users"]);
  const bob = cookieFor("bob@cell.test", ["users"]);
  let gw;
  try {
    gw = await startGateway(oidc.port, path.join(root, "cells"), {}, root);

    // ── 2.2 Anonymous, and forged identity, never reach a cell ──────────────
    // add-login-hero 6.2: the pre-login SPA shell is served to anonymous
    // browsers so the product's own login page can render (it reads the
    // anonymous /api/config + /api/auth/me below and routes itself to /login).
    // The identity boundary moved from "redirect every page" to "never reach a
    // cell": the SPA is a static shell, and every cell-backed call still
    // requires a session.
    const anonymousPage = await gw.call("/", { headers: { accept: "text/html" } });
    assert.equal(anonymousPage.status, 200, "anonymous browsers get the SPA shell (which shows the login page)");
    assert.ok(anonymousPage.text.includes("<!doctype html"), "the shell is the SPA's index.html");

    // Anonymous config/identity reads are public deployment-level facts — the
    // login page needs them before it has any identity.
    const anonConfig = await gw.call("/api/config");
    assert.equal(anonConfig.status, 200, "anonymous /api/config serves the login-page branding");
    const anonMe = await gw.call("/api/auth/me");
    assert.equal(anonMe.status, 200, "anonymous /api/auth/me tells the SPA to render the login page");
    assert.equal(anonMe.json.authenticated, false);
    assert.equal(anonMe.json.mode, "logto");

    const anonymousWs = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve("error"));
      ws.on("open", () => resolve(200));
    });
    assert.equal(anonymousWs, 401, "anonymous WebSocket upgrade must be rejected");

    // Forged headers must not create an identity. /api/config is anonymous by
    // design (login-page branding), so the proof is that the forged request
    // gets the ANONYMOUS answer and never a cell-backed one.
    const forged = await gw.call("/api/config", {
      headers: { "x-forwarded-email": "root@cell.test", "x-forwarded-groups": "admin" },
    });
    assert.equal(forged.status, 200, "anonymous config is public");
    assert.equal(forged.json.assistantName, process.env.ASSISTANT_NAME?.trim() || null, "forged headers must not reach a cell (env answer only)");
    // And the identity-shaped route still refuses to invent one.
    const forgedMe = await gw.call("/api/auth/me", {
      headers: { "x-forwarded-email": "root@cell.test", "x-forwarded-groups": "admin" },
    });
    assert.equal(forgedMe.status, 200);
    assert.equal(forgedMe.json.authenticated, false, "client-supplied identity headers must not authenticate");

    // ── 2.1 First traffic starts the cell; the identity reaches it ──────────
    const me = await gw.call("/api/auth/me", { cookie: alice });
    assert.equal(me.status, 200);
    assert.equal(me.json.email, "alice@cell.test", "the cell must receive the verified identity");

    const aliceCell = await gw.waitForCell("alice@cell.test", "running");
    assert.ok(aliceCell.port > 0 && aliceCell.pid > 0, "the cell must have a port and a pid");
    assert.ok(await waitForCellReady(gw, alice), "the cell's agent must become ready");
    assert.equal((await gw.call("/healthz")).status, 200);

    // ── 2.5 Status is admin-gated ────────────────────────────────────────────
    assert.equal((await gw.call("/api/gateway/status", { cookie: alice })).status, 403, "cell status must be admin-only");
    assert.equal((await gw.call("/api/gateway/status", { cookie: admin })).status, 200);

    // ── 2.3 The proxied WebSocket, and surviving a cell restart ─────────────
    const aliceFrames = [];
    let aliceWs = await openWs(gw.port, alice, aliceFrames);
    assert.ok(await waitForFrame(aliceFrames, () => true), "the proxied WebSocket must receive the cell's connect-time sync");

    // Persist a session, then kill the cell out from under the socket: the
    // reconnect must land on the same user's fresh cell and see that session.
    const session = await gw.call("/api/chat-history/sessions", { method: "POST", cookie: alice });
    assert.equal(session.status, 200);
    const sessionId = session.json.id;

    aliceWs.close();
    process.kill(aliceCell.pid, "SIGKILL");
    const crashed = await gw.waitForCell("alice@cell.test", "error", 30_000);
    assert.equal(crashed.state, "error", "a killed cell must surface as an error for its user");

    const resumedFrames = [];
    aliceWs = await openWs(gw.port, alice, resumedFrames);
    const resumed = await gw.waitForCell("alice@cell.test", "running");
    assert.notEqual(resumed.port, aliceCell.port, "the restart must be a new cell process");

    for (let i = 0; i < 40 && !resumedFrames.some((f) => f.type === "sessions"); i++) await sleep(250);
    const sessionFrame = resumedFrames.find((f) => f.type === "sessions");
    assert.ok(sessionFrame, "the restarted cell must sync its session list over the proxied WebSocket");
    assert.ok(
      sessionFrame.sessions.some((s) => s.id === sessionId),
      "the restarted cell must resume the session persisted before the crash",
    );

    // ── User B is untouched by any of A's trouble ───────────────────────────
    const bobFrames = [];
    const bobWs = await openWs(gw.port, bob, bobFrames);
    const bobSessions = await waitForFrame(bobFrames, (f) => f.type === "sessions");
    assert.ok(bobSessions, "user B must get their own connect-time sync");
    assert.ok(!bobSessions.sessions.some((s) => s.id === sessionId), "user B must never see user A's session");

    // Give B enabled scheduled work so the reaper has to exempt them.
    bobWs.send(JSON.stringify({ type: "cron_add", cron: "0 0 1 1 *", prompt: "keepalive" }));
    await sleep(1200);

    // ── 2.4 Idle reaping, with the enabled-job exemption ────────────────────
    // Both cells go idle. Alice holds nothing scheduled; Bob holds a cron job.
    aliceWs.close();
    bobWs.close();
    // A reaped cell's record is deleted on exit, so absence is also "reaped";
    // the load-bearing assertion is that Bob's cell is still up.
    await gw.waitForCell("alice@cell.test", ["stopping", "stopped"], 30_000).catch(() => null);
    const bobAfterReap = await gw.cellFor("bob@cell.test");
    assert.ok(bobAfterReap && bobAfterReap.state === "running", "a cell with an enabled cron job must never be reaped");

    // Alice's next request cold-starts her again.
    assert.equal((await gw.call("/api/auth/me", { cookie: alice })).status, 200, "a reaped user must cold-start on next request");
  } finally {
    await gw?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await oidc.close();
  }
});

test("gateway: idle reaping is off by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-noreap-"));
  const oidc = await startStubOidc();
  const carol = cookieFor("carol@cell.test", ["users"]);
  let gw;
  try {
    gw = await startGateway(oidc.port, path.join(root, "cells"), { CELL_IDLE_REAP_SECS: "" }, root);
    assert.equal((await gw.call("/api/auth/me", { cookie: carol })).status, 200);
    await gw.waitForCell("carol@cell.test", "running");

    // Longer than the reaping test's idle period above: nothing may stop it.
    await sleep((IDLE_REAP_SECS + 4) * 1000);
    const cell = await gw.cellFor("carol@cell.test");
    assert.ok(cell && cell.state === "running", "with reaping disabled a cell must stay resident");
  } finally {
    await gw?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await oidc.close();
  }
});

// fix-gateway-sigterm-graceful-shutdown: the facet-cutover handler referenced a
// block-scoped packRegistry, so SIGTERM in pack mode (the harness default — no
// FACET_BASE_URL) threw ReferenceError as an unhandled rejection and the
// process died before registry.shutdown(). Cells must outlive nothing, but the
// gateway must not die by accident either: exit 0, stop log, no crash text.
test("gateway: SIGTERM shuts down gracefully in pack mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-sigterm-"));
  const oidc = await startStubOidc();
  let gw;
  try {
    gw = await startGateway(oidc.port, path.join(root, "cells"), {}, root);
    const exited = new Promise((resolve) => gw.proc.once("exit", (code) => resolve(code)));
    gw.proc.kill("SIGTERM");
    const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")]);
    assert.equal(code, 0, "gateway must exit 0 on SIGTERM, not crash on the shutdown path");
    await sleep(150); // let the last stdout chunks land in logs
    const allLogs = gw.logs.join("");
    assert.match(allLogs, /SIGTERM — stopping \d+ cell\(s\)/, "the graceful stop must be logged");
    assert.doesNotMatch(allLogs, /ReferenceError|UnhandledPromiseRejection/, "no crash may appear on the shutdown path");
  } finally {
    await gw?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await oidc.close();
  }
});
