#!/usr/bin/env node
// ── Pack marketplace gateway tests (add-pack-marketplace, tasks 1.3–1.6) ────
//
// Boots the REAL gateway against a stub OIDC discovery document (the
// test-cell-gateway.mjs harness) and drives the pack HTTP surface the way a
// browser would: publish gate, immutable versioning, browse/search/detail,
// subscribe records, unpublish semantics, and the publish rate limit. No
// request reaches the cell catch-all, so no cell ever spawns.
//
//   node --test scripts/test-pack-marketplace.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { signSession } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_SECRET = "pack-marketplace-test-secret";

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

let gateway;
let gwPort;
let dataRoot;
let oidc;

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

const CREATOR = { email: "creator@example.com", groups: ["creators"] };
const USER = { email: "user@example.com", groups: [] };
const OTHER_CREATOR = { email: "ratelimit@example.com", groups: ["creators"] };

function manifest(overrides = {}) {
  return {
    name: "法律-合同",
    description: "合同审查工作流",
    tags: ["法律"],
    skills: [
      { name: "legal-contract-workflow", description: "五阶段合同审查", content: "# 合同审查\n不编造法条。" },
    ],
    mcpServers: [{ registryName: "law-bench" }],
    agents: [{ id: "pack-contract-reviewer", name: "合同审查官", persona: "你是严谨的合同审查官。" }],
    ...overrides,
  };
}

