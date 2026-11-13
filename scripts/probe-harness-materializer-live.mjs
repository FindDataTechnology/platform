#!/usr/bin/env node
// probe-harness-materializer-live.mjs — the add-harness-materializer
// production validation probe (tasks 4.2 / 4.3), run INSIDE the serving
// runner pod after the image roll.
//
// Deploys a synthetic pack whose acp-claude-code member carries REAL pack
// content — a distinctive persona, one skill, one MCP reference, a data
// workspace — plus a dsh member as the zero-regression leg, then checks:
//
//   4.2a the ACP member's turn comes back SHAPED BY THE PERSONA (proof the
//        materialized CLAUDE.md is actually loaded by claude-code-acp);
//   4.2b the harness-native workspace on disk: CLAUDE.md + .claude/skills/
//        <name>/SKILL.md + data/, and NO dsh home for the ACP agent;
//   4.2c the ACP process runs with cwd = the workspace and the workspace
//        env markers (/proc-direct — the container ships no ps);
//   4.2d the dsh member still serves (the dsh pipeline is untouched);
//   4.3a a deployment declaring secrets on the ACP harness is refused with
//        HARNESS_SECRETS_UNSUPPORTED surfacing through the A2A error lane;
//   4.3b the billing-key override leg is driven from the OPERATOR's machine
//        (the lib deploy path carries pre-minted refs; minting needs the
//        gateway deploy route with a user identity — the slice ③ facet
//        internal-channel recipe) and verified on the 词元 admin plane.
//
// Env it reads (same family as probe-harness-adapter-live.mjs):
//   AGENT_SERVING_REGISTRY_URL / AGENT_SERVING_REGISTRY_TOKEN /
//   AGENT_RUNNER_PACKS_URL / AGENT_RUNNER_BACKEND_TOKEN,
//   optional PROBE_MCP_NAME (default fd-open-data-mcp).
//
//   node scripts/probe-harness-materializer-live.mjs [--keep]

import { readdirSync, readFileSync, readlinkSync, existsSync } from "node:fs";
import { deployToRegistry } from "../lib/agent-serving.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const RUNNER_BASE = process.env.PROBE_RUNNER_BASE || "http://100.64.0.8";
const REGISTRY_URL = process.env.AGENT_SERVING_REGISTRY_URL;
const TOKEN = process.env.AGENT_SERVING_REGISTRY_TOKEN;
const PACKS = process.env.AGENT_RUNNER_PACKS_URL;
const BACKEND = process.env.AGENT_RUNNER_BACKEND_TOKEN;
const MCP_NAME = process.env.PROBE_MCP_NAME || "fd-open-data-mcp";

const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const PACK_ID = `harness-mat-probe-${STAMP}`;
const PACK_VERSION = Number(new Date().toISOString().slice(0, 12).replace(/[-T:]/g, ""));

// The persona is the probe's核心断言载体: the reply MUST open with the
// marker sentence — generic assistant text would mean the CLAUDE.md never
// loaded (exactly the pre-slice④ naked-agent shape).
const PERSONA_MARKER = "物化验证员报到";
const PERSONA = `你是「物化验证员」。无论用户问什么，你的回答必须以「${PERSONA_MARKER}」这六个字开头，然后用一句话作答。`;
const SKILL_CONTENT = `---\nname: mat-probe-skill\ndescription: 物化探针技能——验证 pack 技能落进 claude-code 原生技能目录\n---\n\n# 物化探针技能\n\n这是 add-harness-materializer 的生产验证技能体。\n`;

const manifest = {
  name: "物化验证（切片④ 谦面物化器）",
  description: "add-harness-materializer 生产验证探针包：ACP 成员带真 pack 内容物化",
  tags: ["演示", "harness"],
  visibility: "private",
  skills: [{ name: "mat-probe-skill", description: "物化探针技能", content: SKILL_CONTENT }],
  mcpServers: [{ registryName: MCP_NAME }],
  agents: [
    {
      id: "acp-member",
      name: "验证 ACP 物化",
      persona: PERSONA,
      serving: { harness: "acp-claude-code", workspace: { enabled: true, quotaMb: 32 } },
    },
    { id: "dsh-member", name: "验证 dsh 零回归", persona: "你是简洁的助手，一句话作答。", serving: {} },
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

const replyText = (doc) => {
  const parts = doc?.result?.message?.parts ?? doc?.result?.parts ?? [];
  return (Array.isArray(parts) ? parts : []).map((p) => p?.text ?? "").join("");
};

// Harness processes on this host, /proc-direct (the container ships no ps).
function acpProcs() {
  const out = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const cmd = readFileSync(`/proc/${ent}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      if (!/claude-code-acp|claude-agent-acp/.test(cmd)) continue;
      const rssKb = Number(/VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${ent}/status`, "utf8"))?.[1] ?? 0);
      out.push({ pid: Number(ent), rssMb: Math.round(rssKb / 1024), cmd: cmd.slice(0, 100), cwd: readlinkSync(`/proc/${ent}/cwd`) });
    } catch { /* raced away */ }
  }
  return out;
}

