#!/usr/bin/env node
// scripts/dsh-contracts.mjs — the dsh-contracts runner (add-dsh-contracts,
// design D1/D2; ADR-0007 upgrade gate).
//
// Candidate mode: run the v1 contracts (six) plus the live-control contracts
// (⑦⑧⑨, wire-dsh-live-runtime-control) against ANY dsh install —
//
//   npm run dsh:contracts                          # the frozen matrix scratch tree
//   npm run dsh:contracts -- --tree /opt/dsh       # an image install
//   npm run dsh:contracts -- --tree <dir> --bin <dsh-path>   # any manual install
//   npm run dsh:contracts -- --fresh               # rebuild the scratch tree
//
// What it does, in order: resolve the candidate tree → materialize an
// ISOLATED throwaway profile home (mkdtemp + the platform's own parameterized
// writers from dsh-profile.js — the temp home is the only DSH_HOME anyone
// sees; a real ~/.dsh or /opt/dsh-home is never touched) → spawn the candidate
// `dsh --profile platform --patch …` through HarnessClient and complete the
// initialize handshake → run every contract from scripts/lib/dsh-contracts/
// contracts.mjs sequentially, each in its own try/catch so one failure cannot
// drag the rest → print the per-contract report → exit 0 only when all pass.
//
// The child's LLM route points at a local dummy endpoint the runner owns:
// contracts assert routing/registration/credential layers, never a real
// upstream (candidate mode must not spend tokens).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import { HarnessClient } from "@deepseek-ai/dsh-sdk-client";
import { dshClientRuntime } from "../lib/dsh-client-launch.js";
import { startDummyLlm } from "./lib/dsh-contracts/dummy-llm.mjs";
import { ALT_PRESET, CONTRACTS, countTrivialSidecars, ensureScratchTree, firstLine, sleep, treeDshVersion, withTimeout } from "./lib/dsh-contracts/contracts.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HANDSHAKE_BUDGET_MS = 30_000; // design D3
const CONTRACT_TIMEOUT_MS = 60_000;
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
const TEMPLATE_DIR = join(REPO_ROOT, "dsh-profile-template");
const PROFILE_NAME = "platform";
const AGENT_PRESET = "standard"; // the platform's DEFAULT_AGENT_PRESET
const INITIAL_KEY = `sk-contracts-initial-${Date.now()}`;