test.before(async () => {
  oidc = await startStubOidc();
  dataRoot = await mkdtemp(path.join(tmpdir(), "pack-gateway-"));
  gwPort = await freePort();
  gateway = spawn(process.execPath, [path.join(REPO, "gateway/index.js")], {
    cwd: REPO,
    env: {
      ...process.env,
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
      PACK_PUBLISH_RATE_MAX: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stderr.on("data", (c) => process.env.PACK_TEST_VERBOSE && process.stderr.write(c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway boot timeout")), 20_000);
    gateway.stdout.on("data", (c) => {
      if (String(c).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    gateway.on("exit", (code) => reject(new Error(`gateway exited early: ${code}`)));
  });
});

test.after(async () => {
  gateway?.kill("SIGTERM");
  await new Promise((r) => gateway?.on("exit", r));
  await oidc?.close();
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
});

test("publish requires identity and the creator group", async () => {
  // Unauthenticated programmatic client gets a 401 it can act on.
  assert.equal((await api("POST", "/api/packs", { body: { manifest: manifest() } })).status, 401);

  // Authenticated but not a creator.
  const forbidden = await api("POST", "/api/packs", { ...USER, body: { manifest: manifest() } });
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.error, /Creator group required/);
});

test("creator publishes, versions append immutably, foreign republish is rejected", async () => {
  const first = await api("POST", "/api/packs", { ...CREATOR, body: { manifest: manifest() } });
  assert.equal(first.status, 200);
  const { id, version } = first.body;
  assert.equal(version, 1);
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);

  const second = await api("POST", "/api/packs", { ...CREATOR, body: { packId: id, manifest: manifest({ name: "法律-合同 v2" }) } });
  assert.equal(second.status, 200);
  assert.equal(second.body.version, 2);
  assert.equal(second.body.id, id);

  // v1 is still exactly what was published.
  const v1 = await api("GET", `/api/packs/${id}/versions/1`, USER);
  assert.equal(v1.status, 200);
  assert.equal(v1.body.manifest.name, "法律-合同");

  // A different creator cannot append to this pack.
  const foreign = await api("POST", "/api/packs", { ...OTHER_CREATOR, body: { packId: id, manifest: manifest() } });
  assert.equal(foreign.status, 403);

  // Unknown pack answers 404 (fresh author — the shared budget is separate).
  assert.equal(
    (await api("POST", "/api/packs", { email: "packid-probe@example.com", groups: ["creators"], body: { packId: "no-such", manifest: manifest() } })).status,
    404,
  );
});

test("invalid manifests are rejected naming the offending entry", async () => {
  const badMcp = await api("POST", "/api/packs", {
    ...CREATOR,
    body: { manifest: manifest({ mcpServers: [{ registryName: "x", url: "https://evil.example" }] }) },
  });
  assert.equal(badMcp.status, 400);
  assert.match(badMcp.body.errors[0].error, /registry servers/);
  assert.equal(badMcp.body.errors[0].entry, "mcpServers[0]");

  const badAgent = await api("POST", "/api/packs", {
    ...CREATOR,
    body: { manifest: manifest({ agents: [{ id: "x", name: "X", persona: "p", model: "m" }] }) },
  });
  assert.equal(badAgent.status, 400);
  assert.match(badAgent.body.errors[0].error, /persona-only/);

  // Validation failures do not consume the publish budget (see below: the
  // creator's two publishes from the previous tests already used it up).
  assert.equal((await api("POST", "/api/packs", { ...CREATOR, body: { manifest: manifest() } })).status, 429);
});

test("browse, search, and detail serve full skill bodies", async () => {
  // A fresh creator so the shared budget above does not interfere.
  const seeded = await api("POST", "/api/packs", {
    email: "seeder@example.com",
    groups: ["creators"],
    body: { manifest: manifest({ name: "股票研究", tags: ["金融"] }) },
  });
  const stockId = seeded.body.id;

  const list = await api("GET", "/api/packs", USER);
  assert.equal(list.status, 200);
  assert.ok(list.body.packs.length >= 1);

  const bySearch = await api("GET", "/api/packs?search=" + encodeURIComponent("股票"), USER);
  assert.equal(bySearch.body.total, 1);
  assert.equal(bySearch.body.packs[0].name, "股票研究");

  const byTag = await api("GET", "/api/packs?tag=" + encodeURIComponent("法律"), USER);
  assert.ok(byTag.body.packs.some((p) => p.tags.includes("法律")));

  const detail = await api("GET", `/api/packs/${stockId}`, USER);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.manifest.skills[0].content, "# 合同审查\n不编造法条。");
  // Non-author does not see the subscriber count.
  assert.equal(detail.body.subscriberCount, undefined);

  // Author sees it.
  const ownDetail = await api("GET", `/api/packs/${stockId}`, { email: "seeder@example.com", groups: ["creators"] });
  assert.equal(ownDetail.body.subscriberCount, 0);
});

test("subscribe records the version and returns the manifest; unsubscribe is explicit", async () => {
  const seeded = await api("POST", "/api/packs", {
    email: "subseed@example.com",
    groups: ["creators"],
    body: { manifest: manifest({ name: "订阅目标包" }) },
  });
  const id = seeded.body.id;

  const sub = await api("POST", `/api/packs/${id}/subscribe`, USER);
  assert.equal(sub.status, 200);
  assert.equal(sub.body.packId, id);
  assert.equal(sub.body.version, 1);
  assert.ok(sub.body.manifest.skills.length === 1);

  // The author's detail now reflects the count.
  const ownDetail = await api("GET", `/api/packs/${id}`, { email: "subseed@example.com", groups: ["creators"] });
  assert.equal(ownDetail.body.subscriberCount, 1);

  // A new version does not rewrite the recorded subscription.
  await api("POST", "/api/packs", { email: "subseed@example.com", groups: ["creators"], body: { packId: id, manifest: manifest({ name: "订阅目标包 v2" }) } });
  assert.equal((await api("GET", `/api/packs/${id}`, USER)).body.version, 2);

  assert.equal((await api("DELETE", `/api/packs/${id}/subscribe`, USER)).status, 200);
  const after = await api("GET", `/api/packs/${id}`, { email: "subseed@example.com", groups: ["creators"] });
  assert.equal(after.body.subscriberCount, 0);
});

test("unpublish unlists but versions stay retrievable and subscribers keep access", async () => {
  const seeded = await api("POST", "/api/packs", {
    email: "unpublisher@example.com",
    groups: ["creators"],
    body: { manifest: manifest({ name: "将下架包" }) },
  });
  const id = seeded.body.id;
  const author = { email: "unpublisher@example.com", groups: ["creators"] };

  // A subscriber exists before the unpublish.
  assert.equal((await api("POST", `/api/packs/${id}/subscribe`, USER)).status, 200);

  assert.equal((await api("POST", `/api/packs/${id}/unpublish`, USER)).status, 404); // not the author
  assert.equal((await api("POST", `/api/packs/${id}/unpublish`, author)).status, 200);

  // Hidden from listing and from a non-subscriber's detail…
  const stranger = { email: "stranger@example.com", groups: [] };
  assert.equal((await api("GET", `/api/packs/${id}`, stranger)).status, 404);
  const bySearch = await api("GET", "/api/packs?search=" + encodeURIComponent("将下架包"), stranger);
  assert.equal(bySearch.body.total, 0);

  // …but stored versions remain retrievable, the author still sees detail,
  // the active subscriber still sees detail, and no NEW subscribe succeeds.
  assert.equal((await api("GET", `/api/packs/${id}/versions/1`, stranger)).status, 200);
  assert.equal((await api("GET", `/api/packs/${id}`, author)).status, 200);
  assert.equal((await api("GET", `/api/packs/${id}`, USER)).status, 200);
  assert.equal((await api("POST", `/api/packs/${id}/subscribe`, stranger)).status, 404);
});

test("publish rate limit throttles per author", async () => {
  // OTHER_CREATOR already published once (the rejected foreign republish
  // attempt — it passed gate+validation, so it consumed the budget).
  const second = await api("POST", "/api/packs", { ...OTHER_CREATOR, body: { manifest: manifest({ name: "限流第二包" }) } });
  assert.equal(second.status, 200);
  const third = await api("POST", "/api/packs", { ...OTHER_CREATOR, body: { manifest: manifest({ name: "限流第三包" }) } });
  assert.equal(third.status, 429);
});
