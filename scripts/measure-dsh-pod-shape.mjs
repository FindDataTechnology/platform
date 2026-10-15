#!/usr/bin/env node
// scripts/measure-dsh-pod-shape.mjs — pod memory-shape measurement
// (extend-dsh-contracts-020-capabilities task 3.1, design D5).
//
// NOT a CI gate. Produces the RSS-vs-(sessions × context) curve that calibrates
// DshPodAdapter's per-pod memory budget: one dsh child, K sessions (K agents —
// each lazy session id is its own agent), T turns each with a large user chunk
// so derived history grows, RSS sampled every round. The dummy LLM answers
// instantly, so what accumulates is session state — the pod's real payload.
// Compaction runs as configured upstream: the curve measures the SHIPPED
// behavior, including whatever upstream does to long histories.
//
//   node scripts/measure-dsh-pod-shape.mjs [--agents 4] [--turns 6] [--chunk-kb 16]
//
// Output: CSV on stdout (round, live_sessions, turns_done, rss_mb), summary
// JSON on stderr. The numbers land in docs/wanxing-multi-harness-runtime-explore.md.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
import { startDummyLlm } from "./lib/dsh-contracts/dummy-llm.mjs";
import { ensureScratchTree, pollUntil, sleep } from "./lib/dsh-contracts/contracts.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_DIR = join(REPO_ROOT, "dsh-profile-template");
const PROFILE_NAME = "platform";
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];

function parseArgs(argv) {
  const opts = { agents: 4, turns: 6, chunkKb: 16 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agents") opts.agents = Number(argv[++i]);
    else if (argv[i] === "--turns") opts.turns = Number(argv[++i]);
    else if (argv[i] === "--chunk-kb") opts.chunkKb = Number(argv[++i]);
  }
  return opts;
}

// RSS in MB of the child process (ps reports KB on both macOS and Linux).
function rssMb(pid) {
  if (!pid) return null;
  const res = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  const kb = Number(String(res.stdout || "").trim());
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 102.4) / 10 : null;
}

function childPid(client) {
  return client?.pid?.() ?? client?.pid ?? client?.proc?.pid ?? client?.child?.pid ?? null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { tree } = ensureScratchTree({});
  const bin = join(tree, "node_modules", ".bin", "dsh");

  const home = mkdtempSync(join(tmpdir(), "dsh-measure-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-measure-ws-"));
  const dummyLlm = await startDummyLlm();
  let client = null;
  let watcher = null;
  try {
    process.env.DSH_HOME = home;
    process.env.LLM_API_KEY = `sk-measure-${Date.now()}`;
    process.env.LLM_PROVIDERS_STORE = join(home, "llm-providers.json");
    process.env.LLM_DEFAULT_STORE = join(home, "llm-default.json");
    process.env.DB_PATH = join(home, "measure.db");
    process.env.MCP_CONFIG_PATH = join(home, "mcp.json");

    const profileDir = join(home, "profiles", PROFILE_NAME);
    mkdirSync(profileDir, { recursive: true });
    for (const file of SCAFFOLD_FILES) copyFileSync(join(TEMPLATE_DIR, file), join(profileDir, file));
    symlinkSync(join(tree, "node_modules"), join(profileDir, "node_modules"), "dir");
    mkdirSync(join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
    symlinkSync(
      join(tree, "node_modules", "@deepseek-ai", "dsh"),
      join(home, "profiles", "node_modules", "@deepseek-ai", "dsh"),
      "dir",
    );

    const dshProfile = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
    const dirs = { dshHome: home, profileName: PROFILE_NAME };
    const settingsPath = join(profileDir, "cordis.patch.yml");
    const { providers, models } = await dshProfile.writeLlmProfile({
      dirs,
      llmApiKey: process.env.LLM_API_KEY,
      llmBaseUrl: dummyLlm.url,
    });
    await dshProfile.ensureCredentialsStore({ dirs });
    const presetsPatchPath = await dshProfile.writePresetsPatch({ dirs, requireRoster: false });
    const permissionsPatchPath = await dshProfile.writePermissionsPatch();
    void settingsPath;
    const provider = Object.keys(providers)[0];
    const model = models[0]?.id;

    const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
    client = new HarnessClient(
      {},
      dshClientRuntime({
        command: process.execPath,
        args: [bin, "--profile", PROFILE_NAME, "--patch", presetsPatchPath, "--patch", permissionsPatchPath],
        cwd: workspace,
        env: childEnv,
        requestTimeoutMs: 120_000,
        shutdownTimeoutMs: 5_000,
      }),
    );
    client.start();
    const notifications = [];
    watcher = client.subscribe();
    void (async () => {
      for (;;) {
        try {
          const n = await watcher.next();
          if (n) notifications.push(n);
        } catch {
          return;
        }
      }
    })();

    await client.initialize({ cwd: workspace, provider, model, agentPreset: "standard" });
    const pid = childPid(client);
    const chunk = `measurement filler text ${"lorem ipsum dolor sit amet ".repeat(Math.ceil((opts.chunkKb * 1024) / 27))} (round `;

    const sessions = Array.from({ length: opts.agents }, (_, i) => `srv-measure-${i}`);
    const lastStatus = (sid) => {
      let s = null;
      for (const n of notifications) if (n?.method === "session.status" && n?.params?.sessionId === sid) s = n.params.status;
      return s;
    };

    console.log("round,live_sessions,turns_done,rss_mb");
    const rows = [];
    const base = rssMb(pid);
    rows.push({ round: 0, live: 0, turns: 0, rss: base });
    console.log(`0,0,0,${base ?? "?"}`);
    let turnsDone = 0;
    for (let round = 1; round <= opts.turns; round++) {
      for (const sid of sessions) {
        await client.prompt(sid, [{ type: "text", text: `${chunk}${round})` }]);
        await pollUntil(() => (lastStatus(sid) === "idle" ? true : null), { timeoutMs: 60_000, intervalMs: 300 });
        turnsDone++;
      }
      await sleep(300); // let allocators settle before sampling
      const r = rssMb(pid);
      rows.push({ round, live: sessions.length, turns: turnsDone, rss: r });
      console.log(`${round},${sessions.length},${turnsDone},${r ?? "?"}`);
    }

    const perSessionMb = rows.length > 1 && rows.at(-1).rss && rows[0].rss
      ? Math.round(((rows.at(-1).rss - rows[0].rss) / sessions.length) * 10) / 10
      : null;
    console.error(
      JSON.stringify(
        {
          tree,
          dshVersion: JSON.parse(readFileSync(join(tree, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8")).version,
          agents: sessions.length,
          turnsPerAgent: opts.turns,
          chunkKb: opts.chunkKb,
          baselineRssMb: base,
          finalRssMb: rows.at(-1).rss,
          deltaPerSessionMb: perSessionMb,
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    try {
      await watcher?.close();
    } catch { /* best-effort */ }
    try {
      await client?.close();
    } catch { /* best-effort */ }
    await dummyLlm.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`[dsh-measure] ${String(e?.message || e).split("\n")[0]}`);
  process.exitCode = 2;
}
