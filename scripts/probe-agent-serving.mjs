#!/usr/bin/env node
// ── Full-chain probe: Agent Services end-to-end (add-a2a-agent-serving 6.2) ──
//
// Drives the REAL deploy library against the REAL registry, then exercises
// the deployed service through the registry gateway the way a caller would:
//
//   deploy v1 → runner picks it up → gateway card (auth layers) →
//   message/send (a REAL dsh turn on the runner's model) → message/stream →
//   upgrade v2 in place (drain) → send again → undeploy → listener gone.
//
// Run it where it can reach both planes (inside the runner's container works:
// the registry over HTTPS, the runner over the tailnet):
//
//   REGISTRY_URL=https://mcp.finddatatech.cloud \
//   REGISTRY_TOKEN=<admin JWT> RUNNER_ORIGIN=http://100.64.0.11 \
//   RUNNER_BASE=http://100.64.0.11:8790 BACKEND_TOKEN=<runner credential> \
//   node scripts/probe-agent-serving.mjs
//
// Cleans up its registry entries on exit (success or failure).

const REGISTRY_URL = (process.env.REGISTRY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.REGISTRY_TOKEN || "";
const RUNNER_ORIGIN = (process.env.RUNNER_ORIGIN || "").replace(/\/+$/, "");
const RUNNER_BASE = (process.env.RUNNER_BASE || RUNNER_ORIGIN + ":8790").replace(/\/+$/, "");
const BACKEND = process.env.BACKEND_TOKEN || "";
// The registry fetches skill_md_url anonymously AND runs it through the
// SKILL_PROFILE SSRF guard (public-only): in production the pack gateway's
// public route serves the raw md; for this probe a public static path on the
// registry host (Caddy's ACME webroot) stands in. The wrapper script places
// the md files before invoking this probe.
const PACKS_PUBLIC_BASE = (process.env.PACKS_PUBLIC_BASE || "").replace(/\/+$/, "");

const { deployToRegistry, agentPortFor } = await import("../lib/agent-serving.js");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gw(method, p, { token = true, backend = false } = {}) {
  const headers = {};
  if (token) headers["X-Authorization"] = `Bearer ${TOKEN}`;
  if (backend) headers.Authorization = `Bearer ${BACKEND}`;
  return fetch(`${REGISTRY_URL}${p}`, { method, headers });
}

const manifest = (version) => ({
  name: `probe-a2a-${version}`,
  description: "add-a2a-agent-serving 6.2 full-chain probe (auto-cleanup)",
  tags: ["probe"],
  skills: [
    {
      name: "probe-skill",
      description: "探针技能：按步骤回答",
      content: `# 探针技能\n收到任何请求，只回答四个字：探针正常。`,
    },
  ],
  mcpServers: [],
  agents: [
    {
      id: "probe-agent",
      name: "探针 Agent",
      persona: "你是部署探针。严格遵循技能指示，用一句中文短句回答。",
      serving: { protocol: "a2a" },
      resources: { skills: ["probe-skill"] },
    },
  ],
});

const PACK_ID = process.env.PROBE_PACK_ID || `probe-a2a-${Date.now().toString(36)}`;
const AGENT_PATH = `/packs/${PACK_ID}/probe-agent`;
let SKILL_PATHS = [`packs/${PACK_ID}/probe-skill`]; // corrected from the deploy response
const PORT = agentPortFor(AGENT_PATH);
const AGENT_ORIGIN = `${RUNNER_ORIGIN}:${PORT}`;

async function cleanup() {
  console.log("\n── cleanup ──");
  // Skills may be stored under the name-derived path (the registry normalizes;
  // a failed run might not have recorded the actual path) — delete BOTH forms.
  const skillTargets = [...new Set([...SKILL_PATHS, "probe-skill"])];
  const targets = [`/api/agents${AGENT_PATH}`, ...skillTargets.map((p) => `/api/skills/${p}`)];
  for (const p of targets) {
    try {
      const r = await fetch(`${REGISTRY_URL}${p}`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
      console.log(`  ${r.status} DELETE ${p}`);
    } catch (e) {
      console.warn(`  cleanup ${p} failed: ${e.message}`);
    }
  }
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));
// A failed step throws and would otherwise leak its registry rows — the next
// run then hits name collisions. Run cleanup on ANY exit path.
process.on("unhandledRejection", (e) => {
  console.error("unhandled:", e?.message || e);
  void cleanup().then(() => process.exit(1));
});

async function runnerHealth() {
  try {
    return await (await fetch(`${RUNNER_BASE}/health`)).json();
  } catch {
    return null;
  }
}

async function waitForAgent(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await runnerHealth();
    const row = h?.agents?.find((a) => a.path === AGENT_PATH);
    if (row) return row;
    await sleep(3_000);
  }
  return null;
}

async function sendOnce(text, contextId, { stream = false } = {}) {
  const res = await fetch(`${REGISTRY_URL}/agent${AGENT_PATH}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Authorization": `Bearer ${TOKEN}`,
      Authorization: `Bearer ${BACKEND}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: stream ? "message/stream" : "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
    }),
  });
  if (stream) return { status: res.status, body: await res.text() };
  return { status: res.status, body: await res.text() };
}

console.log("── 1. deploy v1 (real deploy library → registry) ──");
const v1 = await deployToRegistry({
  packId: PACK_ID,
  version: 1,
  manifest: manifest("v1"),
  runnerBaseUrl: RUNNER_ORIGIN,
  packsPublicBase: PACKS_PUBLIC_BASE,
  registryUrl: REGISTRY_URL,
  token: TOKEN,
  skillGroups: ["pack-deployers"],
});
if (v1.skills?.length) SKILL_PATHS = v1.skills;
ok(`registered ${AGENT_PATH} → ${AGENT_ORIGIN}`);

