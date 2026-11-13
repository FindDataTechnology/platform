#!/usr/bin/env node
// ── Full-chain probe: turn budgets hard-stop (add-serving-budgets 3.1) ──────
//
// Drives the REAL deploy library against the REAL registry and the staging
// runner, then proves the over-budget hard stop end to end:
//
//   deploy a budget=1m agent (slow skill: bash sleep) → runner picks it up →
//   gateway auth layers → slow message/send → structured -32001 naming "1m"
//   at ~60s → runner shows the child gone (warm) → fast message/send on the
//   SAME context answers from a cold-started child → meter.jsonl carries the
//   budgetKill line and the follow-up ok line.
//
// Run it where it can reach both planes AND the runner's meter file (inside
// the runner's container works — the wrapper script does exactly that):
//
//   REGISTRY_URL=https://mcp.finddatatech.cloud \
//   REGISTRY_TOKEN=<admin JWT> RUNNER_ORIGIN=http://100.64.0.11 \
//   RUNNER_BASE=http://100.64.0.11:8790 BACKEND_TOKEN=<runner credential> \
//   PACKS_PUBLIC_BASE=<public base for skill md> \
//   node scripts/probe-serving-budgets.mjs
//
// METER_FILE defaults to $AGENT_RUNNER_METER_FILE / $AGENT_RUNNER_HOME/meter.jsonl.
// Cleans up its registry entries on exit (success or failure).

import path from "node:path";

const REGISTRY_URL = (process.env.REGISTRY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.REGISTRY_TOKEN || "";
const RUNNER_ORIGIN = (process.env.RUNNER_ORIGIN || "").replace(/\/+$/, "");
const RUNNER_BASE = (process.env.RUNNER_BASE || RUNNER_ORIGIN + ":8790").replace(/\/+$/, "");
const BACKEND = process.env.BACKEND_TOKEN || "";
const PACKS_PUBLIC_BASE = (process.env.PACKS_PUBLIC_BASE || "").replace(/\/+$/, "");
const METER_FILE = process.env.METER_FILE
  || process.env.AGENT_RUNNER_METER_FILE
  || path.join(process.env.AGENT_RUNNER_HOME || "/data", "meter.jsonl");

const { deployToRegistry } = await import("../lib/agent-serving.js");
const { agentKeyFor } = await import("../agent-runner/compose.js");
const { readFileSync } = await import("node:fs");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PACK_ID = process.env.PROBE_PACK_ID || `probe-budget-${Date.now().toString(36)}`;
const AGENT_PATH = `/packs/${PACK_ID}/probe-budget`;
const AGENT_KEY = agentKeyFor({ path: AGENT_PATH });
const SKILL_NAME = "probe-slow-budget";
const BUDGET_MINUTES = 1;
let SKILL_PATHS = [`packs/${PACK_ID}/${SKILL_NAME}`]; // corrected from the deploy response

const manifest = {
  name: `预算探针 ${PACK_ID}`,
  description: "add-serving-budgets 3.1 hard-stop probe (auto-cleanup)",
  tags: ["probe"],
  skills: [
    {
      name: SKILL_NAME,
      description: "探针技能：慢测先 sleep，快测直接回答",
      content: [
        "# 预算探针技能",
        "",
        "收到含「慢测」二字的消息：立刻用 bash 工具执行命令 `sleep 180`（等它完整跑完；",
        "若被工具超时提前中断，就再执行一次 `sleep 180`，直到累计等待超过 5 分钟），然后只回答四个字：慢测完成。",
        "收到含「快测」二字的消息：不要执行任何命令、不要使用任何工具，直接只回答四个字：重生正常。",
      ].join("\n"),
    },
  ],
  mcpServers: [],
  agents: [
    {
      id: "probe-budget",
      name: "预算探针 Agent",
      // Self-contained messages (the staging model is not reliably handed a
      // skill catalog — the probe never depends on skill discovery).
      persona: "你是回合预算执行探针。严格按用户消息给出的步骤行动，不要执行未要求的操作。",
      serving: { protocol: "a2a", budget: { turnMinutes: BUDGET_MINUTES } },
      resources: { skills: [SKILL_NAME] },
    },
  ],
};

async function cleanup() {
  console.log("\n── cleanup ──");
  const skillTargets = [...new Set([...SKILL_PATHS, SKILL_NAME])];
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

async function sendOnce(text, contextId) {
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
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
    }),
    // The slow turn runs to its 60s budget kill before answering; the cap
    // stays well past that so a hung turn fails the probe loudly instead.
    signal: AbortSignal.timeout(240_000),
  });
  return { status: res.status, body: await res.text() };
}

async function gw(method, p, { token = true, backend = false } = {}) {
  const headers = {};
  if (token) headers["X-Authorization"] = `Bearer ${TOKEN}`;
  if (backend) headers.Authorization = `Bearer ${BACKEND}`;
  return fetch(`${REGISTRY_URL}${p}`, { method, headers });
}

