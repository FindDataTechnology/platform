#!/usr/bin/env node
// ── Hosted onboarding path: real gateway + real cell, no dsh required ────────
//
// The 2026-10-17 defects all lived BETWEEN processes, which is why unit tests
// and module-level probes missed them:
//
//   ① a self-service role write landed only in the cell's store, while the
//     gateway stamps x-forwarded-roles from ITS document and the cell's
//     resolver prefers that source — the user picked a domain and every page
//     kept the default navigation;
//   ② the recipes referenced invented pack slugs while the market mints ids
//     randomly per deployment — provisioning failed "Pack version not found";
//   ③ the expert switch dereferenced a websocket that this channel never has;
//
// So this suite boots the REAL gateway over stub OIDC + a stub market and drives
// the real routes (answers → provision) exactly as the browser does. Deliberately
// NOT gated on the dsh runtime: none of the paths above needs one, and a suite
// that skips is a suite that stops finding regressions.
//
//   node scripts/test-onboarding-hosted.mjs

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { signSession } from "../server/session.js";
import { spawnTestServer } from "./lib/test-server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "onboarding-hosted-secret";
const SESSION_SECRET = "onboarding-hosted-session";

// The market's id for 法律-合同: randomly minted in the real deployment
// (`randomBytes(16)` in gateway/packs.js), which is exactly why the recipe
// carries the authored NAME and the plan resolves it.
const LEGAL_PACK_ID = "J9sO_wRCgUVjbYVEqD4Pog";

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
  return `paas_session=${signSession({ email, groups, exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET)}`;
}

// Minimal OIDC discovery: createLogtoAuth fetches it once at boot and then
// verifies session cookies locally, so this is all the gateway needs.
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
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