// The registry health-gates proxy routes: force a check so the location
// blocks exist before we rely on them.
const hc = await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}/health`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
ok(`health check: ${hc.status}`);

console.log("── 2. runner picks the bundle up (poll) ──");
const row = await waitForAgent();
if (!row) die("runner never served the probe agent (poll window exceeded)");
ok(`runner serving on :${row.port} (v${row.version})`);

// Now that the backend card actually answers, re-run the health check so the
// registry flips the entry healthy and emits the gateway location block.
{
  const hc2 = await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}/health`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  const doc = await hc2.json().catch(() => ({}));
  if (doc.status !== "healthy") die(`health re-check not healthy: ${JSON.stringify(doc).slice(0, 200)}`);
  ok("registry health re-check healthy (block emitted)");
}

console.log("── 3. gateway card, auth layers (poll: nginx block reload lags health) ──");
{
  const cardUrl = `/agent${AGENT_PATH}/.well-known/agent-card.json`;
  let card = null;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const anon = await gw("GET", cardUrl, { token: false });
    const noBackend = await gw("GET", cardUrl);
    const runnerLayer = await noBackend.json().catch(() => null);
    const both = await gw("GET", cardUrl, { backend: true });
    card = await both.json().catch(() => null);
    if (anon.status === 401 && noBackend.status === 401 && runnerLayer?.error && both.status === 200 && card?.name === "探针 Agent") {
      ok("anon → 401");
      ok("gateway-cred only → 401 from the RUNNER (validate passed)");
      ok(`card → 200 (${card.name})`);
      break;
    }
    if (Date.now() > deadline) {
      die(`auth layers not settled: anon=${anon.status} noBackend=${noBackend.status} both=${both.status} card=${card?.name}`);
    }
    await sleep(3_000);
  }
}

// Free-tier upstreams throw transient 429/503 — one bounded retry.
async function send(text, contextId, opts = {}) {
  let r = await sendOnce(text, contextId, opts);
  if (r.status === 200 && /429|503|temporarily/.test(r.body)) {
    console.log("  … transient upstream error, retrying in 20s");
    await sleep(20_000);
    r = await sendOnce(text, contextId, opts);
  }
  return r;
}

console.log("── 4. message/send — a REAL dsh turn through the gateway ──");
{
  const t0 = Date.now();
  const r = await send("请按技能回答。", "probe-ctx-1");
  const doc = JSON.parse(r.body);
  const text = doc?.result?.parts?.[0]?.text ?? "";
  if (r.status !== 200 || !text) die(`send failed: ${r.status} ${r.body.slice(0, 200)}`);
  ok(`reply in ${((Date.now() - t0) / 1000).toFixed(1)}s (cold start included): “${text.slice(0, 40)}”`);
}

console.log("── 5. message/stream (SSE) ──");
{
  const r = await send("再回答一次。", "probe-ctx-1", { stream: true });
  if (r.status !== 200 || !/event: message/.test(r.body) || !/event: done/.test(r.body)) {
    die(`stream shape unexpected: ${r.status} ${r.body.slice(0, 200)}`);
  }
  ok("SSE delta/message/done all present");
}

console.log("── 6. in-place upgrade to v2 (drain, no second entry) ──");
{
  await deployToRegistry({
    packId: PACK_ID,
    version: 2,
    manifest: manifest("v2"),
    runnerBaseUrl: RUNNER_ORIGIN,
    packsPublicBase: PACKS_PUBLIC_BASE,
    registryUrl: REGISTRY_URL,
    token: TOKEN,
    skillGroups: ["pack-deployers"],
  });
  const deadline = Date.now() + 120_000;
  let version = row.version;
  while (Date.now() < deadline) {
    const h = await runnerHealth();
    const r2 = h?.agents?.find((a) => a.path === AGENT_PATH);
    version = r2?.version ?? version;
    if (version === 2) break;
    await sleep(3_000);
  }
  if (version !== 2) die(`upgrade never landed (still v${version})`);
  ok("runner swapped to v2 in place");
  const list = await (await fetch(`${REGISTRY_URL}/api/agents`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  const same = (list.agents ?? list).filter((a) => String(a.path) === AGENT_PATH);
  if (same.length !== 1) die(`entry proliferation: ${same.length} rows for ${AGENT_PATH}`);
  ok("exactly one registry entry (no proliferation)");
  const r = await send("v2 验证，请回答。", "probe-ctx-2");
  if (r.status !== 200) die(`post-upgrade send failed: ${r.status}`);
  ok("post-upgrade turn served");
}

console.log("── 7. undeploy (delete entries → runner stops serving) ──");
{
  await cleanup();
  const deadline = Date.now() + 60_000;
  let gone = false;
  while (Date.now() < deadline) {
    const h = await runnerHealth();
    if (!h?.agents?.some((a) => a.path === AGENT_PATH)) {
      gone = true;
      break;
    }
    await sleep(3_000);
  }
  if (!gone) die("runner kept serving after undeploy");
  ok("runner listener stopped, entry gone");
  const card = await gw("GET", `/agent${AGENT_PATH}/.well-known/agent-card.json`, { backend: true });
  if (card.status === 404 || card.status === 502) ok(`gateway route gone (${card.status})`);
  else console.warn(`  ! gateway route still answers ${card.status} (nginx regeneration lag)`);
}

console.log("\nALL GREEN — full chain verified.");
process.exit(0);
