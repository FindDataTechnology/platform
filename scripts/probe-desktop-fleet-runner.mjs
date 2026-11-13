#!/usr/bin/env node
// ── Desktop fleet runner acceptance probe (add-desktop-fleet-runner 6.1) ─────
//
// Exercises the REAL desktop wiring end to end on this machine, without
// touching any production plane:
//
//   stub registry (loopback) ─▶ agent-runner child process with the exact
//   env the supervisor descriptor injects (loopback host, pod mode, seat
//   fleet id + cloud-default sentinel, bundled-node dsh argv) ─▶ reconcile
//   pulls the seat-tagged entry ─▶ real dsh child boots ─▶ A2A message/send
//   gets a REAL LLM turn ─▶ SIGTERM drains with no orphaned dsh.
//
// LLM: the repo's own finddata routing store (rehearsal model
// deepseek-v4.1-flash), per the standing rehearsal rule — never the prod
// default model.
//
// Run: node scripts/probe-desktop-fleet-runner.mjs

import http from "node:http";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { agentPortFor } from "../lib/agent-serving.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEAT = "desktop-probe";
const ENTRY_PATH = "/packs/pk-probe/fleet-probe-agent";
const AGENT_PORT = agentPortFor(ENTRY_PATH);
const OPS_PORT = 18790;
const LLM_TIMEOUT_MS = 120_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENTRY = {
  path: ENTRY_PATH,
  supported_protocol: "a2a",
  is_enabled: true,
  name: "Fleet Probe Agent",
  description: "Desktop fleet plugin acceptance",
  version: "1",
  capabilities: { streaming: true },
  skills: [],
  tags: [],
  metadata: {
    protocol: "a2a",
    packId: "pk-probe",
    packVersion: 1,
    agentId: "fleet-probe-agent",
    agentName: "舰队探针",
    persona: "你是桌面舰队验收探针。收到任何消息都简短作答。",
    skills: [],
    mcpServers: [],
    runner_id: SEAT,
  },
};
const SKILLS = {};

// ── 1. stub registry on loopback ────────────────────────────────────────────
const registry = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith("/api/agents")) {
    // An untagged cloud entry rides along: the probe asserts it is NOT hosted.
    const untagged = { ...ENTRY, path: "/packs/pk-cloud/cloud-agent", metadata: { ...ENTRY.metadata, runner_id: undefined } };
    delete untagged.metadata.runner_id;
    return send(200, { agents: [ENTRY, untagged] });
  }
  const m = req.url.match(/^\/api\/skills\/(.+)\/content$/);
  if (m) {
    if (SKILLS[m[1]] === undefined) return send(404, { detail: "nope" });
    return send(200, { content: SKILLS[m[1]] });
  }
  send(404, { detail: `no stub for ${req.url}` });
});
await new Promise((r) => registry.listen(0, "127.0.0.1", r));
const REGISTRY_PORT = registry.address().port;