// Stand-in for the facet service: answers the two calls the onboarding path
// makes — the name search (reference → id) and the latest-version fetch.
async function startStubMarket() {
  const port = await freePort();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/packs") {
      const search = url.searchParams.get("search") || "";
      const hit = search === "法律-合同";
      return res.end(JSON.stringify({
        total: hit ? 1 : 0,
        page: 1,
        pageSize: 50,
        packs: hit ? [{ id: LEGAL_PACK_ID, name: "法律-合同", version: 1 }] : [],
      }));
    }
    if (url.pathname === `/api/packs/${LEGAL_PACK_ID}`) {
      return res.end(JSON.stringify({
        id: LEGAL_PACK_ID,
        name: "法律-合同",
        version: 2,
        manifest: {
          name: "法律-合同",
          version: 2,
          skills: [],
          // The persona the recipe names as defaultExpert — the pack's own
          // manifest id, as the real 法律-合同 pack publishes it.
          agents: [{ id: "pack-contract-reviewer", name: "合同审查官", persona: "你是「合同审查官」——资深商事合同律师角色。" }],
        },
      }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { port, close: () => new Promise((r) => server.close(r)) };
}

async function bootGateway({ dataRoot, storeRoot, extraEnv = {} }) {
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
      CELL_IDLE_REAP_SECS: "0",
      CELL_START_TIMEOUT_MS: "120000",
      SESSION_SECRET,
      LOGTO_ENDPOINT: `http://127.0.0.1:${extraEnv.OIDC_PORT}`,
      LOGTO_APP_ID: "test-app",
      LOGTO_APP_SECRET: "test-secret",
      LOGTO_CLIENT_TYPE: "confidential",
      PAAS_BASE_URL: "",
      AUTH_MODE: "none",
      CLOUD_MODE: "",
      // No provider: cells serve REST without paying for an LLM.
      LLM_API_KEY: "",
      ...extraEnv,
    },
  });
  const logs = [];
  server.child.stdout.on("data", (b) => logs.push(`[out] ${b}`));
  server.child.stderr.on("data", (b) => logs.push(`[err] ${b}`));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (server.child.exitCode !== null) throw new Error(`gateway exited early:\n${logs.join("")}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    if (i === 119) throw new Error(`gateway never became healthy:\n${logs.join("")}`);
    await sleep(250);
  }

  const call = async (route, { method = "GET", cookie, headers = {}, body } = {}) => {
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
    return { status: res.status, json, text };
  };

  return { base, logs, call, stop: () => server.stop() };
}

test("hosted: self-service role write lands in the gateway store and rides the headers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onboarding-hosted-roles-"));
  const oidc = await startStubOidc();
  const dana = cookieFor("dana@cell.test", ["users"]);
  let gw;
  try {
    gw = await bootGateway({
      dataRoot: path.join(root, "cells"),
      storeRoot: root,
      extraEnv: { OIDC_PORT: oidc.port },
    });

    // The first request boots the user's cell (listen-first: it answers before
    // any agent would be involved).
    const before = await gw.call("/api/auth/me", { cookie: dana });
    assert.equal(before.status, 200, "the cell must answer for the signed-in user");
    assert.equal(before.json.roles.primary, "standard", "a fresh user starts on the default role");

    // The write the onboarding route performs, with the shared secret — the
    // only caller that knows the answer was validated.
    const write = await gw.call("/api/roles/self", {
      method: "POST",
      headers: { "x-cloud-gateway-secret": SECRET },
      body: { email: "dana@cell.test", roles: ["legal"] },
    });
    assert.equal(write.status, 200, `the self-service write must land: ${write.text}`);
    assert.equal(write.json.primary, "legal");

    // Defect ①: the NEXT request must resolve legal. Before the fix the write
    // only reached the cell's own document, the gateway's header said
    // "standard", and the resolver preferred the header.
    const after = await gw.call("/api/auth/me", { cookie: dana });
    assert.equal(after.json.roles.primary, "legal", "the gateway store now resolves legal for this user");

    const cfg = await gw.call("/api/config", { cookie: dana });
    assert.equal(cfg.json.roles.primary, "legal", "the layout chain reads the same resolved role");
    assert.ok(
      cfg.json.resolvedLayout.nav.length < 7,
      `the legal recipe narrows the navigation (got ${JSON.stringify(cfg.json.resolvedLayout.nav)})`,
    );

    // Trust boundary and the escalation invariant.
    const forged = await gw.call("/api/roles/self", {
      method: "POST",
      headers: { "x-forwarded-email": "dana@cell.test" },
      body: { email: "dana@cell.test", roles: ["legal"] },
    });
    assert.equal(forged.status, 401, "the self channel requires the shared secret");

    const escalate = await gw.call("/api/roles/self", {
      method: "POST",
      headers: { "x-cloud-gateway-secret": SECRET },
      body: { email: "dana@cell.test", roles: ["legal"], admin: true },
    });
    assert.equal(escalate.status, 200);
    assert.equal(escalate.json.admin, false, "self-service never grants the admin flag");
    assert.equal((await gw.call("/api/auth/me", { cookie: dana })).json.isAdmin, false, "and the composed answer agrees");
  } finally {
    await gw?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await oidc.close();
  }
});

test("hosted: answers resolves recipe references and provision installs without a socket", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "onboarding-hosted-prov-"));
  const oidc = await startStubOidc();
  const market = await startStubMarket();
  const erin = cookieFor("erin@cell.test", ["users"]);
  let gw;
  try {
    gw = await bootGateway({
      dataRoot: path.join(root, "cells"),
      storeRoot: root,
      extraEnv: {
        OIDC_PORT: oidc.port,
        // The market is the facet service: both the gateway's /api/packs proxy
        // and the cell's server-side install fetch address it through this base.
        FACET_BASE_URL: `http://127.0.0.1:${market.port}`,
        FACET_INTERNAL_TOKEN: "facet-internal-token",
        PACK_MARKETPLACE: "1",
      },
    });

    const me0 = await gw.call("/api/auth/me", { cookie: erin });
    assert.equal(me0.status, 200, "the cell must answer for the signed-in user");

    // ── answers: hosted role write + a plan whose reference RESOLVED
    const answers = await gw.call("/api/onboarding/answers", {
      method: "POST",
      cookie: erin,
      body: { roles: ["legal"], note: "合同审查" },
    });
    assert.equal(answers.status, 200, `answers must be accepted: ${answers.text.slice(0, 200)}`);
    const plan = answers.json.plan;
    assert.ok(plan, "the plan must be returned with the answers");
    // Defect ②: the recipe names the pack by its authored display name; the
    // plan must carry this deployment's minted id.
    assert.equal(plan.packs[0].packId, LEGAL_PACK_ID, `the reference must resolve to the market id: ${JSON.stringify(plan.packs[0])}`);
    assert.equal(plan.packs[0].name, "法律-合同", "the plan carries the authored name for display");
    assert.equal(plan.degraded, false, "a fully resolved plan is not degraded");
    assert.equal(plan.defaultExpert, "pack-contract-reviewer", "the expert is the pack's own persona id");

    // Defect ①: the role took.
    assert.equal((await gw.call("/api/auth/me", { cookie: erin })).json.roles.primary, "legal");

    // ── provision: install + expert with NO websocket
    const prov = await gw.call("/api/onboarding/provision", { method: "POST", cookie: erin });
    assert.equal(prov.status, 200);
    assert.equal(prov.json.results[0].status, "installed", `the resolved pack installs: ${JSON.stringify(prov.json.results[0])}`);
    assert.equal(prov.json.results[0].packId, LEGAL_PACK_ID);
    assert.equal(prov.json.results[0].name, "法律-合同");

    // Defect ③: with no socket the switch used to dereference `ws.user` and
    // throw. This harness has no dsh runtime, so the roster may be empty — the
    // contract is that it never CRASHES, and a failure always names its cause
    // (a bare unexplained "failed" is what made the original defect invisible).
    const expert = prov.json.expert;
    if (expert.status === "selected") {
      assert.equal(expert.id, "pack-contract-reviewer");
    } else {
      assert.equal(expert.status, "failed");
      assert.ok(expert.error, "a socket-less failure must name its cause");
      assert.ok(!/Cannot read properties of null/.test(expert.error), `must not be the old null-deref: ${expert.error}`);
    }

    // Activation is add-only and idempotent.
    const again = await gw.call("/api/onboarding/provision", { method: "POST", cookie: erin });
    assert.equal(again.json.results[0].status, "already-installed", `re-activation installs nothing twice: ${JSON.stringify(again.json.results[0])}`);
  } finally {
    await gw?.stop();
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await oidc.close();
    await market.close();
  }
});