console.log("── 1. deploy a budget=1m agent (real deploy library → registry) ──");
{
  const v1 = await deployToRegistry({
    packId: PACK_ID,
    version: 1,
    manifest,
    runnerBaseUrl: RUNNER_ORIGIN,
    packsPublicBase: PACKS_PUBLIC_BASE,
    registryUrl: REGISTRY_URL,
    token: TOKEN,
    skillGroups: ["pack-deployers"],
  });
  if (v1.skills?.length) SKILL_PATHS = v1.skills;
  const entry = await (await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  if (entry?.metadata?.effective_budget_minutes !== BUDGET_MINUTES) {
    die(`descriptor must carry effective_budget_minutes=${BUDGET_MINUTES}, got ${JSON.stringify(entry?.metadata?.effective_budget_minutes)}`);
  }
  ok(`registered ${AGENT_PATH} (descriptor effective_budget_minutes=${BUDGET_MINUTES})`);
}
{
  const hc = await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}/health`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  ok(`health check: ${hc.status}`);
}

console.log("── 2. runner picks the bundle up (poll) ──");
const row = await waitForAgent();
if (!row) die("runner never served the probe agent (poll window exceeded)");
ok(`runner serving on :${row.port} (v${row.version})`);
{
  const hc2 = await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}/health`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
  const doc = await hc2.json().catch(() => ({}));
  if (doc.status !== "healthy") die(`health re-check not healthy: ${JSON.stringify(doc).slice(0, 200)}`);
  ok("registry health re-check healthy (gateway block emitted)");
}

console.log("── 3. gateway auth layers (poll: block reload lags health) ──");
{
  const cardUrl = `/agent${AGENT_PATH}/.well-known/agent-card.json`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const anon = await gw("GET", cardUrl, { token: false });
    const both = await gw("GET", cardUrl, { backend: true });
    if (anon.status === 401 && both.status === 200) {
      ok("route live (anon 401, both credentials 200)");
      break;
    }
    if (Date.now() > deadline) die(`gateway route not settled: anon=${anon.status} both=${both.status}`);
    await sleep(3_000);
  }
}

console.log(`── 4. slow message/send → expected hard stop at ${BUDGET_MINUTES}m ──`);
const CTX = `probe-budget-ctx-${Date.now().toString(36)}`;
{
  const t0 = Date.now();
  const r = await sendOnce("慢测：请立刻用 bash 工具执行命令 `sleep 180`，等它完整跑完（若被超时中断就再执行一次），然后只回复四个字：慢测完成。不要做任何其他事。", CTX);
  const elapsed = Date.now() - t0;
  const doc = JSON.parse(r.body);
  const err = doc?.error;
  if (r.status !== 200 || !err) die(`expected a structured error, got ${r.status}: ${r.body.slice(0, 300)}`);
  if (err.code !== -32001) die(`expected code -32001, got ${err.code}: ${err.message}`);
  if (!new RegExp(`turn budget \\(${BUDGET_MINUTES}m\\) exceeded`).test(err.message || "")) {
    die(`error must name the ${BUDGET_MINUTES}m bound, got: ${err.message}`);
  }
  if (elapsed < 55_000 || elapsed > 200_000) die(`kill timing off: ${(elapsed / 1000).toFixed(1)}s (expected ~${BUDGET_MINUTES * 60}s)`);
  ok(`hard-stopped after ${(elapsed / 1000).toFixed(1)}s: ${err.code} “${err.message}”`);
}

console.log("── 5. the child was stopped (runner reports the role warm) ──");
{
  const deadline = Date.now() + 30_000;
  let state = null;
  while (Date.now() < deadline) {
    const h = await runnerHealth();
    const r2 = h?.agents?.find((a) => a.path === AGENT_PATH);
    state = r2?.state ?? null;
    if (state === "warm") break;
    await sleep(2_000);
  }
  if (state !== "warm") die(`child not removed after the kill (state: ${state})`);
  ok("no resident child after the kill (next touch cold-starts)");
}

console.log("── 6. fast message/send on the SAME context → cold-started child answers ──");
{
  const t0 = Date.now();
  const r = await sendOnce("快测：不要执行任何命令、不要使用任何工具，只回复四个字：重生正常。", CTX);
  const doc = JSON.parse(r.body);
  const text = doc?.result?.parts?.[0]?.text ?? "";
  if (r.status !== 200 || !text) die(`re-warmed turn failed: ${r.status} ${r.body.slice(0, 300)}`);
  ok(`answered in ${((Date.now() - t0) / 1000).toFixed(1)}s (cold start included): “${text.slice(0, 40)}”`);
}

console.log("── 7. meter.jsonl carries the budget kill and the follow-up success ──");
{
  let lines;
  try {
    lines = readFileSync(METER_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    die(`meter file unreadable at ${METER_FILE}: ${e.message}`);
  }
  const mine = lines.filter((l) => l.agent === AGENT_KEY);
  const kill = mine.find((l) => l.budgetKill === true);
  if (!kill) die(`no budgetKill line for ${AGENT_KEY} in ${METER_FILE} (saw ${mine.length} line(s))`);
  if (kill.ok !== false || !new RegExp(`turn budget \\(${BUDGET_MINUTES}m\\) exceeded`).test(kill.error || "")) {
    die(`budgetKill line shape unexpected: ${JSON.stringify(kill)}`);
  }
  ok(`budgetKill line: kind=${kill.kind}, error=“${kill.error}”`);
  const okLine = mine.find((l) => l.ok === true);
  if (!okLine) die("no ok line for the re-warmed turn");
  ok(`re-warmed turn metered ok (kind=${okLine.kind})`);
}

console.log("\n── 8. undeploy → cleanup ──");
await cleanup();
{
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
}

console.log("\nALL GREEN — turn-budget hard stop verified end to end.");
process.exit(0);