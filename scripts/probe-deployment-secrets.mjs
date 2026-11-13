#!/usr/bin/env node
// ── Staging probe: deployment secrets end-to-end (add-deployment-secrets 3.1) ─
//
// Drives the REAL chain: the platform's deploy route (secret intake +
// lifecycle) → the registry (descriptor carries references only) → the
// staging runner (fetch by reference with the service credential → pin into
// the child's private credentials file) → a declaration whose reference does
// not resolve (composition must fail loudly, no partial set).
//
//  1. publish a PRIVATE probe pack, deploy v1 with a fake secret
//  2. the deploy surface masks (names + last4); every public face and the
//     registry entry/card carry NO value
//  3. force a child composition, then read the child home's .credentials.yaml
//     and assert the fake value is pinned under its declared name
//  4. redeploy the agent entry with a reference the store cannot resolve
//     (the "deleted ref" case) → the next touch must fail with the missing
//     reference named, and the child must not compose
//  5. cleanup: registry entries deleted, probe pack unlisted
//
// Where to run it: anywhere that reaches the platform, the registry, the
// runner, and (for step 3) the runner's home — the runner container itself
// works (RUNNER_HOME=/data), or a host that can read it via a command:
//
//   PLATFORM_URL=https://platform.finddatatech.cloud \
//   PROBE_TOKEN=<platform Bearer (mini-program token) of a creators account> \
//   PROBE_BILLING_KEY=<sk-… of that account's sub2api key>   # when billing is linked \
//   REGISTRY_URL=https://mcp.finddatatech.cloud \
//   REGISTRY_TOKEN=<registry admin JWT> \
//   RUNNER_BASE=http://100.64.0.11:8790 \
//   BACKEND_TOKEN=<runner credential> \
//   RUNNER_HOME=/data \
//   node scripts/probe-deployment-secrets.mjs
//
//   # …or from an ops host with the runner container:
//   PROBE_READ_CMD='ssh cheap1 docker exec agent-runner-dsh cat {path}' \
//   RUNNER_HOME=/data node scripts/probe-deployment-secrets.mjs
//
// The probe runs against a platform built with add-deployment-secrets; on an
// older platform the deploy response carries no secretRefs and the probe says
// so instead of pretending.

import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deployToRegistry } from "../lib/agent-serving.js";

const PLATFORM = (process.env.PLATFORM_URL || "https://platform.finddatatech.cloud").replace(/\/+$/, "");
const PROBE_TOKEN = process.env.PROBE_TOKEN || "";
const BILLING_KEY = process.env.PROBE_BILLING_KEY || "";
const REGISTRY = (process.env.REGISTRY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "";
const RUNNER_ORIGIN = (process.env.RUNNER_ORIGIN || "http://100.64.0.11").replace(/\/+$/, "");
const RUNNER_BASE = (process.env.RUNNER_BASE || `${RUNNER_ORIGIN}:8790`).replace(/\/+$/, "");
const BACKEND = process.env.BACKEND_TOKEN || "";
const RUNNER_HOME = process.env.RUNNER_HOME || "/data";
const READ_CMD = process.env.PROBE_READ_CMD || "";
// The pack is skill-less, so the registry never fetches skill_md_url here;
// the deploy library still requires the field, so it must be set (the
// platform origin is the correct value in any real deployment).
const PACKS_PUBLIC_BASE = (process.env.PACKS_PUBLIC_BASE || PLATFORM).replace(/\/+$/, "");

const PACK_NAME = `probe-secrets-${Date.now().toString(36)}`;
const AGENT_ID = "probe-agent";
const SECRET_NAME = "probe_pat";
const FAKE_VALUE = `ghp_probeFAKE${Date.now()}${"x".repeat(16)}`; // ≥8 chars → masked with last4
const MISSING_REF = `ws_${"0".repeat(24)}`;
// Both are known only after publish (the platform mints the pack id).
let PACK = null;
let AGENT_PATH = null;
const agentKeyNow = () => String(AGENT_PATH).replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
// When the credentials assertion fails, the turn's own error is the best
// diagnostic (a runner-side composition failure explains itself there).
const turnDiagnostic = (turn) => (turn?.body ? `\n    turn said: ${String(turn.body).slice(0, 300)}` : "");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [name, v] of [["PROBE_TOKEN", PROBE_TOKEN], ["REGISTRY_URL", REGISTRY], ["REGISTRY_TOKEN", TOKEN], ["BACKEND_TOKEN", BACKEND]]) {
  if (!v) die(`${name} is required`);
}