function usage(code) {
  console.log(`usage: node scripts/dsh-contracts.mjs [--tree <install-root>] [--bin <dsh-path>] [--fresh]

  --tree   candidate install root (a dir containing node_modules/); default:
           the dsh-matrix scratch npm-ci tree, cached under node_modules/.cache
  --bin    dsh binary; default <tree>/node_modules/.bin/dsh
  --fresh  force a rebuild of the scratch tree (ignored with --tree)`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { fresh: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tree") opts.tree = argv[++i];
    else if (argv[i] === "--bin") opts.bin = argv[++i];
    else if (argv[i] === "--fresh") opts.fresh = true;
    else if (argv[i] === "--help" || argv[i] === "-h") usage(0);
    else {
      console.error(`unknown argument: ${argv[i]}`);
      usage(2);
    }
  }
  return opts;
}

// The dummy OpenAI-compatible endpoint lives in scripts/lib/dsh-contracts/
// dummy-llm.mjs (shared with the pod-shape measurement): it records every
// request — headers, model, system prompt, last user text — and answers with a
// well-formed completion so probe turns settle cleanly. A [HOLD] marker in the
// final message parks a request until release() (the slow-upstream stand-in).

// The initialize handshake with the adapter-registration race retry (same
// pattern as dsh-bridge: the llm-pi-ai adapter registers asynchronously after
// the settings file loads). Everything else fails fast. Under the overall
// 30s budget a hung boot surfaces as a timeout, which IS boot-crash evidence
// for contract ③.
async function handshake(client, params) {
  const deadline = Date.now() + HANDSHAKE_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await withTimeout(client.initialize(params), Math.max(1_000, deadline - Date.now()), "initialize handshake");
      return { ok: true, result };
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/no adapter registered for provider/.test(msg) || Date.now() >= deadline - 500) {
        return { ok: false, error: msg };
      }
      if (attempt === 0) console.log("[dsh-contracts] initialize racing adapter registration; retrying…");
      await sleep(500);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Resolve the candidate tree + bin.
  let tree;
  let treeLabel;
  if (opts.tree) {
    tree = resolve(opts.tree);
    treeLabel = "--tree";
    if (!existsSync(join(tree, "node_modules", "@deepseek-ai", "dsh"))) {
      throw new Error(`${tree} has no node_modules/@deepseek-ai/dsh — pass the install root (the dir npm ci ran in)`);
    }
  } else {
    const scratch = ensureScratchTree({ fresh: opts.fresh });
    tree = scratch.tree;
    treeLabel = scratch.cached ? `matrix scratch tree (cache ${scratch.key})` : `matrix scratch tree (fresh ci ${scratch.key})`;
  }
  const bin = opts.bin || join(tree, "node_modules", ".bin", "dsh");
  if (!existsSync(bin)) {
    throw new Error(`dsh binary not found at ${bin} — pass --bin <path> (for a global install, e.g. --bin $(which dsh))`);
  }

  // 2. Throwaway home + workspace, dummy LLM endpoint.
  const home = mkdtempSync(join(tmpdir(), "dsh-contracts-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "dsh-contracts-ws-"));
  const dummyLlm = await startDummyLlm();
  let client = null;
  let watcher = null;
  let pump = null;
  let currentContract = "(handshake)";

  try {
    // 3. Point EVERYTHING the platform writers read at the temp domain BEFORE
    // importing dsh-profile.js (its module-level DSH_HOME const is how
    // resolveShippedPresetRoot anchors onto the candidate tree). LLM_API_KEY is
    // the dummy key the credentials store seeds and the rotation probe replaces.
    process.env.DSH_HOME = home;
    process.env.LLM_API_KEY = INITIAL_KEY;
    process.env.LLM_PROVIDERS_STORE = join(home, "llm-providers.json");
    process.env.LLM_DEFAULT_STORE = join(home, "llm-default.json");
    process.env.DB_PATH = join(home, "contracts.db");
    process.env.MCP_CONFIG_PATH = join(home, "mcp.json");

    const profileDir = join(home, "profiles", PROFILE_NAME);
    mkdirSync(profileDir, { recursive: true });
    for (const file of SCAFFOLD_FILES) copyFileSync(join(TEMPLATE_DIR, file), join(profileDir, file));
    // Module levels, matching the image layout (/opt/dsh-home):
    //  - profiles/<name>/node_modules → the candidate's whole tree (what the
    //    profile's plugins resolve through — same shape as /opt/dsh);
    //  - profiles/node_modules/@deepseek-ai/dsh → JUST the dsh package. The
    //    profile writer's preset-root anchor resolves through it, and dsh's
    //    boot healer (healProfilesModuleFallback) owns this dir: it keeps a
    //    correct absolute link and fills in the rest of the closure itself.
    //    A whole-dir symlink here makes the leaf a real dir and the healer
    //    refuses to boot ("exists and is not a symlink").
    symlinkSync(join(tree, "node_modules"), join(profileDir, "node_modules"), "dir");
    const dshPkg = join(tree, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(home, "profiles", "node_modules", "@deepseek-ai"), { recursive: true });
    symlinkSync(dshPkg, join(home, "profiles", "node_modules", "@deepseek-ai", "dsh"), "dir");

    const dshProfile = await import(pathToFileURL(join(REPO_ROOT, "dsh-profile.js")).href);
    const dirs = { dshHome: home, profileName: PROFILE_NAME };
    // 0.2.0 (D7.1): the llm-pi-ai providers ride the profile's own patch row
    // (dsh-hmr watches this file), not the retired home-root settings.yaml.
    const settingsPath = join(profileDir, "cordis.patch.yml");
    const credentialsPath = join(home, ".credentials.yaml");
    const { providers, models } = await dshProfile.writeLlmProfile({
      dirs,
      llmApiKey: INITIAL_KEY,
      llmBaseUrl: dummyLlm.url,
    });
    await dshProfile.ensureCredentialsStore({ dirs });
    // ⑩ needs a SECOND declared preset (per-session selection is only
    // observable with two); the alternate persona carries the wire marker.
    const presetsPatchPath = await dshProfile.writePresetsPatch({ dirs, requireRoster: false, extraPresets: [ALT_PRESET] });
    const permissionsPatchPath = await dshProfile.writePermissionsPatch();
    // Compose EVERY bridge the image's /api/ready child composes. Composing only
    // presets+permissions let a real regression ship (2026-10-13): the
    // user-questions bridge called ctx.userQuestions.registerProvider, which
    // dsh 0.2.0-rc.2 does not expose, so the plugin failed to activate and the
    // image's readiness probe never went green — while these contracts stayed
    // 9/9 green because that overlay was never loaded. A gate that omits a
    // plugin cannot gate it.
    const extraPatchPaths = [];
    for (const write of ["writeToolSearchPatch", "writeChartBindPatch", "writeUserQuestionsPatch", "writePluginSupplyPatch", "writeSaveLibraryPatch"]) {
      if (typeof dshProfile[write] !== "function") continue;
      try {
        const p = await dshProfile[write]();
        if (typeof p === "string") extraPatchPaths.push(p);
      } catch (e) {
        console.log(`[dsh-contracts] ${write}: ${e.message}`);
      }
    }
    const skillsPatchPath = join(home, "profiles", PROFILE_NAME, "skills.patch.yml");
    try { await dshProfile.writeSkillsPatch({ dirs, agentPreset: AGENT_PRESET }); }
    catch (e) { console.log(`[dsh-contracts] skills patch: ${e.message}`); }

    // Probe overlay (⑩⑪⑫⑭, extend-dsh-contracts design D1/D3): the in-process
    // agent probe plugin + one trivial MCP server, inserted the same way the
    // platform bridges are (relative-name row beside the profile's cordis.yml).
    // The subagent row override pins the continuable pool at ONE slot so ⑫'s
    // admission refusal is deterministic. Test-only: these files exist solely
    // inside this throwaway profile.
    const PROBE_DIR = join(REPO_ROOT, "scripts", "lib", "dsh-contracts", "probe");
    copyFileSync(join(PROBE_DIR, "contracts-agent-probe.mjs"), join(profileDir, "contracts-agent-probe.mjs"));
    copyFileSync(join(PROBE_DIR, "trivial-mcp-server.mjs"), join(profileDir, "trivial-mcp-server.mjs"));
    const probePatchPath = join(profileDir, "probe.patch.yml");
    writeFileSync(
      probePatchPath,
      yaml.dump([
        { id: "subagent", config: { maxActiveSubagents: 1, maxDepth: 1 } },
        {
          insert: [
            { id: "contracts-agent-probe", name: "./contracts-agent-probe.mjs" },
            {
              id: "mcp-contracts",
              name: "@deepseek-ai/dsh-mcp-client",
              config: {
                serverName: "contracts",
                transport: "stdio",
                command: process.execPath,
                args: [join(profileDir, "trivial-mcp-server.mjs")],
              },
            },
          ],
        },
      ]),
    );
    const provider = Object.keys(providers)[0];
    const model = models[0]?.id;

    console.log(`dsh-contracts — candidate: ${tree} (${treeLabel}, dsh@${treeDshVersion(tree) ?? "?"})`);
    console.log(`  bin: ${bin}`);
    console.log(`  home: ${home} (throwaway; the real DSH_HOME is never touched)`);
    console.log(`  route: provider=${provider} model=${model} → ${dummyLlm.url} (dummy endpoint, no real upstream)`);

    // 4. Spawn + handshake. The child env inherits ours minus the API key (the
    // credentials file must be the winning layer — the layer the rotation probe
    // exercises) and minus proxy vars (a system proxy would blackhole 127.0.0.1).
    const childEnv = dshProfile.buildScrubbedEnv() ?? { ...process.env };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete childEnv[k];
    // Same overlay order as the image child (dsh-bridge.patchArgs); only paths
    // that materialized are passed (the child hard-fails on a missing overlay).
    const args = ["--profile", PROFILE_NAME, ...[...new Set([
      presetsPatchPath,
      existsSync(skillsPatchPath) ? skillsPatchPath : null,
      permissionsPatchPath,
      ...extraPatchPaths,
      probePatchPath,
    ].filter(Boolean))].flatMap((p) => ["--patch", p])];
    client = new HarnessClient(
      {},
      dshClientRuntime({
        command: process.execPath,
        args: [bin, ...args],
        cwd: workspace,
        env: childEnv,
        requestTimeoutMs: CONTRACT_TIMEOUT_MS,
        shutdownTimeoutMs: 5_000,
      }),
    );
    client.start();

    const ctx = {
      tree,
      home,
      workspace,
      profileDir,
      bin,
      settingsPath,
      credentialsPath,
      presetsPatchPath,
      permissionsPatchPath,
      // Contract ②'s declared set: the tree's own lock when it carries one
      // (scratch trees do), else the frozen matrix lock.
      lockPath: existsSync(join(tree, "package-lock.json"))
        ? join(tree, "package-lock.json")
        : join(REPO_ROOT, "dsh-matrix", "package-lock.json"),
      models,
      provider,
      model,
      agentPreset: AGENT_PRESET,
      dummyLlm,
      client,
      handshake: { ok: false, error: "not attempted" },
      bootExit: null, // child died (or boot hung) during the executor handshake
      childExit: null, // child died later: { at: <contract title>, error }
    };

    // Crash watcher: one subscription whose only job is noticing the child died
    // and attributing the exit to whatever was running at the time (design D3).
    // Every notification is also recorded (live-runtime-control contracts ⑧⑨
    // read per-session session.status transitions back).
    ctx.notifications = [];
    watcher = client.subscribe();
    pump = (async () => {
      for (;;) {
        try {
          // The subscription's next() resolves the notification itself.
          const notif = await watcher.next();
          if (notif) ctx.notifications.push(notif);
        } catch (e) {
          const error = String(e?.message || e);
          ctx.childExit = { at: currentContract, error };
          if (currentContract === "(handshake)") ctx.bootExit = { at: currentContract, error };
          return;
        }
      }
    })();

    ctx.handshake = await handshake(client, { cwd: workspace, provider, model, agentPreset: AGENT_PRESET });
    if (!ctx.handshake.ok && /timed out/.test(ctx.handshake.error)) {
      // A hung boot is crash-class evidence for ③/⑤ even though nothing exited.
      ctx.bootExit ??= { at: "(handshake)", error: ctx.handshake.error };
    }

    // 5. Run the table. Session contracts gate themselves (requireHandshake);
    // the static ones (②③⑤) run to their own verdicts even on a dead child —
    // a crash-loop candidate still gets honest per-contract reporting.
    const rows = [];
    let failures = 0;
    for (const contract of CONTRACTS) {
      currentContract = contract.title;
      const tag = contract.tags?.length ? ` [${contract.tags.join(",")}]` : "";
      const advis = contract.advisory ? " [advisory]" : "";
      const t0 = Date.now();
      let status;
      let detail;
      let unjudgeable = false;
      try {
        detail = await withTimeout(contract.run(ctx), CONTRACT_TIMEOUT_MS, contract.title);
        status = "PASS";
      } catch (e) {
        status = "FAIL";
        // Advisory contracts are reported but never counted: the frozen matrix
        // fails ⑨b by known upstream limitation, and a permanently red gate is
        // no gate (concurrent-chat-sessions design D9).
        if (!contract.advisory) failures += 1;
        detail = firstLine(e);
        unjudgeable = /unavailable without a completed handshake/.test(detail);
        if (ctx.childExit?.at === contract.title) {
          detail += ` — child exit evidence: ${firstLine(ctx.childExit.error)}`;
        }
      }
      rows.push({ contract, status, detail, unjudgeable });
      console.log(`  ${contract.title}${tag}${advis} ${status} — ${detail} (${Date.now() - t0}ms)`);
    }

    // ⑭'s no-orphan half: the trivial MCP sidecar must die with the child.
    // The contracts table already printed its rows; the check runs after the
    // child is gone and flips the ⑭ row if a server process survived.
    await client?.close().catch(() => {});
    await sleep(1_500);
    const orphans = countTrivialSidecars();
    if (orphans > 0) {
      const row = rows.find((r) => r.contract.id === "mcp-sidecar-sharing");
      if (row && row.status === "PASS") {
        row.status = "FAIL";
        row.detail = `${orphans} trivial-MCP server process(es) outlived the dsh child — sidecar lifecycle is not process-owned`;
        failures += 1;
        console.log(`  ⑭ MCP sidecar process sharing FAIL — ${row.detail}`);
      }
    }

    // 6. Summary + aggregate exit code. Advisory rows are excluded from both
    // the numerator and the denominator — they report, they never gate.
    const gating = rows.filter((r) => !r.contract.advisory);
    const advisory = rows.filter((r) => r.contract.advisory);
    console.log("");
    const verdict =
      failures === 0
        ? `${gating.length}/${gating.length} PASS`
        : `${gating.length - failures}/${gating.length} PASS, ${failures} FAIL`;
    console.log(`dsh-contracts: ${verdict} — candidate ${tree}`);
    if (!ctx.handshake.ok) {
      console.log(
        `  handshake did not complete (${firstLine(ctx.handshake.error)}): the session contracts are marked unjudgeable, not independently red`,
      );
    }
    // Advisory summary, listed separately so a red ⑨b can never be mistaken
    // for a gate failure (and a green one is easy to find for the upgrade
    // decision).
    for (const { contract, status, detail } of advisory) {
      console.log(`  [advisory] ${contract.title}: ${status} — ${detail}`);
    }
    for (const { contract, status, unjudgeable: unj } of rows) {
      if (status === "FAIL" && contract.tags?.includes("internal-API") && !unj) {
        console.log(
          `  ${contract.title} carries the internal-API tag: upstream changed an internal surface — evaluate an alternative or pin, this is not automatically a "cannot follow" verdict`,
        );
      }
    }
    return failures === 0 ? 0 : 1;
  } finally {
    currentContract = "(shutdown)";
    try {
      await watcher?.close();
    } catch {
      /* already failed */
    }
    pump?.catch(() => {});
    try {
      await client?.close();
    } catch {
      /* the close ladder is best-effort */
    }
    await dummyLlm.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

process.on("SIGINT", () => {
  console.log("\n[dsh-contracts] interrupted");
  // The finally ladder in main() owns cleanup; give it a beat then hard-exit.
  setTimeout(() => process.exit(130), 300);
});

try {
  process.exitCode = await main();
} catch (e) {
  console.error(`[dsh-contracts] ${firstLine(e)}`);
  process.exitCode = 2;
}
