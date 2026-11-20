#!/usr/bin/env node
// ── Agent Studio compose-time validation tests (add-agent-studio 1.1) ────────
//
// The studio's compose-time validator is the EXISTING publish-gate dry-run
// endpoint `POST /api/packs/validate` (creator-pack-forge-support) — task 1.1
// decided reuse over a new endpoint (零第二造): collectPublishVerdict is the
// one collector both publish and validate read, so "endpoint errors are
// publish-gate errors" holds by construction. These tests pin that contract
// concretely against the booted gateway:
//   - auth required; any authenticated caller may validate (eligibility is a
//     caller finding, never a rejection)
//   - a structurally-bad document returns the SAME field-level errors the lib
//     validator produces (endpoint text == gate text, item by item)
//   - a cyclic fleet template fails the fleetTemplate stage with the shared
//     parser's own errors
//   - a tool-face closure violation surfaces the toolFace stage (enforce mode)
//   - a green document validates clean with publishEligibility reported
//
//   node --test scripts/test-agent-studio-validate.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { parseFleetTemplate } from "../server/fleet-template.js";
import { signSession } from "../server/session.js";
import { spawnTestServer } from "./lib/test-server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_SECRET = "agent-studio-validate-test-secret";

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

// Minimal OIDC discovery + JWKS; createLogtoAuth fetches both once at boot.
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

// Stub registry: one server with a tool_list snapshot, for the tool-face gate.
async function startStubRegistry() {
  const port = await freePort();
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/servers")) {
      return res.end(JSON.stringify({
        servers: [
          {
            path: "/stub-srv",
            is_enabled: true,
            tool_list: ["read", "search"],
            metadata: { surface: { commercial_tools: ["read", "search"], tools_commercial: 2, tools_total: 2 } },
          },
        ],
      }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

let gatewayServer;
let gwPort;
let dataRoot;
let oidc;
let stubRegistry;

function api(method, p, { email, groups, body } = {}) {
  const headers = {};
  if (email) headers.cookie = cookieFor(email, groups);
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`http://127.0.0.1:${gwPort}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

const USER = { email: "studio-user@example.com", groups: [] };

// A single-agent studio document (the Agent Document shape).
function doc(overrides = {}) {
  return {
    name: "巡检助手",
    description: "每小时巡检并报数的助手",
    tags: ["运维"],
    agents: [{ id: "patrol", name: "巡检员", persona: "你是巡检员，如实报数。" }],
    ...overrides,
  };
}

test.before(async () => {
  oidc = await startStubOidc();
  stubRegistry = await startStubRegistry();
  dataRoot = await mkdtemp(path.join(tmpdir(), "agent-studio-"));
  gwPort = await freePort();
  gatewayServer = spawnTestServer({
    cwd: REPO,
    args: [path.join(REPO, "gateway/index.js")],
    storeRoot: dataRoot,
    env: {
      ...process.env,
      REGISTRY_URL: `http://127.0.0.1:${stubRegistry.port}`,
      GATEWAY_PORT: String(gwPort),
      GATEWAY_HOST: "127.0.0.1",
      CELL_DATA_ROOT: dataRoot,
      CELL_GATEWAY_SECRET: "gateway-test-secret",
      CELL_IDLE_REAP_SECS: "0",
      SESSION_SECRET,
      LOGTO_ENDPOINT: `http://127.0.0.1:${oidc.port}`,
      LOGTO_APP_ID: "test-app",
      LOGTO_APP_SECRET: "test-secret",
      LOGTO_CLIENT_TYPE: "confidential",
      PAAS_BASE_URL: "",
      AUTH_MODE: "none",
      CLOUD_MODE: "",
      LLM_API_KEY: "",
      // enforce so the toolFace stage pushes verdict items (warn only logs).
      PACK_TOOL_FACE_GATE: "enforce",
    },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway boot timeout")), 20_000);
    gatewayServer.child.stdout.on("data", (c) => {
      if (String(c).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    gatewayServer.child.on("exit", (code) => reject(new Error(`gateway exited early: ${code}`)));
  });
});

test.after(async () => {
  await gatewayServer?.stop();
  await oidc?.close();
  await stubRegistry?.close();
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
});

test("validation requires a signed-in caller", async () => {
  const r = await api("POST", "/api/packs/validate", { body: { manifest: doc() } });
  assert.equal(r.status, 401);
});

test("any authenticated caller may validate; eligibility is a finding, not a rejection", async () => {
  const r = await api("POST", "/api/packs/validate", { email: USER.email, groups: USER.groups, body: { manifest: doc() } });
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, true);
  assert.equal(r.body.caller.publishEligible, false, "non-creator still validates — eligibility rides `caller`");
});

test("structural errors are the lib validator's own field-level items", async () => {
  const bad = doc({ name: "", skills: [{ name: "bad name!", description: "x", content: "y" }] });
  const r = await api("POST", "/api/packs/validate", { email: USER.email, groups: USER.groups, body: { manifest: bad } });
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, false);
  // The route projects verdict items to their BODIES (exactly the reject JSON
  // publishing would carry). Endpoint text == gate text: the reported errors
  // ARE the lib's output for the same input, item for item.
  const first = r.body.errors[0];
  assert.equal(first.error, "Invalid manifest");
  assert.deepEqual(first.errors, validatePackManifest(bad));
});

test("cyclic fleet template fails the fleetTemplate stage with the parser's errors", async () => {
  const cyclic = doc({
    fleet: {
      name: "环队",
      members: [
        { ref: "a", title: "A", parentRef: "b", target: { kind: "pack-preset", packId: "p", presetId: "patrol" } },
        { ref: "b", title: "B", parentRef: "a", target: { kind: "pack-preset", packId: "p", presetId: "patrol" } },
      ],
    },
  });
  const r = await api("POST", "/api/packs/validate", { email: USER.email, groups: USER.groups, body: { manifest: cyclic } });
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, false);
  const fleet = r.body.errors.find((e) => e.error === "Invalid fleet template");
  assert.ok(fleet, "fleetTemplate body reported");
  const parsed = parseFleetTemplate(cyclic);
  assert.equal(parsed.ok, false);
  assert.deepEqual(fleet.errors, parsed.errors ?? [parsed.error]);
});

test("tool-face closure violation surfaces the toolFace stage verbatim", async () => {
  const violating = doc({
    mcpServers: [{ registryName: "stub-srv", allowTools: ["read"] }],
    skills: [{ name: "uses-closed-tool", description: "names a tool outside the declared face", content: "first call mcp__stub-srv__fresh_tool, then mcp__stub-srv__read." }],
  });
  const r = await api("POST", "/api/packs/validate", { email: USER.email, groups: USER.groups, body: { manifest: violating } });
  assert.equal(r.status, 200);
  assert.equal(r.body.valid, false);
  const face = r.body.errors.find((e) => e.toolFace === true);
  assert.ok(face, "toolFace body reported in enforce mode");
  assert.equal(face.error, "Invalid manifest");
  assert.ok(face.errors.length > 0);
});
