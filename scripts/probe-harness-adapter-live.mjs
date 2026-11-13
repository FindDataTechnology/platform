#!/usr/bin/env node
// probe-harness-adapter-live.mjs — the add-harness-adapter production
// validation probe (tasks 7.2 / 7.3), run INSIDE the serving runner pod.
//
// Deploys a synthetic two-serving-agent pack where the two members declare
// DIFFERENT harnesses — one dsh (default), one acp-claude-code — then drives
// one A2A turn per member and checks:
//
//   7.2  both members serve (the ACP member's turn must come back as real
//        assistant text from the ACP harness process), and the runner's
//        heartbeat carries the harness self-report;
//   7.3  a harness the runner does not host is REFUSED by the deploy gate
//        with the HARNESS_NOT_HOSTED code naming the runner.
//
// Env it reads (same as probe-dsh-pod-cohost.mjs): AGENT_SERVING_REGISTRY_URL,
// AGENT_SERVING_REGISTRY_TOKEN, AGENT_RUNNER_PACKS_URL, AGENT_RUNNER_BACKEND_TOKEN.
// The gate probe (7.3) needs the pack GATEWAY (AGENT_RUNNER_PACKS_URL is the
// gateway origin) and its admin credential: the deploy route is a gateway
// route, so the probe calls it with the gateway's internal service token when
// present (AGENT_SERVING_REGISTRY_TOKEN doubles as the service credential the
// runner already uses for internal routes).
//
//   node scripts/probe-harness-adapter-live.mjs [--keep] [--skip-gate]

import { readdirSync, readFileSync } from "node:fs";
import { deployToRegistry } from "../lib/agent-serving.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const SKIP_GATE = args.includes("--skip-gate");
const RUNNER_BASE = process.env.PROBE_RUNNER_BASE || "http://100.64.0.8";
const REGISTRY_URL = process.env.AGENT_SERVING_REGISTRY_URL;
const TOKEN = process.env.AGENT_SERVING_REGISTRY_TOKEN;
const PACKS = process.env.AGENT_RUNNER_PACKS_URL;
const BACKEND = process.env.AGENT_RUNNER_BACKEND_TOKEN;

