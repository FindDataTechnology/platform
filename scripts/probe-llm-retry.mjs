#!/usr/bin/env node
// scripts/probe-llm-retry.mjs — the resilience-contract chaos probe
// (add-llm-retry-resilience, design D5).
//
// Boots a REAL dsh (throwaway profile home, the platform's own writers) whose
// LLM route points at the scripted chaos gateway (e2e/chaos-llm.js). The
// gateway plays the model — including the sub2api concurrency rejection whose
// message text defeats the adapter's message-pattern classification ("Concurrency
// limit exceeded for user": neither a status code nor "rate limit").
//
// One boot, three policy flips — each flip is itself evidence (dsh-settings-file
// hot-reloads the settings document, so the SAME child must change behavior
// live, which is task 1.4's verification):
//
//   ① cold boot WITH retryPolicy  → chaos rejections are retried (llm/retry +
//      llm/retry-started events observed), the turn completes.   [the fix]
//   ② hot-strip the policy        → same chaos, the turn DIES with the
//      unclassified error and ZERO retry events.                [the original
//      bug reproduced on demand — and proof the strip hot-reloaded]
//   ③ hot-restore the policy      → same chaos, retries return.  [flip-back]
//   ④ delegation survival         → the scripted model delegates two PARALLEL
//      subagents under chaos; parent and both children all survive.
//
// Exit 0 only when every scenario holds. Cleanup: the dsh child is killed via
// client shutdown; no 'bin/dsh --profile' process is left behind.
//
// Run: node scripts/probe-llm-retry.mjs [--fresh]

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
import { ensureScratchTree, sleep, withTimeout } from "./lib/dsh-contracts/contracts.mjs";
import { startChaosLlm } from "../e2e/chaos-llm.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_DIR = join(REPO_ROOT, "dsh-profile-template");
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
const PROFILE_NAME = "platform";
const AGENT_PRESET = "standard";
const KEY = `sk-chaos-retry-${Date.now()}`;
const HANDSHAKE_BUDGET_MS = 30_000;
const TURN_BUDGET_MS = 120_000;