// Deliberately SKILL-LESS: the registry anonymously fetches a pack skill's
// md URL through a public-only SSRF guard at registration, which the secrets
// contract has nothing to do with — leaving skills out keeps the probe's path
// minimal (and works identically against a local rehearsal platform whose
// origin is not publicly fetchable).
const manifest = () => ({
  name: PACK_NAME,
  description: "add-deployment-secrets 3.1 staging probe (auto-cleanup)",
  visibility: "private",
  tags: ["probe"],
  skills: [],
  mcpServers: [],
  agents: [
    {
      id: AGENT_ID,
      name: "探针 Agent",
      persona: "你是部署密钥探针。用一句中文短句回答即可。",
      serving: { protocol: "a2a" },
    },
  ],
});

async function platform(method, p, body) {
  return fetch(`${PLATFORM}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${PROBE_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function registry(method, p) {
  return fetch(`${REGISTRY}${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
}

async function runnerHealth() {
  try {
    return await (await fetch(`${RUNNER_BASE}/health`)).json();
  } catch {
    return null;
  }
}

// The child's private home as the RUNNER sees it; when the probe runs outside
// the runner container, PROBE_READ_CMD carries the access ({path} placeholder).
function readRunnerFile(relPath) {
  const full = path.posix.join(RUNNER_HOME, relPath);
  if (READ_CMD) return execSync(READ_CMD.replaceAll("{path}", full), { encoding: "utf8" });
  return readFileSync(full, "utf8");
}

async function sendTurn(text, contextId, timeoutMs = 240_000) {
  const h = await runnerHealth();
  const row = (h?.agents ?? []).find((a) => a.path === AGENT_PATH);
  if (!row) return null;
  const res = await fetch(`${RUNNER_ORIGIN}:${row.port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BACKEND}` },
    // A cold start plus a real LLM turn can take minutes; the composition
    // (and its failure) has settled long before this bound.
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
    }),
  });
  return { status: res.status, body: await res.text() };
}

// The registry health-gates its servable set: right after registration the
// backend isn't listening yet, so re-assert enabled + force a health check
// while we wait for the runner's poll — otherwise the entry can sit disabled
// and the runner (which filters `is_enabled !== false`) never picks it up.
async function nudgeAgent() {
  await registry("POST", `/api/agents${AGENT_PATH}/toggle?enabled=true`).catch(() => {});
  await registry("POST", `/api/agents${AGENT_PATH}/health`).catch(() => {});
}

async function waitForAgent(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastNudge = 0;
  while (Date.now() < deadline) {
    const h = await runnerHealth();
    const row = (h?.agents ?? []).find((a) => a.path === AGENT_PATH);
    if (row) {
      await nudgeAgent(); // listener is up now — flip the entry healthy
      return row;
    }
    if (Date.now() - lastNudge > 9_000) {
      lastNudge = Date.now();
      await nudgeAgent();
    }
    await sleep(3_000);
  }
  return null;
}

async function waitForVersion(version, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await runnerHealth();
    const row = (h?.agents ?? []).find((a) => a.path === AGENT_PATH);
    if (row && String(row.version) === String(version)) return row;
    await sleep(3_000);
  }
  return null;
}

