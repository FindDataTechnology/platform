#!/usr/bin/env node
// probe-stream-channel.mjs — the live delta lane census (restore-assistant-stream-020).
//
//   node scripts/probe-stream-channel.mjs [--tree <install-root>] [--bin <dsh-path>] [--fresh]
//
// Boots the matrix scratch tree child (or any candidate via --tree/--bin, same
// conventions as the contracts runner) against a SLOW-STREAMING dummy LLM
// (6 text deltas at 300ms gaps) and answers one question with timestamps:
//
//   does the bridge-forwarded platform/stream lane carry the live frames, and
//   does session.event stay chunk-free while it streams?
//
// This is the probe that caught the 0.2.0 regression (live transcripts went
// empty: the session format dropped assistant/chunk and nothing listened to
// its replacement). Exit 0 = the lane is healthy; run it against any dsh
// candidate before following a generation bump.
//
// Setup mirrors scripts/dsh-contracts.mjs (throwaway home, platform writers,
// full overlay order) — see that file for the rationale of each step.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
import { ensureScratchTree, pollUntil, sleep, treeDshVersion, withTimeout } from "./lib/dsh-contracts/contracts.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
const TEMPLATE_DIR = join(REPO_ROOT, "dsh-profile-template");
const PROFILE_NAME = "platform";
const AGENT_PRESET = "standard";
const INITIAL_KEY = `sk-stream-probe-${Date.now()}`;
const HANDSHAKE_BUDGET_MS = 30_000;
const DELTA_PARTS = ["你", "好", "，", "世", "界", "！"];
const DELTA_GAP_MS = 300;