const failures = [];
function report(scenario, ok, detail) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${scenario} — ${detail}`);
  if (!ok) failures.push(`${scenario}: ${detail}`);
}

function parseArgs(argv) {
  const opts = { fresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--fresh") opts.fresh = true;
  }
  return opts;
}

// ── Settings surgery: strip / restore every provider's retryPolicy ──────────
// writeLlmProfile always attaches the policy; the strip is applied by direct
// document edit so the SAME generator output is what flips.
function stripRetryPolicy(settingsPath) {
  const doc = yaml.load(readFileSync(settingsPath, "utf8"));
  let stripped = 0;
  for (const p of Object.values(doc?.["llm-pi-ai"]?.providers ?? {})) {
    if (p.retryPolicy) {
      delete p.retryPolicy;
      stripped++;
    }
  }
  writeFileSync(settingsPath, yaml.dump(doc));
  return stripped;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Scratch tree (the frozen matrix closure) + chaos gateway.
  const scratch = ensureScratchTree({ fresh: opts.fresh });
  const tree = scratch.tree;
  const bin = join(tree, "node_modules", ".bin", "dsh");
  if (!existsSync(bin)) throw new Error(`dsh binary not found at ${bin}`);
  const chaos = await startChaosLlm();
  console.log(`probe-llm-retry — tree ${scratch.cached ? "(cached)" : "(fresh ci)"} ${scratch.key}`);
  console.log(`  chaos gateway: ${chaos.url}`);

  // 2. Throwaway home; the platform's own writers produce the profile.
  const home = mkdtempSync(join(tmpdir(), "chaos-retry-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "chaos-retry-ws-"));
  process.env.DSH_HOME = home;
  process.env.LLM_API_KEY = KEY;
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
  const settingsPath = join(home, "settings.yaml");
  const { providers, models } = await dshProfile.writeLlmProfile({
    dirs,
    llmApiKey: KEY,
    llmBaseUrl: chaos.url,
  });
  await dshProfile.ensureCredentialsStore({ dirs });
  const presetsPatchPath = await dshProfile.writePresetsPatch({ dirs, requireRoster: false });
  const permissionsPatchPath = await dshProfile.writePermissionsPatch();
  const provider = Object.keys(providers)[0];
  const model = models[0]?.id;
  const attached = providers[provider]?.retryPolicy;
  report(
    "generated profile carries retryPolicy",
    Boolean(attached?.retryableCodes?.includes("PI_AI_ERROR")),
    `mode=${attached?.mode} maxRetries=${attached?.maxRetries} codes=${attached?.retryableCodes?.join(",")}`,
  );

  // 3. Boot + handshake (adapter-registration race retry, as in dsh-contracts).
  const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
  for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
  const client = new HarnessClient(
    {},
    dshClientRuntime({
      command: bin,
      args: ["--profile", PROFILE_NAME, "--patch", presetsPatchPath, "--patch", permissionsPatchPath],
      cwd: workspace,
      env: childEnv,
      requestTimeoutMs: TURN_BUDGET_MS,
      shutdownTimeoutMs: 5_000,
    }),
  );
  client.start();

  // Event tap: session events across EVERY session (parent + subagent
  // children) — retries, turn ends, assistant messages.
  const events = [];
  const watcher = client.subscribe();
  const pump = (async () => {
    for (;;) {
      try {
        const notif = await watcher.next();
        const ev = notif?.params?.event;
        if (ev) {
          events.push({
            sessionId: notif.params.sessionId,
            type: ev.type,
            data: ev.data,
            t: Date.now(),
          });
        }
      } catch {
        return; // child gone
      }
    }
  })();

  const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await withTimeout(
        client.initialize({ cwd: workspace, provider, model, agentPreset: AGENT_PRESET }),
        Math.max(1_000, deadline - Date.now()),
        "initialize",
      );
      break;
    } catch (e) {
      if (!/no adapter registered for provider/.test(String(e?.message || e)) || Date.now() >= deadline - 500) throw e;
      if (attempt === 0) console.log("  initialize racing adapter registration; retrying…");
      await sleep(500);
    }
  }
  console.log(`  boot ok (provider=${provider} model=${model})`);

  // ── Scenario runner ────────────────────────────────────────────────────────
  // One prompt turn; settle when the session reports turn/end. Returns the
  // turn/end reason + the retry events observed for that session this turn.
  // NOTE: the runtime may issue LLM calls outside the driven session (e.g.
  // title generation) — armed rejections can burn on those, so retry-count
  // assertions are floors, and the gateway's own request log is printed per
  // scenario for exactly this disambiguation.
  async function runTurn(sessionId, prompt) {
    const reqSince = chaos.requests.length;
    const since = events.length;
    const settled = (async () => {
      for (;;) {
        const end = events.slice(since).find((e) => e.sessionId === sessionId && e.type === "turn/end");
        if (end) return end;
        await sleep(250);
      }
    })();
    const promptDone = client.prompt(sessionId, [{ type: "text", text: prompt }]);
    const end = await withTimeout(settled, TURN_BUDGET_MS, `turn/end for ${sessionId}`);
    await Promise.race([promptDone, sleep(5_000)]).catch(() => {});
    const mine = events.slice(since).filter((e) => e.sessionId === sessionId);
    return {
      reason: end.data?.reason ?? null,
      retryScheduled: mine.filter((e) => e.type === "llm/retry"),
      retryStarted: mine.filter((e) => e.type === "llm/retry-started"),
      assistantText: mine
        .filter((e) => e.type === "assistant/message")
        .map((e) => (e.data?.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""))
        .join(""),
      allSince: events.slice(since),
      gw: chaos.requests.slice(reqSince),
    };
  }

  const CHAOS_N = 3; // rejections before the gateway starts answering "ok"
  // Gateway request log: ✗ = rejected, D = delegation trigger hit, ok = text.
  const gwLog = (r) => `gw=${r.gw.map((x) => (x.rejected ? "✗" : x.lastRole === "user" && x.hasSubagentTool && "D") || "ok").join(",")}`;

  // ① THE FIX — cold-boot policy, chaos rejections, the turn must survive.
  await chaos.control({ mode: "pass", rejectCount: CHAOS_N, shape: "sse-error" });
  {
    const r = await runTurn("probe-fix-1", "probe: fixed-policy turn under concurrency chaos");
    const first = r.retryScheduled[0]?.data?.failure ?? null;
    report(
      "① policy on: chaos retried, turn survived",
      r.reason?.kind !== "error" &&
        r.retryScheduled.length >= 2 &&
        r.retryStarted.length >= 2 &&
        /ok/.test(r.assistantText) &&
        first?.code === "PI_AI_ERROR",
      `reason=${r.reason?.kind} retries=${r.retryScheduled.length}(${r.retryStarted.length}) text=${JSON.stringify(r.assistantText.slice(0, 40))} first-failure=${JSON.stringify(first)} ${gwLog(r)}`,
    );
  }

  // ② THE REPRO — strip the policy via file edit (hot reload), same chaos,
  //    the turn must die unclassified with ZERO retries.
  const stripped = stripRetryPolicy(settingsPath);
  await sleep(1_500); // settings hot-reload settle
  await chaos.control({ mode: "pass", rejectCount: CHAOS_N, shape: "sse-error" });
  {
    const r = await runTurn("probe-repro-1", "probe: stripped-policy turn under the same chaos");
    const failureCode = r.reason?.error?.code ?? r.retryScheduled[0]?.data?.failure?.code ?? "(none)";
    report(
      "② policy stripped (hot): original bug reproduced",
      stripped >= 1 && r.reason?.kind === "error" && r.retryScheduled.length === 0,
      `stripped=${stripped} reason=${JSON.stringify(r.reason)} retries=${r.retryScheduled.length} code=${failureCode}`,
    );
  }

  // ③ FLIP-BACK — rewrite the full profile (policy restored, hot reload).
  await dshProfile.writeLlmProfile({ dirs, llmApiKey: KEY, llmBaseUrl: chaos.url });
  await sleep(1_500);
  await chaos.control({ mode: "pass", rejectCount: CHAOS_N, shape: "sse-error" });
  {
    const r = await runTurn("probe-restore-1", "probe: policy restored, chaos again");
    report(
      "③ policy restored (hot): retries returned",
      r.reason?.kind !== "error" && r.retryScheduled.length >= 2,
      `reason=${r.reason?.kind} retries=${r.retryScheduled.length} ${gwLog(r)}`,
    );
  }

  // ④ DELEGATION — two PARALLEL subagents under chaos; parent + children all
  //    survive. Children run in their own sessions: no turn/end of kind error
  //    anywhere, and the parent's own turn completes with text.
  await chaos.control({ mode: "delegate2", rejectCount: CHAOS_N, shape: "sse-error" });
  {
    const r = await runTurn("probe-delegate-1", "probe: delegate two parallel subagents under chaos");
    const childSessions = new Set(r.allSince.map((e) => e.sessionId).filter((s) => s !== "probe-delegate-1"));
    const erroredEnds = r.allSince.filter((e) => e.type === "turn/end" && e.data?.reason?.kind === "error");
    const anyRetry = r.allSince.filter((e) => e.type === "llm/retry").length;
    const histogram = r.allSince.reduce((acc, e) => {
      const k = `${e.sessionId?.slice(0, 18)}:${e.type}`;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    const toolResults = r.allSince
      .filter((e) => e.type === "tool/result")
      .map((e) => {
        const c = e.data?.message?.content?.[0]?.content;
        const text = Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
        return `${e.data?.message?.source?.callId}:isError=${Boolean(e.data?.error)}:${JSON.stringify(text.slice(0, 60))}`;
      });
    report(
      "④ parallel delegation under chaos: all survived",
      r.reason?.kind !== "error" && erroredEnds.length === 0 && childSessions.size >= 2 && anyRetry >= 1 && /ok/.test(r.assistantText),
      `parent=${r.reason?.kind} childSessions=${childSessions.size} erroredEnds=${erroredEnds.length} retries=${anyRetry} text=${JSON.stringify(r.assistantText.slice(0, 40))} ${gwLog(r)} tools=[${toolResults.join(" | ")}] events=${JSON.stringify(histogram)}`,
    );
  }

  // Teardown.
  await pump;
  try {
    await withTimeout(client.shutdown(), 5_000, "shutdown");
  } catch {
    /* best-effort */
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  await chaos.close();

  console.log("");
  if (failures.length) {
    console.log(`probe-llm-retry: ${failures.length} scenario(s) FAILED`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("probe-llm-retry: ALL SCENARIOS GREEN");
}

main().catch((e) => {
  console.error("probe-llm-retry: fatal —", e);
  process.exit(1);
});