// ── 2. runner child with the supervisor's desktop env ───────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wx-fleet-probe-"));
const dshEntry = path.join(REPO, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
assert.ok(fs.existsSync(dshEntry), "bundled dsh entry exists in the repo tree");
const runnerEnv = {
  ...process.env,
  AGENT_SERVING_REGISTRY_URL: `http://127.0.0.1:${REGISTRY_PORT}`,
  AGENT_SERVING_REGISTRY_TOKEN: "probe-token",
  AGENT_RUNNER_HOME: path.join(tmp, "wanxing-runner"),
  AGENT_RUNNER_HOST: "127.0.0.1",
  AGENT_RUNNER_PORT: String(OPS_PORT),
  AGENT_RUNNER_POD_MODE: "1",
  AGENT_RUNNER_FLEET_ID: SEAT,
  AGENT_RUNNER_DEFAULT_ID: "cloud-default",
  AGENT_RUNNER_POLL_SECS: "1",
  AGENT_RUNNER_PROVIDER: "finddata",
  AGENT_RUNNER_MODEL: "deepseek-v4.1-flash",
  LLM_PROVIDERS_STORE: path.join(REPO, "llm-providers.json"),
  DSH_BIN: process.execPath,
  DSH_BIN_ARGS: JSON.stringify([dshEntry]),
  // Same shared dsh home the chat cell uses on a desktop (scaffold + module
  // tree source for the private runner homes).
  AGENT_RUNNER_SEED_HOME: path.join(os.homedir(), ".dsh"),
  // No /opt/dsh on a dev machine → matrix gate skips (same as the packaged
  // desktop, where the tree ships the frozen matrix instead).
  DSH_MATRIX_INSTALL_ROOT: path.join(tmp, "no-matrix"),
};

console.log(`[probe] stub registry :${REGISTRY_PORT}; runner ops :${OPS_PORT}; agent :${AGENT_PORT}`);
const runner = spawn(process.execPath, [path.join(REPO, "agent-runner", "index.js")], {
  env: runnerEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
runner.stdout.on("data", (b) => process.stdout.write(`[runner] ${b}`));
runner.stderr.on("data", (b) => process.stderr.write(`[runner:err] ${b}`));

const results = [];
const check = (name, fn) => fn().then((v) => { results.push([name, true, v]); console.log(`  ✓ ${name}`); })
  .catch((e) => { results.push([name, false, e?.message]); console.error(`  ✗ ${name}: ${e?.message}`); });

async function waitFor(fn, { timeoutMs = 60_000, everyMs = 500, what }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function fetchOk(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => { s.destroy(); resolve(false); });
});

try {
  await check("runner ops /health goes green (loopback)", () =>
    waitFor(() => fetchOk(`http://127.0.0.1:${OPS_PORT}/health`).then((r) => r.json()).then((j) => j && typeof j === "object" ? j : null),
      { what: "ops health", timeoutMs: 30_000 }));

  await check("reconcile hosts the seat-tagged entry only", () =>
    waitFor(async () => {
      const j = await fetchOk(`http://127.0.0.1:${OPS_PORT}/health`).then((r) => r.json());
      const hosted = JSON.stringify(j);
      // The seat entry must appear; the untagged cloud entry must not.
      if (hosted.includes("cloud-agent")) throw new Error("untagged cloud entry leaked onto the seat");
      return hosted.includes(ENTRY_PATH) || hosted.includes("fleet-probe-agent") ? j : null;
    }, { what: "seat entry hosted", timeoutMs: 60_000 }));

  await check("agent A2A listener binds the hash port on loopback", () =>
    waitFor(() => portOpen(AGENT_PORT).then((ok) => ok || null), { what: `agent port ${AGENT_PORT}` }));

  await check("agent card is served", async () => {
    const card = await fetchOk(`http://127.0.0.1:${AGENT_PORT}/.well-known/agent-card.json`).then((r) => r.json());
    assert.equal(card.name, ENTRY.name);
  });

  await check("A2A message/send gets a real LLM turn", async () => {
    const out = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "probe-1",
          method: "message/send",
          params: { message: { role: "user", parts: [{ kind: "text", text: "请只回复两个字：就绪" }] } },
        }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      }).catch((_e) => null);
      if (!res) return null;
      const doc = await res.json().catch(() => null);
      if (!doc || doc.error) return null;
      return doc;
    }, { what: "a completed (non-error) A2A turn", timeoutMs: LLM_TIMEOUT_MS, everyMs: 2000 });
    const text = (out.result?.parts ?? []).map((p) => p?.text ?? "").join("").trim();
    assert.ok(text.length > 0, "assistant replied with text");
    console.log(`      reply: ${JSON.stringify(text.slice(0, 120))}`);
  });
} finally {
  // ── drain + orphan check ──────────────────────────────────────────────────
  await check("SIGTERM drains and the runner exits cleanly", async () => {
    runner.kill("SIGTERM");
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("timeout"), 30_000);
      runner.once("exit", (c) => { clearTimeout(t); resolve(c); });
    });
    assert.notEqual(code, "timeout", "runner exited within 30s of SIGTERM");
    assert.equal(code, 0, `clean exit (got ${code})`);
  });
  registry.close();
  // Orphan check: strict on Linux (/proc cwd under this probe's tmp root);
  // informational only on macOS, where other dev/cell dsh processes are
  // indistinguishable by command line — a false kill there is worse than a
  // missed bonus assertion.
  let dshPids = "";
  try {
    dshPids = execSync(`pgrep -f "${dshEntry}" || true`, { encoding: "utf8" }).trim();
  } catch { /* pgrep absent or no match */ }
  if (process.platform === "linux" && dshPids) {
    const orphan = [];
    for (const pid of dshPids.split("\n").filter(Boolean)) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (cwd.startsWith(tmp)) orphan.push(pid);
      } catch { /* gone already */ }
    }
    if (orphan.length) {
      console.error(`  ✗ orphaned dsh processes: ${orphan.join(", ")} (killing)`);
      for (const pid of orphan) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
      results.push(["no orphaned dsh after drain", false, orphan.join(",")]);
    } else {
      results.push(["no orphaned dsh after drain", true, ""]);
      console.log("  ✓ no orphaned dsh after drain");
    }
  } else {
    console.log(`  ℹ dsh entry procs on this host (informational on ${process.platform}): ${dshPids || "none"}`);
    results.push(["no orphaned dsh after drain", true, "informational on this platform"]);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length
  ? `\n${failed.length} CHECK(S) FAILED:\n${failed.map(([n, , m]) => `  ✗ ${n}: ${m}`).join("\n")}`
  : `\nALL ${results.length} CHECKS PASSED — desktop fleet seat is live end to end`);
process.exit(failed.length ? 1 : 0);