async function cleanup() {
  console.log("\n── cleanup ──");
  if (!PACK) return;
  for (const p of [`/api/agents${AGENT_PATH}`]) {
    try {
      const r = await registry("DELETE", p);
      console.log(`  ${r.status} DELETE ${p}`);
    } catch (e) {
      console.warn(`  cleanup ${p} failed: ${e.message}`);
    }
  }
  try {
    const r = await platform("POST", `/api/packs/${PACK}/unpublish`);
    console.log(`  ${r.status} unpublish probe pack`);
  } catch (e) {
    console.warn(`  cleanup unpublish failed: ${e.message}`);
  }
}
const dieCleanup = (e) => {
  console.error("probe died:", e?.message || e);
  // Registry rows must never leak: wait for cleanup, then stop for real.
  void cleanup().then(
    () => process.exit(1),
    () => process.exit(1),
  );
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
// A top-level `die()` in an ES module surfaces as an uncaughtException (NOT an
// unhandledRejection — verified), so both paths must run cleanup.
process.on("uncaughtException", dieCleanup);
process.on("unhandledRejection", dieCleanup);

// ── 1. publish + deploy v1 with the fake secret ─────────────────────────────
console.log("── 1. publish probe pack (private) + deploy v1 with a fake secret ──");
{
  const pub = await platform("POST", "/api/packs", { manifest: manifest() });
  const pubBody = await pub.json().catch(() => ({}));
  if (!pub.ok) die(`publish failed: ${pub.status} ${JSON.stringify(pubBody).slice(0, 300)}`);
  PACK = pubBody.id;
  AGENT_PATH = `/packs/${PACK}/${AGENT_ID}`;
  ok(`pack ${PACK} published`);

  const deployBody = { secrets: { [AGENT_ID]: { [SECRET_NAME]: FAKE_VALUE } } };
  if (BILLING_KEY) deployBody.billingKeys = { [AGENT_ID]: BILLING_KEY };
  const dep = await platform("POST", `/api/packs/${PACK}/versions/1/deploy`, deployBody);
  const depBody = await dep.json().catch(() => ({}));
  if (depBody.code === "BILLING_KEY_REQUIRED") {
    die("this deployment enforces the billing gate — rerun with PROBE_BILLING_KEY=<sk-…>");
  }
  if (!dep.ok) die(`deploy failed: ${dep.status} ${JSON.stringify(depBody).slice(0, 300)}`);
  ok(`deployed (billing linked: ${depBody.billing?.linked ?? false})`);

  const deployed = (depBody.deployed ?? []).find((d) => d.agentId === AGENT_ID);
  if (!deployed) die("no deployed row for the probe agent");
  const surface = deployed.secretRefs ?? {};
  if (!surface[SECRET_NAME]) {
    die("the deploy surface carries no secretRefs — this platform does not run add-deployment-secrets yet (deploy the change first)");
  }
  if (surface[SECRET_NAME].includes(FAKE_VALUE)) die("the deploy surface leaked the value");
  if (!surface[SECRET_NAME].endsWith(FAKE_VALUE.slice(-4)) || !surface[SECRET_NAME].startsWith("ws_")) {
    die(`deploy surface mask has an unexpected shape: ${surface[SECRET_NAME]}`);
  }
  ok(`deploy surface shows ${SECRET_NAME} masked (${surface[SECRET_NAME]})`);

  // Bindings readout: names only.
  const bindings = await (await platform("GET", `/api/packs/${PACK}/secret-bindings`)).json();
  if (!(bindings[AGENT_ID] ?? []).includes(SECRET_NAME)) die(`secret-bindings missing ${SECRET_NAME}: ${JSON.stringify(bindings)}`);
  ok(`secret-bindings: ${JSON.stringify(bindings[AGENT_ID])}`);

  // ── 2. every public face is value-free ────────────────────────────────────
  console.log("── 2. public faces + registry entry + card carry no value ──");
  const surfaces = [
    ["platform detail", JSON.stringify(await (await platform("GET", `/api/packs/${PACK}`)).json())],
    ["platform version", JSON.stringify(await (await platform("GET", `/api/packs/${PACK}/versions/1`)).json())],
    ["platform bindings", JSON.stringify(bindings)],
    ["deploy response", JSON.stringify(depBody)],
    ["registry entry", JSON.stringify(await (await registry("GET", `/api/agents${AGENT_PATH}`)).json())],
  ];
  for (const [label, text] of surfaces) {
    if (text.includes(FAKE_VALUE)) die(`${label} leaked the value`);
  }
  const entry = await (await registry("GET", `/api/agents${AGENT_PATH}`)).json();
  const meta = entry.metadata ?? {};
  if (!meta.secret_refs?.[SECRET_NAME]) die(`registry descriptor carries no secret_refs: ${JSON.stringify(meta).slice(0, 200)}`);
  ok(`registry descriptor carries the reference only (secret_refs.${SECRET_NAME} = ${meta.secret_refs[SECRET_NAME]})`);

  // The card the caller would see (registry gateway → runner).
  try {
    const cardRes = await fetch(`${REGISTRY}/agent${AGENT_PATH}/.well-known/agent-card.json`, {
      headers: { "X-Authorization": `Bearer ${TOKEN}`, Authorization: `Bearer ${BACKEND}` },
    });
    const cardText = await cardRes.text();
    if (cardText.includes(FAKE_VALUE)) die("card leaked the value");
    ok(`card value-free (HTTP ${cardRes.status})`);
  } catch (e) {
    console.warn(`  ! card fetch skipped: ${e.message}`);
  }

  // ── 3. the child pins the value into its private credentials file ─────────
  console.log("── 3. runner composes the child; the value lands in .credentials.yaml ──");
  const row = await waitForAgent();
  if (!row) die("runner never served the probe agent (poll window exceeded)");
  ok(`runner serving ${AGENT_PATH} on :${row.port} (v${row.version})`);
  const turn = await sendTurn("请按技能回答。", `probe-secret-ctx-${Date.now()}`);
  if (!turn) die("the agent row vanished before the turn");
  ok(`turn triggered (HTTP ${turn.status}; the pinned credential is the point, not the LLM answer)`);

  const agentKey = agentKeyNow();
  const credText = (() => {
    try {
      return readRunnerFile(`${agentKey}/.credentials.yaml`);
    } catch (e) {
      die(`cannot read the child's credentials file (${agentKey}/.credentials.yaml): ${e.message}${turnDiagnostic(turn)}`);
      return "";
    }
  })();
  if (!credText.includes(FAKE_VALUE)) die(`the fake secret is NOT in the child's credentials file${turnDiagnostic(turn)}`);
  ok(`child home credentials carry ${SECRET_NAME} (value in place)`);

  // ── 4. a reference the store cannot resolve fails composition loudly ──────
  console.log("── 4. redeploy with an unresolvable reference → composition fails, ref named ──");
  await deployToRegistry({
    packId: PACK,
    version: 2,
    manifest: manifest(),
    runnerBaseUrl: RUNNER_ORIGIN,
    packsPublicBase: PACKS_PUBLIC_BASE,
    registryUrl: REGISTRY,
    token: TOKEN,
    skillGroups: String(process.env.PROBE_SKILL_GROUPS || "pack-deployers").split(",").map((s) => s.trim()).filter(Boolean),
    secretRefs: { [AGENT_ID]: { [SECRET_NAME]: MISSING_REF } },
  });
  ok("v2 deployed via the deploy library with a dangling reference");
  const swapped = await waitForVersion(2);
  if (!swapped) die("the runner never picked v2 up");
  await sleep(2_000); // let the drain settle before forcing the next spawn
  const failTurn = await sendTurn("再回答一次。", `probe-secret-ctx-fail-${Date.now()}`);
  if (!failTurn) die("the agent row vanished before the failure turn");
  if (!/probe_pat/.test(failTurn.body) || !/could not be fetched/.test(failTurn.body)) {
    die(`the failure did not name the missing secret/ref: ${failTurn.body.slice(0, 300)}`);
  }
  if (failTurn.body.includes(MISSING_REF)) {
    console.warn("  ! the error text carries the full reference; per design D6 it should be masked");
  }
  ok(`composition failed loudly: ${failTurn.body.slice(0, 160).replace(/\s+/g, " ")}`);
  const h2 = await runnerHealth();
  if ((h2?.agents ?? []).find((a) => a.path === AGENT_PATH && a.state !== "warm")) {
    console.warn("  ! a child still shows live after the failed composition — inspect the runner");
  }
}

await cleanup();
console.log("\nALL GREEN — deployment-secrets chain verified on staging.");
process.exit(process.exitCode ?? 0);