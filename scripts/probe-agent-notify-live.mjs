#!/usr/bin/env node
// ── Full-chain probe: agent notifications end-to-end (add-agent-notifications 3.1) ──
//
// Drives the REAL deploy library against the REAL registry, then exercises a
// deployed agent's `bot_notify` tool through the registry gateway the way a
// caller would:
//
//   deploy v1 with notifyChannel=test-channel → runner picks it up →
//   one directive turn (the skill instructs the tool call) → the child's
//   receipt reports delivery → redeploy v2 with notifyChannel=null → the same
//   turn now reports the unbound decline → a [RATE] turn trips the per-agent
//   bound (6/min on the runner, below the relay's own 10/min — so the excess
//   is declined runner-side, before any egress).
//
// Observable halves, in order of availability:
//   • the CHILD's receipt is always asserted from the A2A reply — the skill
//     makes the model echo the tool outcome verbatim;
//   • the RUNNER's notify audit (notify.jsonl) is asserted when NOTIFY_LOG
//     points at it (run the probe where the runner's home is readable);
//   • the PLATFORM relay's audit (bot_relay_log) is asserted when
//     RELAY_LOG_DB points at the platform's sqlite file (run on the platform
//     host / inside its container).
//
// Run it where both planes are reachable (inside the runner's container works):
//
//   REGISTRY_URL=https://mcp.finddatatech.cloud \
//   REGISTRY_TOKEN=<admin JWT> RUNNER_ORIGIN=http://100.64.0.11 \
//   RUNNER_BASE=http://100.64.0.11:8790 BACKEND_TOKEN=<runner credential> \
//   PACKS_PUBLIC_BASE=https://<pack gateway public origin> \
//   NOTIFY_CHANNEL=test-channel [NOTIFY_LOG=/opt/agent-runner/home/notify.jsonl] \
//   [RELAY_LOG_DB=/app/data/app.db] \
//   node scripts/probe-agent-notify-live.mjs
//
// Cleans up its registry entries on exit (success or failure).

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const REGISTRY_URL = (process.env.REGISTRY_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.REGISTRY_TOKEN || "";
const RUNNER_ORIGIN = (process.env.RUNNER_ORIGIN || "").replace(/\/+$/, "");
const RUNNER_BASE = (process.env.RUNNER_BASE || RUNNER_ORIGIN + ":8790").replace(/\/+$/, "");
const BACKEND = process.env.BACKEND_TOKEN || "";
const PACKS_PUBLIC_BASE = (process.env.PACKS_PUBLIC_BASE || "").replace(/\/+$/, "");
const NOTIFY_CHANNEL = process.env.NOTIFY_CHANNEL || "test-channel";
const NOTIFY_LOG = process.env.NOTIFY_LOG || ""; // optional: runner-side notify.jsonl
const RELAY_LOG_DB = process.env.RELAY_LOG_DB || ""; // optional: platform sqlite file

if (!REGISTRY_URL || !TOKEN || !RUNNER_ORIGIN || !BACKEND || !PACKS_PUBLIC_BASE) {
  console.error("missing env: REGISTRY_URL / REGISTRY_TOKEN / RUNNER_ORIGIN / BACKEND_TOKEN / PACKS_PUBLIC_BASE");
  process.exit(2);
}

const { deployToRegistry, agentPortFor } = await import("../lib/agent-serving.js");
const { agentKeyFor } = await import("../agent-runner/compose.js");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const die = (msg) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The skill carries the WHOLE protocol: the tool name, the event keys (the
// four 萬星 self-heal events as examples), and the exact receipt phrasing —
// so the assertions are about the platform, not the model's mood.
const SKILL = `# 通知探针技能（必须严格遵守，不得变通）

你是通知探针。收到任何用户消息后：

1. 消息以 [RATE] 开头：本步骤**只允许使用 bot_notify 工具**（禁止 bash、禁止其他工具、
   禁止编造结果）。必须真实连续调用 bot_notify 恰好 7 次（event=rate_probe，
   text=第1次…第7次），逐条汇报真实返回值。
2. 其他消息：真实调用一次 bot_notify（event=probe_done，text=<用户消息原文>）。
   平台投递时会给正文加 [event] 前缀，属正常。

汇报规则（逐字遵守）：
- 工具 ok=true → 回复必须以 "NOTIFY-OK" 结尾。
- 工具 ok=false → 回复必须以 "NOTIFY-FAIL:" 开头，原样抄录 reason 与 message。
- 绝不允许臆造或推测工具结果；只汇报你真实看到的返回值。

（事件名示例——爬虫自愈四类：ticket_done 工单终态 / pr_opened PR 开出 /
gate_changed 总闸变更 / handoff_needed 超限转人工。本探针用 probe_done / rate_probe。）`;

const manifest = () => ({
  name: `probe-notify-${Date.now().toString(36)}`,
  description: "add-agent-notifications 3.1 full-chain probe (auto-cleanup)",
  tags: ["probe"],
  skills: [{ name: "probe-notify-skill", description: "通知探针技能：按指示调用 bot_notify", content: SKILL }],
  mcpServers: [],
  agents: [
    {
      id: "probe-agent",
      name: "通知探针 Agent",
      persona: "你是部署探针。严格遵循技能指示，回复必须简短。",
      serving: { protocol: "a2a" },
      resources: { skills: ["probe-notify-skill"] },
    },
  ],
});

// PROBE_PACK_ID pins the id (the cheap1 wrapper pre-stages the skill md under
// the acme public dir for a KNOWN id — same recipe as probe-agent-serving).
const PACK_ID = process.env.PROBE_PACK_ID || `probe-notify-${Date.now().toString(36)}`;
const AGENT_PATH = `/packs/${PACK_ID}/probe-agent`;
const AGENT_KEY = agentKeyFor({ path: AGENT_PATH });
const PORT = agentPortFor(AGENT_PATH);
let SKILL_PATHS = [`packs/${PACK_ID}/probe-notify-skill`];

async function cleanup() {
  console.log("\n── cleanup ──");
  const targets = [`/api/agents${AGENT_PATH}`, ...[...new Set([...SKILL_PATHS, "probe-notify-skill"])].map((p) => `/api/skills/${p}`)];
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

async function entryMetadata() {
  const r = await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) return null;
  return (await r.json())?.metadata ?? null;
}

async function healthRow() {
  try {
    const h = await (await fetch(`${RUNNER_BASE}/health`)).json();
    return h?.agents?.find((a) => a.path === AGENT_PATH) ?? null;
  } catch {
    return null;
  }
}

// The runner polls the registry (≤60s) — wait until its VIEW carries what the
// deploy changed. `version` is the observable knob: every deploy in this probe
// stamps a distinct packVersion, so waiting on it proves the runner re-read
// the entry (and thus re-composed the child with the new binding).
async function waitForRunnerVersion(version, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let row = null;
  while (Date.now() < deadline) {
    row = await healthRow();
    if (row && String(row.version) === String(version)) return row;
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
  });
  return { status: res.status, body: await res.text() };
}

// Free-tier upstreams throw transient 429/503 — one bounded retry.
async function send(text, contextId) {
  let r = await sendOnce(text, contextId);
  if (r.status === 200 && /429|503|temporarily/.test(r.body)) {
    await sleep(5_000);
    r = await sendOnce(text, contextId);
  }
  if (r.status !== 200) die(`message/send HTTP ${r.status}: ${r.body.slice(0, 300)}`);
  const doc = JSON.parse(r.body);
  if (doc?.error) die(`message/send JSON-RPC error: ${JSON.stringify(doc.error).slice(0, 300)}`);
  const textOut = (doc?.result?.parts ?? doc?.result?.message?.parts ?? []).map((p) => p?.text).join("") || "";
  if (!textOut) die(`empty reply: ${r.body.slice(0, 300)}`);
  return textOut;
}

function notifyAuditLines() {
  if (!NOTIFY_LOG) return null;
  try {
    return readFileSync(NOTIFY_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

function relayAuditRows(limit = 20) {
  if (!RELAY_LOG_DB) return null;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(RELAY_LOG_DB, { readonly: true, fileMustExist: true });
    try {
      return db
        .prepare("SELECT ts, channel, text_chars AS textChars, outcome, error FROM bot_relay_log WHERE channel = ? ORDER BY ts DESC LIMIT ?")
        .all(NOTIFY_CHANNEL, limit);
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn(`  (relay log unreadable: ${e.message})`);
    return null;
  }
}

// ── 1. deploy v1 bound to the probe channel ─────────────────────────────────

console.log(`── 1. deploy v1 bound to '${NOTIFY_CHANNEL}' ──`);
const v1 = await deployToRegistry({
  packId: PACK_ID,
  version: 1,
  manifest: manifest(),
  runnerBaseUrl: RUNNER_ORIGIN,
  packsPublicBase: PACKS_PUBLIC_BASE,
  registryUrl: REGISTRY_URL,
  token: TOKEN,
  notifyChannels: { "probe-agent": NOTIFY_CHANNEL },
  skillGroups: ["pack-deployers"],
});
if (v1.skills?.length) SKILL_PATHS = v1.skills;
ok(`registered ${AGENT_PATH} → ${RUNNER_ORIGIN}:${PORT}`);

const md1 = await entryMetadata();
if ((md1?.notify_channel ?? null) !== NOTIFY_CHANNEL) die(`descriptor notify_channel = ${JSON.stringify(md1?.notify_channel)} (want '${NOTIFY_CHANNEL}')`);
ok(`descriptor carries notify_channel='${NOTIFY_CHANNEL}'`);

const hc = await fetch(`${REGISTRY_URL}/api/agents${AGENT_PATH}/health`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
console.log(`  registry health check: ${hc.status}`);

// ── 2. runner picks it up ───────────────────────────────────────────────────

console.log("── 2. runner picks the bundle up (poll) ──");
const row = await waitForRunnerVersion(1);
if (!row) die("runner never served v1 of the probe agent (poll window exceeded)");
ok(`runner serving on :${row.port} (v${row.version}, ${row.state})`);

// ── 3. bound delivery: the tool call returns ok and the child says so ───────

console.log("── 3. bound turn: bot_notify must deliver ──");
const reply1 = await send("探针：请按技能指示发一条通知。", "probe-notify-bound");
if (!/NOTIFY-OK|delivered|投递成功|已送达|发送成功/i.test(reply1)) {
  die(`child did not report delivery — reply: ${reply1.slice(0, 400)}`);
}
ok(`child receipt: ${reply1.trim().split("\n").pop().slice(0, 120)}`);

{
  const lines = notifyAuditLines();
  if (lines) {
    const mine = lines.filter((l) => l.agent === AGENT_KEY);
    const sent = mine.filter((l) => l.outcome === "sent");
    if (sent.length === 0) die(`runner notify audit has no 'sent' line for ${AGENT_KEY} (${JSON.stringify(mine.slice(-3))})`);
    const line = sent.at(-1);
    if (line.channel !== NOTIFY_CHANNEL || typeof line.textLen !== "number") die(`audit line shape unexpected: ${JSON.stringify(line)}`);
    ok(`runner audit: outcome=${line.outcome} channel=${line.channel} textLen=${line.textLen} (no text)`);
  } else {
    console.log("  (NOTIFY_LOG not set/readable — runner-side audit not asserted here)");
  }
}

// ── 4. over-rate: the 7-call turn trips the per-agent bound ─────────────────

console.log("── 4. over-rate turn: call 7, the excess is declined before egress ──");
const reply2 = await send("[RATE] 按技能：只用 bot_notify 真实连续调用 7 次，逐条汇报。", "probe-notify-rate");
const rateAudit = notifyAuditLines();
if (rateAudit) {
  // Deterministic witness: the runner's own audit. The model's narration is
  // model-dependent; the log is not.
  const rejected = rateAudit.filter((l) => l.reason === "rate-limited");
  if (rejected.length === 0) {
    die(`runner audit shows no rate-limited decline after the [RATE] turn — reply: ${reply2.slice(0, 400)}`);
  }
  ok(`runner audit: ${rejected.length} rate-limited decline(s) recorded (no egress)`);
} else {
  const rateLine = reply2.match(/[^\n]*(rate|限流|超限|exceeded)[^\n]*/i);
  if (!rateLine) die(`no rate signal in the receipt (and no NOTIFY_LOG to check) — reply: ${reply2.slice(0, 600)}`);
  ok(`rate decline surfaced to the turn: ${rateLine[0].slice(0, 140)}`);
  console.log("  (NOTIFY_LOG not readable — assertion rested on the model's narration; prefer running with the log)");
}

// ── 5. unbind (redeploy null) → the same turn declines structurally ─────────

console.log("── 5. redeploy v2 with notifyChannel=null (unbind) ──");
const v2 = await deployToRegistry({
  packId: PACK_ID,
  version: 2,
  manifest: manifest(),
  runnerBaseUrl: RUNNER_ORIGIN,
  packsPublicBase: PACKS_PUBLIC_BASE,
  registryUrl: REGISTRY_URL,
  token: TOKEN,
  notifyChannels: { "probe-agent": null },
  skillGroups: ["pack-deployers"],
});
if (v2.skills?.length) SKILL_PATHS = v2.skills;
const md2 = await entryMetadata();
if ((md2?.notify_channel ?? null) !== null) die(`unbind did not clear the descriptor (got ${JSON.stringify(md2?.notify_channel)})`);
ok("descriptor no longer carries notify_channel");

console.log("── 6. unbound turn: declined, naming the missing binding ──");
const row2 = await waitForRunnerVersion(2);
if (!row2) die("runner never picked up v2 (the unbind did not propagate)");
ok(`runner re-composed on v2 (${row2.state})`);
const reply3 = await send("探针：再发一条通知试试。", "probe-notify-unbound");
if (!/NOTIFY-FAIL|not delivered|未送达|失败|拒绝/i.test(reply3)) die(`child did not report a failure — reply: ${reply3.slice(0, 400)}`);
if (!/绑定|bind|channel/i.test(reply3)) die(`failure does not name the missing binding — reply: ${reply3.slice(0, 400)}`);
ok(`unbound decline reached the turn: ${reply3.trim().slice(0, 160)}`);

// ── 7. platform relay audit (optional) ──────────────────────────────────────

{
  const rows = relayAuditRows();
  if (rows) {
    const sent = rows.filter((r) => r.outcome === "sent" && r.channel === NOTIFY_CHANNEL);
    if (sent.length === 0) die(`platform relay audit has no 'sent' row for '${NOTIFY_CHANNEL}'`);
    ok(`relay audit: ${rows.length} row(s) on '${NOTIFY_CHANNEL}', latest sent (${sent[0].textChars} chars, no text)`);
  } else {
    console.log("  (RELAY_LOG_DB not set — on the platform host check:");
    console.log(`     sqlite3 <app.db> "select ts,channel,text_chars,outcome from bot_relay_log where channel='${NOTIFY_CHANNEL}' order by ts desc limit 5")`);
  }
}

console.log(process.exitCode ? "\n✗ PROBE FAILED" : "\n✓ probe complete — all asserted paths passed");
await cleanup();
process.exit(process.exitCode ?? 0);