// The slow-streaming dummy: one SSE delta per DELTA_GAP_MS, then finish.
function startSlowDummyLlm() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* non-JSON */ }
      requests.push({ t: Date.now(), model: json?.model ?? null });
      if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        if (i < DELTA_PARTS.length) {
          res.write(`data: ${JSON.stringify({ id: "stream-probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: i === 0 ? "assistant" : undefined, content: DELTA_PARTS[i] }, finish_reason: null }] })}\n\n`);
          i++;
        } else {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ id: "stream-probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        }
      }, DELTA_GAP_MS);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolvePromise({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  const argTree = process.argv.includes("--tree") ? process.argv[process.argv.indexOf("--tree") + 1] : null;
  const argBin = process.argv.includes("--bin") ? process.argv[process.argv.indexOf("--bin") + 1] : null;
  let tree;
  if (argTree) {
    tree = resolve(argTree);
    if (!existsSync(join(tree, "node_modules", "@deepseek-ai", "dsh"))) {
      throw new Error(`${tree} has no node_modules/@deepseek-ai/dsh — pass the install root`);
    }
  } else {
    const scratch = ensureScratchTree({ fresh: process.argv.includes("--fresh") });
    tree = scratch.tree;
  }
  const bin = argBin || join(tree, "node_modules", ".bin", "dsh");
  if (!existsSync(bin)) throw new Error(`dsh binary not found at ${bin}`);

  const home = mkdtempSync(join(tmpdir(), "stream-probe-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "stream-probe-ws-"));
  const dummyLlm = await startSlowDummyLlm();
  let client = null;
  let watcher = null;
  let pump = null;
  let probeSettled = false;

  try {
    process.env.DSH_HOME = home;
    process.env.LLM_API_KEY = INITIAL_KEY;
    process.env.LLM_PROVIDERS_STORE = join(home, "llm-providers.json");
    process.env.LLM_DEFAULT_STORE = join(home, "llm-default.json");
    process.env.DB_PATH = join(home, "probe.db");
    process.env.MCP_CONFIG_PATH = join(home, "mcp.json");

    const profileDir = join(home, "profiles", PROFILE_NAME);
    mkdirSync(profileDir, { recursive: true });
    for (const file of SCAFFOLD_FILES) copyFileSync(join(TEMPLATE_DIR, file), join(profileDir, file));
    symlinkSync(join(tree, "node_modules"), join(profileDir, "node_modules"), "dir");
    const dshPkg = join(tree, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
    symlinkSync(dshPkg, join(home, "profiles", "node_modules", "@deepseek-ai", "dsh"), "dir");

    const dshProfile = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
    const dirs = { dshHome: home, profileName: PROFILE_NAME };
    const { providers, models } = await dshProfile.writeLlmProfile({
      dirs,
      llmApiKey: INITIAL_KEY,
      llmBaseUrl: dummyLlm.url,
    });
    await dshProfile.ensureCredentialsStore({ dirs });
    const presetsPatchPath = await dshProfile.writePresetsPatch({ dirs, requireRoster: false });
    const permissionsPatchPath = await dshProfile.writePermissionsPatch();
    const extraPatchPaths = [];
    for (const write of ["writeToolSearchPatch", "writeChartBindPatch", "writeUserQuestionsPatch", "writeSaveLibraryPatch"]) {
      if (typeof dshProfile[write] !== "function") continue;
      try {
        const p = await dshProfile[write]();
        if (typeof p === "string") extraPatchPaths.push(p);
      } catch (e) {
        console.log(`[stream-probe] ${write}: ${e.message}`);
      }
    }
    const skillsPatchPath = join(home, "profiles", PROFILE_NAME, "skills.patch.yml");
    try { await dshProfile.writeSkillsPatch({ dirs, agentPreset: AGENT_PRESET }); } catch (e) { console.log(`[stream-probe] skills patch: ${e.message}`); }
    const provider = Object.keys(providers)[0];
    const model = models[0]?.id;

    console.log(`probe-stream-channel — dsh@${treeDshVersion(tree)} (${argTree ? "--tree candidate" : "matrix tree"})`);
    console.log(`  route: provider=${provider} model=${model} → ${dummyLlm.url} (${DELTA_PARTS.length}×${DELTA_GAP_MS}ms deltas)`);

    const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
    const args = ["--profile", PROFILE_NAME, ...[...new Set([
      presetsPatchPath,
      existsSync(skillsPatchPath) ? skillsPatchPath : null,
      permissionsPatchPath,
      ...extraPatchPaths,
    ].filter(Boolean))].flatMap((p) => ["--patch", p])];
    client = new HarnessClient({}, dshClientRuntime({
      command: process.execPath,
      args: [bin, ...args],
      cwd: workspace,
      env: childEnv,
      requestTimeoutMs: 60_000,
      shutdownTimeoutMs: 5_000,
    }));
    client.start();

    const notifications = [];
    watcher = client.subscribe();
    pump = (async () => {
      for (;;) {
        try {
          const n = await watcher.next();
          if (n) notifications.push(n);
        } catch (e) {
          if (!probeSettled) console.error(`child/sub transport failed mid-probe: ${String(e?.message || e).split("\n")[0]}`);
          return;
        }
      }
    })();

    const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await withTimeout(client.initialize({ cwd: workspace, provider, model, agentPreset: AGENT_PRESET }), Math.max(1_000, deadline - Date.now()), "initialize");
        break;
      } catch (e) {
        if (!/no adapter registered for provider/.test(String(e?.message || e)) || Date.now() >= deadline - 500) throw e;
        if (attempt === 0) console.log("  (adapter registration race; retrying handshake…)");
        await sleep(500);
      }
    }
    console.log("  handshake ok");

    // Capability gate first — the lane must be advertised.
    const caps = await client.request("platform/capabilities");
    const streamForward = caps?.streamForward === true;
    console.log(`  capabilities: streamForward=${streamForward} methods=${JSON.stringify(caps?.methods ?? [])}`);

    const S = "stream-probe";
    const streamAt = Date.now();
    await client.prompt(S, [{ type: "text", text: "stream census" }]);
    const idle = await pollUntil(
      () => (notifications.some((n) => n?.method === "session.status" && n?.params?.sessionId === S && n.params.status === "idle") ? true : null),
      { timeoutMs: 30_000, intervalMs: 300 },
    );
    if (!idle) throw new Error("the probe turn never went idle");

    const laneEvents = notifications.filter((n) => n?.method === "platform/stream" && n?.params?.sessionId === S);
    const frames = laneEvents.map((n) => n.params.frame);
    const kinds = frames.map((f) => (f?.type === "chunk" ? `chunk:${f.chunk?.type}` : f?.type));
    const firstDeltaDt = (() => {
      const hit = laneEvents.find((n) => n.params.frame?.chunk?.type === "text-delta");
      return hit ? hit.params.frame.time - streamAt : null;
    })();
    const settledAt = (() => {
      const hit = notifications.find((n) => n?.method === "session.event" && n?.params?.event?.type === "assistant/message" && n?.params?.sessionId === S);
      return hit ? Date.now() : null;
    })();
    const chunkEvents = notifications.filter(
      (n) => n?.method === "session.event" && ["assistant/chunk", "assistant/attempt"].includes(n?.params?.event?.type),
    );

    console.log(`  lane frames: ${frames.length} (${kinds.join(", ")})`);
    console.log(`  first text-delta at +${firstDeltaDt}ms (stream window ≈ ${DELTA_PARTS.length * DELTA_GAP_MS}ms); assistant/message settled: ${settledAt ? "yes" : "NO"}`);
    console.log(`  session.event chunk/attempt events during the turn: ${chunkEvents.length}`);

    probeSettled = true;
    const healthy = streamForward && frames.length > 0
      && frames.some((f) => f?.type === "start")
      && frames.some((f) => f?.type === "chunk" && f.chunk?.type === "text-delta")
      && frames.some((f) => f?.type === "end")
      && chunkEvents.length === 0
      && firstDeltaDt !== null && firstDeltaDt < DELTA_PARTS.length * DELTA_GAP_MS;
    console.log(
      healthy
        ? "\nVERDICT: HEALTHY — platform/stream carries the live deltas (well before settlement) and session.event stays chunk-free."
        : "\nVERDICT: BROKEN — the live delta lane is not delivering; a host bound to session.event chunks would stream nothing (the 0.2.0 regression shape).",
    );
    return healthy ? 0 : 1;
  } finally {
    probeSettled = true;
    try { await watcher?.close(); } catch { /* best effort */ }
    pump?.catch(() => {});
    try { await client?.close(); } catch { /* best effort */ }
    await dummyLlm.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`\nPROBE FAILED: ${String(e?.message || e).split("\n")[0]}`);
  process.exitCode = 1;
}