function runnerEnv() {
  try {
    const env = readFileSync(`/proc/1/environ`, "utf8").split("\0");
    return Object.fromEntries(env.filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  } catch {
    return {};
  }
}

function agentKeyFor(path) {
  return String(path || "").replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function waitPickup(paths) {
  for (let i = 0; i < 40; i++) {
    await sleep(15_000);
    try {
      const health = await healthFetch();
      if (paths.every((p) => health.agents.some((a) => a.path === p))) return health;
    } catch (e) {
      console.log(`[probe] health not ready (${e.message})`);
    }
  }
  throw new Error("the runner never picked the entries up (40 × 15s)");
}

async function main() {
  if (!REGISTRY_URL || !TOKEN || !PACKS) throw new Error("env AGENT_SERVING_REGISTRY_URL / AGENT_SERVING_REGISTRY_TOKEN / AGENT_RUNNER_PACKS_URL required");

  // ── 4.2: deploy the content-bearing pack ─────────────────────────────────
  console.log(`[probe] deploying ${PACK_ID} v${PACK_VERSION} (acp member: persona+skill+mcp(${MCP_NAME})+workspace; dsh member: zero-regression)`);
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
  const acpPath = paths.find((p) => p.endsWith("/acp-member"));
  const dshPath = paths.find((p) => p.endsWith("/dsh-member"));
  console.log(`[probe] deployed: ${paths.join(", ")}`);
  const cleanup = async () => {
    if (KEEP) return;
    for (const p of paths) {
      try {
        await fetch(`${REGISTRY_URL}/api/agents${p}/toggle?enabled=false`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
        console.log(`[probe] disabled ${p}`);
      } catch (e) {
        console.log(`[probe] disable failed for ${p}: ${e.message}`);
      }
    }
  };

  try {
    await waitPickup(paths);
    console.log(`[probe] both entries hosted`);

    // 4.2a: the ACP turn must be shaped by the persona.
    const port = agentPort(await healthFetch(), acpPath);
    if (!port) throw new Error(`no listener port for ${acpPath}`);
    const t0 = Date.now();
    const doc = await messageSend(port, "mat-acp", "你是谁？请按你的设定回答。");
    const reply = replyText(doc);
    console.log(`[probe] acp-member turn → ${Math.round((Date.now() - t0) / 1000)}s: ${reply.slice(0, 120).replace(/\n/g, " ")}`);
    if (!reply.includes(PERSONA_MARKER)) {
      throw new Error(`the reply does not carry the persona marker '${PERSONA_MARKER}' — the materialized CLAUDE.md did not shape the agent (doc: ${JSON.stringify(doc).slice(0, 300)})`);
    }
    console.log(`[probe] ✓ PERSONA LOADED: the reply opens with the marker — CLAUDE.md is the live persona channel`);

    // 4.2b: the harness-native workspace on disk.
    const homeRoot = runnerEnv().AGENT_RUNNER_HOME || "/data/agent-home";
    const key = agentKeyFor(acpPath);
    const ws = `${homeRoot}/ws/${key}`;
    const claudeMd = readFileSync(`${ws}/CLAUDE.md`, "utf8");
    if (!claudeMd.startsWith("你是「物化验证员」")) throw new Error(`CLAUDE.md does not lead with the persona: ${claudeMd.slice(0, 80)}`);
    if (!claudeMd.includes("standing A2A agent service")) throw new Error("CLAUDE.md is missing the shared serving suffix");
    if (!existsSync(`${ws}/.claude/skills/mat-probe-skill/SKILL.md`)) throw new Error("the pack skill did not land as a native Agent Skill");
    const skillBody = readFileSync(`${ws}/.claude/skills/mat-probe-skill/SKILL.md`, "utf8");
    if (!skillBody.includes("物化探针技能")) throw new Error("the landed skill body does not match the pack row");
    if (!existsSync(`${ws}/data`)) throw new Error("the declared data workspace was not created");
    if (existsSync(`${homeRoot}/${key}`)) throw new Error("a DSH_HOME was materialized for the ACP agent — the pre-slice④ waste is back");
    console.log(`[probe] ✓ WORKSPACE LAYOUT: CLAUDE.md (persona+suffix) + .claude/skills/mat-probe-skill/SKILL.md + data/ under ${ws}; NO dsh home`);

    // 4.2c: the ACP process runs IN the workspace with the env markers.
    const procs = acpProcs();
    if (procs.length === 0) throw new Error("no claude-code-acp process observed");
    const inWs = procs.find((p) => p.cwd === ws);
    if (!inWs) throw new Error(`no ACP process with cwd=${ws} (observed: ${procs.map((p) => p.cwd).join(", ")})`);
    const env = readFileSync(`/proc/${inWs.pid}/environ`, "utf8").split("\0");
    if (!env.some((l) => l === `AGENT_DATA_DIR=${ws}/data`)) throw new Error("AGENT_DATA_DIR did not reach the ACP process env");
    console.log(`[probe] ✓ PROCESS SHAPE: acp pid ${inWs.pid} cwd=${ws} rss ${inWs.rssMb}MB; AGENT_DATA_DIR present (MCP ${MCP_NAME} rode session/new — the turn itself is the acceptance)`);

    // 4.2d: the dsh member still serves (zero regression on the dsh pipeline).
    const dshPort = agentPort(await healthFetch(), dshPath);
    const t1 = Date.now();
    const doc2 = await messageSend(dshPort, "mat-dsh", "用一句话说明这是 dsh 侧的零回归验证。");
    const reply2 = replyText(doc2);
    console.log(`[probe] dsh-member turn → ${Math.round((Date.now() - t1) / 1000)}s: ${reply2.slice(0, 80).replace(/\n/g, " ")}`);
    if (!reply2.trim()) throw new Error(`the dsh member returned no text: ${JSON.stringify(doc2).slice(0, 300)}`);
    console.log(`[probe] ✓ DSH ZERO-REGRESSION: the untouched dsh pipeline served its turn`);
  } finally {
    await cleanup();
  }

  // ── 4.3a: the secrets refusal, through the real A2A error lane ───────────
  console.log("[probe] 4.3a: deploying an ACP agent that declares secrets (expect HARNESS_SECRETS_UNSUPPORTED)");
  const refusalPackId = `${PACK_ID}-sec`;
  const refusalDeployed = await deployToRegistry({
    packId: refusalPackId,
    version: PACK_VERSION,
    manifest: {
      name: "物化验证·secrets 拒绝",
      visibility: "private",
      skills: [],
      mcpServers: [],
      agents: [{ id: "sec-member", name: "验证 secrets 拒绝", persona: "x", serving: { harness: "acp-claude-code" } }],
    },
    runnerBaseUrl: RUNNER_BASE,
    packsPublicBase: PACKS,
    registryUrl: REGISTRY_URL,
    token: TOKEN,
    runnerId: "runner-serving",
    secretRefs: { "sec-member": { probe_secret: "ref-does-not-exist" } },
  });
  const secPath = refusalDeployed.deployed.map((d) => d.agentPath)[0];
  try {
    await waitPickup([secPath]);
    const secPort = agentPort(await healthFetch(), secPath);
    const doc3 = await messageSend(secPort, "mat-sec", "ping");
    const errText = JSON.stringify(doc3?.error ?? doc3);
    console.log(`[probe] secrets refusal → ${errText.slice(0, 240)}`);
    if (!/no controlled secrets channel/.test(errText)) {
      throw new Error("the A2A error lane did not surface the secrets refusal text");
    }
    console.log(`[probe] ✓ SECRETS FAIL-CLOSED: the refusal named the missing channel through the real error lane`);
  } finally {
    if (!KEEP) {
      await fetch(`${REGISTRY_URL}/api/agents${secPath}/toggle?enabled=false`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => {});
      console.log(`[probe] disabled ${secPath}`);
    }
  }

  console.log(`\n[probe] ✓ HARNESS MATERIALIZER VERIFIED (layout + persona channel + process shape + dsh zero-regression + secrets fail-closed)`);
}

try {
  await main();
} catch (e) {
  console.error(`\nPROBE FAILED: ${e?.message || e}`);
  process.exitCode = 1;
}