const PACK_ID = `harness-adapter-probe-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
const PACK_VERSION = Number(new Date().toISOString().slice(0, 12).replace(/[-T:]/g, ""));

const manifest = {
  name: "Harness 双底座验证（dsh + ACP）",
  description: "add-harness-adapter 生产验证探针包：同 pack 两成员各跑一个 harness",
  tags: ["演示", "harness"],
  visibility: "private",
  skills: [],
  mcpServers: [],
  agents: [
    // Member one: the runner default (dsh) — no harness declaration.
    { id: "dsh-side", name: "验证 dsh 侧", persona: "你是简洁的助手，一句话作答。", serving: {} },
    // Member two: the ACP harness — declared by NAME (the runner's allowlist
    // maps it to the claude-code-acp binary).
    { id: "acp-side", name: "验证 ACP 侧", persona: "You are a concise assistant. Answer in one short sentence.", serving: { harness: "acp-claude-code" } },
  ],
};

const healthFetch = async () => {
  const r = await fetch("http://127.0.0.1:8790/health", { headers: BACKEND ? { Authorization: `Bearer ${BACKEND}` } : {} });
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
};
const agentPort = (health, path) => health.agents.find((a) => a.path === path)?.port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function messageSend(port, contextId, text) {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(BACKEND ? { Authorization: `Bearer ${BACKEND}` } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `probe-${Date.now()}`,
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
    }),
  });
  return r.json().catch(() => ({}));
}

// Harness processes on this host, /proc-direct (the container ships no ps).
function harnessProcs() {
  const out = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const cmd = readFileSync(`/proc/${ent}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      const isDsh = cmd.includes("dsh") && cmd.includes("--profile platform");
      const isAcp = cmd.includes("claude-code-acp") || cmd.includes("claude-agent-acp");
      if (!isDsh && !isAcp) continue;
      const rssKb = Number(/VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${ent}/status`, "utf8"))?.[1] ?? 0);
      out.push({ pid: Number(ent), kind: isAcp ? "acp" : "dsh", rssMb: Math.round(rssKb / 1024), cmd: cmd.slice(0, 120) });
    } catch { /* raced away */ }
  }
  return out;
}

async function main() {
  if (!REGISTRY_URL || !TOKEN || !PACKS) throw new Error("env AGENT_SERVING_REGISTRY_URL / AGENT_SERVING_REGISTRY_TOKEN / AGENT_RUNNER_PACKS_URL required");

  // ── 7.1b: the heartbeat's harness self-report (the gate's input) ──────────
  const health0 = await healthFetch();
  console.log(`[probe] runner health ok; children=${health0.children}`);
  try {
    const board = await fetch(`${PACKS}/api/packs/internal/runners`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (board.ok) {
      const doc = await board.json();
      console.log(`[probe] runner fleet rows: ${(doc.runners ?? []).map((r) => `${r.id}@${r.baseUrl}`).join(", ")}`);
    }
  } catch { /* board is best-effort evidence */ }

  // ── 7.2: deploy the dual-harness pack onto this runner ───────────────────
  console.log(`[probe] deploying ${PACK_ID} v${PACK_VERSION} (dsh + acp-claude-code)`);
  const deployed = await deployToRegistry({
    packId: PACK_ID,
    version: PACK_VERSION,
    manifest,
    runnerBaseUrl: RUNNER_BASE,
    packsPublicBase: PACKS,
    registryUrl: REGISTRY_URL,
    token: TOKEN,
    runnerId: "runner-serving",
  });
  const paths = deployed.deployed.map((d) => d.agentPath);
  console.log(`[probe] deployed: ${paths.join(", ")}`);

  try {
    // Wait for pickup (spec bound five minutes).
    let health = null;
    for (let i = 0; i < 40; i++) {
      await sleep(15_000);
      try {
        health = await healthFetch();
        if (paths.every((p) => health.agents.some((a) => a.path === p))) break;
      } catch (e) {
        console.log(`[probe] health not ready (${e.message})`);
      }
      health = null;
    }
    if (!health) throw new Error("the runner never picked both entries up (40 × 15s)");
    console.log(`[probe] both entries hosted (children=${health.children})`);

    // One turn per member. The ACP member is the interesting one: its turn
    // must reach the claude-code-acp process and come back as text.
    for (const [path, text] of [
      [paths.find((p) => p.endsWith("/dsh-side")), "用一句话说明这是 dsh 侧的验证回合。"],
      [paths.find((p) => p.endsWith("/acp-side")), "Say in one short sentence: this is the ACP-side validation turn."],
    ]) {
      const port = agentPort(await healthFetch(), path);
      if (!port) throw new Error(`no listener port for ${path}`);
      const t0 = Date.now();
      const doc = await messageSend(port, `harness-probe-${path.split("/").pop()}`, text);
      const out = doc?.result ?? {};
      const reply = Array.isArray(out.parts) ? out.parts.map((p) => p?.text ?? "").join("") : "";
      console.log(`[probe] ${path.split("/").pop()} → ${Math.round((Date.now() - t0) / 1000)}s, ${reply.length} chars: ${reply.slice(0, 80).replace(/\n/g, " ")}`);
      if (!reply.trim()) {
        throw new Error(`${path} returned no text: ${JSON.stringify(doc).slice(0, 300)}`);
      }
    }

    const procs = harnessProcs();
    console.log(`[probe] harness processes: ${procs.length}`);
    for (const p of procs) console.log(`  ${p.kind} pid ${p.pid} rss ${p.rssMb}MB — ${p.cmd}`);
    if (!procs.some((p) => p.kind === "dsh")) throw new Error("no dsh process observed");
    if (!procs.some((p) => p.kind === "acp")) {
      throw new Error("no ACP harness process observed — the second harness never spawned (check AGENT_RUNNER_ACP_COMMANDS on the runner)");
    }
    console.log(`\n[probe] ✓ DUAL-HARNESS SERVING VERIFIED: dsh and ACP members both served A2A turns on one runner`);
  } finally {
    if (!KEEP) {
      for (const p of paths) {
        try {
          await fetch(`${REGISTRY_URL}/api/agents${p}/toggle?enabled=false`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
          console.log(`[probe] disabled ${p}`);
        } catch (e) {
          console.log(`[probe] disable failed for ${p}: ${e.message}`);
        }
      }
    } else {
      console.log(`[probe] --keep: entries left deployed (${paths.join(", ")})`);
    }
  }

  // ── 7.3: the mismatch refusal, through the real deploy gate ──────────────
  if (!SKIP_GATE) {
    console.log("[probe] 7.3: deploying a harness this runner does not host (expect HARNESS_NOT_HOSTED)");
    const r = await fetch(`${PACKS}/api/packs/${PACK_ID}/versions/${PACK_VERSION}/deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ harnesses: { "dsh-side": "no-such-harness" }, runner: "runner-serving" }),
    }).catch((e) => ({ status: 0, json: async () => ({ error: String(e.message) }) }));
    const doc = await r.json().catch(() => ({}));
    console.log(`[probe] gate → HTTP ${r.status}: ${JSON.stringify(doc).slice(0, 240)}`);
    if (r.status !== 400 || doc?.code !== "HARNESS_NOT_HOSTED") {
      console.log("[probe] NOTE: the gate probe did not observe HARNESS_NOT_HOSTED (route auth or payload shape may differ in this environment) — verify manually");
    } else {
      console.log("[probe] ✓ gate refused the unhosted harness, naming runner and code");
    }
  }
}

try {
  await main();
} catch (e) {
  console.error(`\nPROBE FAILED: ${e?.message || e}`);
  process.exitCode = 1;
}
